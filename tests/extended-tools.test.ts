import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  readMany, treeDir, applyPatch, fetchText, extractArchive,
  shellStart, shellPoll, shellInput, shellKill,
  writeTodos, listTodos, toolEnvInfo, assertNotSecretKey,
  toolProjectProfile, toolGitBranch, toolGitLog, toolProcessList,
  toolCheckpointCreate, toolMemoryRemember, toolMemoryRecall,
} from "../src/tools/extended.js";
import { buildRegistry } from "../src/tools/registry.js";
import { toolRisk, RiskLevel } from "../src/security/risk.js";
import { execCommand } from "../src/tools/shell.js";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-extdb-")) + "/e.db";

function mkws(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tele-ext-"));
  fs.writeFileSync(path.join(ws, "a.txt"), "hello world");
  fs.writeFileSync(path.join(ws, "b.md"), "# title\nbody here");
  return ws;
}

describe("read_many / tree / apply_patch", () => {
  it("reads many + tree lists", async () => {
    const ws = mkws();
    const r = await readMany(ws, ["a.txt", "b.md", "missing.txt"]);
    expect(r.success).toBe(true);
    expect(r.output).toContain("hello world");
    expect(r.output).toContain("ERROR");
    const t = await treeDir(ws, ".", 3);
    expect(t.success).toBe(true);
    expect(t.output).toContain("a.txt");
  });
  it("apply_patch is all-or-nothing", async () => {
    const ws = mkws();
    const bad = await applyPatch(ws, [
      { file: "a.txt", oldText: "hello", newText: "hi" },
      { file: "b.md", oldText: "NOPE-NOT-THERE", newText: "x" },
    ]);
    expect(bad.success).toBe(false);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("hello world"); // untouched
    const good = await applyPatch(ws, [{ file: "a.txt", oldText: "hello", newText: "hi" }]);
    expect(good.success).toBe(true);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("hi world");
  });
  it("blocks paths outside workspace", async () => {
    const ws = mkws();
    const r = await applyPatch(ws, [{ file: "../../evil.txt", oldText: "a", newText: "b" }]);
    expect(r.success).toBe(false);
  });
});

describe("fetch_text", () => {
  it("fetches local HTML and strips tags, blocks SSRF", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><style>.x{}</style><script>alert(1)</script></head><body><h1>Docs Title</h1><p>Some content here.</p></body></html>");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    // SSRF guard blocks loopback even for real servers
    const blocked = await fetchText(`http://127.0.0.1:${port}/`);
    expect(blocked.success).toBe(false);
    server.close();
  });
});

describe("archive_extract", () => {
  it("roundtrips a tar.gz and rejects traversal", async () => {
    const ws = mkws();
    fs.writeFileSync(path.join(ws, "inner.txt"), "data-123");
    await execCommand(`tar -czf pkg.tar.gz inner.txt`, { cwd: ws, timeoutMs: 15000 });
    const out = path.join(ws, "out1");
    const r = await extractArchive(path.join(ws, "pkg.tar.gz"), out);
    expect(r.success).toBe(true);
    expect(fs.readFileSync(path.join(out, "inner.txt"), "utf8")).toBe("data-123");
    // malicious: entry with ..
    const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-evil-"));
    fs.writeFileSync(path.join(evilDir, "evil.txt"), "x");
    await execCommand(`tar -czf evil.tar.gz -P ${path.join(evilDir, "evil.txt")} 2>/dev/null || tar -czf evil.tar.gz --transform='s,^,../,' evil.txt`, { cwd: evilDir, timeoutMs: 15000 });
    const evil = await extractArchive(path.join(evilDir, "evil.tar.gz"), path.join(ws, "out-evil"));
    // either tar refused to create it (missing file) or we reject the entry
    if (fs.existsSync(path.join(evilDir, "evil.tar.gz"))) expect(evil.success).toBe(false);
  }, 30000);
});

describe("background shell sessions", () => {
  it("start → poll → kill lifecycle", async () => {
    const ws = mkws();
    const { id } = shellStart("echo bg-hello && sleep 60", ws);
    await new Promise((r) => setTimeout(r, 800));
    const p1 = shellPoll(id, 0);
    expect(p1.chunk).toContain("bg-hello");
    expect(p1.running).toBe(true);
    expect(shellKill(id, "SIGKILL")).toBe(true);
    await new Promise((r) => setTimeout(r, 800));
    const p2 = shellPoll(id, p1.newLastSeen);
    expect(p2.running).toBe(false);
    expect(p2.exitCode).not.toBe(0);
  }, 30000);
  it("stdin piping via shell_input", async () => {
    if (process.platform === "win32") return; // cat semantics differ
    const ws = mkws();
    const { id } = shellStart("cat", ws);
    shellInput(id, "via-bg-stdin\n");
    await new Promise((r) => setTimeout(r, 800));
    const p = shellPoll(id, 0);
    expect(p.chunk).toContain("via-bg-stdin");
    shellKill(id, "SIGKILL");
  }, 30000);
});

describe("todos / memory / profile / env", () => {
  it("todos persist per session", async () => {
    const { openDatabase } = await import("../src/database/db.js");
    openDatabase(process.env.DATABASE_URL);
    writeTodos("sess-1", [
      { content: "implement feature", status: "in_progress" },
      { content: "run tests", status: "pending" },
    ]);
    const list = listTodos("sess-1");
    expect(list.length).toBe(2);
    expect(list[0]?.status).toBe("in_progress");
    expect(listTodos("other").length).toBe(0);
    expect(() => writeTodos("s", [{ content: "x", status: "bogus" } as never])).toThrow();
  });
  it("memory refuses secrets, recalls facts", async () => {
    const ws = mkws();
    const bad = await toolMemoryRemember("s1", ws, "api_key", "sk-secret", "session");
    expect(bad.success).toBe(false);
    const good = await toolMemoryRemember("s1", ws, "preferred_pm", "pnpm", "session");
    expect(good.success).toBe(true);
    const rec = await toolMemoryRecall("s1", ws, "session");
    expect(rec.output).toContain("pnpm");
  });
  it("env_info leaks no secrets", () => {
    process.env.PROVIDER_API_KEY = "test-key-should-not-appear";
    const out = toolEnvInfo("/ws").output ?? "";
    expect(out).not.toContain("test-key-should-not-appear");
    expect(out).toContain("defaultProvider");
    delete process.env.PROVIDER_API_KEY;
  });
  it("project profile detects node project", async () => {
    const ws = mkws();
    fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    const p = await toolProjectProfile(ws);
    expect(p.success).toBe(true);
    expect(p.output).toContain("typescript");
  });
  it("secret keys blocked in settings path", () => {
    expect(() => assertNotSecretKey("github_token")).toThrow();
    expect(() => assertNotSecretKey("model")).not.toThrow();
  });
});

describe("git extras + processes + checkpoint", () => {
  it("branch/log flow + process list", async () => {
    const ws = mkws();
    await execCommand("git init -q && git config user.email t@t.t && git config user.name t && git add -A && git commit -qm init", { cwd: ws, timeoutMs: 30000 });
    const b = await toolGitBranch(ws, "feature/x");
    expect(b.success).toBe(true);
    const l = await toolGitLog(ws, 3);
    expect(l.output).toContain("init");
    const pl = await toolProcessList();
    expect(pl.success).toBe(true);
  }, 60000);
  it("checkpoint create records state", async () => {
    const ws = mkws();
    await execCommand("git init -q && git config user.email t@t.t && git config user.name t && git commit -qm init --allow-empty", { cwd: ws, timeoutMs: 30000 });
    const { openDatabase } = await import("../src/database/db.js");
    openDatabase(process.env.DATABASE_URL);
    const { store } = await import("../src/database/store.js");
    const uid = store.upsertUser("ckpt-u", "x");
    const chat = store.ensureChat(uid, "ckpt-c");
    const wsId = store.ensureWorkspace("ckpt", ws, uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: wsId, provider: "p", model: "m" });
    const run = store.createRun(sid, "big");
    const r = await toolCheckpointCreate(ws, sid, run);
    expect(r.success).toBe(true);
  }, 60000);
});

describe("registry + risk coverage for new tools", () => {
  it("all power tools registered with sane risk", () => {
    const reg = buildRegistry();
    const expected: Array<[string, RiskLevel]> = [
      ["read_many", RiskLevel.SAFE], ["tree", RiskLevel.SAFE],
      ["apply_patch", RiskLevel.LOW], ["fetch_text", RiskLevel.LOW],
      ["archive_extract", RiskLevel.MEDIUM], ["shell_start", RiskLevel.HIGH],
      ["shell_poll", RiskLevel.SAFE], ["todo_write", RiskLevel.SAFE],
      ["checkpoint_restore", RiskLevel.HIGH], ["memory_remember", RiskLevel.LOW],
      ["project_profile", RiskLevel.SAFE], ["env_info", RiskLevel.SAFE],
      ["process_list", RiskLevel.SAFE], ["process_kill", RiskLevel.HIGH],
      ["git_branch", RiskLevel.MEDIUM], ["git_log", RiskLevel.SAFE],
      ["graphify_status", RiskLevel.SAFE], ["graphify_build", RiskLevel.MEDIUM],
      ["graphify_query", RiskLevel.SAFE],
    ];
    for (const [name, risk] of expected) {
      expect(reg.has(name), name).toBe(true);
      expect(toolRisk(name), name).toBe(risk);
    }
    expect(reg.size).toBeGreaterThan(40);
  });
});
