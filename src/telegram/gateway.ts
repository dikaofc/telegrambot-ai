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
import { emptySnapshot, applyEvent, renderStatusMessage, renderFinalSummary, renderFinalSummaryHtml, renderFailure, renderFailureHtml, splitFinalHtml } from "./renderer.js";
import { runControlsKeyboard, approvalKeyboard, afterRunKeyboard, afterRunKeyboardAuto, settingsKeyboard, setupKeyboard } from "./keyboards.js";
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
      } else if (data.startsWith("run:pause:")) {
        const runId = data.split(":")[2] as string;
        const ok = await pauseRun(runId);
        await ctx.answerCallbackQuery({ text: ok ? "dijeda" : "nggak ada task" });
        if (ok) await ctx.editMessageText("⏸ Dijeda — kirim resume buat lanjut");
      } else if (data.startsWith("run:resume:")) {
        const runId = data.split(":")[2] as string;
        const ok = await resumeRun(runId);
        await ctx.answerCallbackQuery({ text: ok ? "dilanjut" : "nggak ada" });
        if (ok) await ctx.editMessageText("▶️ Lanjut lagi!");
      } else if (data.startsWith("run:diff:")) {
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, "default", getEnv().PROVIDER, getEnv().DEFAULT_MODEL);
        const s = store.getSession(sessionId) as { workspace_id: string } | undefined;
        const wsPath = s ? (store.getWorkspaceById(s.workspace_id) as { path: string } | undefined)?.path ?? resolveWorkspacePath("default") : resolveWorkspacePath("default");
        const { gitTools } = await import("../tools/git.js");
        const diff = await gitTools.diff(wsPath, ["--stat"]);
        await ctx.answerCallbackQuery({ text: "diff" });
        await ctx.reply(diff.success ? `📄 <b>Perubahan:</b>\n<pre>${(diff.output ?? "").slice(0, 3500).replace(/</g, "&lt;")}</pre>` : `Gagal ambil diff — ${diff.error}`, { parse_mode: "HTML" });
      } else if (data.startsWith("run:logs:")) {
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, "default", getEnv().PROVIDER, getEnv().DEFAULT_MODEL);
        const last = store.lastRunForSession(sessionId) as { id: string } | undefined;
        if (!last) { await ctx.answerCallbackQuery({ text: "no runs yet" }); return; }
        const calls = store.toolCallsForRun(last.id, 15);
        const lines = calls.map((t) => `${t.success ? "✓" : "✗"} ${t.tool} [${t.risk}]`).join("\n") || "(no tool calls)";
        await ctx.answerCallbackQuery({ text: "logs" });
        await ctx.reply(`🧾 <b>Log terakhir:</b>\n<pre>${lines.slice(0, 3500).replace(/</g, "&lt;")}</pre>`, { parse_mode: "HTML" });
      } else if (data.startsWith("run:retry:")) {
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, "default", getEnv().PROVIDER, getEnv().DEFAULT_MODEL);
        const last = store.lastUserMessage(sessionId);
        await ctx.answerCallbackQuery({ text: last ? "retrying" : "nothing to retry" });
        if (last) await runAgentForMessage(ctx as unknown as Context, last);
      } else if (data.startsWith("appr:ok:") || data.startsWith("appr:no:")) {
        const approvalId = data.split(":")[2] as string;
        store.resolveApproval(approvalId, data.startsWith("appr:ok:") ? "approved" : "rejected");
        await ctx.answerCallbackQuery({ text: data.startsWith("appr:ok:") ? "approved" : "rejected" });
        await ctx.editMessageText(data.startsWith("appr:ok:") ? "✅ approved — resuming…" : "❌ rejected — agent will work around it.");
      } else if (data === "set:model") {
        await ctx.answerCallbackQuery({ text: "model" });
        await ctx.reply("🤖 <b>Ganti Model</b>\n\nKetik: <code>/model nama-model</code>\nContoh: <code>/model oc/muse-spark-1.2-contributor-free</code>\nAtau natural: <i>pakai model minimax</i>", { parse_mode: "HTML" });
      } else if (data === "set:provider") {
        await ctx.answerCallbackQuery({ text: "provider" });
        const { providerKeyboard } = await import("./keyboards.js");
        const { availableProviders } = await import("../providers/factory.js");
        await ctx.reply("🔌 <b>Pilih Provider</b> — mau pakai yang mana?", { parse_mode: "HTML", reply_markup: { inline_keyboard: providerKeyboard(availableProviders()) } });
      } else if (data.startsWith("setp:")) {
        const provider = data.split(":")[1] as string;
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, "default", getEnv().PROVIDER, getEnv().DEFAULT_MODEL);
        store.updateSession(sessionId, { provider });
        await ctx.answerCallbackQuery({ text: `provider ${provider}` });
        await ctx.editMessageText(`🔌 provider updated → <b>${provider}</b>`, { parse_mode: "HTML" });
      } else if (data === "set:workspace") {
        await ctx.answerCallbackQuery({ text: "workspace" });
        await ctx.reply("📁 <b>Ganti Workspace</b>\n\nKetik: <code>/workspace nama-project</code>\nAtau: <i>buka project 9router</i>", { parse_mode: "HTML" });
      } else if (data === "set:perms") {
        await ctx.answerCallbackQuery({ text: "permissions" });
        await ctx.reply("🛡 <b>Izin</b>\n\n• <code>git push</code> → butuh approval\n• <code>rm -rf /</code> → diblokir\n\nUbah: ketik <i>jangan push tanpa izin</i>", { parse_mode: "HTML" });
      } else if (data === "set:memory") {
        await ctx.answerCallbackQuery({ text: "memory" });
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, "default", getEnv().PROVIDER, getEnv().DEFAULT_MODEL);
        const mem = store.getMemory("session", sessionId);
        await ctx.reply(`💾 <b>Memory</b> session ini:\n<pre>${JSON.stringify(mem, null, 2).slice(0, 3000).replace(/</g, "&lt;")}</pre>`, { parse_mode: "HTML" });
      } else if (data === "set:notif") {
        await ctx.answerCallbackQuery({ text: "notifications" });
        await ctx.reply("🔔 <b>Notifikasi</b>\n\nSemua status & approval masuk ke chat ini", { parse_mode: "HTML" });
      } else if (data === "set:access") {
        await ctx.answerCallbackQuery({ text: "access" });
        await ctx.reply(`👤 <b>Access</b>\n\nmode: <code>${getEnv().BOT_ACCESS_MODE}</code>\nowner: <code>${getEnv().OWNER_IDS}</code>\n\nUbah via .env: <code>BOT_ACCESS_MODE=owner|private|public|allowlist</code>`, { parse_mode: "HTML" });
      } else if (data === "set:agent") {
        await ctx.answerCallbackQuery({ text: "agent" });
        await ctx.reply(`⚙️ <b>Agent</b>\n\nprovider: <code>${getEnv().PROVIDER}</code>\nmodel: <code>${getEnv().DEFAULT_MODEL}</code>\n\nGanti: <code>/model …</code> atau <code>/provider …</code>`, { parse_mode: "HTML" });
      } else if (data.startsWith("setup:")) {
        await ctx.answerCallbackQuery({ text: `provider: ${data.split(":")[1]}` });
        await ctx.reply("Kirim: <code>endpoint=... apikey=... model=...</code>", { parse_mode: "Markdown" });
      } else if (data === "file:read") {
        await ctx.answerCallbackQuery({ text: "baca file" });
        await ctx.reply("📖 Coba ketik: <i>baca file uploads/nama.md dong</i> — langsung dibacain", { parse_mode: "HTML" });
      } else {
        await ctx.answerCallbackQuery({ text: "ok" });
      }
    } catch (e) { await ctx.answerCallbackQuery({ text: String(e).slice(0, 100) }); }
  });

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const gate = isAuthorized(userId, ctx.chat?.id);
    if (!gate.ok) { await ctx.reply(`⛔ Belum ada akses — ${gate.reason}`); return; }
    if (!checkMessageRate(String(userId))) { await ctx.reply("⏳ Kebanyakan request, santai dulu ya — coba lagi semenit"); return; }
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
      if (setting.key === "model") { store.updateSession(sessionId, { model: setting.value }); await ctx.reply(`✅ Model diganti → <code>${setting.value}</code>`); return; }
      if (setting.key === "provider") { store.updateSession(sessionId, { provider: setting.value }); await ctx.reply(`✅ Provider diganti → <code>${setting.value}</code>`); return; }
      if (setting.key === "workspace") { await ctx.reply(`✅ Workspace pindah → <code>${setting.value}</code>`); return; }
      if (setting.key === "approval:high") { store.setSetting(`approval:high:${sessionId}`, "ask", "session", sessionId); await ctx.reply("✅ Sip, <code>git push</code> sekarang butuh approval dulu"); return; }
      if (setting.key === "access") { await ctx.reply("🔒 Mau ganti akses? Balas <code>confirm owner only</code>"); return; }
    }

    await runAgentForMessage(ctx, text);
  });

  bot.on("message:document", async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    if (!isAuthorized(userId, ctx.chat?.id).ok) { await ctx.reply("⛔ Belum ada akses"); return; }
    const doc = ctx.message.document;
    const env = getEnv();
    const sizeCheck = validateUploadSize(doc.file_size ?? 0, env.MAX_UPLOAD_MB);
    if (!sizeCheck.ok) { await ctx.reply(`⛔ File kegedean — ${sizeCheck.reason}`); return; }
    const extCheck = validateUploadExt(doc.file_name ?? "");
    if (!extCheck.ok) { await ctx.reply(`⛔ Format nggak didukung — ${extCheck.reason}`); return; }
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
      if (!r.success) { await ctx.reply(`❌ Gagal download — ${r.error}`); return; }
      // Also copy to default workspace so agent (default) can see it via read_file
      try {
        const defaultWs = resolveWorkspacePath("default");
        const { default: fs } = await import("node:fs");
        const { default: path } = await import("node:path");
        const copyDest = path.join(defaultWs, "uploads", doc.file_name ?? "upload.bin");
        fs.mkdirSync(path.dirname(copyDest), { recursive: true });
        fs.copyFileSync(dest, copyDest);
      } catch { /* best-effort */ }
      const low = (doc.file_name ?? "").toLowerCase();
      if (low.endsWith(".zip") || low.endsWith(".tar.gz") || low.endsWith(".tgz") || low.endsWith(".tar")) {
        const { extractArchive } = await import("../tools/extended.js");
        const outDir = `${wsPath}/${(doc.file_name ?? "upload").replace(/\.(zip|tar\.gz|tgz|tar)$/i, "")}`;
        const ex = await extractArchive(dest, outDir);
        await ctx.reply(ex.success
          ? `📦 received + extracted → ${doc.file_name}\n${ex.output}\nworkspace: ${wsName} (also copied to default/uploads/)\nTell me what to do with it.`
          : `📦 received → ${doc.file_name}\n⚠️ auto-extract failed: ${ex.error}\nworkspace: ${wsName}`);
        return;
      }
      // Text-like files: .md .txt .json .js .ts .py .log .diff .patch — show preview with blockquote + HTML
      const textExts = [".md", ".txt", ".json", ".js", ".ts", ".py", ".log", ".diff", ".patch"];
      const isText = textExts.some((e) => low.endsWith(e));
      if (isText) {
        try {
          const { default: fs } = await import("node:fs");
          const content = fs.readFileSync(dest, "utf8").slice(0, 8000);
          const preview = content.slice(0, 3000);
          const esc = preview.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const lang = low.endsWith(".md") ? "markdown" : low.endsWith(".json") ? "json" : low.endsWith(".py") ? "python" : low.endsWith(".js") || low.endsWith(".ts") ? "typescript" : "";
          const codeBlock = lang ? `<pre><code class="language-${lang}">${esc}</code></pre>` : `<blockquote>${esc.slice(0, 2000)}</blockquote>`;
          await ctx.reply(
            `📄 <b>received → ${doc.file_name}</b>\n` +
            `<i>workspace: ${wsName} & default/uploads/</i>\n` +
            `<i>size: ${((doc.file_size ?? 0) / 1024).toFixed(1)} KB — agent bisa baca via <code>read_file</code></i>\n\n` +
            `${codeBlock}\n\n` +
            `<i>Tips: ketik natural</i> <code>baca file ${doc.file_name} dan jelaskan</code> <i>atau</i> <code>analisa file ini</code>`,
            {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [[{ text: "📖 Baca file", callback_data: "file:read" }, { text: "🔍 Analisa", callback_data: "file:read" }]] },
            },
          );
          return;
        } catch { /* fall through to generic */ }
      }
      await ctx.reply(`📦 received → ${doc.file_name}\nworkspace: ${wsName} (also default/uploads/)\nTell me what to do with it.`);
    } catch (e) { await ctx.reply(`❌ Upload gagal — ${String(e).slice(0, 500)}`); }
  });

  return bot;
}

async function handleControl(ctx: Context, control: "stop" | "pause" | "resume"): Promise<void> {
  const telegramId = String(ctx.from?.id ?? "");
  const dbUser = store.upsertUser(telegramId, ctx.from?.username);
  const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
  const latest = store.latestSessionForChat(chatDb) as { id: string } | undefined;
  if (!latest) { await ctx.reply("⏸ Nggak ada task yang jalan"); return; }
  const runId = sessionRunId(latest.id);
  if (!runId) { await ctx.reply("⏸ Nggak ada task yang jalan"); return; }
  if (control === "stop") {
    await stopRun(runId);
    await ctx.reply("🛑 Dibatalkan — progress kesimpen, kirim pesan baru aja");
  } else if (control === "pause") {
    (await pauseRun(runId))
      ? await ctx.reply("⏸ Dijeda — kirim <code>resume</code> buat lanjut")
      : await ctx.reply("⏸ Udah selesai, nggak ada yang dijeda");
  } else {
    (await resumeRun(runId))
      ? await ctx.reply("▶️ Lanjut lagi!")
      : await ctx.reply("▶️ Nggak ada yang dijeda");
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
  const statusMsg = await withRetry(() => ctx.reply("✨ Lagi dikerjain — bentar ya..."));
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
    let lastSummary = "";
    for await (const ev of handle.events) {
      snap = applyEvent(snap, ev);
      if (ev.type === "tool_start") attempted.push(`${ev.tool} ${JSON.stringify(ev.args).slice(0, 150)}`);
      if (ev.type === "file_change") filesChanged.push(...ev.files);
      if (ev.type === "completed" && ev.summary) lastSummary = ev.summary;
      if (ev.type === "approval_required") {
        await ctx.reply(`⚠️ Butuh izin dulu\n\nMau jalanin:\n<code>${ev.command}</code>\n\nRisiko: <b>${ev.risk}</b>\nAlasan: ${ev.reason}`, { parse_mode: "HTML", reply_markup: { inline_keyboard: approvalKeyboard(ev.approvalId) } });
      }
      if (ev.type === "error" || ev.type === "state" || ev.type === "test" || ev.type === "file_change") await pushEdit();
      if (ev.type === "completed") tokens += 100;
    }
    const duration = Date.now() - started;
    if (lastSummary.includes("\n\ngit:\n")) lastSummary = lastSummary.split("\n\ngit:\n")[0].trim();
    // Try HTML first (auto markdown + blockquote), fall back to plain on parse error
    const finalHtml = renderFinalSummaryHtml({ filesChanged: [...new Set(filesChanged)], durationMs: duration, tokens, model: env.DEFAULT_MODEL, summary: lastSummary || undefined });
    const htmlChunks = splitFinalHtml(finalHtml);
    const firstChunk = htmlChunks[0] ?? finalHtml;
    const dedupFiles = [...new Set(filesChanged)];
    const kb = afterRunKeyboardAuto(sessionId, { filesChanged: dedupFiles.length, hasLogs: attempted.length > 0 });
    const replyMarkup = kb ? { inline_keyboard: kb } : undefined;
    try {
      await withRetry(() => ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, firstChunk, replyMarkup ? { parse_mode: "HTML", reply_markup: replyMarkup } : { parse_mode: "HTML" }));
      // If no keyboard for pure chat, ensure any old keyboard is removed (edit without markup clears it)
      if (!replyMarkup) {
        try { await ctx.api.editMessageReplyMarkup(ctx.chat!.id, statusMsg.message_id, { reply_markup: undefined }); } catch { /* ignore */ }
      }
    } catch {
      const fallback = renderFinalSummary({ filesChanged: dedupFiles, durationMs: duration, tokens, model: env.DEFAULT_MODEL, summary: lastSummary || undefined });
      const { text: safe2 } = truncateForTelegram(fallback);
      await withRetry(() => ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, safe2, replyMarkup ? { reply_markup: replyMarkup } : {}));
    }
    // Remaining chunks (for long AI answers) as separate messages with same HTML mode
    for (let i = 1; i < htmlChunks.length; i++) {
      const chunk = htmlChunks[i] as string;
      try { await ctx.reply(chunk, { parse_mode: "HTML" }); }
      catch { await ctx.reply(chunk.replace(/<[^>]+>/g, "")); }
    }
    if (finalHtml.length > 3800 * htmlChunks.length) {
      await ctx.replyWithDocument(new InputFile(Buffer.from(lastSummary || finalHtml, "utf8"), "summary.txt"), { caption: "full summary" });
    }
  } catch (e) {
    const msg = String(e);
    if (msg.includes("already active")) {
      await ctx.reply("⏳ Masih ngerjain task sebelumnya — pesanmu kecatet. Kirim <code>stop</code> kalau mau batalin");
      return;
    }
    const failureHtml = renderFailureHtml({ attempted, lastError: msg, remains: "workspace left as-is; no destructive retry was performed automatically" });
    for (const chunk of splitFinalHtml(failureHtml)) {
      try { await ctx.reply(chunk, { parse_mode: "HTML" }); } catch { const f = renderFailure({ attempted, lastError: msg, remains: "workspace left as-is; no destructive retry was performed automatically" }); for (const c of splitMessage(f)) await ctx.reply(c); break; }
    }
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
