import readline from "node:readline";
import { loadEnv, getEnv } from "../../../src/config/env.js";
import { openDatabase } from "../../../src/database/db.js";
import { store } from "../../../src/database/store.js";
import { assertNotSecretKey } from "../../../src/tools/extended.js";
import {
  statusText, sessionsText, runsText, approvalsText, usageText, auditText,
  workspacesText, providersText, settingsText, metricsText, graphifyText,
  stopRunById, runIdForSession,
} from "../../../src/tui/screens.js";

const HELP = [
  "commands:",
  "  status                 health + counts",
  "  sessions [n]           list sessions",
  "  runs [sessionId] [n]   list runs",
  "  stop <runId|sessionId> stop a run (sessionId resolves to its active run)",
  "  approvals              pending approvals",
  "  approve <id>           approve a pending action",
  "  reject <id>            reject a pending action",
  "  usage [userId]         token/cost totals",
  "  audit [n]              recent audit log (secrets redacted)",
  "  workspaces             list workspaces + detected profiles",
  "  providers              provider health",
  "  graphify <workspace>   knowledge-graph status",
  "  settings               list settings",
  "  set <key> <value> [scope] [scopeId]   save setting (never secrets)",
  "  metrics                prometheus metrics",
  "  doctor                 run doctor checks",
  "  help                   this help",
  "  quit                   exit",
].join("\n");

async function handle(line: string, out: (s: string) => void): Promise<boolean> {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  switch ((cmd || "").toLowerCase()) {
    case "status": out(await statusText()); break;
    case "sessions": out(sessionsText(Number(rest[0]) || 20)); break;
    case "runs": out(runsText(rest[0], Number(rest[1]) || 20)); break;
    case "stop": {
      const id = rest[0] ?? "";
      if (!id) { out("usage: stop <runId|sessionId>"); break; }
      const runId = /^[0-9a-f-]{8,}$/i.test(id) && id.includes("-") ? id : runIdForSession(id);
      out(await stopRunById(runId));
      break;
    }
    case "approvals": out(approvalsText()); break;
    case "approve": case "reject": {
      if (!rest[0]) { out(`usage: ${cmd} <approvalId>`); break; }
      store.resolveApproval(rest[0], cmd === "approve" ? "approved" : "rejected");
      out(`${rest[0]} → ${cmd === "approve" ? "approved" : "rejected"}`);
      break;
    }
    case "usage": out(usageText(rest[0])); break;
    case "audit": out(auditText(Number(rest[0]) || 20)); break;
    case "workspaces": out(workspacesText()); break;
    case "providers": out(await providersText()); break;
    case "graphify": out(await graphifyText(rest[0] ?? "default")); break;
    case "settings": out(settingsText()); break;
    case "set": {
      const [key, value, scope, scopeId] = rest;
      if (!key || value === undefined) { out("usage: set <key> <value> [scope] [scopeId]"); break; }
      try {
        assertNotSecretKey(key);
        store.setSetting(key, value, scope || "global", scopeId || "");
        out(`saved ${key}`);
      } catch (e) { out(`refused: ${String(e)}`); }
      break;
    }
    case "metrics": out(metricsText()); break;
    case "doctor": {
      const { runDoctor } = await import("../../../src/observability/doctor.js");
      out(JSON.stringify(await runDoctor(), null, 2));
      break;
    }
    case "help": case "?": out(HELP); break;
    case "quit": case "exit": case "q": return false;
    case "": break;
    default: out(`unknown command: ${cmd}\n${HELP}`);
  }
  return true;
}

async function main(): Promise<void> {
  loadEnv();
  openDatabase();
  const env = getEnv();
  try {
    const { syncFilesystemWorkspaces } = await import("../../../src/workspace/manager.js");
    syncFilesystemWorkspaces();
  } catch { /* non-fatal */ }
  // Start dashboard API in background so `npm run tui` also serves the dashboard.
  // If bot/api already runs on the same port, just reuse it (no crash).
  let dashPort = env.PORT;
  try {
    const { buildApiServer } = await import("../../../src/api/server.js");
    const { listenWithFallback } = await import("../../../src/api/listen.js");
    const api = await buildApiServer();
    dashPort = await listenWithFallback(api, env.PORT, env.HOST);
  } catch (e) {
    console.log(`dashboard: port ${env.PORT} sudah dipakai proses lain — pakai yang sudah jalan (http://localhost:${env.PORT}).`);
  }
  console.log(`TeleAgent TUI — dashboard at http://localhost:${dashPort}`);
  console.log(await statusText());
  console.log("type 'help' for commands.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "teleagent> " });
  rl.prompt();
  for await (const line of rl) {
    try {
      const cont = await handle(line, (s) => console.log(s));
      if (!cont) { rl.close(); break; }
    } catch (e) { console.log(`error: ${String(e).slice(0, 500)}`); }
    rl.prompt();
  }
}

void main().catch((e) => { console.error(e); process.exit(1); });
