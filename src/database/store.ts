import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "./db.js";
import { getDb } from "./db.js";

function one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export const store = {
  upsertUser(telegramId: string, username?: string): string {
    const existing = one<{ id: string }>("SELECT id FROM users WHERE telegram_id = ?", telegramId);
    if (existing) return existing.id;
    const id = randomUUID();
    getDb().prepare("INSERT INTO users(id, telegram_id, username) VALUES(?,?,?)").run(id, telegramId, username ?? null);
    return id;
  },
  ensureChat(userId: string, chatId: string): string {
    const existing = one<{ id: string }>("SELECT id FROM chats WHERE user_id = ? AND telegram_chat_id = ?", userId, chatId);
    if (existing) return existing.id;
    const id = randomUUID();
    getDb().prepare("INSERT INTO chats(id, user_id, telegram_chat_id) VALUES(?,?,?)").run(id, userId, chatId);
    return id;
  },
  ensureWorkspace(name: string, wsPath: string, userId?: string): string {
    const existing = one<{ id: string }>("SELECT id FROM workspaces WHERE path = ?", wsPath);
    if (existing) return existing.id;
    const id = randomUUID();
    getDb().prepare("INSERT INTO workspaces(id, name, path, user_id) VALUES(?,?,?,?)").run(id, name, wsPath, userId ?? null);
    return id;
  },
  createSession(s: { userId: string; chatId: string; workspaceId: string; provider: string; model: string; runtime?: string }): string {
    const id = randomUUID();
    getDb().prepare(
      "INSERT INTO sessions(id, user_id, chat_id, workspace_id, provider, model, runtime, status) VALUES(?,?,?,?,?,?,?,?)",
    ).run(id, s.userId, s.chatId, s.workspaceId, s.provider, s.model, s.runtime ?? "native", "idle");
    return id;
  },
  getSession(id: string) {
    return one("SELECT * FROM sessions WHERE id = ?", id);
  },
  latestSessionForChat(chatDbId: string) {
    return one("SELECT * FROM sessions WHERE chat_id = ? ORDER BY updated_at DESC LIMIT 1", chatDbId);
  },
  updateSession(id: string, patch: Record<string, string>) {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = ?`).join(", ");
    getDb().prepare(`UPDATE sessions SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
  },
  addMessage(sessionId: string, role: string, content: string): string {
    const id = randomUUID();
    getDb().prepare("INSERT INTO messages(id, session_id, role, content) VALUES(?,?,?,?)").run(id, sessionId, role, content);
    return id;
  },
  messages(sessionId: string, limit = 100) {
    return all<{ role: string; content: string; created_at: string }>(
      "SELECT role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?", sessionId, limit,
    );
  },
  createRun(sessionId: string, input: string): string {
    const id = randomUUID();
    getDb().prepare("INSERT INTO agent_runs(id, session_id, input, status) VALUES(?,?,?,?)").run(id, sessionId, input, "running");
    return id;
  },
  finishRun(id: string, status: string, tIn = 0, tOut = 0) {
    getDb().prepare("UPDATE agent_runs SET status = ?, finished_at = datetime('now'), tokens_input = ?, tokens_output = ? WHERE id = ?").run(status, tIn, tOut, id);
  },
  activeRunForSession(sessionId: string) {
    return one<{ id: string }>("SELECT id FROM agent_runs WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1", sessionId);
  },
  logTool(runId: string, tool: string, argsHash: string, risk: string, o: { approval?: string; success?: boolean; exitCode?: number; durationMs?: number } = {}) {
    const id = randomUUID();
    getDb().prepare(
      "INSERT INTO tool_calls(id, run_id, tool, args_hash, risk, approval, success, exit_code, duration_ms) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(id, runId, tool, argsHash, risk, o.approval ?? null, o.success === undefined ? null : o.success ? 1 : 0, o.exitCode ?? null, o.durationMs ?? null);
    return id;
  },
  createApproval(runId: string, tool: string, command: string, risk: string): string {
    const id = randomUUID();
    getDb().prepare("INSERT INTO approvals(id, run_id, tool, command, risk, status) VALUES(?,?,?,?,?,?)").run(id, runId, tool, command, risk, "pending");
    return id;
  },
  resolveApproval(id: string, status: string) {
    getDb().prepare("UPDATE approvals SET status = ? WHERE id = ?").run(status, id);
  },
  getApproval(id: string) {
    return one<{ id: string; run_id: string; tool: string; command: string; risk: string; status: string }>("SELECT * FROM approvals WHERE id = ?", id);
  },
  resolveApprovalPrefix(prefix: string, status: string): string | null {
    const rows = all<{ id: string }>("SELECT id FROM approvals WHERE id LIKE ? AND status = 'pending' LIMIT 2", (`${prefix}%`) as SQLInputValue);
    if (rows.length !== 1) return null;
    const id = rows[0]?.id as string;
    getDb().prepare("UPDATE approvals SET status = ? WHERE id = ?").run(status as SQLInputValue, id as SQLInputValue);
    return id;
  },
  audit(e: { userId?: string; chatId?: string; sessionId?: string; tool?: string; argsHash?: string; risk?: string; approval?: string; result?: string; exitCode?: number; durationMs?: number }) {
    const id = randomUUID();
    getDb().prepare(
      "INSERT INTO audit_logs(id, user_id, chat_id, session_id, tool, args_hash, risk, approval, result, exit_code, duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(id, e.userId ?? null, e.chatId ?? null, e.sessionId ?? null, e.tool ?? null, e.argsHash ?? null, e.risk ?? null, e.approval ?? null, e.result ?? null, e.exitCode ?? null, e.durationMs ?? null);
  },
  markUpdate(updateId: string): boolean {
    try {
      getDb().prepare("INSERT INTO processed_updates(update_id) VALUES(?)").run(String(updateId));
      return true;
    } catch { return false; }
  },
  wasProcessed(updateId: string): boolean {
    return Boolean(one("SELECT update_id FROM processed_updates WHERE update_id = ?", String(updateId)));
  },
  setSetting(key: string, value: string, scope = "global", scopeId = "") {
    getDb().prepare("INSERT INTO settings(key, scope, scope_id, value) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, scope=excluded.scope, scope_id=excluded.scope_id").run(key, scope, scopeId, value);
  },
  getSetting(key: string): string | undefined {
    const r = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return r?.value;
  },
  addUsage(userId: string, runId: string, provider: string, model: string, tIn: number, tOut: number, cost = 0) {
    const id = randomUUID();
    getDb().prepare("INSERT INTO usage(id, user_id, run_id, provider, model, tokens_input, tokens_output, cost_usd) VALUES(?,?,?,?,?,?,?,?)").run(id, userId, runId, provider, model, tIn, tOut, cost);
  },
  dailyTokens(userId: string): number {
    const r = one<{ t: number }>("SELECT COALESCE(SUM(tokens_input + tokens_output),0) AS t FROM usage WHERE user_id = ? AND created_at >= datetime('now','-1 day')", userId);
    return r?.t ?? 0;
  },
  saveCheckpoint(runId: string, workspaceId: string, gitCommit: string | null, files: string[]): string {
    const id = randomUUID();
    getDb().prepare("INSERT INTO checkpoints(id, run_id, workspace_id, git_commit, files_json) VALUES(?,?,?,?,?)").run(id, runId, workspaceId, gitCommit, JSON.stringify(files));
    return id;
  },
  setMemory(scope: string, scopeId: string, key: string, value: string) {
    getDb().prepare("INSERT INTO memory(id, scope, scope_id, key, value) VALUES(?,?,?, ?,?) ON CONFLICT(scope, scope_id, key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')").run(randomUUID(), scope, scopeId, key, value);
  },
  getMemory(scope: string, scopeId: string): Record<string, string> {
    const rows = all<{ key: string; value: string }>("SELECT key, value FROM memory WHERE scope = ? AND scope_id = ?", scope, scopeId);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  // ---- dashboard / TUI queries ----
  listSessions(limit = 50) {
    return all("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", limit as SQLInputValue);
  },
  listRuns(sessionId?: string, limit = 50) {
    if (sessionId) return all("SELECT * FROM agent_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?", sessionId as SQLInputValue, limit as SQLInputValue);
    return all("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?", limit as SQLInputValue);
  },
  pendingApprovals(limit = 50) {
    return all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?", limit as SQLInputValue);
  },
  usageTotals(userId?: string) {
    const where = userId ? "WHERE user_id = ?" : "";
    const args = userId ? [userId as SQLInputValue] : [];
    const total = one<{ runs: number; t_in: number; t_out: number; cost: number }>(
      `SELECT COUNT(*) AS runs, COALESCE(SUM(tokens_input),0) AS t_in, COALESCE(SUM(tokens_output),0) AS t_out, COALESCE(SUM(cost_usd),0) AS cost FROM usage ${where}`, ...args,
    );
    const perModel = all<{ provider: string; model: string; runs: number; t_in: number; t_out: number; cost: number }>(
      `SELECT provider, model, COUNT(*) AS runs, COALESCE(SUM(tokens_input),0) AS t_in, COALESCE(SUM(tokens_output),0) AS t_out, COALESCE(SUM(cost_usd),0) AS cost FROM usage ${where} GROUP BY provider, model ORDER BY cost DESC`, ...args,
    );
    return { total: total ?? { runs: 0, t_in: 0, t_out: 0, cost: 0 }, perModel };
  },
  auditList(limit = 100) {
    return all("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?", limit as SQLInputValue);
  },
  listSettings() {
    return all<{ key: string; scope: string; scope_id: string; value: string }>("SELECT key, scope, scope_id, value FROM settings ORDER BY key ASC");
  },
  getWorkspaceById(id: string) {
    return one("SELECT * FROM workspaces WHERE id = ?", id as SQLInputValue);
  },
  latestCheckpoint(workspaceId: string) {
    return one<{ id: string; run_id: string; git_commit: string | null; files_json: string; created_at: string }>(
      "SELECT * FROM checkpoints WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1", workspaceId as SQLInputValue,
    );
  },
  toolCallsForRun(runId: string, limit = 30) {
    return all<{ tool: string; risk: string; approval: string | null; success: number | null; exit_code: number | null; duration_ms: number | null; created_at: string }>(
      "SELECT tool, risk, approval, success, exit_code, duration_ms, created_at FROM tool_calls WHERE run_id = ? ORDER BY created_at ASC LIMIT ?", runId as SQLInputValue, limit as SQLInputValue,
    );
  },
  lastUserMessage(sessionId: string): string | null {
    const r = one<{ content: string }>("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1", sessionId as SQLInputValue);
    return r?.content ?? null;
  },
  getRun(id: string) {
    return one<{ id: string; session_id: string; input: string; status: string; started_at: string; finished_at: string | null; tokens_input: number; tokens_output: number }>(
      "SELECT * FROM agent_runs WHERE id = ?", id as SQLInputValue,
    );
  },
  lastRunForSession(sessionId: string) {
    return one<{ id: string; input: string; status: string; started_at: string; finished_at: string | null }>(
      "SELECT * FROM agent_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1", sessionId as SQLInputValue,
    );
  },
  counts() {
    const c = (t: string): number => (one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)?.n ?? 0);
    return {
      users: c("users"), sessions: c("sessions"), runs: c("agent_runs"),
      running: (one<{ n: number }>("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'")?.n ?? 0),
      toolCalls: c("tool_calls"), approvals: c("approvals"),
      pendingApprovals: (one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0),
      workspaces: c("workspaces"),
    };
  },
};

export type Store = typeof store;
