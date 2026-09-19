import type { AgentEvent, AgentState } from "../runtime/types.js";
import { progressBar } from "../utils/large-output.js";

const STATE_EMOJI: Record<AgentState, string> = {
  idle: "💤", thinking: "🧠", planning: "🧠", reading: "🔎",
  editing: "🛠", executing: "▶️", testing: "▶️", waiting_approval: "⚠️",
  retrying: "🔁", completed: "✅", failed: "❌", cancelled: "🛑",
};

/** Telegram renderer: operational progress only, never raw chain-of-thought. */
export function renderEventLine(ev: AgentEvent): string | null {
  switch (ev.type) {
    case "thinking": return "🧠 analyzing request";
    case "planning": return `🧠 ${ev.message}`;
    case "tool_start":
      if (ev.tool === "read_file" || ev.tool === "glob" || ev.tool === "grep" || ev.tool === "search_code")
        return `📖 reading ${String((ev.args.target ?? ev.args.pattern ?? ev.args.query ?? "") as string)}`;
      if (ev.tool === "write_file" || ev.tool === "edit_file") return `🛠 modifying ${String(ev.args.target ?? "")}`;
      if (ev.tool === "shell") return `▶️ running ${String(ev.args.command ?? "").slice(0, 120)}`;
      if (ev.tool === "npm_test" || ev.tool === "npm_build") return `▶️ running ${ev.tool}`;
      return `🔧 ${ev.tool}`;
    case "tool_output": return ev.success ? null : `❌ ${ev.tool} failed`;
    case "file_change": return `📝 changed: ${ev.files.slice(0, 5).join(", ")}`;
    case "command": return `▶️ exit ${ev.exitCode ?? "?"}: ${ev.command.slice(0, 100)}`;
    case "test": return ev.failed > 0 ? `❌ tests: ${ev.passed} passed, ${ev.failed} failed` : `✅ tests: ${ev.passed} passed`;
    case "approval_required": return `⚠️ approval required (${ev.risk}): ${ev.command.slice(0, 200)}`;
    case "error": return `❌ ${ev.error.slice(0, 300)}`;
    case "completed": return `✅ completed — ${ev.filesChanged.length} files changed`;
    case "state": return `${STATE_EMOJI[ev.state]} ${ev.state}`;
    default: return null;
  }
}

export interface StatusSnapshot {
  phase: string;
  tool?: string;
  command?: string;
  progress: number;
  filesChanged: number;
  testsPassed: number;
  errors: number;
  detail: string[];
}

export function emptySnapshot(): StatusSnapshot {
  return { phase: "starting", progress: 2, filesChanged: 0, testsPassed: 0, errors: 0, detail: [] };
}

export function applyEvent(snap: StatusSnapshot, ev: AgentEvent): StatusSnapshot {
  const next = { ...snap, detail: [...snap.detail].slice(-8) };
  const line = renderEventLine(ev);
  if (line) next.detail.push(line);
  switch (ev.type) {
    case "state": next.phase = ev.state; next.progress = Math.min(95, next.progress + 4); break;
    case "tool_start": next.tool = ev.tool; if (ev.tool === "shell") next.command = String(ev.args.command ?? "").slice(0, 120); next.progress = Math.min(95, next.progress + 3); break;
    case "file_change": next.filesChanged += ev.files.length; break;
    case "test": next.testsPassed += ev.passed; next.errors += ev.failed; break;
    case "error": next.errors += 1; break;
    case "completed": next.phase = "completed"; next.progress = 100; break;
  }
  return next;
}

export function renderStatusMessage(snap: StatusSnapshot): string {
  return [
    "🧠 Agent working...",
    "",
    `phase: ${snap.phase}`,
    snap.tool ? `tool: ${snap.tool}` : undefined,
    snap.command ? `command: ${snap.command}` : undefined,
    "",
    "progress:",
    `${progressBar(snap.progress)} ${snap.progress}%`,
    "",
    `files changed: ${snap.filesChanged}`,
    `tests: ${snap.testsPassed} passed`,
    `errors: ${snap.errors}`,
    snap.detail.length ? "" : undefined,
    ...snap.detail.slice(-6),
  ].filter((l) => l !== undefined).join("\n");
}

export function renderFinalSummary(o: { filesChanged: string[]; testsPassed?: number; durationMs: number; tokens: number; model: string; verification?: string }): string {
  const mins = Math.floor(o.durationMs / 60000);
  const secs = Math.floor((o.durationMs % 60000) / 1000);
  return [
    "✅ task completed",
    "",
    `model: ${o.model}`,
    `duration: ${mins}m ${secs}s`,
    `tokens: ${(o.tokens / 1000).toFixed(1)}k`,
    `files changed: ${o.filesChanged.length}`,
    o.filesChanged.length ? o.filesChanged.slice(0, 15).map((f) => `- ${f}`).join("\n") : undefined,
    o.verification ? "" : undefined,
    o.verification,
  ].filter((l) => l !== undefined).join("\n");
}

export function renderFailure(o: { attempted: string[]; lastError: string; remains: string }): string {
  return [
    "⚠️ task incomplete",
    "",
    "what happened:",
    o.lastError.slice(0, 1000),
    "",
    "what was attempted:",
    ...o.attempted.slice(-8).map((a) => `- ${a.slice(0, 200)}`),
    "",
    "what remains:",
    o.remains.slice(0, 1000),
  ].join("\n");
}
