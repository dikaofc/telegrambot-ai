import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-dashdb-")) + "/d.db";
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-dashws-"));
process.env.TELEAGENT_API_KEY = "";
process.env.BOT_ACCESS_MODE = "owner";
process.env.OWNER_IDS = "";

import { buildApiServer } from "../src/api/server.js";
import { openDatabase } from "../src/database/db.js";
import { store } from "../src/database/store.js";
import { dashboardPage, DASHBOARD_TABS, routeForTab } from "../src/dashboard/page.js";

describe("dashboard", () => {
  it("serves HTML shell with all tabs", () => {
    const html = dashboardPage();
    for (const tab of ["Status", "Sessions", "Runs", "Approvals", "Workspaces", "Providers", "Usage", "Audit", "Settings", "Graphify"]) {
      expect(html).toContain(tab);
    }
    expect(html).toContain("apiKey");
  });

  it("status + resource endpoints work end to end", async () => {
    openDatabase(process.env.DATABASE_URL);
    const app = await buildApiServer();

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["content-type"]).toContain("text/html");
    expect(root.body).toContain("TeleAgent");

    // every tab is addressable and identifies itself, so refresh/deep-link works
    for (const tab of DASHBOARD_TABS) {
      const r = await app.inject({ method: "GET", url: routeForTab(tab) });
      expect(r.statusCode, `${tab} route`).toBe(200);
      expect(r.headers["content-type"]).toContain("text/html");
      expect(r.body, `${tab} page`).toContain(`data-active-tab="${tab}"`);
    }

    // HTML navigations to unknown paths fall back to the shell; JSON stays honest
    const spa = await app.inject({ method: "GET", url: "/some/deep/link", headers: { accept: "text/html" } });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("data-active-tab=\"Status\"");
    const api404 = await app.inject({ method: "GET", url: "/api/nope", headers: { accept: "application/json" } });
    expect(api404.statusCode).toBe(404);
    expect(api404.headers["content-type"]).toContain("application/json");

    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(200);
    const sBody = JSON.parse(status.body);
    expect(sBody.counts).toBeDefined();
    expect(sBody.health).toBeDefined();

    // seed data
    const uid = store.upsertUser("dash-u", "d");
    const chat = store.ensureChat(uid, "dash-c");
    const wsId = store.ensureWorkspace("dash-ws", (process.env.WORKSPACE_ROOT as string) + "/dash-ws", uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: wsId, provider: "9router", model: "auto" });
    const run = store.createRun(sid, "do things");
    store.addUsage(uid, run, "9router", "auto", 100, 50, 0.002);
    const apId = store.createApproval(run, "shell", "git push", "HIGH");
    store.audit({ userId: uid, tool: "read_file", argsHash: "x", risk: "SAFE", result: "ok" });

    for (const url of ["/api/sessions", "/api/runs", "/api/approvals/pending", "/api/workspaces", "/api/usage", "/api/audit", "/api/settings", "/api/providers"]) {
      const r = await app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(200);
    }

    const mem = await app.inject({ method: "GET", url: "/api/memory?scope=session&scopeId=none" });
    expect(mem.statusCode).toBe(200);

    // settings roundtrip + secret refusal
    const setOk = await app.inject({ method: "POST", url: "/api/settings", payload: { key: "model", value: "auto", scope: "global" } });
    expect(setOk.statusCode).toBe(200);
    const setBad = await app.inject({ method: "POST", url: "/api/settings", payload: { key: "github_token", value: "x" } });
    expect(setBad.statusCode).toBe(403);

    // approval resolve via dashboard
    const resolve = await app.inject({ method: "POST", url: `/api/approvals/${apId}`, payload: { status: "approved" } });
    expect(resolve.statusCode).toBe(200);
    expect(store.getApproval(apId)?.status).toBe("approved");

    // stop unknown run
    const stop = await app.inject({ method: "POST", url: "/api/runs/does-not-exist/stop" });
    expect(JSON.parse(stop.body).stopped).toBe(false);

    // graphify status endpoint responds (binary may be absent — still honest JSON)
    const g = await app.inject({ method: "GET", url: "/api/graphify/status?workspace=default" });
    expect(g.statusCode).toBe(200);
    expect(JSON.parse(g.body)).toHaveProperty("available");

    await app.close();
  }, 60000);

  it("6-digit PIN works + brute force gets braked", async () => {
    process.env.TELEAGENT_API_KEY = "482910";
    const app = await buildApiServer();
    const good = (extra = {}) => app.inject({ method: "GET", url: "/api/sessions?limit=1", headers: { "x-api-key": "482910" }, ...extra });
    const bad = () => app.inject({ method: "GET", url: "/api/sessions?limit=1", headers: { "x-api-key": "000000" } });
    expect((await good()).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) expect((await bad()).statusCode).toBe(401);
    // 10th wrong try still 401, 11th hits the brake
    expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(429);
    // correct PIN still rejected while blocked, works after failures reset
    expect((await good()).statusCode).toBe(429);
    await app.close();
    process.env.TELEAGENT_API_KEY = "";
  }, 60000);
});
