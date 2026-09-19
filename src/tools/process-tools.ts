import { execArgs, execCommand } from "./shell.js";
import type { ToolResult } from "./types.js";

const active = new Map<number, { cmd: string; started: number }>();

export async function listProcesses(): Promise<ToolResult> {
  return execArgs("ps", ["-eo", "pid,etimes,comm,args"], process.cwd(), 10_000);
}

export async function killProcess(pid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<ToolResult> {
  try {
    process.kill(pid, signal);
    active.delete(pid);
    return { success: true, output: `signal ${signal} sent to ${pid}` };
  } catch (e) { return { success: false, error: String(e) }; }
}

export function trackProcess(pid: number, cmd: string): void {
  active.set(pid, { cmd, started: Date.now() });
  if (active.size > 500) { const k = active.keys().next().value as number; active.delete(k); }
}

export function activeProcesses(): Array<{ pid: number; cmd: string; started: number }> {
  return [...active.entries()].map(([pid, v]) => ({ pid, ...v }));
}

export async function dockerPs(): Promise<ToolResult> {
  return execCommand("docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'", { cwd: process.cwd(), timeoutMs: 15_000 });
}
