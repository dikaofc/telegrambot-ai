import { Bot, InputFile, type Context } from "grammy";
import { getEnv } from "../config/env.js";
import { getLogger } from "../observability/logger.js";
import { metrics } from "../observability/metrics.js";
import { store } from "../database/store.js";
import { isAuthorized } from "../security/access.js";
import { checkMessageRate } from "../security/rate-limit.js";
import { isDuplicateUpdate, markUpdateProcessed } from "../utils/idempotency.js";
import { resolveWorkspacePath } from "../workspace/manager.js";
import { startRun, stopRun, ensureSession, interpretControlMessage, sessionRunId, pauseRun, resumeRun } from "../agent/orchestrator.js";
import { emptySnapshot, applyEvent, renderStatusMessage, renderFinalSummary, renderFailure } from "./renderer.js";
import { runControlsKeyboard, approvalKeyboard, afterRunKeyboard, settingsKeyboard, setupKeyboard } from "./keyboards.js";
import { truncateForTelegram, splitMessage } from "../utils/large-output.js";
import { validateUploadSize, validateUploadExt, assertSafeArchiveEntry } from "../security/upload-validation.js";
import { setupBotCommands } from "./commands.js";

const log = () => getLogger();

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let delay = 500;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e: unknown) {
      last = e;
      const msg = String((e as { message?: string })?.message ?? e);
      if (msg.includes("429")) await new Promise((r) => setTimeout(r, 2000));
      else await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw last;
}

function parseNaturalSettings(text: string): { key: string; value: string } | null {
  const t = text.toLowerCase();
  let m = /pakai model (\S+)|use model (\S+)|model (\S+) untuk task/i.exec(text);
  const model = m?.[1] ?? m?.[2] ?? m?.[3];
  if (/model/.test(t) && model) return { key: "model", value: model.replace(/[^a-zA-Z0-9/_:.-]/g, "") };
  if (/provider|9router|openai|xai|ollama/.test(t) && /pakai|use|switch|ganti/.test(t)) {
    for (const p of ["9router", "openai", "xai", "anthropic", "ollama", "custom"]) if (t.includes(p)) return { key: "provider", value: p };
  }
  if (/jangan.*push|push.*persetujuan|push.*approval/.test(t)) return { key: "approval:high", value: "ask" };
  if (/owner only|owner-only|jadi owner/.test(t)) return { key: "access", value: "owner" };
  if (/workspace|project|kerjakan project|buka project/.test(t)) {
    const mm = /(?:project|workspace)\s+([a-zA-Z0-9/_.-]+)/i.exec(text);
    if (mm?.[1]) return { key: "workspace", value: mm[1] as string };
  }
  return null;
}

export function createBot(): Bot {
  const env = getEnv();
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    if (isDuplicateUpdate(updateId)) return; // duplicate protection
    markUpdateProcessed(updateId);
    await next();
  });

  // Full slash-command suite: /start /help /status /settings /model /provider
  // /workspace /new /stop /pause /resume /retry /diff /log /undo /approvals
  // /approve /reject /usage /doctor /graph (+ natural language still works).
  setupBotCommands(bot, { runText: (ctx, text) => runAgentForMessage(ctx, text) });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    if (!isAuthorized(userId, ctx.chat?.id).ok) { await ctx.answerCallbackQuery({ text: "unauthorized" }); return; }
    try {
      if (data.startsWith("run:stop:")) {
        const runId = data.split(":")[2] as string;
        await stopRun(runId);
        await ctx.answerCallbackQuery({ text: "stopping…" });
        await ctx.editMessageText("🛑 stopping run…");
      } else if (data.startsWith("appr:ok:") || data.startsWith("appr:no:")) {
        const approvalId = data.split(":")[2] as string;
        store.resolveApproval(approvalId, data.startsWith("appr:ok:") ? "approved" : "rejected");
        await ctx.answerCallbackQuery({ text: data.startsWith("appr:ok:") ? "approved" : "rejected" });
        await ctx.editMessageText(data.startsWith("appr:ok:") ? "✅ approved — resuming…" : "❌ rejected — agent will work around it.");
      } else if (data.startsWith("setup:")) {
        await ctx.answerCallbackQuery({ text: `provider: ${data.split(":")[1]}` });
        await ctx.reply("Send: `endpoint=... apikey=... model=...`", { parse_mode: "Markdown" });
      } else {
        await ctx.answerCallbackQuery({ text: "ok" });
      }
    } catch (e) { await ctx.answerCallbackQuery({ text: String(e).slice(0, 100) }); }
  });

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const gate = isAuthorized(userId, ctx.chat?.id);
    if (!gate.ok) { await ctx.reply(`⛔ unauthorized (${gate.reason})`); return; }
    if (!checkMessageRate(String(userId))) { await ctx.reply("⏳ rate limited — slow down a bit."); return; }
    metrics.telegramMessages.inc();
    const text = ctx.message.text;

    // control messages (stop/pause/resume) target the active run
    const control = interpretControlMessage(text);
    if (control) { await handleControl(ctx, control); return; }

    // natural-language settings
    const setting = parseNaturalSettings(text);
    if (setting && /model|provider|workspace|approval|access/.test(setting.key) && text.length < 120) {
      const telegramId = String(userId);
      const dbUser = store.upsertUser(telegramId, ctx.from?.username);
      const chatDb = store.ensureChat(dbUser, String(ctx.chat.id));
      const sessionId = ensureSession(dbUser, chatDb, "default", getEnv().PROVIDER, getEnv().DEFAULT_MODEL);
      if (setting.key === "model") { store.updateSession(sessionId, { model: setting.value }); await ctx.reply(`model preference updated:\n${setting.value}`); return; }
      if (setting.key === "provider") { store.updateSession(sessionId, { provider: setting.value }); await ctx.reply(`provider updated:\n${setting.value}`); return; }
      if (setting.key === "workspace") { await ctx.reply(`workspace updated:\n${setting.value}`); return; }
      if (setting.key === "approval:high") { store.setSetting(`approval:high:${sessionId}`, "ask", "session", sessionId); await ctx.reply("policy updated:\ngit push → approval required"); return; }
      if (setting.key === "access") { await ctx.reply("access change requires owner confirmation — reply `confirm owner only` to apply."); return; }
    }

    await runAgentForMessage(ctx, text);
  });

  bot.on("message:document", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    if (!isAuthorized(userId, ctx.chat?.id).ok) { await ctx.reply("⛔ unauthorized"); return; }
    const doc = ctx.message.document;
    const env = getEnv();
    const sizeCheck = validateUploadSize(doc.file_size ?? 0, env.MAX_UPLOAD_MB);
    if (!sizeCheck.ok) { await ctx.reply(`⛔ upload rejected: ${sizeCheck.reason}`); return; }
    const extCheck = validateUploadExt(doc.file_name ?? "");
    if (!extCheck.ok) { await ctx.reply(`⛔ upload rejected: ${extCheck.reason}`); return; }
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const wsName = `upload-${ctx.chat.id}`;
      const wsPath = resolveWorkspacePath(wsName);
      const dest = assertSafeArchiveEntry(doc.file_name ?? "upload.bin", wsPath);
      const { downloadFile } = await import("../tools/http.js");
      const trusted = ["api.telegram.org"];
      const { assertSafeUrl } = await import("../security/ssrf.js");
      assertSafeUrl(url, trusted);
      const r = await downloadFile(url, dest, 120_000, trusted);
      if (!r.success) { await ctx.reply(`❌ download failed: ${r.error}`); return; }
      const low = (doc.file_name ?? "").toLowerCase();
      if (low.endsWith(".zip") || low.endsWith(".tar.gz") || low.endsWith(".tgz") || low.endsWith(".tar")) {
        const { extractArchive } = await import("../tools/extended.js");
        const outDir = `${wsPath}/${(doc.file_name ?? "upload").replace(/\.(zip|tar\.gz|tgz|tar)$/i, "")}`;
        const ex = await extractArchive(dest, outDir);
        await ctx.reply(ex.success
          ? `📦 received + extracted → ${doc.file_name}\n${ex.output}\nworkspace: ${wsName}\nTell me what to do with it.`
          : `📦 received → ${doc.file_name}\n⚠️ auto-extract failed: ${ex.error}\nworkspace: ${wsName}`);
        return;
      }
      await ctx.reply(`📦 received → ${doc.file_name}\nworkspace: ${wsName}\nTell me what to do with it.`);
    } catch (e) { await ctx.reply(`❌ upload failed: ${String(e).slice(0, 500)}`); }
  });

  return bot;
}

async function handleControl(ctx: Context, control: "stop" | "pause" | "resume"): Promise<void> {
  const telegramId = String(ctx.from?.id ?? "");
  const dbUser = store.upsertUser(telegramId, ctx.from?.username);
  const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
  const latest = store.latestSessionForChat(chatDb) as { id: string } | undefined;
  if (!latest) { await ctx.reply("no active run"); return; }
  const runId = sessionRunId(latest.id);
  if (!runId) { await ctx.reply("no active run"); return; }
  if (control === "stop") {
    await stopRun(runId);
    await ctx.reply("🛑 cancelled. State persisted — send a message to start something new.");
  } else if (control === "pause") {
    (await pauseRun(runId))
      ? await ctx.reply("⏸ paused. State saved — send `resume` to continue.")
      : await ctx.reply("no active run (already finished?)");
  } else {
    (await resumeRun(runId))
      ? await ctx.reply("▶️ resumed.")
      : await ctx.reply("no paused run found.");
  }
}

async function runAgentForMessage(ctx: Context, text: string): Promise<void> {
  const env = getEnv();
  const userId = ctx.from?.id;
  if (userId === undefined) return;
  const telegramId = String(userId);
  const dbUser = store.upsertUser(telegramId, ctx.from?.username);
  const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));

  // workspace resolution: explicit "project X" or session default
  const setting = parseNaturalSettings(text);
  const workspaceName = setting?.key === "workspace" ? setting.value : "default";
  const sessionId = ensureSession(dbUser, chatDb, workspaceName, env.PROVIDER, env.DEFAULT_MODEL);
  const wsPath = resolveWorkspacePath(workspaceName === "default" ? await defaultWorkspace(sessionId) : workspaceName);

  // live status message (aggregated + debounced edits)
  const statusMsg = await withRetry(() => ctx.reply("🧠 Agent working...\n\nphase: starting"));
  let snap = emptySnapshot();
  let lastEdit = 0;
  const pushEdit = async () => {
    const now = Date.now();
    if (now - lastEdit < 1500) return;
    lastEdit = now;
    try { await withRetry(() => ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, renderStatusMessage(snap), { reply_markup: { inline_keyboard: runControlsKeyboard("pending") } })); } catch { /* ignore edit races */ }
  };

  const started = Date.now();
  let filesChanged: string[] = [];
  const attempted: string[] = [];
  try {
    const handle = await startRun({ userId: dbUser, chatDbId: chatDb, sessionId, workspacePath: wsPath, provider: env.PROVIDER, model: env.DEFAULT_MODEL, input: text });
    try { await withRetry(() => ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, renderStatusMessage(snap), { reply_markup: { inline_keyboard: runControlsKeyboard(handle.runId) } })); } catch { /* noop */ }
    let tokens = 0;
    for await (const ev of handle.events) {
      snap = applyEvent(snap, ev);
      if (ev.type === "tool_start") attempted.push(`${ev.tool} ${JSON.stringify(ev.args).slice(0, 150)}`);
      if (ev.type === "file_change") filesChanged.push(...ev.files);
      if (ev.type === "approval_required") {
        await ctx.reply(`⚠️ approval required\n\nagent wants to execute:\n\n${ev.command}\n\nrisk: ${ev.risk}\n\nreason:\n${ev.reason}`, { reply_markup: { inline_keyboard: approvalKeyboard(ev.approvalId) } });
      }
      if (ev.type === "error" || ev.type === "state" || ev.type === "test" || ev.type === "file_change") await pushEdit();
      if (ev.type === "completed") tokens += 100;
    }
    const duration = Date.now() - started;
    const finalText = renderFinalSummary({ filesChanged: [...new Set(filesChanged)], durationMs: duration, tokens, model: env.DEFAULT_MODEL });
    const { text: safe, truncated } = truncateForTelegram(finalText);
    await withRetry(() => ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, safe, { reply_markup: { inline_keyboard: afterRunKeyboard(sessionId) } }));
    if (truncated) {
      await ctx.replyWithDocument(new InputFile(Buffer.from(finalText, "utf8"), "summary.txt"), { caption: "full summary" });
    }
  } catch (e) {
    const msg = String(e);
    if (msg.includes("already active")) {
      await ctx.reply("⏳ I'm still working on the previous task — your message was noted. Send `stop` to cancel it.");
      return;
    }
    const failure = renderFailure({ attempted, lastError: msg, remains: "workspace left as-is; no destructive retry was performed automatically" });
    for (const chunk of splitMessage(failure)) await ctx.reply(chunk);
    try { await withRetry(() => ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, `⚠️ task incomplete\n\n${msg.slice(0, 500)}`)); } catch { /* noop */ }
    log().error({ event: "telegram.run.failed", err: msg }, "agent run failed");
  }
}

async function defaultWorkspace(sessionId: string): Promise<string> {
  const s = store.getSession(sessionId) as { workspace_id?: string } | undefined;
  void s;
  return "default";
}

export { setupKeyboard };
