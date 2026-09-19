import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-apidb-")) + "/api.db";
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-apiws-"));
process.env.TELEAGENT_API_KEY = "";

import { buildApiServer } from "../src/api/server.js";
import { isAuthorized } from "../src/security/access.js";
import { checkMessageRate, checkRunRate, checkTokenQuota, resetRateState } from "../src/security/rate-limit.js";
import { execSandboxed } from "../src/sandbox/manager.js";
import { httpGet } from "../src/tools/http.js";
import { createCheckpoint } from "../src/agent/checkpoint.js";
import { store } from "../src/database/store.js";
import { openDatabase } from "../src/database/db.js";

describe("api internal", () => {
  it("health/ready/metrics/providers/sessions", async () => {
    openDatabase(process.env.DATABASE_URL);
    const app = await buildApiServer();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).status).toBeDefined();
    const metricsRes = await app.inject({ method: "GET", url: "/metrics" });
    expect(metricsRes.body).toContain("agent_runs_total");
    const prov = await app.inject({ method: "GET", url: "/v1/providers" });
    expect(JSON.parse(prov.body).providers.length).toBeGreaterThan(0);
    const sess = await app.inject({ method: "POST", url: "/v1/sessions", payload: { userId: "u1", chatId: "c1" } });
    expect(sess.statusCode).toBe(200);
    const id = JSON.parse(sess.body).id as string;
    const got = await app.inject({ method: "GET", url: `/v1/sessions/${id}` });
    expect(got.statusCode).toBe(200);
    await app.close();
  }, 30000);
});

describe("access + rate limiting", () => {
  it("owner mode + allowlist", () => {
    process.env.BOT_ACCESS_MODE = "owner";
    process.env.OWNER_IDS = "123";
    expect(isAuthorized(123).ok).toBe(true);
    expect(isAuthorized(999).ok).toBe(false);
    process.env.BOT_ACCESS_MODE = "public";
    expect(isAuthorized(999).ok).toBe(true);
    process.env.BOT_ACCESS_MODE = "owner";
  });
  it("rate limits + quota", () => {
    resetRateState();
    process.env.RATE_LIMIT_MESSAGES = "2";
    expect(checkMessageRate("rl-u")).toBe(true);
    expect(checkMessageRate("rl-u")).toBe(true);
    expect(checkMessageRate("rl-u")).toBe(false);
    process.env.RATE_LIMIT_MESSAGES = "30";
    expect(checkRunRate("rl-u2")).toBe(true);
    const q = checkTokenQuota("fresh-user-no-usage");
    expect(q.ok).toBe(true);
  });
});

describe("sandbox + network + checkpoint", () => {
  it("sandbox executes real command", async () => {
    const r = await execSandboxed("echo sandbox-ok", process.env.WORKSPACE_ROOT as string);
    expect(r.success).toBe(true);
    expect(r.output).toContain("sandbox-ok");
  }, 30000);
  it("http tool blocks SSRF", async () => {
    const r = await httpGet("http://127.0.0.1/blocked");
    expect(r.success).toBe(false);
  });
  it("checkpoint records git state", async () => {
    openDatabase(process.env.DATABASE_URL);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-ckpt-"));
    const { execCommand } = await import("../src/tools/shell.js");
    await execCommand("git init -q && git config user.email t@t.t && git config user.name t && git commit -qm init --allow-empty", { cwd: dir, timeoutMs: 30000 });
    const uid = store.upsertUser("ck-u", "x");
    const chat = store.ensureChat(uid, "ck-c");
    const ws = store.ensureWorkspace("ck", dir, uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: ws, provider: "p", model: "m" });
    const run = store.createRun(sid, "big change");
    const id = await createCheckpoint(run, ws, dir);
    expect(id.length).toBeGreaterThan(5);
  }, 30000);
});
