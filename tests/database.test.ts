import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-db-")) + "/t.db";
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-ws-"));

import { store } from "../src/database/store.js";
import { openDatabase } from "../src/database/db.js";
import { SCHEMA_TABLES } from "../src/database/schema.js";

describe("database persistence", () => {
  beforeEach(() => { openDatabase(process.env.DATABASE_URL); });

  it("has all required tables", () => {
    const db = openDatabase(process.env.DATABASE_URL);
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    for (const t of SCHEMA_TABLES) expect(names).toContain(t);
  });

  it("user/chat/session/message/run lifecycle + restart recovery shape", () => {
    const uid = store.upsertUser("111", "tester");
    const chat = store.ensureChat(uid, "222");
    const ws = store.ensureWorkspace("proj", process.env.WORKSPACE_ROOT + "/proj", uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: ws, provider: "9router", model: "auto" });
    store.addMessage(sid, "user", "hello");
    store.addMessage(sid, "assistant", "hi");
    expect(store.messages(sid).length).toBe(2);
    const run = store.createRun(sid, "do work");
    store.logTool(run, "read_file", "abc", "SAFE", { approval: "auto", success: true, exitCode: 0, durationMs: 5 });
    store.finishRun(run, "completed", 10, 20);
    store.setMemory("session", sid, "k", "v");
    expect(store.getMemory("session", sid).k).toBe("v");
    store.addUsage(uid, run, "9router", "auto", 10, 20, 0.001);
    expect(store.dailyTokens(uid)).toBe(30);
  });

  it("duplicate update protection", () => {
    expect(store.markUpdate("u-1")).toBe(true);
    expect(store.markUpdate("u-1")).toBe(false);
    expect(store.wasProcessed("u-1")).toBe(true);
  });

  it("approval lifecycle", () => {
    const uid = store.upsertUser("333", "a");
    const chat = store.ensureChat(uid, "444");
    const ws = store.ensureWorkspace("w2", process.env.WORKSPACE_ROOT + "/w2", uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: ws, provider: "openai", model: "m" });
    const run = store.createRun(sid, "deploy?");
    const ap = store.createApproval(run, "shell", "git push", "HIGH");
    store.resolveApproval(ap, "approved");
    expect(store.getApproval(ap)?.status).toBe("approved");
  });
});
