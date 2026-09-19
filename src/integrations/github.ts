import { execArgs } from "../tools/shell.js";
import type { ToolResult } from "../tools/types.js";

/** GitHub integration (token-based). Read allowed; write/merge gated by approval upstream. */
function headers(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? "";
  return token ? { authorization: `Bearer ${token}`, "user-agent": "teleagent/1.0" } : { "user-agent": "teleagent/1.0" };
}

export async function ghApi(pathname: string): Promise<ToolResult> {
  try {
    const res = await fetch(`https://api.github.com${pathname}`, { headers: headers() });
    const text = await res.text();
    return res.ok ? { success: true, output: text.slice(0, 50_000) } : { success: false, error: `GitHub ${res.status}: ${text.slice(0, 1000)}` };
  } catch (e) { return { success: false, error: String(e) }; }
}

export async function createBranch(cwd: string, name: string): Promise<ToolResult> {
  return execArgs("git", ["checkout", "-b", name], cwd, 30_000);
}

export async function listIssues(owner: string, repo: string): Promise<ToolResult> {
  return ghApi(`/repos/${owner}/${repo}/issues?state=open&per_page=20`);
}

export async function listPulls(owner: string, repo: string): Promise<ToolResult> {
  return ghApi(`/repos/${owner}/${repo}/pulls?state=open&per_page=20`);
}

export async function ghPrDiff(owner: string, repo: string, number: number): Promise<ToolResult> {
  try {
    const token = process.env.GITHUB_TOKEN ?? "";
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "user-agent": "teleagent/1.0",
        accept: "application/vnd.github.diff",
      },
    });
    const text = await res.text();
    return res.ok ? { success: true, output: text.slice(0, 30_000) } : { success: false, error: `GitHub ${res.status}: ${text.slice(0, 500)}` };
  } catch (e) { return { success: false, error: String(e) }; }
}
