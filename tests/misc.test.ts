import { describe, it, expect } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { resolveProvider, resolveModel, mergeScopes } from "../src/config/hierarchy.js";
import { planMultiAgent, AGENT_PROFILES } from "../src/agent/multi-agent.js";
import { registerPlugin, listPlugins } from "../src/plugins/types.js";
import { startRun, ensureSession, interpretControlMessage, activeRunCount } from "../src/agent/orchestrator.js";
import { recoverInterruptedRuns, recoveryMessage } from "../src/agent/recovery.js";
import { rememberSession, recallSession } from "../src/agent/memory.js";
import { compactSession, buildContext } from "../src/agent/context-manager.js";
import { store } from "../src/database/store.js";
import { openDatabase } from "../src/database/db.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-misc-")) + "/m.db";
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-miscws-"));

describe("config hierarchy", () => {
  it("env > file > provider > system + scope merge", () => {
    const env = loadEnv({ ...process.env, PROVIDER: "openai", DEFAULT_MODEL: "gpt-x" });
    expect(resolveProvider(env, { provider: "xai" })).toBe("openai");
    expect(resolveProvider({ ...env, PROVIDER: "" } as never, {})).toBeTruthy();
    expect(resolveModel(env, {}, "my-model")).toBe("my-model");
    const merged = mergeScopes({ global: { provider: "a" }, session: { provider: "b" }, user: { model: "m" } });
    expect(merged.provider).toBe("b");
    expect(merged.model).toBe("m");
  });
});

describe("multi-agent + plugins + profiles", () => {
  it("plans research→coding→testing→review", () => {
    const plans = planMultiAgent("review project ini dan perbaiki semua issue yang ditemukan");
    expect(plans.map((p) => p.role)).toContain("coding");
    expect(plans.map((p) => p.role)).toContain("review");
    expect(AGENT_PROFILES.coding.tools).toContain("shell");
  });
  it("plugins register without core changes", async () => {
    registerPlugin({ id: "t", name: "T", register: async () => undefined });
    expect(listPlugins().length).toBeGreaterThan(0);
  });
});

describe("orchestrator guards", () => {
  it("control messages + concurrency guard + recovery", async () => {
    openDatabase(process.env.DATABASE_URL);
    expect(interpretControlMessage("stop.")).toBe("stop");
    expect(interpretControlMessage("halo")).toBe(null);
    expect(activeRunCount()).toBe(0);
    const uid = store.upsertUser("oc-u", "x");
    const chat = store.ensureChat(uid, "oc-c");
    const sid = ensureSession(uid, chat, "default", "9router", "auto");
    // force unreachable provider → deterministic probe path still completes
    process.env.PROVIDER_BASE_URL = "http://127.0.0.1:1/v1";
    const h = await startRun({ userId: uid, chatDbId: chat, sessionId: sid, workspacePath: "guard-ws", provider: "9router", model: "auto", input: "list the workspace" });
    const events = [];
    for await (const e of h.events) events.push(e);
    expect(events.some((e) => e.type === "completed" || e.type === "error")).toBe(true);
    expect(recoveryMessage({ workspace: "w", lastState: "testing" })).toContain("server restarted");
    expect(recoverInterruptedRuns().length).toBe(0);
    delete process.env.PROVIDER_BASE_URL;
  }, 60000);
  it("memory + compaction", async () => {
    openDatabase(process.env.DATABASE_URL);
    const uid = store.upsertUser("mem-u", "x");
    const chat = store.ensureChat(uid, "mem-c");
    const sid = ensureSession(uid, chat, "default", "9router", "auto");
    rememberSession(sid, "preferred_pm", "pnpm");
    expect(recallSession(sid).preferred_pm).toBe("pnpm");
    await compactSession(sid);
    const ctx = await buildContext(sid, "ws1");
    expect(Array.isArray(ctx.history)).toBe(true);
  });
});
