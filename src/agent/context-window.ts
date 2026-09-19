import type { ChatMessage } from "../providers/types.js";

/**
 * Context engineering for the in-run message list.
 *
 * A run appends one tool result per iteration. Unbounded, that grows into
 * hundreds of kilobytes of raw command output, which blows the model's context
 * (or silently truncates it upstream) and pushes the original objective out of
 * attention range. So: trim individual results, then keep the whole window
 * inside a character budget by folding the oldest tool results into a summary.
 */

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 6_000;
export const DEFAULT_MAX_CONTEXT_CHARS = 60_000;

/** Keep the head and tail of a long tool result, eliding the middle. */
export function trimToolResult(text: string, maxChars = DEFAULT_MAX_TOOL_RESULT_CHARS): string {
  const s = String(text ?? "");
  if (s.length <= maxChars) return s;
  const marker = `\n…[${s.length - maxChars} chars elided by context window]…\n`;
  const room = Math.max(maxChars - marker.length, 0);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return s.slice(0, head) + marker + (tail > 0 ? s.slice(s.length - tail) : "");
}

export interface WindowResult {
  messages: ChatMessage[];
  /** Characters of the window after enforcement. */
  chars: number;
  /** How many messages were folded into the summary. */
  compacted: number;
  trimmed: boolean;
}

function totalChars(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += (m.content?.length ?? 0) + 16;
  return n;
}

/**
 * Enforce a character budget on the conversation sent to the model.
 *
 * Invariants: the first system message is never dropped, the most recent user
 * message is never dropped, and what was folded away is represented by a visible
 * summary line (not silently discarded) so the model knows history was compacted.
 */
export function enforceContextBudget(
  messages: ChatMessage[],
  maxChars = DEFAULT_MAX_CONTEXT_CHARS,
  maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
): WindowResult {
  let trimmed = false;
  const sized: ChatMessage[] = messages.map((m) => {
    if (m.role !== "tool" && !/^Tool result/i.test(m.content ?? "")) return m;
    const next = trimToolResult(m.content ?? "", maxToolResultChars);
    if (next !== m.content) trimmed = true;
    return { ...m, content: next };
  });

  let chars = totalChars(sized);
  if (chars <= maxChars) return { messages: sized, chars, compacted: 0, trimmed };

  // Never evict these: the system prompt (index 0) and the newest user turn.
  const system = sized[0]?.role === "system" ? sized[0] : undefined;
  const rest = (system ? sized.slice(1) : sized).slice();
  const lastUserIdx = [...rest].reverse().findIndex((m) => m.role === "user");
  const newestUser = lastUserIdx >= 0 ? rest.length - 1 - lastUserIdx : -1;

  const absorbed: string[] = [];
  const kept: ChatMessage[] = [];
  let keptChars = system ? (system.content?.length ?? 0) + 16 : 0;
  const budgetForRest = maxChars - keptChars;

  for (let i = rest.length - 1; i >= 0; i--) {
    if (i === newestUser) { kept.unshift(rest[i] as ChatMessage); keptChars += (rest[i] as ChatMessage).content?.length ?? 0; continue; }
    const m = rest[i] as ChatMessage;
    const size = (m.content?.length ?? 0) + 16;
    if (keptChars + size <= budgetForRest) {
      kept.unshift(m);
      keptChars += size;
    } else {
      absorbed.unshift(`${m.role}: ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }

  const summary: ChatMessage | undefined = absorbed.length > 0
    ? {
        role: "tool",
        toolName: "context_compaction",
        content: `[context compacted — ${absorbed.length} earlier message(s) folded to stay within the context budget]\n${absorbed.join("\n")}`.slice(0, 4_000),
      }
    : undefined;

  const next = system ? [system, ...(summary ? [summary] : []), ...kept] : [...(summary ? [summary] : []), ...kept];
  return { messages: next, chars: totalChars(next), compacted: absorbed.length, trimmed };
}

/**
 * Compose the per-run starting context: system prompt, compacted session
 * summary, a bounded slice of history, then the new user turn.
 */
export function composeRunMessages(o: {
  systemPrompt: string;
  history: ChatMessage[];
  summary?: string | null;
  input: string;
  maxChars?: number;
}): { messages: ChatMessage[]; compacted: number } {
  const head: ChatMessage[] = [{ role: "system", content: o.systemPrompt }];
  if (o.summary?.trim()) {
    head.push({ role: "system", content: `Earlier in this session (compacted):\n${o.summary.trim().slice(0, 4_000)}` });
  }
  const messages: ChatMessage[] = [...head, ...o.history, { role: "user", content: o.input }];
  const res = enforceContextBudget(messages, o.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS);
  return { messages: res.messages, compacted: res.compacted };
}
