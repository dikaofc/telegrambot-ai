import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-cmddb-")) + "/c.db";
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-cmdws-"));

import { COMMANDS, buildHelpText } from "../src/telegram/commands.js";
import { store } from "../src/database/store.js";
import { openDatabase } from "../src/database/db.js";
import { pauseRun, resumeRun } from "../src/agent/orchestrator.js";
import { pickSkill, listSkills } from "../src/agent/skills.js";

describe("slash command catalog", () => {
  it("covers full control with usage + examples", () => {
    const names = COMMANDS.map((c) => c.command);
    for (const need of ["start", "help", "status", "settings", "model", "provider", "workspace", "new", "stop", "pause", "resume", "retry", "diff", "log", "undo", "approvals", "approve", "reject", "usage", "doctor", "graph"]) {
      expect(names, need).toContain(need);
    }
    for (const c of COMMANDS) {
      expect(c.short.length, c.command).toBeGreaterThan(3);
      expect(c.usage, c.command).toContain("/" + c.command);
      expect(c.example, c.command).toBeTruthy();
    }
    const help = buildHelpText();
    expect(help).toContain("/approve");
    expect(help).toContain("/undo");
    expect(help.length).toBeGreaterThan(1000);
  });
});

describe("command backends (store/orchestrator)", () => {
  it("checkpoint lookup + prefix approval + last message/run", async () => {
    openDatabase(process.env.DATABASE_URL);
    const uid = store.upsertUser("cmd-u", "x");
    const chat = store.ensureChat(uid, "cmd-c");
    const ws = store.ensureWorkspace("cmd-ws", (process.env.WORKSPACE_ROOT as string) + "/cmd-ws", uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: ws, provider: "p", model: "m" });
    store.addMessage(sid, "user", "do the thing");
    expect(store.lastUserMessage(sid)).toBe("do the thing");
    const run = store.createRun(sid, "do the thing");
    expect(store.lastRunForSession(sid)?.id).toBe(run);
    expect(store.toolCallsForRun(run)).toEqual([]);
    store.logTool(run, "read_file", "h", "SAFE", { approval: "auto", success: true });
    expect(store.toolCallsForRun(run).length).toBe(1);
    expect(store.latestCheckpoint(ws)).toBeUndefined();
    store.saveCheckpoint(run, ws, "abc123", ["a.ts"]);
    expect(store.latestCheckpoint(ws)?.git_commit).toBe("abc123");
    const ap = store.createApproval(run, "shell", "git push", "HIGH");
    expect(store.resolveApprovalPrefix(ap.slice(0, 8), "approved")).toBe(ap);
    expect(store.resolveApprovalPrefix("zzz-nope", "approved")).toBeNull();
    // pause/resume on unknown run = false (no crash)
    expect(await pauseRun("nope")).toBe(false);
    expect(await resumeRun("nope")).toBe(false);
  });

  it("new skills route correctly", () => {
    expect(listSkills("skills").some((s) => s.name === "reviewer")).toBe(true);
    expect(listSkills("skills").some((s) => s.name === "security")).toBe(true);
    expect(pickSkill("review this code for bugs", "skills")?.name).toBe("reviewer");
    expect(pickSkill("refactor this module", "skills")?.name).toBe("refactor");
    expect(pickSkill("check for vulnerabilities", "skills")?.name).toBe("security");
    expect(pickSkill("write tests for this", "skills")?.name).toBe("testing");
  });
});
