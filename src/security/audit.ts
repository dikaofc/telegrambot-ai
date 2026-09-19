import { createHash } from "node:crypto";
import { store } from "../database/store.js";
import { redactSecrets } from "./secrets.js";
import { getLogger } from "../observability/logger.js";

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args ?? null)).digest("hex").slice(0, 16);
}

export function auditTool(o: {
  userId?: string; chatId?: string; sessionId?: string; tool: string;
  args: unknown; risk: string; approval?: string; result?: string;
  exitCode?: number; durationMs?: number;
}): void {
  const log = getLogger();
  const argsHash = hashArgs(o.args);
  const redacted = redactSecrets(o.result ?? "").slice(0, 2000);
  store.audit({
    userId: o.userId, chatId: o.chatId, sessionId: o.sessionId,
    tool: o.tool, argsHash, risk: o.risk, approval: o.approval,
    result: redacted.slice(0, 500), exitCode: o.exitCode, durationMs: o.durationMs,
  });
  log.info({ event: "tool.completed", tool: o.tool, duration: o.durationMs, exitCode: o.exitCode }, "tool completed");
}
