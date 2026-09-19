import type { ToolDefinition } from "./types.js";
import type { PlanPhase } from "../agent/planner.js";

/**
 * Tool capability metadata + selection.
 *
 * Sending all ~90 tool schemas on every request costs tokens, confuses small
 * models, and invites write calls before the agent has even read the code. Each
 * tool therefore has a category and a mutability flag, and the runtime only
 * exposes the subset that the current plan phase actually needs.
 */

export type ToolCategory =
  | "files" | "search" | "shell" | "git" | "verify" | "graph" | "data"
  | "web" | "supply" | "source" | "plan" | "system" | "subagent" | "meta";

export type TaskKind = "coding" | "reasoning" | "chat";

/**
 * Categories are declared per tool name. Everything unknown falls back to
 * "meta" and stays visible: never hide a tool we don't understand.
 */
const CATEGORY: Record<string, ToolCategory> = {
  // files
  read_file: "files", write_file: "files", edit_file: "files", delete_file: "files",
  move_file: "files", copy_file: "files", list_directory: "files", tree: "files",
  read_many: "files", apply_patch: "files", archive_extract: "files", zip_create: "files",
  file_exists: "files", file_info: "files", search_replace: "files", rename_symbol: "files",
  // search / navigation
  glob: "search", find_files: "search", grep: "search", search_code: "search",
  find_definition: "search", find_references: "search", symbol_outline: "search",
  call_hierarchy: "search", import_graph: "search", lsp_hover: "search",
  // shell / processes
  shell: "shell", shell_start: "shell", shell_poll: "shell", shell_input: "shell",
  shell_kill: "shell", shell_batch: "shell", process_list: "system", process_kill: "system",
  perf_benchmark: "verify",
  // git
  git_status: "git", git_diff: "git", git_log: "git", git_show: "git", git_branch: "git",
  git_checkout: "git", git_commit: "git", git_stash: "git", git_blame: "git",
  git_file_history: "git", git_worktree_create: "git", git_worktree_list: "git",
  git_worktree_remove: "git", repo_clone: "source",
  // verification
  npm_test: "verify", npm_build: "verify", lint_tool: "verify", typecheck_tool: "verify",
  format_code: "verify", coverage_report: "verify", full_verify: "verify",
  dead_code_report: "verify", bundle_size: "verify", type_coverage: "verify",
  test_flakiness: "verify", code_metrics: "verify", docgen: "verify",
  // knowledge graph
  graphify_status: "graph", graphify_build: "graph", graphify_query: "graph",
  graphify_path: "graph", graphify_explain: "graph",
  // data
  sqlite_query: "data", export_session: "data",
  // web / research
  http_get: "web", http_post: "web", http_download: "web", fetch_text: "web",
  web_search: "web", api_check: "web", browser_navigate: "web", browser_extract: "web",
  // supply chain
  npm_install: "supply", dep_add: "supply", audit_deps: "supply", outdated_deps: "supply",
  secret_scan: "supply", security_full_audit: "supply", dependency_update: "supply",
  // source hosting
  github_issues: "source", github_prs: "source", github_pr_diff: "source", pr_create: "source",
  // plan / memory / meta
  todo_write: "plan", todo_list: "plan", project_profile: "plan", env_info: "plan",
  memory_remember: "plan", memory_recall: "plan", checkpoint_create: "plan",
  checkpoint_restore: "plan", doctor_check: "system", quota_status: "system",
  scout: "subagent", workspace_snapshot: "meta",
};

/** Tools that modify workspace state or the host. Used for checkpointing + risk. */
const MUTATING = new Set([
  "write_file", "edit_file", "delete_file", "move_file", "copy_file", "apply_patch",
  "archive_extract", "zip_create", "search_replace", "rename_symbol", "shell",
  "shell_start", "shell_batch", "git_branch", "git_checkout", "git_commit", "git_stash",
  "git_worktree_create", "git_worktree_remove", "repo_clone", "npm_install", "dep_add",
  "dependency_update", "pr_create", "format_code", "workspace_snapshot", "checkpoint_restore",
  "export_session", "http_download", "browser_navigate",
]);

/** Read-only categories: safe to expose while the agent is still discovering. */
const DISCOVER_CATEGORIES: ToolCategory[] = ["files", "search", "graph", "data", "plan", "subagent", "system", "git"];

export function categoryOf(tool: string): ToolCategory {
  return CATEGORY[tool] ?? "meta";
}

export function isMutatingTool(tool: string): boolean {
  return MUTATING.has(tool);
}

export interface ToolMeta {
  name: string;
  category: ToolCategory;
  mutating: boolean;
}

export function toolMeta(name: string): ToolMeta {
  return { name, category: categoryOf(name), mutating: isMutatingTool(name) };
}

/**
 * Which tool *names* are visible for a task kind + plan phase.
 *
 * - chat: no tools at all (chat must never pay for tool schemas)
 * - reasoning: read-only discovery tools
 * - coding/discover: read-only tools (nothing can be written before reading)
 * - coding/implement: discovery + mutating + verification tools
 * - coding/verify: discovery + verification tools
 */
export function selectToolNames(taskKind: TaskKind, phase: PlanPhase, allNames?: Iterable<string>): string[] {
  if (taskKind === "chat") return [];
  const universe = allNames ? [...allNames] : Object.keys(CATEGORY);
  const visible = (n: string): boolean => {
    const cat = categoryOf(n);
    // Mutability always wins over category: a mutating tool is never handed out
    // to a read-only phase, whatever bucket it sits in.
    const mutating = isMutatingTool(n);
    if (taskKind === "reasoning") return !mutating && (DISCOVER_CATEGORIES.includes(cat) || cat === "web");
    // coding
    if (phase === "implement") return true;
    if (phase === "verify") return !mutating || cat === "verify";
    // discover: read-only, and verification tools stay out until a change exists
    return !mutating && cat !== "verify" && cat !== "supply";
  };
  return universe.filter(visible);
}

/** Filter the registry down to the schema list sent to the model. */
export function selectToolSchemas(
  registry: Map<string, ToolDefinition>,
  taskKind: TaskKind,
  phase: PlanPhase,
): Array<{ name: string; description: string; schema: Record<string, unknown> }> {
  const names = new Set(selectToolNames(taskKind, phase, registry.keys()));
  const out: Array<{ name: string; description: string; schema: Record<string, unknown> }> = [];
  for (const [name, d] of registry) {
    if (!names.has(name)) continue;
    out.push({ name, description: d.description, schema: d.schema });
  }
  return out;
}

/** Human-readable inventory (dashboard / TUI / doctor). */
export function toolInventory(registry: Map<string, ToolDefinition>): Array<ToolMeta & { description: string }> {
  return [...registry.values()].map((d) => ({ ...toolMeta(d.name), description: d.description }));
}
