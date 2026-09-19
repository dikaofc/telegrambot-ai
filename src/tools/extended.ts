import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { getEnv } from "../config/env.js";
import { assertInsideWorkspace } from "../workspace/manager.js";
import { assertSafeArchiveEntry, validateFileName } from "../security/upload-validation.js";
import { store } from "../database/store.js";
import { execArgs, execCommand } from "./shell.js";
import { httpGet } from "./http.js";
import { gitTools } from "./git.js";
import { listProcesses, killProcess } from "./process-tools.js";
import { detectProjectProfile } from "../workspace/manager.js";
import { createCheckpoint } from "../agent/checkpoint.js";
import type { ToolResult } from "./types.js";
import { ok, fail } from "./types.js";

const execFileAsync = promisify(execFile);

// ---------- read_many / tree / apply_patch ----------

export async function readMany(ws: string, files: string[], maxBytesEach = 100_000): Promise<ToolResult> {
  if (files.length > 10) return fail("max 10 files per call");
  const parts: string[] = [];
  for (const f of files) {
    try {
      const resolved = assertInsideWorkspace(ws, f);
      const st = fs.statSync(resolved);
      if (st.isDirectory()) { parts.push(`===== ${f} (directory, skipped) =====`); continue; }
      const fd = fs.openSync(resolved, "r");
      const buf = Buffer.alloc(Math.min(st.size, maxBytesEach));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      parts.push(`===== ${f} (${st.size} bytes${st.size > maxBytesEach ? ", truncated" : ""}) =====\n` + buf.toString("utf8"));
    } catch (e) { parts.push(`===== ${f} (ERROR: ${String(e).slice(0, 200)}) =====`); }
  }
  return ok(parts.join("\n\n").slice(0, 300_000));
}

export async function treeDir(ws: string, target = ".", depth = 3, maxEntries = 300): Promise<ToolResult> {
  try {
    const root = assertInsideWorkspace(ws, target);
    const out: string[] = [];
    const walk = (dir: string, prefix: string, level: number) => {
      if (out.length >= maxEntries || level > depth) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)); }
      catch { return; }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        let size = "";
        if (!e.isDirectory()) {
          try { size = ` (${fs.statSync(path.join(dir, e.name)).size}b)`; } catch { /* noop */ }
        }
        out.push(`${prefix}${e.isDirectory() ? "📁 " : "📄 "}${e.name}${size}`);
        if (out.length >= maxEntries) return;
        if (e.isDirectory()) walk(path.join(dir, e.name), prefix + "  ", level + 1);
      }
    };
    walk(root, "", 0);
    return ok(out.join("\n") || "(empty)");
  } catch (e) { return fail(String(e)); }
}

export interface PatchItem { file: string; oldText: string; newText: string; }

export async function applyPatch(ws: string, items: PatchItem[]): Promise<ToolResult> {
  if (!Array.isArray(items) || items.length === 0) return fail("items[] required");
  if (items.length > 20) return fail("max 20 patch items per call");
  try {
    // validate everything BEFORE writing anything (atomic-ish)
    const staged: Array<{ resolved: string; rel: string; next: string }> = [];
    for (const it of items) {
      if (!it.file || typeof it.oldText !== "string" || typeof it.newText !== "string") return fail("each item needs file/oldText/newText");
      if (it.newText.length > 1_000_000) return fail(`newText too large for ${it.file}`);
      const resolved = assertInsideWorkspace(ws, it.file);
      const cur = fs.readFileSync(resolved, "utf8");
      if (!cur.includes(it.oldText)) return fail(`oldText not found in ${it.file} — no files were modified`);
      staged.push({ resolved, rel: it.file, next: cur.replace(it.oldText, it.newText) });
    }
    for (const s of staged) fs.writeFileSync(s.resolved, s.next, "utf8");
    const files = staged.map((s) => s.rel);
    return ok(`patched ${files.length} file(s): ${files.join(", ")}`, { filesChanged: files });
  } catch (e) { return fail(String(e)); }
}

// ---------- fetch_text (SSRF-protected, HTML stripped) ----------

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

export async function fetchText(url: string, maxChars = 30_000): Promise<ToolResult> {
  const r = await httpGet(url);
  if (!r.success) return r;
  const raw = r.output ?? "";
  const text = /<\s*html|<\s*body|<\s*div|<\s*p[\s>]/i.test(raw) ? stripHtml(raw) : raw;
  return ok(text.slice(0, maxChars));
}

// ---------- archive_extract (traversal + zip-bomb guarded) ----------

async function commandExists(cmd: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execFileAsync("where", [cmd], { timeout: 8000 });
    } else {
      await execFileAsync("which", [cmd], { timeout: 8000 });
    }
    return true;
  } catch { return false; }
}

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) total += fs.statSync(full).size;
      } catch { /* noop */ }
    }
  }
  return total;
}

async function listArchive(archive: string): Promise<string[]> {
  const low = archive.toLowerCase();
  if (low.endsWith(".zip")) {
    if (await commandExists("python3")) {
      const { stdout } = await execFileAsync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(chr(10).join(z.namelist()))", archive], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
      return String(stdout).split("\n").map((s) => s.trim()).filter(Boolean);
    }
    const { stdout } = await execFileAsync("unzip", ["-Z1", archive], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    return String(stdout).split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (low.endsWith(".tar.gz") || low.endsWith(".tgz") || low.endsWith(".tar")) {
    const { stdout } = await execFileAsync("tar", ["-tf", archive], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    return String(stdout).split("\n").map((s) => s.replace(/^\.\//, "").trim()).filter((s) => s && s !== ".");
  }
  throw new Error("unsupported archive (use .zip, .tar.gz, .tgz, .tar)");
}

export async function extractArchive(archivePath: string, destDir: string, maxExtractedMb?: number): Promise<ToolResult> {
  const env = getEnv();
  const limitMb = maxExtractedMb ?? env.MAX_EXTRACTED_MB;
  const started = Date.now();
  try {
    if (!fs.existsSync(archivePath)) return fail(`archive not found: ${archivePath}`);
    fs.mkdirSync(destDir, { recursive: true });
    const entries = await listArchive(archivePath);
    if (entries.length === 0) return fail("archive is empty");
    if (entries.length > 20_000) return fail("archive has too many entries");
    for (const e of entries) {
      const v = validateFileName(e);
      if (!v.ok) return fail(`unsafe entry '${e.slice(0, 120)}': ${v.reason}`);
      assertSafeArchiveEntry(e, destDir);
    }
    const low = archivePath.toLowerCase();
    if (low.endsWith(".zip")) {
      if (await commandExists("python3")) {
        await execFileAsync("python3", ["-c",
          "import zipfile,sys,os\narc, dst = sys.argv[1], sys.argv[2]\nwith zipfile.ZipFile(arc) as z:\n for m in z.infolist():\n  out = os.path.realpath(os.path.join(dst, m.filename))\n  assert out == os.path.realpath(dst) or out.startswith(os.path.realpath(dst) + os.sep), 'traversal'\n  z.extract(m, dst)",
          archivePath, destDir], { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
      } else if (process.platform === "win32") {
        await execFileAsync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`], { timeout: 300_000 });
      } else {
        await execFileAsync("unzip", ["-oq", archivePath, "-d", destDir], { timeout: 300_000 });
      }
    } else {
      await execFileAsync("tar", ["-xf", archivePath, "-C", destDir], { timeout: 300_000 });
    }
    const bytes = await dirSizeBytes(destDir);
    if (bytes > limitMb * 1024 * 1024) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return fail(`zip bomb guard: extracted ${Math.round(bytes / 1048576)}MB > ${limitMb}MB — removed`);
    }
    return ok(`extracted ${entries.length} entries (${bytes} bytes) → ${destDir}`, { duration: Date.now() - started });
  } catch (e) { return fail(String(e)); }
}

// ---------- background shell sessions (long-running processes) ----------

interface BgSession {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  dropped: number;
  total: number;
  exitCode: number | null;
  signal: string | null;
  started: number;
  cwd: string;
}

const bgSessions = new Map<string, BgSession>();
let bgCounter = 0;
const BG_OUTPUT_CAP = 1_000_000;

function bgShell(cmd: string): { bin: string; args: string[] } {
  if (process.platform === "win32") return { bin: "powershell.exe", args: ["-NoProfile", "-Command", cmd] };
  return { bin: "bash", args: ["-lc", cmd] };
}

export function shellStart(command: string, cwd: string): { id: string } {
  const id = `bg-${Date.now().toString(36)}-${++bgCounter}`;
  const { bin, args } = bgShell(command);
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, WORKSPACE: cwd, TERM: "dumb" } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const s: BgSession = { id, command, child, output: "", dropped: 0, total: 0, exitCode: null, signal: null, started: Date.now(), cwd };
  child.stdout?.on("data", (d) => appendBg(s, String(d)));
  child.stderr?.on("data", (d) => appendBg(s, String(d)));
  child.on("close", (code, signal) => { s.exitCode = code ?? (signal ? 143 : 0); s.signal = signal ?? null; });
  bgSessions.set(id, s);
  if (bgSessions.size > 50) {
    const oldest = [...bgSessions.values()].filter((x) => x.exitCode !== null).sort((a, b) => a.started - b.started)[0];
    if (oldest) { try { oldest.child.kill("SIGKILL"); } catch { /* noop */ } bgSessions.delete(oldest.id); }
  }
  return { id };
}

function appendBg(s: BgSession, chunk: string): void {
  s.output += chunk;
  s.total += chunk.length;
  if (s.output.length > BG_OUTPUT_CAP) {
    const cut = s.output.length - BG_OUTPUT_CAP;
    s.output = s.output.slice(cut);
    s.dropped += cut;
  }
}

export function shellPoll(id: string, lastSeen = 0, tailChars = 20_000): { running: boolean; chunk: string; newLastSeen: number; exitCode: number | null; total: number } {
  const s = bgSessions.get(id);
  if (!s) throw new Error(`unknown shell session: ${id}`);
  const absEnd = s.dropped + s.output.length;
  const from = Math.max(lastSeen, s.dropped, absEnd - Math.max(tailChars, 0));
  const chunk = s.output.slice(from - s.dropped);
  return { running: s.exitCode === null, chunk, newLastSeen: absEnd, exitCode: s.exitCode, total: s.total };
}

export function shellInput(id: string, data: string): void {
  const s = bgSessions.get(id);
  if (!s) throw new Error(`unknown shell session: ${id}`);
  if (s.exitCode !== null) throw new Error(`session ${id} already exited (${s.exitCode})`);
  s.child.stdin?.write(data);
}

export function shellKill(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
  const s = bgSessions.get(id);
  if (!s) return false;
  try {
    s.child.kill(signal);
    return true;
  } catch { return false; }
}

// ---------- todos (persistent via SQLite memory) ----------

export interface TodoItem { content: string; status: "pending" | "in_progress" | "completed"; }

export function writeTodos(sessionId: string, todos: TodoItem[]): void {
  if (!Array.isArray(todos) || todos.length > 50) throw new Error("todos must be an array (max 50)");
  for (const t of todos) {
    if (!t.content || !["pending", "in_progress", "completed"].includes(t.status)) throw new Error("each todo needs content + status");
  }
  store.setMemory("todos", sessionId || "global", "list", JSON.stringify(todos).slice(0, 20_000));
}

export function listTodos(sessionId: string): TodoItem[] {
  try {
    const raw = store.getMemory("todos", sessionId || "global").list;
    if (!raw) return [];
    const arr = JSON.parse(raw) as TodoItem[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ---------- checkpoint / memory / profile / env tools ----------

export async function toolCheckpointCreate(workspacePath: string, sessionId: string, runId: string): Promise<ToolResult> {
  try {
    const s = store.getSession(sessionId) as { workspace_id: string } | undefined;
    const wsId = s?.workspace_id ?? store.ensureWorkspace("default", workspacePath);
    const id = await createCheckpoint(runId || `manual-${Date.now()}`, wsId, workspacePath);
    return ok(`checkpoint ${id}`);
  } catch (e) { return fail(String(e)); }
}

export async function toolCheckpointRestore(workspacePath: string, commit: string): Promise<ToolResult> {
  try {
    if (!/^[0-9a-f]{4,40}$/i.test(commit)) return fail("commit must be a git SHA");
    const { rollbackToCommit } = await import("../agent/checkpoint.js");
    const r = await rollbackToCommit(workspacePath, commit);
    return r.ok ? ok(r.output) : fail(r.output);
  } catch (e) { return fail(String(e)); }
}

const SECRET_KEY_RE = /token|api[_-]?key|secret|password|private|webhook|auth/i;

export function assertNotSecretKey(key: string): void {
  if (SECRET_KEY_RE.test(key)) throw new Error("secrets can only be set via environment/.env, never via settings API or agent tools");
}

export async function toolMemoryRemember(sessionId: string, workspacePath: string, key: string, value: string, scope: string): Promise<ToolResult> {
  try {
    assertNotSecretKey(key + " " + value.slice(0, 200));
    const { rememberSession, rememberWorkspace } = await import("../agent/memory.js");
    if (scope === "workspace") rememberWorkspace(workspacePath, key, value);
    else rememberSession(sessionId, key, value);
    return ok(`remembered [${scope}] ${key}`);
  } catch (e) { return fail(String(e)); }
}

export async function toolMemoryRecall(sessionId: string, workspacePath: string, scope: string): Promise<ToolResult> {
  try {
    const { recallSession, recallWorkspace } = await import("../agent/memory.js");
    const data = scope === "workspace" ? recallWorkspace(workspacePath) : recallSession(sessionId);
    return ok(JSON.stringify(data, null, 2).slice(0, 10_000));
  } catch (e) { return fail(String(e)); }
}

export async function toolProjectProfile(workspacePath: string): Promise<ToolResult> {
  try {
    const p = detectProjectProfile(workspacePath);
    const st = await gitTools.status(workspacePath);
    return ok(JSON.stringify({ ...p, git: (st.output ?? "").slice(0, 500) }, null, 2));
  } catch (e) { return fail(String(e)); }
}

export function toolEnvInfo(workspacePath: string): ToolResult {
  const env = getEnv();
  return ok(JSON.stringify({
    workspace: workspacePath,
    defaultProvider: env.PROVIDER,
    defaultModel: env.DEFAULT_MODEL,
    sandbox: { enabled: env.SANDBOX_ENABLED, runtime: env.SANDBOX_RUNTIME },
    agentMaxRetries: env.AGENT_MAX_RETRIES,
    maxConcurrentRuns: env.MAX_CONCURRENT_RUNS,
    rateLimits: { messagesPerMin: env.RATE_LIMIT_MESSAGES, runsPerHour: env.RATE_LIMIT_RUNS, maxDailyTokens: env.MAX_DAILY_TOKENS },
    uploads: { maxUploadMb: env.MAX_UPLOAD_MB, maxExtractedMb: env.MAX_EXTRACTED_MB },
    accessMode: env.BOT_ACCESS_MODE,
    port: env.PORT,
  }, null, 2));
}

// ---------- git extras / process wrappers ----------

export async function toolGitBranch(cwd: string, name: string): Promise<ToolResult> {
  if (!/^[A-Za-z0-9/_.-]{1,100}$/.test(name)) return fail("invalid branch name");
  return execArgs("git", ["checkout", "-b", name], cwd, 30_000);
}

export async function toolGitCheckout(cwd: string, ref: string): Promise<ToolResult> {
  if (!/^[A-Za-z0-9/_.-]{1,100}$/.test(ref)) return fail("invalid ref");
  return gitTools.checkout(cwd, ref);
}

export async function toolGitLog(cwd: string, n: number): Promise<ToolResult> {
  const count = Math.min(Math.max(Math.floor(n) || 10, 1), 100);
  return gitTools.log(cwd, count);
}

export async function toolGitShow(cwd: string, ref: string, file?: string): Promise<ToolResult> {
  if (!/^[A-Za-z0-9/_.-]{1,100}$/.test(ref)) return fail("invalid ref");
  const args = file ? ["show", `${ref}:${file}`] : ["show", "--stat", ref];
  const r = await execArgs("git", args, cwd, 30_000);
  if (r.success && r.output) r.output = r.output.slice(0, 20_000);
  return r;
}

export async function toolProcessList(): Promise<ToolResult> {
  const r = await listProcesses();
  if (r.success && r.output) r.output = r.output.split("\n").slice(0, 40).join("\n");
  return r;
}

export async function toolProcessKill(pid: number): Promise<ToolResult> {
  if (!Number.isInteger(pid) || pid <= 0) return fail("invalid pid");
  return killProcess(pid, "SIGTERM");
}

export async function toolRunTests(ws: string): Promise<ToolResult> {
  const { runTest } = await import("./package-manager.js");
  return runTest(ws);
}

export async function toolRunBuild(ws: string): Promise<ToolResult> {
  const { runBuild } = await import("./package-manager.js");
  return runBuild(ws);
}

export async function toolExec(ws: string, command: string, timeoutMs?: number): Promise<ToolResult> {
  return execCommand(command, { cwd: ws, timeoutMs: timeoutMs ?? 120_000 });
}
