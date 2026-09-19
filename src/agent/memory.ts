import { store } from "../database/store.js";

/** Two-level memory: session memory + workspace memory. Secrets are never stored. */
export function rememberSession(sessionId: string, key: string, value: string): void {
  if (/secret|token|api[_-]?key|password|private/i.test(key + value)) throw new Error("refusing to store secret in memory");
  store.setMemory("session", sessionId, key, value.slice(0, 4000));
}

export function rememberWorkspace(workspaceId: string, key: string, value: string): void {
  if (/secret|token|api[_-]?key|password|private/i.test(key + value)) throw new Error("refusing to store secret in memory");
  store.setMemory("workspace", workspaceId, key, value.slice(0, 4000));
}

export function recallSession(sessionId: string): Record<string, string> {
  return store.getMemory("session", sessionId);
}

export function recallWorkspace(workspaceId: string): Record<string, string> {
  return store.getMemory("workspace", workspaceId);
}
