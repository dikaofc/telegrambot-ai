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
  const systemChars = system ? (system.content?.length ?? 0) + 16 : 0;
  const sizeOf = (m: ChatMessage): number => (m.content?.length ?? 0) + 16;
  const describe = (m: ChatMessage): string => `${m.role}: ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 160)}`;

  // Greedy: walk newest → oldest keeping what fits, always keeping the newest
  // user turn. Then shrink until the window (including the compaction notice)
  // genuinely fits, so the budget is a guarantee and not a hope.
  const keep = new Array<boolean>(rest.length).fill(false);
  const absorbed: string[] = [];
  let keptChars = systemChars;
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i] as ChatMessage;
    const size = sizeOf(m);
    if (i === newestUser || keptChars + size <= maxChars) {
      keep[i] = true;
      keptChars += size;
    } else {
      absorbed.unshift(describe(m));
    }
  }

  // Shrink: drop the oldest *kept* evidence before the summary, never the newest user turn.
  const droppable = rest.map((_, i) => i).filter((i) => keep[i] && i !== newestUser);
  let summaryText = "";
  const build = (): ChatMessage[] => {
    const keptList = rest.filter((_, i) => keep[i]);
    const summary: ChatMessage | undefined = summaryText
      ? { role: "tool", toolName: "context_compaction", content: summaryText }
      : undefined;
    return system ? [system, ...(summary ? [summary] : []), ...keptList] : [...(summary ? [summary] : []), ...keptList];
  };
  const summaryFor = (n: number): string => {
    if (n === 0) return "";
    return `[context compacted — ${n} earlier message(s) folded to stay within the context budget]\n${absorbed.slice(-n).join("\n")}`;
  };

  summaryText = summaryFor(absorbed.length);
  while (totalChars(build()) > maxChars && droppable.length > 0) {
    const idx = droppable.shift() as number;
    keep[idx] = false;
    absorbed.unshift(describe(rest[idx] as ChatMessage));
    summaryText = summaryFor(absorbed.length);
  }
  // Still over budget → the notice itself has to give way (evidence beats commentary).
  while (totalChars(build()) > maxChars && summaryText) {
    summaryText = summaryText.length > 600 ? summaryText.slice(0, 600) : "";
  }

  const next = build();
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
