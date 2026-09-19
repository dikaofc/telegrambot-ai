import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), "tele-wsswitch-")) + "/ws.db";
process.env.DATABASE_URL = tmpDb;
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-wsswitch-ws-"));
process.env.RATE_LIMIT_RUNS = "60";

import { classifyTask } from "../src/providers/router.js";
import { parseNaturalSettings } from "../src/telegram/gateway.js";
import { ensureSession } from "../src/agent/orchestrator.js";
import { switchSessionWorkspace } from "../src/telegram/commands.js";
import { resolveWorkspacePath } from "../src/workspace/manager.js";
import { store } from "../src/database/store.js";
import { openDatabase } from "../src/database/db.js";

beforeEach(() => { openDatabase(process.env.DATABASE_URL); });

describe("workspace switch regressions (Telegram log 19.09)", () => {
  it("identity questions are never workspace switches", () => {
    expect(parseNaturalSettings("sekarang di workspace apa")).toBeNull();
    expect(parseNaturalSettings("sekarang di work space apa")).toBeNull();
    expect(parseNaturalSettings("/workspace")).toBeNull();
  });
  it("natural switch skips stopwords and takes the real name", () => {
    expect(parseNaturalSettings("ganti workspace ke telegrambot-ai")?.value).toBe("telegrambot-ai");
    expect(parseNaturalSettings("workspace telegrambot-ai")?.value).toBe("telegrambot-ai");
    expect(parseNaturalSettings("buka project my-app")?.value).toBe("my-app");
  });
  it("shell/filesystem intent gets tools (never chat)", () => {
    expect(classifyTask("coba ketik ls -la")).toBe("coding");
    expect(classifyTask("ls -la di workspace /x")).toBe("coding");
    expect(classifyTask("ketik di terminal: warp-cli disconnect")).toBe("coding");
    expect(classifyTask("baca file message.txt dan jelaskan")).toBe("coding");
    expect(classifyTask("siapa kamu")).toBe("chat");
    expect(classifyTask("halo, apa kabar?")).toBe("chat");
  });
  it("implicit ensureSession preserves workspace/model/provider", () => {
    const uid = store.upsertUser("ws-u", "u");
    const chat = store.ensureChat(uid, "ws-c");
    const s1 = ensureSession(uid, chat, "proj-a", "openai", "gpt-x");
    const sw = switchSessionWorkspace(uid, s1, "proj-b");
    expect(sw.name).toBe("proj-b");
    expect(sw.path).toContain("proj-b");
    // every normal message must NOT reset workspace/model
    const s2 = ensureSession(uid, chat, null, null, null);
    expect(s2).toBe(s1);
    const row = store.getSession(s1) as { workspace_id: string; provider: string; model: string };
    expect((store.getWorkspaceById(row.workspace_id) as { path: string }).path).toContain("proj-b");
    expect(row.provider).toBe("openai");
    expect(row.model).toBe("gpt-x");
  });
  it("/workspace takes first token only, resolves exact path", () => {
    const uid = store.upsertUser("ws-u2", "u");
    const chat = store.ensureChat(uid, "ws-c2");
    const s1 = ensureSession(uid, chat, null, null, null);
    const sw = switchSessionWorkspace(uid, s1, "ganti telegrambot-ai");
    expect(sw.name).toBe("ganti");
    expect(sw.path.endsWith("/ganti")).toBe(true);
    expect(resolveWorkspacePath("telegrambot-ai")).toContain("telegrambot-ai");
  });
});
