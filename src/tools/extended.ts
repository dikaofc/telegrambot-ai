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

// ---------- pure-JS grep (deterministic, cross-platform: rg/grep differ per OS) ----------

export interface JsGrepOpts { maxHits?: number; maxFiles?: number; ignoreCase?: boolean; exts?: RegExp }

export async function jsGrep(ws: string, pattern: string, opts: JsGrepOpts = {}): Promise<string[]> {
  const { maxHits = 50, maxFiles = 500, ignoreCase = false, exts } = opts;
  const re = new RegExp(pattern, ignoreCase ? "i" : "");
  const hits: string[] = [];
  let scanned = 0;
  const stack = [ws];
  while (stack.length && hits.length < maxHits && scanned < maxFiles) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (hits.length >= maxHits || scanned >= maxFiles) break;
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".worktrees" || e.name === "graphify-out") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      const rel = path.relative(ws, full).replace(/\\/g, "/");
      if (exts && !exts.test(rel)) continue;
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || st.size > 1_000_000) continue;
      scanned += 1;
      let text: string;
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (text.includes("\0")) continue; // binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        try { m = re.exec(lines[i] as string); } catch { return hits; }
        if (m) hits.push(`${rel}:${i + 1}:${(lines[i] as string).trim().slice(0, 200)}`);
      }
    }
  }
  return hits;
}

// ---------- definition / references (offline AST-lite navigation) ----------

const CODE_EXT_RE = /\.(ts|mts|cts|js|mjs|jsx|tsx|py|go|rs|java|kt|rb|php|cs|swift|c|cpp|h|hpp|lua|scala)$/i;

export async function toolFindDefinition(ws: string, symbol: string): Promise<ToolResult> {
  try {
    if (!/^[\w$]{2,100}$/.test(symbol)) return fail("invalid symbol");
    const hits = await jsGrep(ws, `(def|function|class|fn|func|type|interface|struct|enum|trait)\\s+${symbol}\\b`, { exts: CODE_EXT_RE, maxHits: 30 });
    return ok(hits.length ? hits.join("\n") : `(no definition found for ${symbol} — try find_references)`);
  } catch (e) { return fail(String(e)); }
}

export async function toolFindReferences(ws: string, symbol: string): Promise<ToolResult> {
  try {
    if (!/^[\w$]{2,100}$/.test(symbol)) return fail("invalid symbol");
    const hits = await jsGrep(ws, `\\b${symbol}\\b`, { exts: CODE_EXT_RE, maxHits: 50 });
    return ok(hits.length ? `${hits.length} reference(s):\n` + hits.join("\n") : `(no references to ${symbol})`);
  } catch (e) { return fail(String(e)); }
}

// ---------- scout subagent ----------

export async function toolScout(ws: string, sessionId: string, runId: string, goal: string): Promise<ToolResult> {
  try {
    if (!goal || goal.length < 5) return fail("goal required (min 5 chars)");
    const { scout } = await import("../agent/scout.js");
    return scout(ws, sessionId, goal.slice(0, 2000), 8, runId);
  } catch (e) { return fail(String(e)); }
}

// ---------- sqlite query (read-only, workspace-bounded) ----------

export async function toolSqliteQuery(ws: string, dbRel: string, sql: string): Promise<ToolResult> {
  try {
    if (!/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql)) return fail("only read queries allowed (SELECT/WITH/PRAGMA/EXPLAIN)");
    if (sql.length > 5000) return fail("query too long");
    const dbPath = assertInsideWorkspace(ws, dbRel);
    if (!fs.existsSync(dbPath)) return fail(`database not found: ${dbRel}`);
    const loader = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (p: string, o?: object) => { prepare(s: string): { all(...a: unknown[]): Array<Record<string, unknown>> }; close(): void } } }).getBuiltinModule("node:sqlite");
    const db = new loader.DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(sql).all().slice(0, 100);
      return ok(JSON.stringify(rows, null, 2).slice(0, 20_000) || "(0 rows)");
    } finally { try { db.close(); } catch { /* noop */ } }
  } catch (e) { return fail(String(e)); }
}

// ---------- api check ----------

export async function toolApiCheck(url: string, method = "GET", body?: string): Promise<ToolResult> {
  const t0 = Date.now();
  try {
    const { assertSafeUrl } = await import("../security/ssrf.js");
    assertSafeUrl(url);
    const m = method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(m)) return fail("invalid method");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method: m, signal: ctrl.signal,
        headers: { "user-agent": "teleagent/1.0", "content-type": "application/json" },
        body: ["POST", "PUT", "PATCH"].includes(m) ? (body ?? "") : undefined,
      });
      const text = await res.text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (["content-type", "x-request-id", "retry-after", "x-ratelimit-remaining"].includes(k)) headers[k] = v; });
      return ok(JSON.stringify({ status: res.status, ms: Date.now() - t0, bytes: text.length, headers, body: text.slice(0, 4000) }, null, 2));
    } finally { clearTimeout(t); }
  } catch (e) { return fail(String(e)); }
}

// ---------- secret scan (values redacted) ----------

// dash placed first/last in classes so no locale treats it as a range end
const SECRET_SCAN_RE = "(api[-_]?key|passwd|password|secret|token)\\s*[:=]\\s*['\"]?[^'\"\\s]+|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bpas]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----";

function redactLine(line: string): string {
  return line.replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-****")
    .replace(/ghp_[A-Za-z0-9]+/g, "ghp_****")
    .replace(/xox[bpas]-[A-Za-z0-9-]+/g, "xox****")
    .replace(/AKIA[0-9A-Z]{16}/g, "AKIA****")
    .replace(/([:=]\s*['"]?)[^'"\s]{4,}(['"]?)/g, "$1****$2");
}

export async function toolSecretScan(ws: string): Promise<ToolResult> {
  try {
    let lines: string[] = [];
    const r = await execArgs("git", ["grep", "-n", "-E", "-i", SECRET_SCAN_RE, "--", "."], ws, 60_000);
    if (r.success) {
      lines = (r.output ?? "").split("\n").filter(Boolean);
    } else {
      const g = await execArgs("grep", ["-rn", "-E", "-i", "-e", SECRET_SCAN_RE, ".", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist"], ws, 60_000);
      if (g.success) {
        lines = (g.output ?? "").split("\n").filter(Boolean);
      } else {
        // system grep missing/broken (Windows, odd locales) → pure-JS fallback
        lines = await jsGrep(ws, SECRET_SCAN_RE, { ignoreCase: true, maxHits: 100 });
      }
    }
    // ignore our own docs/tests that mention patterns innocuously? No — report all, redacted.
    const shown = lines.slice(0, 30).map(redactLine);
    if (lines.length === 0) return ok("✅ no secrets detected");
    return ok(`⚠️ ${lines.length} possible secret(s) — rotate + remove from history:\n` + shown.join("\n").slice(0, 6000));
  } catch (e) { return fail(String(e)); }
}

// ---------- outdated deps ----------

export async function toolOutdatedDeps(ws: string): Promise<ToolResult> {
  try {
    const pathMod = await import("node:path");
    const fsMod = await import("node:fs");
    if (fsMod.existsSync(pathMod.join(ws, "package.json"))) {
      const r = await execCommand("npm outdated --json", { cwd: ws, timeoutMs: 120_000 });
      const raw = (r.output ?? r.error ?? "{}").slice(0, 6000);
      try {
        const j = JSON.parse(raw || "{}") as Record<string, { current?: string; wanted?: string; latest?: string }>;
        const names = Object.keys(j);
        if (names.length === 0) return ok("✅ all dependencies up to date");
        return ok(`${names.length} outdated:\n` + names.slice(0, 20).map((n) => `- ${n}: ${j[n]?.current} → ${j[n]?.latest}`).join("\n"));
      } catch { return ok(raw.slice(0, 3000)); }
    }
    if (fsMod.existsSync(pathMod.join(ws, "requirements.txt"))) {
      const r = await execArgs("pip", ["list", "--outdated", "--format=json"], ws, 120_000);
      if (!r.success) return fail("pip outdated check failed");
      const arr = JSON.parse(r.output || "[]") as Array<{ name: string; version: string; latest_version: string }>;
      if (arr.length === 0) return ok("✅ all dependencies up to date");
      return ok(arr.slice(0, 20).map((p) => `- ${p.name}: ${p.version} → ${p.latest_version}`).join("\n"));
    }
    return fail("no supported manifest (package.json / requirements.txt)");
  } catch (e) { return fail(String(e)); }
}

// ---------- export session transcript ----------

export async function toolExportSession(ws: string, sessionId: string, outRel: string): Promise<ToolResult> {
  try {
    const out = assertInsideWorkspace(ws, outRel || "session-export.md");
    const msgs = store.messages(sessionId, 500);
    const md = `# session export (${sessionId.slice(0, 8)})\n\n` + msgs.map((m) => `## ${m.role}\n\n${m.content}\n`).join("\n");
    fs.writeFileSync(out, md.slice(0, 500_000), "utf8");
    return ok(`exported ${msgs.length} messages → ${outRel}`, { filesChanged: [outRel] });
  } catch (e) { return fail(String(e)); }
}

// ---------- rename symbol (word-boundary, dry-run default) ----------

export async function toolRenameSymbol(ws: string, oldName: string, newName: string, include?: string, dryRun = true): Promise<ToolResult> {
  if (!/^[\w$]{2,100}$/.test(oldName) || !/^[\w$]{2,100}$/.test(newName)) return fail("invalid symbol names");
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return toolSearchReplace(ws, `\\b${esc}\\b`, newName, include ?? "*.{ts,js,py,go,rs}", dryRun);
}

// ---------- dep add (deterministic installer) ----------

export async function toolDepAdd(ws: string, pkg: string, dev = false): Promise<ToolResult> {
  try {
    if (!/^[a-zA-Z0-9@/_+.-]{1,120}$/.test(pkg) || pkg.includes("..")) return fail("invalid package name");
    const pathMod = await import("node:path");
    const fsMod = await import("node:fs");
    if (fsMod.existsSync(pathMod.join(ws, "package.json"))) {
      const { detectPackageManager } = await import("./package-manager.js");
      const pm = detectPackageManager(ws);
      const args: Record<string, string[]> = {
        npm: dev ? ["install", "--save-dev", pkg] : ["install", pkg],
        pnpm: dev ? ["add", "-D", pkg] : ["add", pkg],
        yarn: dev ? ["add", "-D", pkg] : ["add", pkg],
        bun: dev ? ["add", "-d", pkg] : ["add", pkg],
      };
      return execArgs(pm, args[pm] ?? ["install", pkg], ws, 600_000);
    }
    if (fsMod.existsSync(pathMod.join(ws, "requirements.txt")) || fsMod.existsSync(pathMod.join(ws, "pyproject.toml"))) {
      return execArgs("pip", ["install", pkg], ws, 600_000);
    }
    if (fsMod.existsSync(pathMod.join(ws, "Cargo.toml"))) return execArgs("cargo", ["add", pkg], ws, 600_000);
    if (fsMod.existsSync(pathMod.join(ws, "go.mod"))) return execArgs("go", ["get", pkg], ws, 600_000);
    return fail("no supported manifest for dep_add");
  } catch (e) { return fail(String(e)); }
}

// ---------- shell batch ----------

export async function toolShellBatch(ws: string, commands: string[], stopOnError = true): Promise<ToolResult> {
  try {
    if (!Array.isArray(commands) || commands.length === 0 || commands.length > 10) return fail("commands[] required (1-10)");
    const parts: string[] = [];
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i] as string;
      const r = await execCommand(cmd, { cwd: ws, timeoutMs: 300_000 });
      parts.push(`$ [${i + 1}/${commands.length}] ${cmd}\n${(r.success ? r.output ?? "" : `FAILED: ${r.error ?? ""}`).slice(0, 8000)}`);
      if (!r.success && stopOnError) {
        parts.push(`(stopped at step ${i + 1})`);
        return fail(parts.join("\n\n").slice(0, 20_000));
      }
    }
    return ok(parts.join("\n\n").slice(0, 20_000));
  } catch (e) { return fail(String(e)); }
}

// ---------- repo clone (https/ssh only, no file:// or loopback) ----------

export async function toolRepoClone(ws: string, url: string, dest: string): Promise<ToolResult> {
  try {
    if (!/^https:\/\/[^/\s]+\/[^/\s]+/.test(url) && !/^git@[^:\s]+:[^/\s]+\/[^/\s]+/.test(url)) {
      return fail("only https:// or git@ URLs allowed (no file:// or local paths)");
    }
    if (/^https:\/\//.test(url)) {
      const { assertSafeUrl } = await import("../security/ssrf.js");
      assertSafeUrl(url); // blocks localhost/private/link-local
    }
    const target = assertInsideWorkspace(ws, dest);
    if (fs.existsSync(target)) return fail(`destination exists: ${dest}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const r = await execArgs("git", ["clone", "--depth", "1", url, target], ws, 600_000);
    return r.success ? ok(`cloned → ${dest}\n${(r.output ?? "").slice(0, 1000)}`) : fail((r.error ?? "clone failed").slice(0, 2000));
  } catch (e) { return fail(String(e)); }
}

// ---------- git worktrees (isolated parallel task dirs) ----------

export async function toolWorktreeCreate(ws: string, branch: string): Promise<ToolResult> {
  try {
    if (!/^[A-Za-z0-9/_.-]{1,100}$/.test(branch)) return fail("invalid branch name");
    const dir = path.join(ws, ".worktrees", branch.replace(/\//g, "-"));
    const rel = path.relative(ws, dir);
    if (fs.existsSync(dir)) return fail(`worktree dir exists: ${rel}`);
    fs.mkdirSync(path.join(ws, ".worktrees"), { recursive: true });
    const exists = await execArgs("git", ["rev-parse", "--verify", branch], ws, 15000);
    const args = exists.success ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir];
    const r = await execArgs("git", args, ws, 120_000);
    return r.success ? ok(`worktree ready: ${rel} @ ${branch}\nAgent can work here without touching the main checkout.`) : fail((r.error ?? "worktree failed").slice(0, 2000));
  } catch (e) { return fail(String(e)); }
}

export async function toolWorktreeList(ws: string): Promise<ToolResult> {
  return execArgs("git", ["worktree", "list", "--porcelain"], ws, 15000);
}

export async function toolWorktreeRemove(ws: string, dirRel: string, force = false): Promise<ToolResult> {
  try {
    const dir = assertInsideWorkspace(ws, dirRel);
    if (path.resolve(dir) === path.resolve(ws)) return fail("refusing to remove workspace root");
    const r = await execArgs("git", force ? ["worktree", "remove", "--force", dir] : ["worktree", "remove", dir], ws, 120_000);
    return r.success ? ok(`worktree removed: ${dirRel}`) : fail((r.error ?? "remove failed — commit or stash changes first, or force=true").slice(0, 2000));
  } catch (e) { return fail(String(e)); }
}

// ---------- github read tools ----------

export async function toolGithubIssues(owner: string, repo: string): Promise<ToolResult> {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return fail("invalid owner/repo");
  const { listIssues } = await import("../integrations/github.js");
  return listIssues(owner, repo);
}

export async function toolGithubPrs(owner: string, repo: string): Promise<ToolResult> {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) return fail("invalid owner/repo");
  const { listPulls } = await import("../integrations/github.js");
  return listPulls(owner, repo);
}

export async function toolGithubPrDiff(owner: string, repo: string, number: number): Promise<ToolResult> {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || !Number.isInteger(number) || number <= 0) {
    return fail("invalid owner/repo/number");
  }
  const { ghPrDiff } = await import("../integrations/github.js");
  return ghPrDiff(owner, repo, number);
}

// ---------- coverage ----------

export async function toolCoverage(ws: string): Promise<ToolResult> {
  const attempts: Array<{ label: string; cmd: string }> = [
    { label: "vitest", cmd: "npx --yes vitest run --coverage" },
    { label: "c8", cmd: "npx --yes c8 npm test" },
    { label: "pytest-cov", cmd: "pytest --cov --cov-report=term-missing -q" },
    { label: "go-cover", cmd: "go test -cover ./..." },
  ];
  const tried: string[] = [];
  for (const a of attempts) {
    const r = await execCommand(a.cmd, { cwd: ws, timeoutMs: 600_000 });
    tried.push(a.label);
    if (/No test files found|coverage.*not|command not found|No such|ERROR: .*cov|unknown flag/i.test((r.output ?? "") + (r.error ?? ""))) continue;
    if ((r.output ?? "").trim() || r.success) {
      return { success: r.success, output: `[${a.label}]\n` + (r.output ?? r.error ?? "").slice(0, 8000), error: r.success ? undefined : (r.error ?? "").slice(0, 2000), metadata: r.metadata };
    }
  }
  return fail(`no coverage runner worked here (tried: ${tried.join(", ")})`);
}

// ---------- download / archive create ----------

export async function toolDownload(url: string, destRel: string, ws: string, timeoutMs = 120_000): Promise<ToolResult> {
  try {
    const { downloadFile } = await import("./http.js");
    const { assertInsideWorkspace } = await import("../workspace/manager.js");
    const trusted: string[] = [];
    const dest = assertInsideWorkspace(ws, destRel);
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    fsMod.mkdirSync(pathMod.dirname(dest), { recursive: true });
    void trusted;
    return downloadFile(url, dest, timeoutMs);
  } catch (e) { return fail(String(e)); }
}

export async function toolZipCreate(ws: string, paths: string[], outRel: string): Promise<ToolResult> {
  try {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 50) return fail("paths[] required (1-50)");
    const { assertInsideWorkspace } = await import("../workspace/manager.js");
    const out = assertInsideWorkspace(ws, outRel);
    const safe = paths.map((p) => assertInsideWorkspace(ws, p));
    const rel = safe.map((p) => path.relative(ws, p));
    const fsMod = await import("node:fs");
    fsMod.mkdirSync(path.dirname(out), { recursive: true });
    const low = out.toLowerCase();
    if (low.endsWith(".tar.gz") || low.endsWith(".tgz")) {
      await execFileAsync("tar", ["-czf", out, "-C", ws, ...rel], { timeout: 300_000 });
    } else if (low.endsWith(".zip") && await commandExists("python3")) {
      await execFileAsync("python3", ["-c",
        "import zipfile,sys,os\nws, out, files = sys.argv[1], sys.argv[2], sys.argv[3:]\nwith zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:\n for f in files:\n  full=os.path.join(ws,f)\n  z.write(full, f) if os.path.isfile(full) else [z.write(os.path.join(r,fn), os.path.relpath(os.path.join(r,fn), ws)) for r,_,fs in os.walk(full) for fn in fs]",
        ws, out, ...rel], { timeout: 300_000 });
    } else if (low.endsWith(".zip")) {
      await execFileAsync("tar", ["-caf", out, "-C", ws, ...rel], { timeout: 300_000 });
    } else {
      return fail("output must end with .tar.gz, .tgz or .zip");
    }
    const st = fs.statSync(out);
    return ok(`created ${outRel} (${st.size} bytes)`, { filesChanged: [outRel] });
  } catch (e) { return fail(String(e)); }
}

// ---------- search & replace across files ----------

export async function toolSearchReplace(ws: string, pattern: string, replacement: string, include = "*.{ts,js,py,go,rs}", dryRun = true, maxFiles = 20): Promise<ToolResult> {
  try {
    const re = new RegExp(pattern, "g");
    const { globFiles } = await import("./search.js");
    void globFiles;
    const { execArgs: ea } = await import("./shell.js");
    // candidate files via grep
    const grep = await ea("grep", ["-rl", "-e", pattern, "."], ws, 60_000);
    if (!grep.success) return ok("no matches found");
    let files = (grep.output ?? "").split("\n").map((s) => s.trim().replace(/^\.\//, "")).filter(Boolean);
    if (include) {
      const incRe = new RegExp("^" + include.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\{[^}]*\}/g, (m) => `(?:${m.slice(1, -1).replace(/,/g, "|")})`).replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      files = files.filter((f) => incRe.test(f) || incRe.test("x." + f.split(".").pop()));
    }
    files = files.slice(0, maxFiles);
    const report: string[] = [];
    let total = 0;
    for (const f of files) {
      const resolved = assertInsideWorkspace(ws, f);
      let cur: string;
      try { cur = fs.readFileSync(resolved, "utf8"); } catch { continue; }
      const n = (cur.match(re) ?? []).length;
      if (n === 0) continue;
      total += n;
      report.push(`${f}: ${n} occurrence(s)${dryRun ? " (dry-run)" : " REPLACED"}`);
      if (!dryRun) fs.writeFileSync(resolved, cur.replace(re, replacement), "utf8");
    }
    if (report.length === 0) return ok("no matches found");
    return ok(`${dryRun ? "[dry-run] would replace" : "replaced"} ${total} occurrence(s) in ${report.length} file(s):\n` + report.join("\n"),
      dryRun ? undefined : { filesChanged: files });
  } catch (e) { return fail(String(e)); }
}

// ---------- symbol outline (offline code map, no graphify needed) ----------

const SYMBOL_RES: Array<{ lang: string; res: RegExp[] }> = [
  { lang: "ts/js", res: [/^\s*export\s+(async\s+)?(function|class|const|interface|type|enum)\s+([\w$]+)/, /^\s*(async\s+)?function\s+([\w$]+)/, /^\s*class\s+([\w$]+)/, /^\s*(?:export\s+default\s+)?(?:async\s+)?([\w$]+)\s*=\s*\(.*\)\s*=>/, /^\s{0,4}(?:public|private|protected)?\s*(?:async\s+)?([\w$]+)\s*\(.*\)\s*\{/] },
  { lang: "py", res: [/^\s*(async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/] },
  { lang: "go", res: [/^\s*func\s+(?:\([^)]*\)\s*)?(\w+)/, /^\s*type\s+(\w+)/] },
  { lang: "rs", res: [/^\s*(?:pub\s+)?fn\s+(\w+)/, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/] },
  { lang: "java/kt", res: [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum|fun)\s+(\w+)/, /^\s*(?:public|private|protected)?\s*[\w<>\[\]]+\s+(\w+)\s*\(/] },
];

export async function toolSymbolOutline(ws: string, target: string, maxSymbols = 100): Promise<ToolResult> {
  try {
    const resolved = assertInsideWorkspace(ws, target);
    const lines = fs.readFileSync(resolved, "utf8").split("\n");
    const out: string[] = [];
    lines.forEach((line, i) => {
      for (const { res } of SYMBOL_RES) {
        for (const re of res) {
          const m = re.exec(line);
          const name = m?.[m.length - 1];
          if (name && !/^(if|for|while|switch|catch|return)$/.test(name)) {
            out.push(`L${i + 1} ${name}`);
            break;
          }
        }
        if (out.length >= maxSymbols) break;
      }
    });
    return ok(out.length ? out.slice(0, maxSymbols).join("\n") : "(no symbols detected)");
  } catch (e) { return fail(String(e)); }
}

// ---------- web search (keyless, best-effort) ----------

export async function toolWebSearch(query: string, maxResults = 5): Promise<ToolResult> {
  try {
    const { assertSafeUrl } = await import("../security/ssrf.js");
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    assertSafeUrl(url);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; teleagent/1.0)" } });
      if (!res.ok) return fail(`search HTTP ${res.status}`);
      const html = await res.text();
      const results: string[] = [];
      const re = /<a[^>]+href="([^"]+)"[^>]*>([^<]{5,200})<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && results.length < Math.min(Math.max(maxResults, 1), 10)) {
        const href = m[1] ?? "";
        const title = (m[2] ?? "").trim();
        if (!href.startsWith("http") || /duckduckgo\.com/i.test(href)) continue;
        results.push(`- ${title}\n  ${href}`);
      }
      if (results.length === 0) return fail("no results (search backend may be blocking automated queries)");
      return ok(results.join("\n"));
    } finally { clearTimeout(t); }
  } catch (e) { return fail(String(e)); }
}

// ---------- dependency audit / format / lint / typecheck ----------

export async function toolAuditDeps(ws: string): Promise<ToolResult> {
  try {
    const pathMod = await import("node:path");
    const fsMod = await import("node:fs");
    if (fsMod.existsSync(pathMod.join(ws, "package.json"))) {
      const r = await execCommand("npm audit --json", { cwd: ws, timeoutMs: 120_000 });
      const raw = (r.output ?? r.error ?? "").slice(0, 8000);
      try {
        const j = JSON.parse(raw) as { metadata?: { vulnerabilities?: Record<string, number> } };
        const v = j.metadata?.vulnerabilities;
        if (v) return ok(`npm audit: ${JSON.stringify(v)}`, { exitCode: r.metadata?.exitCode });
      } catch { /* fallthrough with raw */ }
      return r.success ? ok(raw.slice(0, 4000)) : fail(`npm audit found issues:\n${raw.slice(0, 4000)}`);
    }
    if (fsMod.existsSync(pathMod.join(ws, "requirements.txt")) || fsMod.existsSync(pathMod.join(ws, "pyproject.toml"))) {
      const r = await execArgs("pip", ["audit"], ws, 120_000);
      return r.success ? ok((r.output ?? "").slice(0, 4000)) : fail((r.error ?? "pip audit unavailable").slice(0, 2000));
    }
    if (fsMod.existsSync(pathMod.join(ws, "Cargo.toml"))) {
      const r = await execArgs("cargo", ["audit"], ws, 120_000);
      return r.success ? ok((r.output ?? "").slice(0, 4000)) : fail((r.error ?? "cargo-audit not installed").slice(0, 2000));
    }
    return fail("no supported manifest (package.json / requirements / Cargo.toml)");
  } catch (e) { return fail(String(e)); }
}

export async function toolFormatCode(ws: string): Promise<ToolResult> {
  const ran: string[] = [];
  const failed: string[] = [];
  const tryRun = async (label: string, cmd: string) => {
    const r = await execCommand(cmd, { cwd: ws, timeoutMs: 180_000 });
    if (r.success) ran.push(label);
    else if (!/not found|command not found|No such/i.test(r.error ?? "")) failed.push(`${label}: ${(r.error ?? "").slice(0, 200)}`);
  };
  const profile = detectProjectProfile(ws);
  if (profile.language === "typescript" || profile.framework) await tryRun("prettier", "npx --yes prettier --write .");
  if (profile.language === "python") await tryRun("black", "black .");
  if (profile.language === "go") await tryRun("gofmt", "gofmt -w .");
  if (profile.language === "rust") await tryRun("cargo-fmt", "cargo fmt");
  if (ran.length === 0 && failed.length === 0) return fail("no formatter available for this workspace");
  if (failed.length) return fail(`formatters failed:\n${failed.join("\n")}`);
  return ok(`formatted with: ${ran.join(", ")}`);
}

export async function toolLint(ws: string): Promise<ToolResult> {
  const profile = detectProjectProfile(ws);
  if (!profile.lintCommand) return fail("no lint command detected for this workspace");
  const r = await execCommand(profile.lintCommand, { cwd: ws, timeoutMs: 300_000 });
  return { success: r.success, output: r.output?.slice(0, 8000), error: r.error?.slice(0, 4000), metadata: r.metadata };
}

export async function toolTypecheck(ws: string): Promise<ToolResult> {
  const profile = detectProjectProfile(ws);
  if (!profile.typecheckCommand) return fail("no typecheck command detected for this workspace");
  const r = await execCommand(profile.typecheckCommand, { cwd: ws, timeoutMs: 300_000 });
  return { success: r.success, output: r.output?.slice(0, 8000), error: r.error?.slice(0, 4000), metadata: r.metadata };
}

// ---------- git stash / doctor / quota for the agent ----------

export async function toolGitStash(cwd: string, message?: string): Promise<ToolResult> {
  return execArgs("git", ["stash", "push", "-m", message || `teleagent-${Date.now()}`], cwd, 60_000);
}

export async function toolDoctor(): Promise<ToolResult> {
  try {
    const { checkHealth } = await import("../observability/health.js");
    return ok(JSON.stringify(await checkHealth(), null, 2).slice(0, 6000));
  } catch (e) { return fail(String(e)); }
}

export async function toolQuotaStatus(userId: string): Promise<ToolResult> {
  try {
    const env = getEnv();
    const used = store.dailyTokens(userId);
    const totals = store.usageTotals(userId);
    return ok(JSON.stringify({
      daily: { used, limit: env.MAX_DAILY_TOKENS, remaining: Math.max(0, env.MAX_DAILY_TOKENS - used) },
      lifetime: totals.total,
    }, null, 2));
  } catch (e) { return fail(String(e)); }
}
