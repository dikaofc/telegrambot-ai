import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-tuidb-")) + "/t.db";
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-tuiws-"));

import { formatTable, truncateCell, sessionsText, runsText, approvalsText, usageText, settingsText, workspacesText, statusText } from "../src/tui/screens.js";
import { openDatabase } from "../src/database/db.js";
import { store } from "../src/database/store.js";

describe("tui screens", () => {
  it("formatTable aligns columns", () => {
    const t = formatTable(["a", "bb"], [["x", "yy"], ["longer", "z"]]);
    const lines = t.split("\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toContain("a");
    expect(lines[2]?.length).toBe(lines[0]?.length);
    expect(truncateCell("abcdef", 5)).toBe("abcd…");
  });

  it("screens render seeded data", async () => {
    openDatabase(process.env.DATABASE_URL);
    const uid = store.upsertUser("tui-u", "t");
    const chat = store.ensureChat(uid, "tui-c");
    const wsId = store.ensureWorkspace("tui-ws", (process.env.WORKSPACE_ROOT as string) + "/tui-ws", uid);
    fs.mkdirSync((process.env.WORKSPACE_ROOT as string) + "/tui-ws", { recursive: true });
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: wsId, provider: "9router", model: "auto" });
    store.createRun(sid, "hello task");
    store.setSetting("model", "auto", "global", "");

    expect(sessionsText()).toContain("9router");
    expect(runsText()).toContain("hello task");
    expect(approvalsText()).toContain("no pending approvals");
    expect(usageText()).toContain("runs=");
    expect(settingsText()).toContain("model");
    expect(workspacesText()).toContain("tui-ws");
    expect(await statusText()).toContain("TELEAGENT");
  });
});
