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
import { setWebhookHandler } from "./webhook-bus.js";

const log = () => getLogger();

/**
 * Webhook plumbing. Telegram posts updates to POST /telegram/webhook, so the
 * API server hands them to the running bot through the webhook bus.
 * handleUpdate() requires bot.me, so init once and dedupe concurrent first
 * calls (the first update would otherwise race getMe against itself).
 */
let webhookInit: Promise<void> | null = null;

export function registerWebhookBot(bot: Bot): void {
  webhookInit = null;
  setWebhookHandler(async (update) => {
    webhookInit ??= bot.init();
    await webhookInit;
    await bot.handleUpdate(update);
  });
  getLogger().info({ event: "bot.webhook.registered" }, "bot ready to receive webhook updates");
}

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

export function parseNaturalSettings(text: string): { key: string; value: string } | null {
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
    // question/stop words must never become a workspace name ("workspace apa" → chat, not switch)
    const stop = new Set(["ke", "di", "dari", "yang", "apa", "siapa", "dimana", "gimana", "bagaimana", "untuk", "dan", "atau", "dengan", "pada", "ini", "itu", "saya", "kamu", "adalah", "the", "a", "an", "to", "in", "on", "what", "which", "where"]);
    const re = /(?:project|workspace)\s+([a-zA-Z0-9/_.-]+)/gi;
    let m2: RegExpExecArray | null;
    while ((m2 = re.exec(text)) !== null) {
      const v = (m2[1] as string).replace(/[?.!,]+$/, "");
      if (v && !stop.has(v.toLowerCase())) return { key: "workspace", value: v };
    }
    // "ganti workspace ke X" — name comes after a stopword
    const m3 = /(?:project|workspace)\s+[a-zA-Z0-9/_.-]+\s+([a-zA-Z0-9/_.-]+)/i.exec(text);
    if (m3?.[1] && !stop.has((m3[1] as string).toLowerCase())) return { key: "workspace", value: (m3[1] as string).replace(/[?.!,]+$/, "") };
  }
  return null;
}

/**
 * Fast-path for trivial read-only shell one-liners ("ls -la", "pwd", "cat x").
 * Returns the exact command to run, or null to fall through to the agent loop.
 * Deliberately strict: single line, no chaining/substitution/redirection/globs.
 */
export function matchFastShellCommand(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 300 || /[\n\r;&|<>$`!\\*?~#(){}[\]]/.test(t)) return null;
  const m = /^(ls|dir|pwd|whoami|date|echo|cat)\b\s*(.*)$/i.exec(t);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();
  if (verb === "cat") {
    // one safe relative path only — no flags, no traversal, no absolute paths
    if (!rest || /^-/.test(rest) || /\s/.test(rest)) return null;
    if (rest.includes("..")) return null;
    if (rest.startsWith("/")) return null;
  } else if (verb === "echo") {
    if (!rest) return null;
  } else if (verb === "ls" || verb === "dir") {
    if (rest && !/^[\w./\- ]+$/.test(rest)) return null;
  } else if (rest) {
    return null; // pwd/whoami/date take no arguments
  }
  return `${verb}${rest ? " " + rest : ""}`;
}

export function createBot(): Bot {
  const env = getEnv();
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

  // Never let a handler error stop polling (e.g. tapping an expired button).
  bot.catch((err) => {
    getLogger().error({ event: "bot.handler.error", err: String(err).slice(0, 500) }, "telegram handler error — polling continues");
  });

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
    // Expired taps (old messages, bot restarts) must never kill polling.
    const answer = async (arg?: { text: string } | string): Promise<void> => {
      try {
        if (typeof arg === "string") await ctx.answerCallbackQuery({ text: arg });
        else if (arg) await ctx.answerCallbackQuery(arg);
        else await ctx.answerCallbackQuery({ text: "ok" });
      } catch { /* query too old / invalid — safe to ignore */ }
    };
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;
    if (!isAuthorized(userId, ctx.chat?.id).ok) { await answer({ text: "unauthorized" }); return; }
    try {
      if (data.startsWith("run:stop:")) {
        const runId = data.split(":")[2] as string;
        await stopRun(runId);
        await answer({ text: "stopping…" });
        await ctx.editMessageText("🛑 stopping run…");
      } else if (data.startsWith("run:pause:")) {
        const runId = data.split(":")[2] as string;
        const ok = await pauseRun(runId);
        await answer({ text: ok ? "dijeda" : "nggak ada task" });
        if (ok) await ctx.editMessageText("⏸ Dijeda — kirim resume buat lanjut");
      } else if (data.startsWith("run:resume:")) {
        const runId = data.split(":")[2] as string;
        const ok = await resumeRun(runId);
        await answer({ text: ok ? "dilanjut" : "nggak ada" });
        if (ok) await ctx.editMessageText("▶️ Lanjut lagi!");
      } else if (data.startsWith("run:diff:")) {
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, null, null, null);
        const s = store.getSession(sessionId) as { workspace_id: string } | undefined;
        const wsPath = s ? (store.getWorkspaceById(s.workspace_id) as { path: string } | undefined)?.path ?? resolveWorkspacePath("default") : resolveWorkspacePath("default");
        const { gitTools } = await import("../tools/git.js");
        const diff = await gitTools.diff(wsPath, ["--stat"]);
        await answer({ text: "diff" });
        await ctx.reply(diff.success ? `📄 <b>Perubahan:</b>\n<pre>${(diff.output ?? "").slice(0, 3500).replace(/</g, "&lt;")}</pre>` : `Gagal ambil diff — ${diff.error}`, { parse_mode: "HTML" });
      } else if (data.startsWith("run:logs:")) {
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, null, null, null);
        const last = store.lastRunForSession(sessionId) as { id: string } | undefined;
        if (!last) { await answer({ text: "no runs yet" }); return; }
        const calls = store.toolCallsForRun(last.id, 15);
        const lines = calls.map((t) => `${t.success ? "✓" : "✗"} ${t.tool} [${t.risk}]`).join("\n") || "(no tool calls)";
        await answer({ text: "logs" });
        await ctx.reply(`🧾 <b>Log terakhir:</b>\n<pre>${lines.slice(0, 3500).replace(/</g, "&lt;")}</pre>`, { parse_mode: "HTML" });
      } else if (data.startsWith("run:retry:")) {
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, null, null, null);
        const last = store.lastUserMessage(sessionId);
        await answer({ text: last ? "retrying" : "nothing to retry" });
        if (last) await runAgentForMessage(ctx as unknown as Context, last);
      } else if (data.startsWith("appr:ok:") || data.startsWith("appr:no:")) {
        const approvalId = data.split(":")[2] as string;
        const approved = data.startsWith("appr:ok:");
        const ap = store.getApproval(approvalId) as { run_id: string; status: string } | undefined;
        const { runIdForLookup } = await import("../agent/orchestrator.js");
        const alive = ap ? runIdForLookup(ap.run_id) : false;
        store.resolveApproval(approvalId, approved ? "approved" : "rejected");
        await answer({ text: approved ? "approved" : "rejected" });
        try {
          await ctx.editMessageText(
            !ap ? "❓ Approval tidak dikenal (mungkin sudah dibersihkan)."
              : ap.status !== "pending" ? `ℹ️ Approval ini sudah di-${ap.status} sebelumnya.`
              : !alive ? (approved
                ? "✅ noted — tapi run-nya sudah selesai, tidak ada yang dilanjutkan."
                : "❌ noted — run-nya sudah selesai.")
              : approved ? "✅ approved — resuming…" : "❌ rejected — agent will work around it.",
          );
        } catch { /* already edited */ }
      } else if (data === "set:model") {
        await answer({ text: "model" });
        await ctx.reply("🤖 <b>Ganti Model</b>\n\nKetik: <code>/model nama-model</code>\nContoh: <code>/model oc/muse-spark-1.2-contributor-free</code>\nAtau natural: <i>pakai model minimax</i>", { parse_mode: "HTML" });
      } else if (data === "set:provider") {
        await answer({ text: "provider" });
        const { providerKeyboard } = await import("./keyboards.js");
        const { availableProviders } = await import("../providers/factory.js");
        await ctx.reply("🔌 <b>Pilih Provider</b> — mau pakai yang mana?", { parse_mode: "HTML", reply_markup: { inline_keyboard: providerKeyboard(availableProviders()) } });
      } else if (data.startsWith("setp:")) {
        const provider = data.split(":")[1] as string;
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, null, null, null);
        store.updateSession(sessionId, { provider });
        await answer({ text: `provider ${provider}` });
        await ctx.editMessageText(`🔌 provider updated → <b>${provider}</b>`, { parse_mode: "HTML" });
      } else if (data === "set:workspace") {
        await answer({ text: "workspace" });
        await ctx.reply("📁 <b>Ganti Workspace</b>\n\nKetik: <code>/workspace nama-project</code>\nAtau: <i>buka project 9router</i>", { parse_mode: "HTML" });
      } else if (data === "set:perms") {
        await answer({ text: "permissions" });
        await ctx.reply("🛡 <b>Izin</b>\n\n• <code>git push</code> → butuh approval\n• <code>rm -rf /</code> → diblokir\n\nUbah: ketik <i>jangan push tanpa izin</i>", { parse_mode: "HTML" });
      } else if (data === "set:memory") {
        await answer({ text: "memory" });
        const telegramId = String(userId);
        const dbUser = store.upsertUser(telegramId, ctx.from?.username);
        const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
        const sessionId = ensureSession(dbUser, chatDb, null, null, null);
        const mem = store.getMemory("session", sessionId);
        await ctx.reply(`💾 <b>Memory</b> session ini:\n<pre>${JSON.stringify(mem, null, 2).slice(0, 3000).replace(/</g, "&lt;")}</pre>`, { parse_mode: "HTML" });
      } else if (data === "set:notif") {
        await answer({ text: "notifications" });
        await ctx.reply("🔔 <b>Notifikasi</b>\n\nSemua status & approval masuk ke chat ini", { parse_mode: "HTML" });
      } else if (data === "set:access") {
        await answer({ text: "access" });
        await ctx.reply(`👤 <b>Access</b>\n\nmode: <code>${getEnv().BOT_ACCESS_MODE}</code>\nowner: <code>${getEnv().OWNER_IDS}</code>\n\nUbah via .env: <code>BOT_ACCESS_MODE=owner|private|public|allowlist</code>`, { parse_mode: "HTML" });
      } else if (data === "set:agent") {
        await answer({ text: "agent" });
        await ctx.reply(`⚙️ <b>Agent</b>\n\nprovider: <code>${getEnv().PROVIDER}</code>\nmodel: <code>${getEnv().DEFAULT_MODEL}</code>\n\nGanti: <code>/model …</code> atau <code>/provider …</code>`, { parse_mode: "HTML" });
      } else if (data.startsWith("setup:")) {
        await answer({ text: `provider: ${data.split(":")[1]}` });
        await ctx.reply("Kirim: <code>endpoint=... apikey=... model=...</code>", { parse_mode: "Markdown" });
      } else if (data === "file:read") {
        await answer({ text: "baca file" });
        await ctx.reply("📖 Coba ketik: <i>baca file uploads/nama.md dong</i> — langsung dibacain", { parse_mode: "HTML" });
      } else {
        await answer({ text: "ok" });
      }
    } catch (e) { await answer({ text: String(e).slice(0, 100) }); }
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
      const sessionId = ensureSession(dbUser, chatDb, null, null, null);
      if (setting.key === "model") { store.updateSession(sessionId, { model: setting.value }); await ctx.reply(`✅ Model diganti → <code>${setting.value}</code>`); return; }
      if (setting.key === "provider") { store.updateSession(sessionId, { provider: setting.value }); await ctx.reply(`✅ Provider diganti → <code>${setting.value}</code>`); return; }
      if (setting.key === "workspace") {
        const { switchSessionWorkspace } = await import("./commands.js");
        try {
          const sw = switchSessionWorkspace(dbUser, sessionId, setting.value);
          await ctx.reply(`✅ Workspace pindah → <code>${sw.name}</code> (<code>${sw.path}</code>)`);
        } catch (e) { await ctx.reply(`❌ ${String(e).slice(0, 200)}`); }
        return;
      }
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

async function runFastShell(
  ctx: Context,
  o: { dbUser: string; sessionId: string; wsPath: string; command: string; input: string },
): Promise<void> {
  const esc = (s: string): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const t0 = Date.now();
  const { execCommand } = await import("../tools/shell.js");
  const { auditTool } = await import("../security/audit.js");
  const { truncateForTelegram } = await import("../utils/large-output.js");
  store.addMessage(o.sessionId, "user", o.input);
  let body: string;
  try {
    const r = await execCommand(o.command, { cwd: o.wsPath, timeoutMs: 30_000 });
    auditTool({
      userId: o.dbUser, sessionId: o.sessionId, tool: "shell",
      args: { command: o.command, fastPath: true }, risk: "SAFE", approval: "auto",
      result: r.output ?? r.error, exitCode: r.metadata?.exitCode, durationMs: Date.now() - t0,
    });
    body = r.success ? (r.output || "(empty)") : `❌ exit ${r.metadata?.exitCode ?? "?"}:\n${r.error ?? ""}`;
    store.addMessage(o.sessionId, "assistant", body.slice(0, 8000));
  } catch (e) { body = `❌ ${String(e).slice(0, 500)}`; }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const { text } = truncateForTelegram(`💻 <code>${esc(o.command)}</code>\n<pre>${esc(body.slice(0, 3500))}</pre>\n\n⏱ ${secs}s • langsung, tanpa token AI`);
  try { await withRetry(() => ctx.reply(text, { parse_mode: "HTML" })); }
  catch { await withRetry(() => ctx.reply(text.replace(/<[^>]+>/g, ""))); }
}

async function runAgentForMessage(ctx: Context, text: string): Promise<void> {
  const env = getEnv();
  const userId = ctx.from?.id;
  if (userId === undefined) return;
  const telegramId = String(userId);
  const dbUser = store.upsertUser(telegramId, ctx.from?.username);
  const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));

  // workspace resolution: explicit "project X" wins, otherwise keep the session's current workspace.
  // A name that escapes WORKSPACE_ROOT is dropped (with a note) instead of
  // throwing before the status message is sent.
  const setting = parseNaturalSettings(text);
  let explicitWs: string | null = null;
  if (setting?.key === "workspace") {
    try { resolveWorkspacePath(setting.value); explicitWs = setting.value; }
    catch (e) { await ctx.reply(`❌ ${String(e).slice(0, 200)}`); }
  }
  const sessionId = ensureSession(dbUser, chatDb, explicitWs, null, null);
  const sess = store.getSession(sessionId) as { provider: string; model: string; workspace_id: string } | undefined;
  const sessWs = sess ? (store.getWorkspaceById(sess.workspace_id) as { path: string } | undefined)?.path : undefined;
  const wsPath = sessWs ?? resolveWorkspacePath("default");
  const runProvider = sess?.provider || env.PROVIDER;
  const runModel = sess?.model || env.DEFAULT_MODEL;

  // Fast-path: trivial read-only shell one-liners run instantly with zero
  // tokens instead of spinning the whole plan loop (fixes "ls -la takes forever").
  const fast = matchFastShellCommand(text);
  if (fast) {
    await runFastShell(ctx, { dbUser, sessionId, wsPath, command: fast, input: text });
    return;
  }

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
    const handle = await startRun({ userId: dbUser, chatDbId: chatDb, sessionId, workspacePath: wsPath, provider: runProvider, model: runModel, input: text });
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
    const finalHtml = renderFinalSummaryHtml({ filesChanged: [...new Set(filesChanged)], durationMs: duration, tokens, model: runModel, summary: lastSummary || undefined });
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
      const fallback = renderFinalSummary({ filesChanged: dedupFiles, durationMs: duration, tokens, model: runModel, summary: lastSummary || undefined });
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

export { setupKeyboard };
