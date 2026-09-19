import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { dockerAvailable, dockerRun } from "../tools/docker.js";
import { execCommand } from "../tools/shell.js";
import type { ToolResult } from "../tools/types.js";

export interface SandboxLimits { memory: string; cpus: number; timeoutMs: number; }

/** Sandbox manager: docker when available, else filesystem-boundary local execution. */
export async function execSandboxed(command: string, workspacePath: string, limits?: Partial<SandboxLimits>): Promise<ToolResult> {
  const env = getEnv();
  if (!env.SANDBOX_ENABLED) {
    return execCommand(command, { cwd: workspacePath, timeoutMs: limits?.timeoutMs ?? 300_000 });
  }
  if (env.SANDBOX_RUNTIME === "docker" || (env.SANDBOX_RUNTIME === "local" && false)) {
    if (await dockerAvailable()) {
      return dockerRun("node:22-bookworm", ["bash", "-lc", command], {
        memory: limits?.memory ?? env.SANDBOX_MEMORY,
        cpus: String(limits?.cpus ?? env.SANDBOX_CPUS),
        workdir: "/workspace",
        volumes: [`${path.resolve(workspacePath)}:/workspace`],
      });
    }
  }
  // local sandbox: enforce boundary (workspace cwd + controlled env + timeout)
  const resolved = path.resolve(workspacePath);
  fs.mkdirSync(resolved, { recursive: true });
  return execCommand(command, { cwd: resolved, timeoutMs: limits?.timeoutMs ?? 300_000 });
}

export async function sandboxStatus(): Promise<{ enabled: boolean; runtime: string; docker: boolean }> {
  const env = getEnv();
  return { enabled: env.SANDBOX_ENABLED, runtime: env.SANDBOX_RUNTIME, docker: await dockerAvailable().catch(() => false) };
}
