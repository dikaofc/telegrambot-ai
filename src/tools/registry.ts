import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";
import * as fsTools from "./filesystem.js";
import { execCommand } from "./shell.js";
import { gitTools } from "./git.js";
import { globFiles, grepCode, findFiles, searchCode } from "./search.js";
import { httpGet, httpPost } from "./http.js";
import { runTest, runBuild, installDeps, detectPackageManager } from "./package-manager.js";
import { browserNavigate, browserExtract, hasBrowserWorker } from "./browser.js";
import { graphStatus, buildGraph, queryGraph, graphPath, explainNode } from "../integrations/graphify.js";
import * as ext from "./extended.js";

function def(name: string, description: string, schema: Record<string, unknown>, execute: ToolDefinition["execute"]): ToolDefinition {
  return { name, description, schema, execute };
}

export function buildRegistry(): Map<string, ToolDefinition> {
  const m = new Map<string, ToolDefinition>();
  const add = (d: ToolDefinition) => m.set(d.name, d);

  add(def("read_file", "Read a file inside the workspace", { target: "string" }, async (a, c) => fsTools.readFile(c.workspacePath, String(a.target))));
  add(def("write_file", "Write/create a file", { target: "string", content: "string" }, async (a, c) => fsTools.writeFile(c.workspacePath, String(a.target), String(a.content ?? ""))));
  add(def("edit_file", "Edit a file by exact string replacement", { target: "string", oldText: "string", newText: "string" }, async (a, c) => fsTools.editFile(c.workspacePath, String(a.target), String(a.oldText), String(a.newText), Boolean(a.replaceAll))));
  add(def("delete_file", "Delete a file", { target: "string" }, async (a, c) => fsTools.deleteFile(c.workspacePath, String(a.target))));
  add(def("move_file", "Move a file", { src: "string", dest: "string" }, async (a, c) => fsTools.moveFile(c.workspacePath, String(a.src), String(a.dest))));
  add(def("copy_file", "Copy a file", { src: "string", dest: "string" }, async (a, c) => fsTools.copyFile(c.workspacePath, String(a.src), String(a.dest))));
  add(def("list_directory", "List directory", { target: "string?" }, async (a, c) => fsTools.listDirectory(c.workspacePath, String(a.target ?? "."))));
  add(def("file_exists", "Check existence", { target: "string" }, async (a, c) => fsTools.fileExists(c.workspacePath, String(a.target))));
  add(def("file_info", "File metadata", { target: "string" }, async (a, c) => fsTools.fileInfo(c.workspacePath, String(a.target))));
  add(def("glob", "Glob files", { pattern: "string" }, async (a, c) => globFiles(c.workspacePath, String(a.pattern))));
  add(def("find_files", "Find by name", { name: "string" }, async (a, c) => findFiles(c.workspacePath, String(a.name))));
  add(def("grep", "Grep pattern", { pattern: "string" }, async (a, c) => grepCode(c.workspacePath, String(a.pattern))));
  add(def("search_code", "Search code (rg/grep)", { query: "string" }, async (a, c) => searchCode(c.workspacePath, String(a.query))));
  add(def("shell", "Execute shell command (policy-gated)", { command: "string", timeoutMs: "number?" }, async (a, c): Promise<ToolResult> => execCommand(String(a.command), { cwd: c.workspacePath, timeoutMs: typeof a.timeoutMs === "number" ? a.timeoutMs as number : c.timeoutMs })));
  add(def("git_status", "git status", {}, async (_a, c) => gitTools.status(c.workspacePath)));
  add(def("git_diff", "git diff", {}, async (_a, c) => gitTools.diff(c.workspacePath)));
  add(def("git_log", "git log", {}, async (_a, c) => gitTools.log(c.workspacePath)));
  add(def("git_commit", "git add+commit", { message: "string", files: "string[]?" }, async (a, c) => {
    const files = Array.isArray(a.files) ? (a.files as string[]) : ["."];
    const addR = await gitTools.add(c.workspacePath, files);
    if (!addR.success) return addR;
    return gitTools.commit(c.workspacePath, String(a.message ?? "agent commit"));
  }));
  add(def("npm_test", "Run project tests (deterministic)", {}, async (_a, c) => runTest(c.workspacePath)));
  add(def("npm_build", "Run project build (deterministic)", {}, async (_a, c) => runBuild(c.workspacePath)));
  add(def("npm_install", "Install dependencies", {}, async (_a, c) => installDeps(c.workspacePath)));
  add(def("detect_pm", "Detect package manager", {}, async (_a, c) => ({ success: true, output: detectPackageManager(c.workspacePath) })));
  add(def("http_get", "HTTP GET (SSRF-protected)", { url: "string" }, async (a) => httpGet(String(a.url))));
  add(def("http_post", "HTTP POST (SSRF-protected)", { url: "string", body: "unknown?" }, async (a) => httpPost(String(a.url), a.body)));
  add(def("browser_navigate", "Browser navigate (needs worker)", { url: "string" }, async (a) => browserNavigate(String(a.url))));
  add(def("browser_extract", "Browser extract text (needs worker)", { selector: "string?" }, async (a) => browserExtract(a.selector === undefined ? undefined : String(a.selector))));
  // knowledge-graph harness (Graphify CLI; code indexing is local/offline)
  add(def("graphify_status", "Knowledge-graph status for workspace (nodes/edges/built)", {}, async (_a, c) => {
    const s = await graphStatus(c.workspacePath);
    return { success: true, output: JSON.stringify(s, null, 2) };
  }));
  add(def("graphify_build", "Build/update workspace knowledge graph (local AST, offline)", { updateOnly: "boolean?" }, async (a, c) => buildGraph(c.workspacePath, Boolean(a.updateOnly))));
  add(def("graphify_query", "Ask the knowledge graph a plain-language question", { question: "string" }, async (a, c) => queryGraph(c.workspacePath, String(a.question))));
  add(def("graphify_path", "Shortest path between two concepts in the graph", { from: "string", to: "string" }, async (a, c) => graphPath(c.workspacePath, String(a.from), String(a.to))));
  add(def("graphify_explain", "Explain one concept: definition, location, connections", { symbol: "string" }, async (a, c) => explainNode(c.workspacePath, String(a.symbol))));
  // ---- extended power tools ----
  add(def("read_many", "Read up to 10 files at once (bounded, truncated)", { files: "string[]" }, async (a, c) => ext.readMany(c.workspacePath, Array.isArray(a.files) ? (a.files as string[]) : [])));
  add(def("tree", "Directory tree with sizes (skips node_modules/.git/dist)", { target: "string?", depth: "number?" }, async (a, c) => ext.treeDir(c.workspacePath, String(a.target ?? "."), typeof a.depth === "number" ? a.depth as number : 3)));
  add(def("apply_patch", "Apply exact-match edits to many files atomically (all-or-nothing validation)", { items: "{file,oldText,newText}[]" }, async (a, c) => ext.applyPatch(c.workspacePath, Array.isArray(a.items) ? (a.items as ext.PatchItem[]) : [])));
  add(def("fetch_text", "Fetch a URL and return clean text (SSRF-protected, HTML stripped)", { url: "string" }, async (a) => ext.fetchText(String(a.url))));
  add(def("archive_extract", "Extract .zip/.tar.gz safely (traversal + zip-bomb guarded)", { file: "string", dest: "string?" }, async (a, c) => ext.extractArchive(
    (await import("../workspace/manager.js")).assertInsideWorkspace(c.workspacePath, String(a.file)),
    (await import("../workspace/manager.js")).assertInsideWorkspace(c.workspacePath, String(a.dest ?? "extracted")),
  )));
  add(def("shell_start", "Start a BACKGROUND shell session (dev servers, watch mode, long builds). Returns session id.", { command: "string" }, async (a, c) => {
    const { id } = ext.shellStart(String(a.command), c.workspacePath);
    return { success: true, output: `session ${id} started` };
  }));
  add(def("shell_poll", "Poll a background session for new output", { id: "string", lastSeen: "number?", tailChars: "number?" }, async (a) => {
    try {
      const r = ext.shellPoll(String(a.id), typeof a.lastSeen === "number" ? a.lastSeen as number : 0, typeof a.tailChars === "number" ? a.tailChars as number : 20000);
      return { success: true, output: JSON.stringify({ running: r.running, exitCode: r.exitCode, output: r.chunk.slice(-20000) }) + `\n[newLastSeen=${r.newLastSeen}]` };
    } catch (e) { return { success: false, error: String(e) }; }
  }));
  add(def("shell_input", "Send stdin to a background session", { id: "string", data: "string" }, async (a) => {
    try { ext.shellInput(String(a.id), String(a.data ?? "")); return { success: true, output: "sent" }; }
    catch (e) { return { success: false, error: String(e) }; }
  }));
  add(def("shell_kill", "Terminate a background session", { id: "string" }, async (a) => ({ success: true, output: String(ext.shellKill(String(a.id))) })));
  add(def("todo_write", "Persist a task plan (statuses: pending/in_progress/completed)", { todos: "{content,status}[]" }, async (a, c) => {
    try { ext.writeTodos(c.sessionId ?? "global", Array.isArray(a.todos) ? (a.todos as ext.TodoItem[]) : []); return { success: true, output: "todos saved" }; }
    catch (e) { return { success: false, error: String(e) }; }
  }));
  add(def("todo_list", "Read the current task plan", {}, async (_a, c) => ({ success: true, output: JSON.stringify(ext.listTodos(c.sessionId ?? "global"), null, 2) })));
  add(def("checkpoint_create", "Snapshot workspace (git state + changed files) before big changes", {}, async (_a, c) => ext.toolCheckpointCreate(c.workspacePath, c.sessionId ?? "", c.runId ?? "")));
  add(def("checkpoint_restore", "Restore workspace to a git commit (stashes current work first)", { commit: "string(git SHA)" }, async (a, c) => ext.toolCheckpointRestore(c.workspacePath, String(a.commit))));
  add(def("memory_remember", "Save a durable fact (never secrets) to session/workspace memory", { key: "string", value: "string", scope: "session|workspace?" }, async (a, c) => ext.toolMemoryRemember(c.sessionId ?? "", c.workspacePath, String(a.key), String(a.value ?? ""), String(a.scope ?? "session"))));
  add(def("memory_recall", "Recall durable facts from session/workspace memory", { scope: "session|workspace?" }, async (a, c) => ext.toolMemoryRecall(c.sessionId ?? "", c.workspacePath, String(a.scope ?? "session"))));
  add(def("project_profile", "Detect language/framework/pm/test/build commands + git state", {}, async (_a, c) => ext.toolProjectProfile(c.workspacePath)));
  add(def("env_info", "Safe runtime info (no secrets): limits, defaults, workspace", {}, async (_a, c) => ext.toolEnvInfo(c.workspacePath)));
  add(def("process_list", "List OS processes (top 40)", {}, async () => ext.toolProcessList()));
  add(def("process_kill", "SIGTERM a process by pid", { pid: "number" }, async (a) => ext.toolProcessKill(Number(a.pid))));
  add(def("git_branch", "Create + checkout a branch", { name: "string" }, async (a, c) => ext.toolGitBranch(c.workspacePath, String(a.name))));
  add(def("git_checkout", "Checkout a branch/commit", { ref: "string" }, async (a, c) => ext.toolGitCheckout(c.workspacePath, String(a.ref))));
  add(def("git_log", "Recent commits", { n: "number?" }, async (a, c) => ext.toolGitLog(c.workspacePath, typeof a.n === "number" ? a.n as number : 10)));
  add(def("git_show", "Show a commit or file at a ref", { ref: "string", file: "string?" }, async (a, c) => ext.toolGitShow(c.workspacePath, String(a.ref), a.file === undefined ? undefined : String(a.file))));
  // ---- web + supply chain + code intelligence ----
  add(def("http_download", "Download a URL into the workspace (SSRF-protected)", { url: "string", dest: "string" }, async (a, c) => ext.toolDownload(String(a.url), String(a.dest), c.workspacePath)));
  add(def("zip_create", "Archive workspace paths into .tar.gz/.zip (to send results back)", { paths: "string[]", out: "string" }, async (a, c) => ext.toolZipCreate(c.workspacePath, Array.isArray(a.paths) ? (a.paths as string[]) : [], String(a.out))));
  add(def("search_replace", "Regex find/replace across files (dryRun first!)", { pattern: "string", replacement: "string", include: "string?", dryRun: "boolean?" }, async (a, c) => ext.toolSearchReplace(c.workspacePath, String(a.pattern), String(a.replacement ?? ""), a.include === undefined ? undefined : String(a.include), a.dryRun === undefined ? true : Boolean(a.dryRun))));
  add(def("symbol_outline", "Offline symbol map of one file (functions/classes with line numbers)", { target: "string" }, async (a, c) => ext.toolSymbolOutline(c.workspacePath, String(a.target))));
  add(def("web_search", "Keyless web search (best-effort docs lookup)", { query: "string" }, async (a) => ext.toolWebSearch(String(a.query))));
  add(def("audit_deps", "Dependency vulnerability audit (npm/pip/cargo)", {}, async (_a, c) => ext.toolAuditDeps(c.workspacePath)));
  add(def("format_code", "Run project formatter (prettier/black/gofmt/cargo fmt)", {}, async (_a, c) => ext.toolFormatCode(c.workspacePath)));
  add(def("lint_tool", "Run project lint command", {}, async (_a, c) => ext.toolLint(c.workspacePath)));
  add(def("typecheck_tool", "Run project typecheck command", {}, async (_a, c) => ext.toolTypecheck(c.workspacePath)));
  add(def("git_stash", "Stash current changes with a message", { message: "string?" }, async (a, c) => ext.toolGitStash(c.workspacePath, a.message === undefined ? undefined : String(a.message))));
  add(def("doctor_check", "Self-diagnose: telegram/db/provider/sandbox/workspace/pty", {}, async () => ext.toolDoctor()));
  add(def("quota_status", "Token quota + usage for current user", {}, async (_a, c) => ext.toolQuotaStatus(c.userId ?? "")));
  return m;
}

export function toolSchemasForLLM(registry: Map<string, ToolDefinition>): Array<{ name: string; description: string; schema: Record<string, unknown> }> {
  const out: Array<{ name: string; description: string; schema: Record<string, unknown> }> = [];
  for (const d of registry.values()) {
    if (d.name === "browser_navigate" || d.name === "browser_extract") {
      if (!hasBrowserWorker()) continue; // LLM only sees available tools
    }
    out.push({ name: d.name, description: d.description, schema: d.schema });
  }
  return out;
}
