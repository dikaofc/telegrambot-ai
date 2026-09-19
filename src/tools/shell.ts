import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyCommand } from "../security/command-parser.js";
import { RiskLevel } from "../security/risk.js";
import type { ToolResult } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ShellOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: string;
}

function sandboxEnv(cwd: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: process.env.HOME ?? "/tmp",
    WORKSPACE: cwd,
    TEMP: "/tmp",
    ...extra,
  } as NodeJS.ProcessEnv;
}

export async function execCommand(command: string, opts: ShellOptions): Promise<ToolResult> {
  const verdict = classifyCommand(command);
  if (verdict.risk === RiskLevel.CRITICAL) {
    return { success: false, error: `blocked CRITICAL command: ${verdict.reasons.join("; ")}`, metadata: { exitCode: -1 } };
  }
  const started = Date.now();
  const timeout = opts.timeoutMs ?? 120_000;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: opts.cwd,
      env: sandboxEnv(opts.cwd, opts.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } }, 5000);
    }, timeout);
    child.stdout.on("data", (d) => { stdout += String(d); if (stdout.length > 500_000) stdout = stdout.slice(-500_000); });
    child.stderr.on("data", (d) => { stderr += String(d); if (stderr.length > 500_000) stderr = stderr.slice(-500_000); });
    if (opts.stdin) { child.stdin.write(opts.stdin); child.stdin.end(); }
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ success: false, error: String(e), metadata: { duration: Date.now() - started, exitCode: -1 } });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - started;
      const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).slice(-50_000);
      if (code === 0) resolve({ success: true, output, metadata: { duration, exitCode: 0 } });
      else resolve({ success: false, error: output || `exit ${code} signal ${signal}`, metadata: { duration, exitCode: code ?? -1 } });
    });
  });
}

export async function execArgs(file: string, args: string[], cwd: string, timeoutMs = 60_000): Promise<ToolResult> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    return { success: true, output: String(stdout) + (stderr ? `\n[stderr]\n${stderr}` : ""), metadata: { duration: Date.now() - started, exitCode: 0 } };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string; code?: number };
    return { success: false, error: String(err.stdout ?? "") + String(err.stderr ?? "") + String(err.message ?? e), metadata: { duration: Date.now() - started, exitCode: err.code ?? 1 } };
  }
}

export function interruptTree(pid: number): void {
  try { process.kill(-pid, "SIGINT"); } catch { try { process.kill(pid, "SIGINT"); } catch { /* noop */ } }
}
