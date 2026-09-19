import { execArgs } from "./shell.js";
import type { ToolResult } from "./types.js";

async function git(cwd: string, args: string[]): Promise<ToolResult> {
  return execArgs("git", args, cwd);
}

export const gitTools = {
  status: (cwd: string) => git(cwd, ["status", "--short", "--branch"]),
  diff: (cwd: string, extra: string[] = []) => git(cwd, ["diff", ...extra]),
  log: (cwd: string, n = 20) => git(cwd, ["log", `--max-count=${n}`, "--oneline"]),
  branch: (cwd: string) => git(cwd, ["branch", "-a"]),
  add: (cwd: string, files: string[]) => git(cwd, ["add", ...files]),
  commit: (cwd: string, message: string) => git(cwd, ["commit", "-m", message]),
  push: (cwd: string, remote = "origin", branch = "HEAD") => git(cwd, ["push", remote, branch]),
  pull: (cwd: string) => git(cwd, ["pull", "--ff-only"]),
  checkout: (cwd: string, ref: string) => git(cwd, ["checkout", ref]),
  currentCommit: async (cwd: string): Promise<string | null> => {
    const r = await git(cwd, ["rev-parse", "HEAD"]);
    if (!r.success) return null;
    return (r.output ?? "").trim() || null;
  },
  isDirty: async (cwd: string): Promise<boolean> => {
    const r = await git(cwd, ["status", "--porcelain"]);
    return r.success && (r.output ?? "").trim().length > 0;
  },
  currentBranch: async (cwd: string): Promise<string | null> => {
    const r = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!r.success) return null;
    return (r.output ?? "").trim() || null;
  },
};
