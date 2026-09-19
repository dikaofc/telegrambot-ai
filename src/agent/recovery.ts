import { store } from "../database/store.js";
import { getDb } from "../database/db.js";
import { getLogger } from "../observability/logger.js";

/** Crash recovery: mark interrupted runs, restore sessions to a safe state. */
export function recoverInterruptedRuns(): Array<{ runId: string; sessionId: string }> {
  const log = getLogger();
  try {
    const rows = getDb().prepare("SELECT id, session_id FROM agent_runs WHERE status = 'running'").all() as Array<{ id: string; session_id: string }>;
    for (const r of rows) {
      store.finishRun(r.id, "interrupted", 0, 0);
      log.warn({ event: "run.recovered", runId: r.id }, "marked interrupted run after restart");
    }
    return rows.map((r) => ({ runId: r.id, sessionId: r.session_id }));
  } catch (e) {
    log.error({ event: "recovery.failed", err: String(e) }, "recovery failed");
    return [];
  }
}

export function recoveryMessage(sessionInfo: { workspace?: string; lastState?: string }): string {
  return [
    "server restarted.",
    "",
    "restoring session...",
    sessionInfo.workspace ? `workspace: ${sessionInfo.workspace}` : undefined,
    sessionInfo.lastState ? `last state: ${sessionInfo.lastState}` : undefined,
    "",
    "Interrupted tools were NOT re-executed automatically (destructive commands are never replayed after a crash). Send a message to resume.",
  ].filter(Boolean).join("\n");
}
