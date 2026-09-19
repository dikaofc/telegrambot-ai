import { randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import { resolveWorkspacePath, detectProjectProfile } from "../workspace/manager.js";
import { store } from "../database/store.js";
import { createRuntime } from "../runtime/factory.js";
import { checkMessageRate, checkRunRate, checkTokenQuota } from "../security/rate-limit.js";
import { getLogger } from "../observability/logger.js";
import type { AgentEvent } from "../runtime/types.js";

export interface RunHandle {
  runId: string;
  sessionId: string;
  events: AsyncIterable<AgentEvent>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
}

const activeRuns = new Map<string, { stop: () => Promise<void>; pause: () => Promise<void>; resume: () => Promise<void> }>();
const sessionLocks = new Map<string, string>(); // sessionId -> runId

export function activeRunCount(): number { return activeRuns.size; }

export async function startRun(o: {
  userId: string; chatDbId: string; sessionId: string; workspacePath: string;
  provider: string; model: string; input: string;
}): Promise<RunHandle> {
  const env = getEnv();
  const log = getLogger();
  if (!checkMessageRate(o.userId)) throw new Error("rate limited: too many messages/minute");
  if (!checkRunRate(o.userId)) throw new Error("rate limited: too many runs/hour");
  const quota = checkTokenQuota(o.userId);
  if (!quota.ok) throw new Error(`daily token quota exceeded (${quota.used}/${quota.limit})`);
  if (activeRuns.size >= env.MAX_CONCURRENT_RUNS) throw new Error("server busy: too many concurrent runs");
  if (sessionLocks.has(o.sessionId)) {
    // one active run per chat: treat new message as control/update, queue after current
    throw new Error("a run is already active in this chat — it will see your message; use Stop to cancel it first");
  }
  const wsPath = resolveWorkspacePath(o.workspacePath);
  store.updateSession(o.sessionId, { status: "running", provider: o.provider, model: o.model });
  const runId = store.createRun(o.sessionId, o.input);
  store.addMessage(o.sessionId, "user", o.input);
  store.setMemory("workspace", o.sessionId, "last_input", o.input.slice(0, 1000));
  try {
    const profile = detectProjectProfile(wsPath);
    for (const [k, v] of Object.entries(profile)) if (v) store.setMemory("workspace", wsPath, k, String(v));
  } catch { /* non-fatal */ }

  const runtime = await createRuntime("native", {
    sessionId: o.sessionId, runId, workspacePath: wsPath,
    provider: o.provider, model: o.model, userId: o.userId,
  });
  sessionLocks.set(o.sessionId, runId);
  const entry = { stop: () => runtime.interrupt(), pause: () => runtime.pause(), resume: () => runtime.resume() };
  activeRuns.set(runId, entry);

  async function* wrap(): AsyncIterable<AgentEvent> {
    try {
      for await (const ev of runtime.run(o.input)) {
        if (ev.type === "completed" && ev.summary) store.addMessage(o.sessionId, "assistant", ev.summary.slice(0, 8000));
        yield ev;
      }
    } finally {
      activeRuns.delete(runId);
      sessionLocks.delete(o.sessionId);
      try { store.updateSession(o.sessionId, { status: "idle" }); } catch (e) { log.warn({ err: String(e) }, "session unlock update failed"); }
    }
  }

  return {
    runId, sessionId: o.sessionId, events: wrap(),
    stop: async () => { await runtime.interrupt(); },
    pause: async () => { await runtime.pause(); },
    resume: async () => { await runtime.resume(); },
  };
}

export async function stopRun(runId: string): Promise<boolean> {
  const r = activeRuns.get(runId);
  if (!r) return false;
  await r.stop();
  return true;
}

export async function pauseRun(runId: string): Promise<boolean> {
  const r = activeRuns.get(runId);
  if (!r) return false;
  await r.pause();
  return true;
}

export async function resumeRun(runId: string): Promise<boolean> {
  const r = activeRuns.get(runId);
  if (!r) return false;
  await r.resume();
  return true;
}

export function ensureSession(userId: string, chatDbId: string, workspaceName: string, provider: string, model: string): string {
  const wsPath = resolveWorkspacePath(workspaceName || "default");
  const wsId = store.ensureWorkspace(workspaceName || "default", wsPath, userId);
  const latest = store.latestSessionForChat(chatDbId) as { id: string } | undefined;
  if (latest) {
    store.updateSession(latest.id, { workspace_id: wsId, provider, model });
    return latest.id;
  }
  return store.createSession({ userId, chatId: chatDbId, workspaceId: wsId, provider, model });
}

export function interpretControlMessage(text: string): "stop" | "pause" | "resume" | null {
  const t = text.trim().toLowerCase();
  if (/^(stop|berhenti|cancel|batal|hentikan)(\.|!)?$/.test(t)) return "stop";
  if (/^(pause|jeda|tunggu)$/.test(t)) return "pause";
  if (/^(resume|lanjut|lanjutkan)$/.test(t)) return "resume";
  return null;
}

export function sessionRunId(sessionId: string): string | undefined {
  return sessionLocks.get(sessionId) ?? undefined;
}

export function runIdForLookup(runId: string): boolean { return activeRuns.has(runId); }
void randomUUID;
