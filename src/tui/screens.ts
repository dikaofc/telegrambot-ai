import { store } from "../database/store.js";
import { checkHealth } from "../observability/health.js";
import { renderPrometheus } from "../observability/metrics.js";
import { listWorkspaces, resolveWorkspacePath, detectProjectProfile } from "../workspace/manager.js";
import { availableProviders, createProvider } from "../providers/factory.js";
import { activeRunCount, sessionRunId } from "../agent/orchestrator.js";
import { stopRun } from "../agent/orchestrator.js";
import { graphStatus } from "../integrations/graphify.js";

/** Pure text-table renderer (testable, no I/O). */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string => cells.map((c, i) => (c ?? "").padEnd(widths[i] as number)).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  return [line(headers), sep, ...rows.map(line)].join("\n");
}

export function truncateCell(s: string, n: number): string {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export async function statusText(): Promise<string> {
  const h = await checkHealth();
  const c = store.counts();
  const lines = [
    "TELEAGENT status",
    `  overall : ${h.status}`,
    `  telegram: ${h.telegram ? "ok" : "MISSING TOKEN"}  database: ${h.database ? "ok" : "FAIL"}  workspace: ${h.workspace ? "ok" : "FAIL"}  pty: ${h.pty ? "ok" : "FAIL"}  sandbox: ${h.sandbox ? "on" : "off"}  provider: ${h.provider ? "ok" : "unverified"}`,
    `  sessions: ${c.sessions}  runs: ${c.runs} (active: ${activeRunCount()})  tool calls: ${c.toolCalls}`,
    `  pending approvals: ${c.pendingApprovals}  workspaces: ${c.workspaces}  users: ${c.users}`,
  ];
  return lines.join("\n");
}

export function sessionsText(limit = 20): string {
  const rows = (store.listSessions(limit) as Array<Record<string, string>>).map((s) => [
    String(s.id).slice(0, 8), String(s.chat_id).slice(0, 8), `${s.provider}/${s.model}`, String(s.status), String(s.updated_at ?? ""),
  ]);
  if (rows.length === 0) return "(no sessions yet)";
  return formatTable(["id", "chat", "provider/model", "status", "updated"], rows);
}

export function runsText(sessionId?: string, limit = 20): string {
  const rows = (store.listRuns(sessionId, limit) as Array<Record<string, string | number>>).map((r) => [
    String(r.id).slice(0, 8), String(r.session_id).slice(0, 8), truncateCell(String(r.input), 50), String(r.status), `${r.tokens_input ?? 0}+${r.tokens_output ?? 0}`,
  ]);
  if (rows.length === 0) return "(no runs yet)";
  return formatTable(["id", "session", "input", "status", "tokens"], rows);
}

export function approvalsText(): string {
  const rows = (store.pendingApprovals() as Array<Record<string, string>>).map((a) => [
    String(a.id).slice(0, 8), String(a.tool), truncateCell(String(a.command), 60), String(a.risk),
  ]);
  if (rows.length === 0) return "(no pending approvals)";
  return formatTable(["id", "tool", "command", "risk"], rows);
}

export function usageText(userId?: string): string {
  const u = store.usageTotals(userId);
  const head = `runs=${u.total.runs} tokens_in=${u.total.t_in} tokens_out=${u.total.t_out} cost_usd=${Number(u.total.cost).toFixed(4)}`;
  const rows = u.perModel.map((m) => [m.provider, m.model, String(m.runs), String(m.t_in + m.t_out), `$${Number(m.cost).toFixed(4)}`]);
  return head + (rows.length ? "\n" + formatTable(["provider", "model", "runs", "tokens", "cost"], rows) : "\n(no usage recorded)");
}

export function auditText(limit = 20): string {
  const rows = (store.auditList(limit) as Array<Record<string, string | number>>).map((l) => [
    String(l.created_at ?? ""), String(l.tool ?? ""), String(l.risk ?? ""), String(l.approval ?? ""), String(l.exit_code ?? ""), String(l.duration_ms ?? ""),
  ]);
  if (rows.length === 0) return "(audit log empty)";
  return formatTable(["time", "tool", "risk", "approval", "exit", "ms"], rows);
}

export function workspacesText(): string {
  const names = listWorkspaces();
  if (names.length === 0) return "(no workspaces — they are created on first use)";
  const rows = names.map((n) => {
    const p = resolveWorkspacePath(n);
    let prof = "";
    try {
      const d = detectProjectProfile(p);
      prof = [d.language, d.framework, d.packageManager].filter(Boolean).join("/");
    } catch { /* noop */ }
    return [n, p, prof];
  });
  return formatTable(["name", "path", "profile"], rows);
}

export async function providersText(): Promise<string> {
  const out: string[] = [];
  for (const n of availableProviders()) {
    try {
      const p = createProvider(n);
      const healthy = await p.health().catch(() => false);
      out.push(`${n}: ${healthy ? "ok" : "DOWN"}`);
    } catch { out.push(`${n}: DOWN`); }
  }
  return out.join("\n");
}

export function settingsText(): string {
  const rows = store.listSettings().map((s) => [s.key, `${s.scope}/${s.scope_id.slice(0, 8)}`, truncateCell(s.value, 60)]);
  if (rows.length === 0) return "(no custom settings)";
  return formatTable(["key", "scope", "value"], rows);
}

export function metricsText(): string {
  return renderPrometheus();
}

export async function graphifyText(workspace: string): Promise<string> {
  let wsPath: string;
  try { wsPath = resolveWorkspacePath(workspace); }
  catch (e) { return `invalid workspace: ${String(e)}`; }
  const s = await graphStatus(wsPath);
  return JSON.stringify(s, null, 2);
}

export async function stopRunById(runId: string): Promise<string> {
  return (await stopRun(runId)) ? `stop signal sent to ${runId}` : `no active run ${runId}`;
}

export function runIdForSession(sessionId: string): string {
  return sessionRunId(sessionId) ?? "(none active)";
}
