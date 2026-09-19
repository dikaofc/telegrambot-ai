import { loadEnv } from "../../../src/config/env.js";
import { checkHealth } from "../../../src/observability/health.js";
import { getLogger } from "../../../src/observability/logger.js";
import { openDatabase } from "../../../src/database/db.js";
import { createBot } from "../../../src/telegram/gateway.js";
import { applyBotMenu } from "../../../src/telegram/commands.js";
import { buildApiServer } from "../../../src/api/server.js";
import { listenWithFallback } from "../../../src/api/listen.js";
import { recoverInterruptedRuns } from "../../../src/agent/recovery.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = getLogger();
  openDatabase();
  // Ensure workspace dirs exist + registered so dashboard/TUI never look empty
  try {
    const { ensureWorkspaceDirs, listWorkspaces, resolveWorkspacePath } = await import("../../../src/workspace/manager.js");
    const { store } = await import("../../../src/database/store.js");
    ensureWorkspaceDirs();
    for (const name of listWorkspaces()) {
      try { store.ensureWorkspace(name, resolveWorkspacePath(name)); } catch { /* noop */ }
    }
    if (listWorkspaces().length === 0) {
      try { store.ensureWorkspace("default", resolveWorkspacePath("default")); } catch { /* noop */ }
    }
  } catch { /* non-fatal */ }

  console.log("TELEAGENT v1.0.0\n");
  const h = await checkHealth();
  const tick = (ok: boolean): string => (ok ? "✓" : "✗");
  console.log(`telegram       ${tick(h.telegram)}`);
  console.log(`database       ${tick(h.database)}`);
  console.log(`sandbox        ${tick(h.sandbox)}`);
  console.log(`pty            ${tick(h.pty)}`);
  console.log(`\nprovider:\n${env.PROVIDER ?? "9router"}\n`);
  console.log(`model:\n${env.DEFAULT_MODEL ?? "auto"}\n`);
  console.log(`access:\n${(env.BOT_ACCESS_MODE ?? "owner").toUpperCase()} ONLY`);
  console.log(`\nworkspace:\n${env.WORKSPACE_ROOT ?? "./workspaces"}`);
  console.log("\nagent:\nREADY");

  recoverInterruptedRuns();

  // internal API (health/metrics/REST/WS/gateway) alongside the bot
  const api = await buildApiServer();
  const port = Number(env.PORT ?? 49375);
  const actualPort = await listenWithFallback(api, port, "0.0.0.0");
  log.info({ event: "api.listening", port: actualPort }, "api listening");
  console.log(`\ndashboard:\nhttp://localhost:${actualPort}\n`);

  if (!env.TELEGRAM_BOT_TOKEN) {
    log.warn("TELEGRAM_BOT_TOKEN missing — bot not started, api only");
    return;
  }
  const bot = createBot();
  await applyBotMenu(bot);
  const webhookUrl = env.TELEGRAM_WEBHOOK_URL;
  if (webhookUrl) {
    await api.ready();
    log.info({ event: "bot.webhook", url: webhookUrl }, "webhook mode: set TELEGRAM_WEBHOOK_URL in BotFather to POST /telegram/webhook");
    await bot.api.setWebhook(webhookUrl, { secret_token: env.TELEGRAM_WEBHOOK_SECRET || undefined });
  } else {
    log.info({ event: "bot.polling" }, "starting long polling (dev default)");
    await bot.start();
  }

  const shutdown = async (): Promise<void> => {
    log.info("shutting down gracefully…");
    try { bot.stop(); } catch { /* noop */ }
    try { await api.close(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((e) => { console.error(e); process.exit(1); });
