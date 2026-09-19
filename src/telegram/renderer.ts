import type { AgentEvent, AgentState } from "../runtime/types.js";
import { progressBar } from "../utils/large-output.js";
import { mdToHtml, wrapBlockquoteIfNeeded, splitHtml } from "./format.js";

const STATE_EMOJI: Record<AgentState, string> = {
  idle: "💤", thinking: "🧠", planning: "🧠", reading: "🔎",
  editing: "🛠", executing: "▶️", testing: "▶️", waiting_approval: "⚠️",
  retrying: "🔁", completed: "✅", failed: "❌", cancelled: "🛑",
};

/** Telegram renderer: operational progress only, never raw chain-of-thought. */
export function renderEventLine(ev: AgentEvent): string | null {
  switch (ev.type) {
    case "thinking": return "✨ Lagi ngulik permintaanmu...";
    case "planning": return `🧠 ${ev.message}`;
    case "plan": return `🗺️ plan r${ev.revision}: ${ev.label}`;
    case "replan": return `🔁 replan r${ev.revision} — ${ev.reason.slice(0, 200)}`;
    case "progress": return null;
    case "step_done": return `✓ ${ev.title}`;
    case "tool_start":
      if (ev.tool === "read_file" || ev.tool === "glob" || ev.tool === "grep" || ev.tool === "search_code")
        return `📖 baca ${String((ev.args.target ?? ev.args.pattern ?? ev.args.query ?? "") as string)}`;
      if (ev.tool === "write_file" || ev.tool === "edit_file") return `🛠 ubah ${String(ev.args.target ?? "")}`;
      if (ev.tool === "shell") return `▶️ jalanin ${String(ev.args.command ?? "").slice(0, 120)}`;
      if (ev.tool === "npm_test" || ev.tool === "npm_build") return `▶️ jalanin ${ev.tool}`;
      return `🔧 ${ev.tool}`;
    case "tool_output": return ev.success ? null : `❌ ${ev.tool} failed`;
    case "file_change": return `📝 ubah: ${ev.files.slice(0, 5).join(", ")}`;
    case "command": return `▶️ exit ${ev.exitCode ?? "?"}: ${ev.command.slice(0, 100)}`;
    case "test": return ev.failed > 0 ? `❌ tests: ${ev.passed} passed, ${ev.failed} failed` : `✅ tests: ${ev.passed} passed`;
    case "approval_required": return `⚠️ butuh izin (${ev.risk}): ${ev.command.slice(0, 200)}`;
    case "error": return `❌ ${ev.error.slice(0, 300)}`;
    case "completed": return `✅ beres — ${ev.filesChanged.length} file diubah`;
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
  /** Live plan progress ("step 2/4 · implement: …") from a real plan. */
  plan?: string;
  planSteps?: Array<{ title: string; status: string }>;
}

export function emptySnapshot(): StatusSnapshot {
  return { phase: "starting", progress: 2, filesChanged: 0, testsPassed: 0, errors: 0, detail: [] };
}

const STEP_ICON: Record<string, string> = { completed: "✓", in_progress: "→", failed: "✗", skipped: "-", pending: "•" };

export function applyEvent(snap: StatusSnapshot, ev: AgentEvent): StatusSnapshot {
  const next = { ...snap, detail: [...snap.detail].slice(-8) };
  const line = renderEventLine(ev);
  if (line) next.detail.push(line);
  switch (ev.type) {
    case "state": next.phase = ev.state; next.progress = Math.min(95, next.progress + 4); break;
    case "plan": next.plan = ev.label; next.planSteps = ev.steps.map((s) => ({ title: s.title, status: s.status })); break;
    case "replan": next.plan = `revision ${ev.revision}`; break;
    case "progress": next.plan = ev.label; if (ev.percent > next.progress) next.progress = Math.min(95, ev.percent); break;
    case "step_done":
      if (next.planSteps) next.planSteps = next.planSteps.map((s) => (s.title === ev.title ? { ...s, status: "completed" } : s));
      break;
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
    "✨ Lagi dikerjain...",
    "",
    `status: ${snap.phase}`,
    snap.plan ? `plan: ${snap.plan}` : undefined,
    ...(snap.planSteps ?? []).slice(0, 5).map((s) => `  ${STEP_ICON[s.status] ?? "•"} ${s.title.slice(0, 70)}`),
    snap.tool ? `tool: ${snap.tool}` : undefined,
    snap.command ? `cmd: ${snap.command}` : undefined,
    "",
    "progress:",
    `${progressBar(snap.progress)} ${snap.progress}%`,
    "",
    `ubah: ${snap.filesChanged} file`,
    `tes: ${snap.testsPassed} lolos`,
    `error: ${snap.errors}`,
    snap.detail.length ? "" : undefined,
    ...snap.detail.slice(-6),
  ].filter((l) => l !== undefined).join("\n");
}

export function renderFinalSummary(o: { filesChanged: string[]; testsPassed?: number; durationMs: number; tokens: number; model: string; verification?: string; summary?: string }): string {
  // Plain fallback — no model, only time+tokens, still cool via blockquote-like lines
  const mins = Math.floor(o.durationMs / 60000);
  const secs = Math.floor((o.durationMs % 60000) / 1000);
  const summaryBlock = o.summary?.trim() ? o.summary.trim().slice(0, 3500) : undefined;
  const metaPlain = `> ⏱ ${mins}m ${secs}s • 🔢 ${(o.tokens / 1000).toFixed(1)}k tokens`;
  if (summaryBlock && o.filesChanged.length === 0) {
    return [summaryBlock, "", metaPlain, o.verification ? "" : undefined, o.verification].filter((l) => l !== undefined).join("\n");
  }
  return [summaryBlock ? summaryBlock : undefined, summaryBlock ? "" : undefined, "✅ Beres!", "", `files changed: ${o.filesChanged.length}`, o.filesChanged.length ? o.filesChanged.slice(0, 15).map((f) => `- ${f}`).join("\n") : undefined, o.verification ? "" : undefined, o.verification, "", metaPlain].filter((l) => l !== undefined).join("\n");
}

export function renderFinalSummaryHtml(o: { filesChanged: string[]; testsPassed?: number; durationMs: number; tokens: number; model: string; verification?: string; summary?: string }): string {
  const mins = Math.floor(o.durationMs / 60000);
  const secs = Math.floor((o.durationMs % 60000) / 1000);
  const rawSummary = o.summary?.trim() ? o.summary.trim().slice(0, 8000) : undefined;
  const summaryHtml = rawSummary ? wrapBlockquoteIfNeeded(mdToHtml(rawSummary)) : undefined;
  // Keren: cukup time + tokens, bungkus blockquote (model tidak ditampilkan di chat sesuai request)
  const meta = `<blockquote>⏱ <i>${mins}m ${secs}s</i>  •  🔢 <i>${(o.tokens / 1000).toFixed(1)}k tokens</i></blockquote>`;
  const verificationHtml = o.verification ? mdToHtml(o.verification) : undefined;
  if (summaryHtml && o.filesChanged.length === 0) {
    return [summaryHtml, "", meta, verificationHtml ? "" : undefined, verificationHtml ? `<blockquote>${verificationHtml}</blockquote>` : undefined].filter((l) => l !== undefined).join("\n");
  }
  const filesHtml = o.filesChanged.length ? o.filesChanged.slice(0, 15).map((f) => `• <code>${f.replace(/</g, "&lt;")}</code>`).join("\n") : undefined;
  return [
    summaryHtml ? summaryHtml : undefined,
    summaryHtml ? "" : undefined,
    "<b>✅ Beres!</b>",
    "",
    `<i>ubah:</i> ${o.filesChanged.length} file`,
    filesHtml ? filesHtml : undefined,
    verificationHtml ? "" : undefined,
    verificationHtml ? `<blockquote>${verificationHtml}</blockquote>` : undefined,
    "",
    meta,
  ].filter((l) => l !== undefined).join("\n");
}

export function renderFailureHtml(o: { attempted: string[]; lastError: string; remains: string }): string {
  return [
    "<b>⚠️ task incomplete</b>",
    "",
    "<b>what happened:</b>",
    `<blockquote>${mdToHtml(o.lastError.slice(0, 1500))}</blockquote>`,
    "",
    "<b>what was attempted:</b>",
    ...o.attempted.slice(-8).map((a) => `• <code>${a.slice(0, 200).replace(/</g, "&lt;")}</code>`),
    "",
    "<b>what remains:</b>",
    `<blockquote>${mdToHtml(o.remains.slice(0, 1000))}</blockquote>`,
  ].join("\n");
}

export function splitFinalHtml(html: string): string[] { return splitHtml(html, 3800); }

export function renderFailure(o: { attempted: string[]; lastError: string; remains: string }): string {
  return [
    "⚠️ Belum beres",
    "",
    "kenapa:",
    o.lastError.slice(0, 1000),
    "",
    "udah dicoba:",
    ...o.attempted.slice(-8).map((a) => `- ${a.slice(0, 200)}`),
    "",
    "sisa:",
    o.remains.slice(0, 1000),
  ].join("\n");
}
