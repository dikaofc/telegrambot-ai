import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile, writeFile, editFile, deleteFile, listDirectory } from "../src/tools/filesystem.js";
import { execCommand } from "../src/tools/shell.js";
import { gitTools } from "../src/tools/git.js";
import { globFiles, searchCode } from "../src/tools/search.js";
import { buildRegistry } from "../src/tools/registry.js";
import { spawnPty } from "../src/tools/pty.js";

let ws: string;
beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "tele-fs-"));
  fs.writeFileSync(path.join(ws, "a.txt"), "hello");
});

describe("filesystem tools", () => {
  it("read/write/edit/delete + boundary", async () => {
    const w = await writeFile(ws, "sub/b.txt", "content-123");
    expect(w.success).toBe(true);
    const r = await readFile(ws, "sub/b.txt");
    expect(r.output).toBe("content-123");
    const e = await editFile(ws, "sub/b.txt", "content-123", "content-456");
    expect(e.success).toBe(true);
    const l = await listDirectory(ws, "sub");
    expect(l.output).toContain("b.txt");
    const d = await deleteFile(ws, "sub/b.txt");
    expect(d.success).toBe(true);
    const evil = await readFile(ws, "../../etc/passwd");
    expect(evil.success).toBe(false);
  });
  it("registry exposes required tools", () => {
    const reg = buildRegistry();
    for (const t of ["read_file", "write_file", "edit_file", "shell", "git_status", "npm_test", "http_get", "search_code", "glob"]) {
      expect(reg.has(t)).toBe(true);
    }
  });
  it("registry rejects garbage file targets (never creates 'undefined')", async () => {
    const reg = buildRegistry();
    const ctx = { workspacePath: ws, runId: "t", sessionId: "t", userId: "t" };
    for (const [tool, args] of [
      ["write_file", { content: "x" }],
      ["write_file", { target: "undefined", content: "x" }],
      ["edit_file", { target: "  ", oldText: "a", newText: "b" }],
      ["delete_file", {}],
      ["move_file", { src: "a.txt" }],
      ["read_file", { target: undefined }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await reg.get(tool)!.execute(args, ctx);
      expect(r.success, `${tool} ${JSON.stringify(args)}`).toBe(false);
    }
    expect(fs.existsSync(path.join(ws, "undefined"))).toBe(false);
  });
  it("registry accepts sibling arg keys (file/path/text/cmd aliases)", async () => {
    const reg = buildRegistry();
    const ctx = { workspacePath: ws, runId: "t", sessionId: "t", userId: "t" };
    const w = await reg.get("write_file")!.execute({ file: "alias.txt", text: "alias-ok" }, ctx);
    expect(w.success).toBe(true);
    expect(fs.readFileSync(path.join(ws, "alias.txt"), "utf8")).toBe("alias-ok");
    const r = await reg.get("read_file")!.execute({ path: "alias.txt" }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain("alias-ok");
    const s = await reg.get("shell")!.execute({ cmd: "echo alias-shell" }, ctx);
    expect(s.success).toBe(true);
    expect(s.output).toContain("alias-shell");
    const mv = await reg.get("move_file")!.execute({ source: "alias.txt", destination: "alias2.txt" }, ctx);
    expect(mv.success).toBe(true);
    expect(fs.existsSync(path.join(ws, "alias2.txt"))).toBe(true);
  });
});

describe("shell execution", () => {
  it("runs echo and captures output", async () => {
    const r = await execCommand("echo hello-shell", { cwd: ws, timeoutMs: 10_000 });
    expect(r.success).toBe(true);
    expect(r.output).toContain("hello-shell");
    expect(r.metadata?.exitCode).toBe(0);
  });
  it("reports failure with exit code", async () => {
    const r = await execCommand("exit 3", { cwd: ws, timeoutMs: 10_000 });
    expect(r.success).toBe(false);
    expect(r.metadata?.exitCode).toBe(3);
  });
  it("blocks critical commands", async () => {
    const r = await execCommand("rm -rf /", { cwd: ws, timeoutMs: 10_000 });
    expect(r.success).toBe(false);
  });
  it("stdin piping works", async () => {
    const r = await execCommand("cat", { cwd: ws, timeoutMs: 10_000, stdin: "via-stdin" });
    expect(r.success).toBe(true);
    expect(r.output).toContain("via-stdin");
  });
});

describe("pty", () => {
  it("streams output and waits for exit", async () => {
    const s = await spawnPty("echo pty-hello && sleep 0.1 && echo pty-done", ws);
    let data = "";
    s.onData((d) => { data += d; });
    const res = await s.wait(15_000);
    expect(res.exitCode).toBe(0);
    expect(data + res.output).toContain("pty-hello");
  });
  it("supports interrupt/kill of long-running process", async () => {
    const s = await spawnPty("sleep 30", ws);
    s.kill("SIGKILL");
    const res = await s.wait(15_000);
    expect(res.exitCode).not.toBe(0);
  });
});

describe("git integration", () => {
  it("status/log/diff/commit flow", async () => {
    await execCommand("git init -q && git config user.email t@t.t && git config user.name t && git add -A && git commit -qm init", { cwd: ws, timeoutMs: 30_000 });
    const st = await gitTools.status(ws);
    expect(st.success).toBe(true);
    fs.writeFileSync(path.join(ws, "new.txt"), "x");
    const st2 = await gitTools.status(ws);
    expect(st2.output).toContain("new.txt");
    const diff = await gitTools.diff(ws);
    expect(diff.success).toBe(true);
    const logR = await gitTools.log(ws, 5);
    expect(logR.output).toContain("init");
    expect(await gitTools.currentBranch(ws)).toBeTruthy();
  });
});

describe("search", () => {
  it("glob + search find content", async () => {
    fs.writeFileSync(path.join(ws, "needle.ts"), "const needle_xyz = 1;\n");
    const g = await globFiles(ws, "*.ts");
    expect(g.output).toContain("needle.ts");
    const s = await searchCode(ws, "needle_xyz");
    expect(s.success).toBe(true);
    expect(s.output).toContain("needle_xyz");
  });
});
