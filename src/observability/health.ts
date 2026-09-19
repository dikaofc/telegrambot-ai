import fs from "node:fs";
import { getEnv } from "../config/env.js";

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  telegram: boolean;
  database: boolean;
  sandbox: boolean;
  provider: boolean;
  workspace: boolean;
  pty: boolean;
  detail?: Record<string, string>;
}

/**
 * Probing pty spawns a shell, and /api/status is polled every few seconds by
 * the dashboard, so memoise the result briefly instead of forking a process
 * per poll. Availability of child_process effectively never changes at runtime.
 */
let ptyProbe: { at: number; ok: boolean; detail: string } | null = null;
const PTY_PROBE_TTL_MS = 30_000;

async function probePty(): Promise<{ ok: boolean; detail: string }> {
  if (ptyProbe && Date.now() - ptyProbe.at < PTY_PROBE_TTL_MS) return ptyProbe;
  let result: { ok: boolean; detail: string };
  try {
    await import("node:child_process").then((m) => m.execSync("echo pty-ok"));
    let detail = "child_process ok";
    try {
      // @ts-expect-error optional peer: node-pty may not be installed
      await import("node-pty").then(() => { detail = "node-pty available"; }).catch(() => { detail = "child_process fallback"; });
    } catch { /* fallback */ }
    result = { ok: true, detail };
  } catch (e) {
    result = { ok: false, detail: String(e) };
  }
  ptyProbe = { at: Date.now(), ...result };
  return result;
}

export function resetHealthCache(): void {
  ptyProbe = null;
}

export async function checkHealth(opts?: { checkProvider?: () => Promise<boolean> }): Promise<HealthStatus> {
  const env = getEnv();
  const detail: Record<string, string> = {};
  let telegram = Boolean(env.TELEGRAM_BOT_TOKEN);
  detail.telegram = telegram ? "token present" : "TELEGRAM_BOT_TOKEN missing";
  let database = true;
  try {
    const p = env.DATABASE_URL;
    if (p.startsWith("postgres")) {
      database = true;
      detail.database = "postgres configured (deferred check)";
    } else {
      const dir = p.replace(/\/[^/]*$/, "") || ".";
      fs.mkdirSync(dir === p ? "." : dir, { recursive: true });
      database = true;
      detail.database = "sqlite path writable";
    }
  } catch (e) {
    database = false;
    detail.database = String(e);
  }
  let workspace = true;
  try {
    fs.mkdirSync(env.WORKSPACE_ROOT, { recursive: true });
    fs.accessSync(env.WORKSPACE_ROOT, fs.constants.R_OK | fs.constants.W_OK);
    detail.workspace = env.WORKSPACE_ROOT;
  } catch (e) {
    workspace = false;
    detail.workspace = String(e);
  }
  const probe = await probePty();
  const pty = probe.ok;
  detail.pty = probe.detail;
  const sandbox = !env.SANDBOX_ENABLED || workspace;
  detail.sandbox = env.SANDBOX_ENABLED ? `enabled (${env.SANDBOX_RUNTIME})` : "disabled";
  let provider = true;
  if (opts?.checkProvider) {
    try { provider = await opts.checkProvider(); } catch { provider = false; }
  } else {
    provider = true;
    detail.provider = `${env.PROVIDER} (deferred live check)`;
  }
  const all = telegram && database && workspace && pty;
  return {
    status: all ? (provider ? "ok" : "degraded") : "down",
    telegram, database, sandbox, provider, workspace, pty, detail,
  };
}
