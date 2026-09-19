import { execArgs } from "../tools/shell.js";
import { store } from "../database/store.js";

/** Checkpoint: git commit snapshot + changed-file list before big changes. */
export async function createCheckpoint(runId: string, workspaceId: string, workspacePath: string): Promise<string> {
  const commit = await execArgs("git", ["rev-parse", "HEAD"], workspacePath, 10_000);
  const status = await execArgs("git", ["status", "--porcelain"], workspacePath, 10_000);
  const files = (status.success ? status.output ?? "" : "").split("\n").filter(Boolean).map((l) => l.slice(3));
  return store.saveCheckpoint(runId, workspaceId, commit.success ? (commit.output ?? "").trim() : null, files);
}

export async function rollbackToCommit(workspacePath: string, commit: string): Promise<{ ok: boolean; output: string }> {
  const r = await execArgs("git", ["stash", "push", "-m", "teleagent-checkpoint"], workspacePath, 30_000);
  const c = await execArgs("git", ["checkout", commit], workspacePath, 30_000);
  return { ok: c.success, output: `${r.output ?? ""}\n${c.output ?? c.error ?? ""}`.slice(0, 3000) };
}
