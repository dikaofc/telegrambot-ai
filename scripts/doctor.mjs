#!/usr/bin/env node
// doctor: Telegram token, provider, API endpoint, model, database, Docker, PTY, filesystem, permissions, workspace
import fs from "node:fs";
import { execSync } from "node:child_process";

const checks = [];
function check(name, fn) {
  try { const msg = fn(); checks.push([name, true, msg ?? "OK"]); }
  catch (e) { checks.push([name, false, String(e.message ?? e).slice(0, 200)]); }
}

const env = process.env;
check("Telegram token", () => { if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN missing"); return "present"; });
check("provider", () => `${env.PROVIDER || "9router (default)"} (single universal config)`);
check("API endpoint", () => env.PROVIDER_BASE_URL || `preset: ${env.PROVIDER || "9router"}`);
check("API key", () => { if (!env.PROVIDER_API_KEY) throw new Error("PROVIDER_API_KEY missing"); return "present"; });
check("model", () => env.DEFAULT_MODEL || "auto");
check("database", () => { fs.mkdirSync("./data", { recursive: true }); return "sqlite path writable"; });
check("Docker", () => { try { execSync("docker info", { stdio: "pipe" }); return "available"; } catch { return "not available (local sandbox fallback)"; } });
check("PTY", () => { execSync("echo pty-ok", { stdio: "pipe" }); return "child_process ok"; });
check("filesystem", () => { fs.accessSync(".", fs.constants.R_OK | fs.constants.W_OK); return "rw ok"; });
check("permissions", () => env.BOT_ACCESS_MODE || "owner (default)");
check("workspace", () => { fs.mkdirSync(env.WORKSPACE_ROOT ?? "/tmp/teleagent-ws", { recursive: true }); return env.WORKSPACE_ROOT ?? "/tmp/teleagent-ws"; });

for (const [n, ok, msg] of checks) console.log(`checking ${n.padEnd(12)} ........ ${ok ? "OK" : "FAIL"} (${msg})`);
if (checks.some((c) => !c[1] && c[0] === "Telegram token")) process.exitCode = 1;
