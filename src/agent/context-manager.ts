import { store } from "../database/store.js";
import { redactSecrets } from "../security/secrets.js";

export interface BuiltContext {
  history: Array<{ role: string; content: string }>;
  summary: string | null;
  workspaceMemory: Record<string, string>;
  sessionMemory: Record<string, string>;
}

/** Context manager: short-term history + session summary + workspace memory. */
export async function buildContext(sessionId: string, workspaceId: string, maxMessages = 20): Promise<BuiltContext> {
  const msgs = store.messages(sessionId, 100);
  const history = msgs.slice(-maxMessages).map((m) => ({ role: m.role, content: redactSecrets(m.content).slice(0, 3000) }));
  const sessionMemory = store.getMemory("session", sessionId);
  const workspaceMemory = store.getMemory("workspace", workspaceId);
  const summary = (store.getMemory("session", sessionId).summary as string | undefined) ?? null;
  return { history, summary, workspaceMemory, sessionMemory };
}

export async function compactSession(sessionId: string): Promise<void> {
  const msgs = store.messages(sessionId, 200);
  if (msgs.length < 60) return;
  const first = msgs.slice(0, msgs.length - 20);
  const summary = `Earlier work (${first.length} messages): ` + first.map((m) => `${m.role}: ${m.content.slice(0, 200)}`).join(" | ").slice(0, 3000);
  const prev = store.getMemory("session", sessionId).summary;
  store.setMemory("session", sessionId, "summary", prev ? `${prev}\n${summary}`.slice(0, 6000) : summary);
}
