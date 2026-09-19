import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  toolFindDefinition, toolFindReferences, toolSqliteQuery, toolApiCheck,
  toolSecretScan, toolOutdatedDeps, toolExportSession, toolRenameSymbol,
  toolDepAdd, toolShellBatch, toolRepoClone, toolWorktreeCreate,
  toolWorktreeList, toolWorktreeRemove, toolCoverage,
  toolGithubIssues, toolGithubPrs, toolGithubPrDiff,
} from "../src/tools/extended.js";
import { buildRegistry } from "../src/tools/registry.js";
import { toolRisk, RiskLevel } from "../src/security/risk.js";
import { estimateCostUsd } from "../src/providers/router.js";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-ext3db-")) + "/e3.db";

function mkws(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tele-ext3-"));
  fs.writeFileSync(path.join(ws, "calc.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport const total = add(1, 2);\n");
  fs.writeFileSync(path.join(ws, "main.py"), "def run():\n    return add(3, 4)\n");
  return ws;
}

describe("definition / references", () => {
  it("finds defs and usages across languages", async () => {
    const ws = mkws();
    const d = await toolFindDefinition(ws, "add");
    expect(d.success).toBe(true);
    expect(d.output).toContain("calc.ts");
    const r = await toolFindReferences(ws, "add");
    expect(r.success).toBe(true);
    expect(r.output).toContain("calc.ts");
    expect(r.output).toContain("main.py");
    expect((await toolFindDefinition(ws, "x")).success).toBe(false);
    expect((await toolFindDefinition(ws, "../../etc")).success).toBe(false);
  }, 60000);
});

describe("sqlite_query", () => {
  it("reads rows, refuses writes and escapes", async () => {
    const ws = mkws();
    const dbPath = path.join(ws, "app.db");
    const loader = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (p: string) => { exec(s: string): void; close(): void } } }).getBuiltinModule("node:sqlite");
    const db = new loader.DatabaseSync(dbPath);
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users(name) VALUES('dika'),('budi');");
    db.close();
    const r = await toolSqliteQuery(ws, "app.db", "SELECT * FROM users ORDER BY id");
    expect(r.success).toBe(true);
    expect(r.output).toContain("dika");
    expect(r.output).toContain("budi");
    expect((await toolSqliteQuery(ws, "app.db", "DROP TABLE users")).success).toBe(false);
    expect((await toolSqliteQuery(ws, "../../etc/passwd", "SELECT 1")).success).toBe(false);
    expect((await toolSqliteQuery(ws, "missing.db", "SELECT 1")).success).toBe(false);
  });
});

describe("api_check", () => {
  it("refuses loopback (SSRF) and bad input honestly", async () => {
    expect((await toolApiCheck("http://127.0.0.1:9/x")).success).toBe(false);
    expect((await toolApiCheck("https://example.com/x", "BREW")).success).toBe(false);
  });
});

describe("secret_scan", () => {
  it("flags a planted key but redacts its value", async () => {
    const ws = mkws();
    fs.writeFileSync(path.join(ws, "leak.py"), 'API_KEY = "sk-abcdefghij1234567890"\n');
    const r = await toolSecretScan(ws);
    expect(r.success).toBe(true);
    expect(r.output).toContain("leak.py");
    expect(r.output).not.toContain("abcdefghij1234567890");
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), "tele-clean-"));
    fs.writeFileSync(path.join(clean, "ok.txt"), "nothing here\n");
    expect((await toolSecretScan(clean)).output).toContain("no secrets");
  }, 60000);
});

describe("outdated / export / rename / dep_add / batch", () => {
  it("outdated on manifest-less ws is honest", async () => {
    expect((await toolOutdatedDeps(mkws())).success).toBe(false);
  });
  it("export_session writes transcript", async () => {
    const { openDatabase } = await import("../src/database/db.js");
    openDatabase(process.env.DATABASE_URL);
    const { store } = await import("../src/database/store.js");
    const ws = mkws();
    const uid = store.upsertUser("exp-u", "x");
    const chat = store.ensureChat(uid, "exp-c");
    const wsId = store.ensureWorkspace("exp", ws, uid);
    const sid = store.createSession({ userId: uid, chatId: chat, workspaceId: wsId, provider: "p", model: "m" });
    store.addMessage(sid, "user", "hello transcript");
    const r = await toolExportSession(ws, sid, "transcript.md");
    expect(r.success).toBe(true);
    expect(fs.readFileSync(path.join(ws, "transcript.md"), "utf8")).toContain("hello transcript");
  });
  it("rename is dry-run by default, real on demand", async () => {
    const ws = mkws();
    const dry = await toolRenameSymbol(ws, "add", "sum", "*.ts", true);
    expect(dry.success).toBe(true);
    expect(dry.output).toContain("dry-run");
    expect(fs.readFileSync(path.join(ws, "calc.ts"), "utf8")).toContain("function add");
    const real = await toolRenameSymbol(ws, "add", "sum", "*.ts", false);
    expect(real.success).toBe(true);
    expect(fs.readFileSync(path.join(ws, "calc.ts"), "utf8")).toContain("function sum");
    expect((await toolRenameSymbol(ws, "../x", "y")).success).toBe(false);
  });
  it("dep_add validates input", async () => {
    expect((await toolDepAdd(mkws(), "")).success).toBe(false);
    expect((await toolDepAdd(mkws(), "../evil")).success).toBe(false);
  });
  it("shell_batch runs in order and stops on error", async () => {
    const ws = mkws();
    const ok = await toolShellBatch(ws, ["echo one", "echo two"]);
    expect(ok.success).toBe(true);
    expect(ok.output).toContain("one");
    expect(ok.output).toContain("two");
    const bad = await toolShellBatch(ws, ["echo before", "exit 7"]);
    expect(bad.success).toBe(false);
    expect(bad.error ?? bad.output).toContain("stopped at step 2");
  }, 60000);
});

describe("repo_clone + worktrees", () => {
  it("refuses file:// and local destinations that exist", async () => {
    const ws = mkws();
    expect((await toolRepoClone(ws, "file:///etc/passwd", "x")).success).toBe(false);
    expect((await toolRepoClone(ws, "http://127.0.0.1:9/r.git", "x")).success).toBe(false);
  });
  it("worktree lifecycle in a temp repo", async () => {
    const ws = mkws();
    const { execCommand } = await import("../src/tools/shell.js");
    await execCommand("git init -q && git config user.email t@t.t && git config user.name t && git add -A && git commit -qm init", { cwd: ws, timeoutMs: 30000 });
    const c = await toolWorktreeCreate(ws, "feature/scout-test");
    expect(c.success).toBe(true);
    expect(fs.existsSync(path.join(ws, ".worktrees", "feature-scout-test", "calc.ts"))).toBe(true);
    const l = await toolWorktreeList(ws);
    expect(l.output).toContain(".worktrees");
    const rm = await toolWorktreeRemove(ws, ".worktrees/feature-scout-test");
    expect(rm.success).toBe(true);
    expect((await toolWorktreeRemove(ws, ".")).success).toBe(false);
  }, 120000);
});

describe("github + coverage honesty", () => {
  it("invalid identifiers rejected without network", async () => {
    expect((await toolGithubIssues("..", "x")).success).toBe(false);
    expect((await toolGithubPrs("o", "..")).success).toBe(false);
    expect((await toolGithubPrDiff("o", "r", -1)).success).toBe(false);
  });
  it("coverage on empty ws is honest", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tele-cov-"));
    const r = await toolCoverage(ws);
    expect(typeof r.success).toBe("boolean");
  }, 300000);
});

describe("registry + cost estimator", () => {
  it("wave-3 registered with correct gates", () => {
    const reg = buildRegistry();
    const expected: Array<[string, RiskLevel]> = [
      ["find_definition", RiskLevel.SAFE], ["find_references", RiskLevel.SAFE],
      ["scout", RiskLevel.SAFE], ["secret_scan", RiskLevel.SAFE],
      ["outdated_deps", RiskLevel.SAFE], ["git_worktree_list", RiskLevel.SAFE],
      ["sqlite_query", RiskLevel.LOW], ["api_check", RiskLevel.LOW],
      ["export_session", RiskLevel.LOW], ["rename_symbol", RiskLevel.LOW],
      ["coverage_report", RiskLevel.LOW], ["github_issues", RiskLevel.LOW],
      ["github_prs", RiskLevel.LOW], ["github_pr_diff", RiskLevel.LOW],
      ["dep_add", RiskLevel.MEDIUM], ["repo_clone", RiskLevel.MEDIUM],
      ["git_worktree_create", RiskLevel.MEDIUM], ["shell_batch", RiskLevel.HIGH],
      ["git_worktree_remove", RiskLevel.HIGH],
    ];
    for (const [name, risk] of expected) {
      expect(reg.has(name), name).toBe(true);
      expect(toolRisk(name), name).toBe(risk);
    }
    expect(reg.size).toBeGreaterThan(65);
  });
  it("cost estimator is sane", () => {
    expect(estimateCostUsd("ollama", "m", 1000000, 1000000)).toBe(0);
    expect(estimateCostUsd("openai", "m", 1000000, 0)).toBeCloseTo(0.15, 5);
    expect(estimateCostUsd("unknown", "m", 999, 999)).toBe(0);
  });
});
