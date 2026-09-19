import { loadEnv } from "../../../src/config/env.js";
import { checkHealth } from "../../../src/observability/health.js";
import { getLogger } from "../../../src/observability/logger.js";
import { openDatabase } from "../../../src/database/db.js";
import { createBot } from "../../../src/telegram/gateway.js";
import { buildApiServer } from "../../../src/api/server.js";
import { recoverInterruptedRuns } from "../../../src/agent/recovery.js";

async function main(): Promise<void> {
  loadEnv();
  const log = getLogger();
  openDatabase();

  const env = process.env;
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
  console.log(`\nworkspace:\n${env.WORKSPACE_ROOT ?? "/workspaces"}`);
  console.log("\nagent:\nREADY");

  recoverInterruptedRuns();

  // internal API (health/metrics/REST/WS/gateway) alongside the bot
  const api = await buildApiServer();
  const port = Number(env.PORT ?? 49374);
  await api.listen({ port, host: "0.0.0.0" });
  log.info({ event: "api.listening", port }, "api listening");
  console.log(`\ndashboard:\nhttp://localhost:${port}\n`);

  if (!env.TELEGRAM_BOT_TOKEN) {
    log.warn("TELEGRAM_BOT_TOKEN missing — bot not started, api only");
    return;
  }
  const bot = createBot();
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
