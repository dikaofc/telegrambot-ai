export enum RiskLevel { SAFE = "SAFE", LOW = "LOW", MEDIUM = "MEDIUM", HIGH = "HIGH", CRITICAL = "CRITICAL" }

const TOOL_RISK: Record<string, RiskLevel> = {
  read_file: RiskLevel.SAFE,
  file_exists: RiskLevel.SAFE,
  file_info: RiskLevel.SAFE,
  list_directory: RiskLevel.SAFE,
  find_files: RiskLevel.SAFE,
  glob: RiskLevel.SAFE,
  grep: RiskLevel.SAFE,
  search_code: RiskLevel.SAFE,
  git_diff: RiskLevel.SAFE,
  git_status: RiskLevel.SAFE,
  git_log: RiskLevel.SAFE,
  write_file: RiskLevel.LOW,
  edit_file: RiskLevel.LOW,
  npm_test: RiskLevel.LOW,
  shell_safe: RiskLevel.LOW,
  http_get: RiskLevel.LOW,
  npm_install: RiskLevel.MEDIUM,
  pip_install: RiskLevel.MEDIUM,
  git_commit: RiskLevel.MEDIUM,
  git_checkout: RiskLevel.MEDIUM,
  http_post: RiskLevel.MEDIUM,
  docker_run: RiskLevel.MEDIUM,
  git_push: RiskLevel.HIGH,
  git_pull: RiskLevel.HIGH,
  shell: RiskLevel.HIGH,
  shell_start: RiskLevel.HIGH,
  shell_input: RiskLevel.HIGH,
  shell_kill: RiskLevel.HIGH,
  shell_batch: RiskLevel.HIGH,
  process_kill: RiskLevel.HIGH,
  checkpoint_restore: RiskLevel.HIGH,
  git_worktree_remove: RiskLevel.HIGH,
  read_many: RiskLevel.SAFE,
  tree: RiskLevel.SAFE,
  git_show: RiskLevel.SAFE,
  shell_poll: RiskLevel.SAFE,
  todo_write: RiskLevel.SAFE,
  todo_list: RiskLevel.SAFE,
  memory_recall: RiskLevel.SAFE,
  project_profile: RiskLevel.SAFE,
  env_info: RiskLevel.SAFE,
  process_list: RiskLevel.SAFE,
  graphify_status: RiskLevel.SAFE,
  graphify_query: RiskLevel.SAFE,
  graphify_path: RiskLevel.SAFE,
  graphify_explain: RiskLevel.SAFE,
  apply_patch: RiskLevel.LOW,
  fetch_text: RiskLevel.LOW,
  memory_remember: RiskLevel.LOW,
  checkpoint_create: RiskLevel.LOW,
  http_download: RiskLevel.LOW,
  zip_create: RiskLevel.LOW,
  search_replace: RiskLevel.LOW,
  web_search: RiskLevel.LOW,
  audit_deps: RiskLevel.LOW,
  format_code: RiskLevel.LOW,
  lint_tool: RiskLevel.LOW,
  typecheck_tool: RiskLevel.LOW,
  sqlite_query: RiskLevel.LOW,
  api_check: RiskLevel.LOW,
  export_session: RiskLevel.LOW,
  rename_symbol: RiskLevel.LOW,
  coverage_report: RiskLevel.LOW,
  github_issues: RiskLevel.LOW,
  github_prs: RiskLevel.LOW,
  github_pr_diff: RiskLevel.LOW,
  symbol_outline: RiskLevel.SAFE,
  doctor_check: RiskLevel.SAFE,
  quota_status: RiskLevel.SAFE,
  find_definition: RiskLevel.SAFE,
  find_references: RiskLevel.SAFE,
  scout: RiskLevel.SAFE,
  secret_scan: RiskLevel.SAFE,
  outdated_deps: RiskLevel.SAFE,
  git_worktree_list: RiskLevel.SAFE,
  archive_extract: RiskLevel.MEDIUM,
  git_branch: RiskLevel.MEDIUM,
  git_stash: RiskLevel.MEDIUM,
  graphify_build: RiskLevel.MEDIUM,
  dep_add: RiskLevel.MEDIUM,
  repo_clone: RiskLevel.MEDIUM,
  git_worktree_create: RiskLevel.MEDIUM,
};

export function toolRisk(tool: string): RiskLevel {
  return TOOL_RISK[tool] ?? RiskLevel.MEDIUM;
}

export type ApprovalDecision = "auto" | "ask" | "deny";

export function policyForRisk(risk: RiskLevel, overrides?: Record<string, ApprovalDecision>): ApprovalDecision {
  if (overrides) {
    const v = overrides[risk.toLowerCase()];
    if (v) return v;
  }
  switch (risk) {
    case RiskLevel.SAFE:
    case RiskLevel.LOW: return "auto";
    case RiskLevel.MEDIUM:
    case RiskLevel.HIGH: return "ask";
    case RiskLevel.CRITICAL: return "deny";
  }
}
