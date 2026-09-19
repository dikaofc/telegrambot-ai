import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tele-hardws-"));
process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-harddb-")) + "/h.db";
process.env.WORKSPACE_ROOT = wsRoot;
process.env.TELEAGENT_API_KEY = "";

import { resolveWorkspacePath, workspaceRoot, assertInsideWorkspace } from "../src/workspace/manager.js";
import { setWebhookHandler, webhookHandlerReady, dispatchWebhookUpdate } from "../src/telegram/webhook-bus.js";
import { buildApiServer } from "../src/api/server.js";
import { store } from "../src/database/store.js";
import { openDatabase } from "../src/database/db.js";
import { loadEnv } from "../src/config/env.js";

beforeEach(() => { openDatabase(process.env.DATABASE_URL); });

describe("workspace boundary", () => {
  it("resolves plain names inside the root", () => {
    const p = resolveWorkspacePath("my-project");
    expect(p).toBe(path.join(workspaceRoot(), "my-project"));
    expect(fs.existsSync(p)).toBe(true);
  });

  it("accepts absolute paths that stay inside the root", () => {
    const inside = path.join(workspaceRoot(), "explicit");
    expect(resolveWorkspacePath(inside)).toBe(inside);
  });

  it("rejects traversal out of the root", () => {
    expect(() => resolveWorkspacePath("../escape")).toThrow(/escape denied/);
    expect(() => resolveWorkspacePath("../../etc")).toThrow(/escape denied/);
    expect(() => resolveWorkspacePath("a/../../b")).toThrow(/escape denied/);
    expect(() => resolveWorkspacePath("/etc")).toThrow(/escape denied/);
    // nothing was created outside the root
    expect(fs.existsSync(path.resolve(workspaceRoot(), "../escape"))).toBe(false);
  });

  it("rejects empty names and keeps assertInsideWorkspace honest", () => {
    expect(() => resolveWorkspacePath("")).toThrow();
    expect(() => assertInsideWorkspace(wsRoot, "../../etc")).toThrow();
    expect(assertInsideWorkspace(wsRoot, "ok/file.txt")).toContain("ok");
  });
});

describe("telegram webhook wiring", () => {
  it("reports not-ready, then dispatches once a handler is registered", async () => {
    setWebhookHandler(null);
    expect(webhookHandlerReady()).toBe(false);
    expect(await dispatchWebhookUpdate({ update_id: 1 } as never)).toBe(false);

    const seen: number[] = [];
    setWebhookHandler(async (u) => { seen.push(u.update_id); });
    expect(webhookHandlerReady()).toBe(true);
    expect(await dispatchWebhookUpdate({ update_id: 42 } as never)).toBe(true);
    expect(seen).toEqual([42]);
    setWebhookHandler(null);
  });

  it("route returns 503 without a bot and 200 when the bot handles it", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "";
    setWebhookHandler(null);
    const app = await buildApiServer();

    const noBot = await app.inject({ method: "POST", url: "/telegram/webhook", payload: { update_id: 7 } });
    expect(noBot.statusCode).toBe(503);

    const malformed = await app.inject({ method: "POST", url: "/telegram/webhook", payload: { nope: true } });
    expect(malformed.statusCode).toBe(503); // still no handler — checked before body

    let handled = 0;
    setWebhookHandler(async () => { handled++; });
    const ok = await app.inject({ method: "POST", url: "/telegram/webhook", payload: { update_id: 7 } });
    expect(ok.statusCode).toBe(200);
    expect(handled).toBe(1);

    const badBody = await app.inject({ method: "POST", url: "/telegram/webhook", payload: { nope: true } });
    expect(badBody.statusCode).toBe(400);

    setWebhookHandler(null);
    await app.close();
  });

  it("rejects a wrong secret token", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "topsecret";
    setWebhookHandler(async () => undefined);
    const app = await buildApiServer();
    const r = await app.inject({
      method: "POST", url: "/telegram/webhook", payload: { update_id: 1 },
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
    });
    expect(r.statusCode).toBe(401);
    const good = await app.inject({
      method: "POST", url: "/telegram/webhook", payload: { update_id: 1 },
      headers: { "x-telegram-bot-api-secret-token": "topsecret" },
    });
    expect(good.statusCode).toBe(200);
    setWebhookHandler(null);
    process.env.TELEGRAM_WEBHOOK_SECRET = "";
    await app.close();
  });
});

describe("api auth + run lookup", () => {
  it("defaults the listen host to loopback", () => {
    const env = loadEnv({ ...process.env, HOST: undefined } as never);
    expect(env.HOST).toBe("127.0.0.1");
  });

  it("allows loopback without a key but refuses remote callers", async () => {
    process.env.TELEAGENT_API_KEY = "";
    const app = await buildApiServer();

    const local = await app.inject({ method: "GET", url: "/api/audit" });
    expect(local.statusCode).toBe(200);

    const remote = await app.inject({ method: "GET", url: "/api/audit", remoteAddress: "203.0.113.9" });
    expect(remote.statusCode).toBe(401);

    const remoteMutation = await app.inject({
      method: "POST", url: "/api/settings", payload: { key: "model", value: "x" }, remoteAddress: "203.0.113.9",
    });
    expect(remoteMutation.statusCode).toBe(401);

    const remoteSession = await app.inject({ method: "POST", url: "/v1/sessions", payload: {}, remoteAddress: "203.0.113.9" });
    expect(remoteSession.statusCode).toBe(401);

    await app.close();
  });

  it("accepts a matching key from a remote caller and rejects a bad one", async () => {
    process.env.TELEAGENT_API_KEY = "sekret-key";
    const app = await buildApiServer();
    const bad = await app.inject({ method: "GET", url: "/api/audit", remoteAddress: "203.0.113.9", headers: { "x-api-key": "nope" } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: "GET", url: "/api/audit", remoteAddress: "203.0.113.9", headers: { "x-api-key": "sekret-key" } });
    expect(good.statusCode).toBe(200);
    await app.close();
    process.env.TELEAGENT_API_KEY = "";
  });

  it("rejects workspace escapes over HTTP with 400, not 500", async () => {
    const app = await buildApiServer();
    const r = await app.inject({ method: "POST", url: "/v1/workspaces", payload: { name: "../../pwned" } });
    expect(r.statusCode).toBe(400);
    const s = await app.inject({ method: "POST", url: "/v1/sessions", payload: { workspace: "/etc" } });
    expect(s.statusCode).toBe(400);
    await app.close();
  });

  it("returns the real run for /v1/runs/:id and 404 for unknown ids", async () => {
    const app = await buildApiServer();
    const uid = store.upsertUser("run-u", "u");
    const chat = store.ensureChat(uid, "run-c");
    const wsId = store.ensureWorkspace("run-ws", path.join(wsRoot, "run-ws"), uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: wsId, provider: "9router", model: "auto" });
    const runId = store.createRun(sid, "inspect the repo");

    const found = await app.inject({ method: "GET", url: `/v1/runs/${runId}` });
    expect(found.statusCode).toBe(200);
    const body = JSON.parse(found.body);
    expect(body.run.id).toBe(runId);
    expect(body.run.input).toBe("inspect the repo");
    expect(body.active).toBe(false);
    expect(Array.isArray(body.toolCalls)).toBe(true);

    const missing = await app.inject({ method: "GET", url: "/v1/runs/does-not-exist" });
    expect(missing.statusCode).toBe(404);

    const missingEvents = await app.inject({ method: "GET", url: "/v1/runs/does-not-exist/events" });
    expect(missingEvents.statusCode).toBe(404);

    await app.close();
  });

  it("/v1/sessions/:id/messages runs in the session's own workspace", async () => {
    const wsName = "bound-ws";
    const wsPath = resolveWorkspacePath(wsName);
    fs.writeFileSync(path.join(wsPath, "package.json"), JSON.stringify({ name: "bound", dependencies: { express: "1" } }));

    const app = await buildApiServer();
    const uid = store.upsertUser("bound-u", "u");
    const chat = store.ensureChat(uid, "bound-c");
    const wsId = store.ensureWorkspace(wsName, wsPath, uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: wsId, provider: "9router", model: "auto" });

    process.env.PROVIDER_BASE_URL = "http://127.0.0.1:1/v1"; // unreachable → fast deterministic failure
    const r = await app.inject({ method: "POST", url: `/v1/sessions/${sid}/messages`, payload: { input: "hello" } });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).runId).toBeTruthy();

    // The run records the workspace profile under the session's workspace path.
    // If the route had used a hardcoded "default", this key would never appear.
    let language: string | undefined;
    for (let i = 0; i < 100 && !language; i++) {
      language = store.getMemory("workspace", wsPath).language;
      if (!language) await new Promise((res) => setTimeout(res, 50));
    }
    expect(language).toBe("typescript");
    expect(store.getMemory("workspace", resolveWorkspacePath("default")).language).toBeUndefined();

    delete process.env.PROVIDER_BASE_URL;
    await app.close();
  }, 30000);
});
