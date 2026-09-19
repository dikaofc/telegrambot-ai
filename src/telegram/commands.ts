import { Bot, InputFile, type Context } from "grammy";
import { getEnv, KNOWN_PROVIDERS } from "../config/env.js";
import { getLogger } from "../observability/logger.js";
import { checkHealth } from "../observability/health.js";
import { store } from "../database/store.js";
import { isAuthorized } from "../security/access.js";
import { resolveWorkspacePath } from "../workspace/manager.js";
import { ensureSession, stopRun, pauseRun, resumeRun, sessionRunId } from "../agent/orchestrator.js";
import { rollbackToCommit } from "../agent/checkpoint.js";
import { gitTools } from "../tools/git.js";
import { truncateForTelegram, splitMessage } from "../utils/large-output.js";
import { settingsKeyboard } from "./keyboards.js";

export interface BotCommandMeta {
  command: string;
  short: string;
  usage: string;
  example: string;
}

/** Single source of truth for slash commands: powers /help + the Telegram menu. */
export const COMMANDS: BotCommandMeta[] = [
  { command: "start", short: "Start + connection status", usage: "/start", example: "/start" },
  { command: "help", short: "Full command reference", usage: "/help", example: "/help" },
  { command: "status", short: "Session, model, provider, workspace, active run", usage: "/status", example: "/status" },
  { command: "settings", short: "Settings panel (inline buttons)", usage: "/settings", example: "/settings" },
  { command: "model", short: "Switch model for this chat", usage: "/model <name>  (auto = router default)", example: "/model cbai/minimax-m3" },
  { command: "provider", short: "Switch provider for this chat", usage: `/provider <${KNOWN_PROVIDERS.join("|")}>`, example: "/provider openai" },
  { command: "workspace", short: "Switch active workspace", usage: "/workspace <name>", example: "/workspace my-project" },
  { command: "new", short: "Fresh session (clear conversation)", usage: "/new", example: "/new" },
  { command: "stop", short: "Cancel the active run (also: /cancel)", usage: "/stop", example: "/stop" },
  { command: "pause", short: "Pause the active run (state saved)", usage: "/pause", example: "/pause" },
  { command: "resume", short: "Resume a paused run", usage: "/resume", example: "/resume" },
  { command: "retry", short: "Re-run your last message", usage: "/retry", example: "/retry" },
  { command: "diff", short: "Show uncommitted changes", usage: "/diff", example: "/diff" },
  { command: "log", short: "Tool-call log of the last run", usage: "/log [n=15]", example: "/log 30" },
  { command: "undo", short: "Restore last checkpoint (git rollback)", usage: "/undo", example: "/undo" },
  { command: "approvals", short: "List pending approvals", usage: "/approvals", example: "/approvals" },
  { command: "approve", short: "Approve a pending action", usage: "/approve <id…> (first chars enough)", example: "/approve a8f31d" },
  { command: "reject", short: "Reject a pending action", usage: "/reject <id…>", example: "/reject a8f31d" },
  { command: "usage", short: "Tokens, cost, daily quota", usage: "/usage", example: "/usage" },
  { command: "doctor", short: "Self-diagnose all subsystems", usage: "/doctor", example: "/doctor" },
  { command: "graph", short: "Ask the knowledge graph", usage: "/graph <question>", example: "/graph what connects auth to the database?" },
];

export function buildHelpText(): string {
  const lines = ["🤖 *TeleAgent commands* — full control. (You can also just talk normally.)", ""];
  for (const c of COMMANDS) {
    lines.push(`/${c.command} — ${c.short}\n  usage: \`${c.usage}\`\n  ex: \`${c.example}\``);
  }
  lines.push("", "Tips: send `stop` anytime to cancel. Destructive git ops always ask first — except /undo, which IS your explicit approval.");
  return lines.join("\n");
}

interface Ctx {
  dbUser: string;
  chatDb: string;
  sessionId: string;
  provider: string;
  model: string;
  workspaceId: string;
  wsPath: string;
}

function sessionCtx(ctx: Context): Ctx {
  const env = getEnv();
  const telegramId = String(ctx.from?.id ?? "");
  const dbUser = store.upsertUser(telegramId, ctx.from?.username);
  const chatDb = store.ensureChat(dbUser, String(ctx.chat?.id ?? ""));
  const sessionId = ensureSession(dbUser, chatDb, "default", env.PROVIDER, env.DEFAULT_MODEL);
  const s = store.getSession(sessionId) as { provider: string; model: string; workspace_id: string };
  const wsRow = store.getWorkspaceById(s.workspace_id) as { path: string } | undefined;
  const wsPath = wsRow?.path ?? resolveWorkspacePath("default");
  return { dbUser, chatDb, sessionId, provider: s.provider, model: s.model, workspaceId: s.workspace_id, wsPath };
}

function authed(ctx: Context): boolean {
  const userId = ctx.from?.id;
  if (userId === undefined) return false;
  const g = isAuthorized(userId, ctx.chat?.id);
  if (!g.ok) { void ctx.reply(`⛔ unauthorized (${g.reason})`); return false; }
  return true;
}

async function activeRunId(sessionId: string): Promise<string | null> {
  return sessionRunId(sessionId) ?? null;
}

/** Register every slash command. runText reuses the main agent pipeline. */
export function setupBotCommands(bot: Bot, deps: { runText: (ctx: Context, text: string) => Promise<void> }): void {
  const log = getLogger();

  bot.command("start", async (ctx) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    await ctx.reply(
      `🤖 TeleAgent\n\nstatus: ready\nprovider: ${c.provider}\nmodel: ${c.model}\nworkspace: ${c.wsPath}\n\nSend me anything — I understand natural language.\nType /help for full control commands.`,
      { reply_markup: { inline_keyboard: settingsKeyboard() } },
    );
  });

  bot.command("help", async (ctx) => {
    if (!authed(ctx)) return;
    for (const chunk of splitMessage(buildHelpText(), 4000)) {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    }
  });

  bot.command("status", async (ctx) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    const runId = await activeRunId(c.sessionId);
    const last = store.lastRunForSession(c.sessionId) as { status: string } | undefined;
    await ctx.reply(
      `📊 status\n\nprovider: ${c.provider}\nmodel: ${c.model}\nworkspace: ${c.wsPath}\nactive run: ${runId ?? "(idle)"}\nlast run: ${last?.status ?? "(none)"}\n\n/send anything to start working.`,
    );
  });

  bot.command("settings", async (ctx) => {
    if (!authed(ctx)) return;
    await ctx.reply("⚙️ Settings", { reply_markup: { inline_keyboard: settingsKeyboard() } });
  });

  bot.command("model", async (ctx) => {
    if (!authed(ctx)) return;
    const name = (ctx.match as string ?? "").trim();
    if (!name) { await ctx.reply("usage: /model <name>\ncurrent: " + sessionCtx(ctx).model); return; }
    const c = sessionCtx(ctx);
    store.updateSession(c.sessionId, { model: name.replace(/[^a-zA-Z0-9/_:.-]/g, "") });
    await ctx.reply(`model preference updated:\n${name}\n(applies to this chat from now on)`);
  });

  bot.command("provider", async (ctx) => {
    if (!authed(ctx)) return;
    const name = ((ctx.match as string) ?? "").trim().toLowerCase();
    if (!KNOWN_PROVIDERS.includes(name)) {
      await ctx.reply(`usage: /provider <${KNOWN_PROVIDERS.join("|")}>\ncurrent: ${sessionCtx(ctx).provider}`);
      return;
    }
    const c = sessionCtx(ctx);
    store.updateSession(c.sessionId, { provider: name });
    await ctx.reply(`provider updated:\n${name}`);
  });

  bot.command("workspace", async (ctx) => {
    if (!authed(ctx)) return;
    const name = ((ctx.match as string) ?? "").trim();
    if (!name) { await ctx.reply("usage: /workspace <name>\ncurrent: " + sessionCtx(ctx).wsPath); return; }
    const c = sessionCtx(ctx);
    const p = resolveWorkspacePath(name);
    const wsId = store.ensureWorkspace(name, p, c.dbUser);
    store.updateSession(c.sessionId, { workspace_id: wsId });
    await ctx.reply(`workspace updated:\n${name} → ${p}`);
  });

  bot.command("new", async (ctx) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    const id = store.createSession({ userId: c.dbUser, chatId: c.chatDb, workspaceId: c.workspaceId, provider: c.provider, model: c.model });
    await ctx.reply(`🆕 fresh session started (${id.slice(0, 8)}). Previous history is kept in the database.`);
  });

  const control = (kind: "stop" | "pause" | "resume") => async (ctx: Context) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    const runId = await activeRunId(c.sessionId);
    if (!runId) { await ctx.reply("no active run"); return; }
    const ok = kind === "stop" ? await stopRun(runId) : kind === "pause" ? await pauseRun(runId) : await resumeRun(runId);
    await ctx.reply(ok
      ? kind === "stop" ? "🛑 cancelled. State persisted." : kind === "pause" ? "⏸ paused. State saved." : "▶️ resumed."
      : "no active run (already finished?)");
  };
  bot.command("stop", control("stop"));
  bot.command("cancel", control("stop"));
  bot.command("pause", control("pause"));
  bot.command("resume", control("resume"));

  bot.command("retry", async (ctx) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    const last = store.lastUserMessage(c.sessionId);
    if (!last) { await ctx.reply("nothing to retry yet — send me a task first."); return; }
    await ctx.reply(`🔁 retrying your last message:\n${last.slice(0, 300)}`);
    await deps.runText(ctx, last);
  });

  bot.command("diff", async (ctx) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    const stat = await gitTools.diff(c.wsPath, ["--stat"]);
    const body = stat.success ? (stat.output ?? "(clean)") : `error: ${stat.error}`;
    const full = await gitTools.diff(c.wsPath);
    const { text, truncated } = truncateForTelegram(`📝 uncommitted changes:\n\n${body}`);
    await ctx.reply(text);
    if (truncated && full.success) {
      await ctx.replyWithDocument(new InputFile(Buffer.from(full.output ?? "", "utf8"), "changes.diff"), { caption: "full diff" });
    }
  });

  bot.command("log", async (ctx) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    const n = Math.min(Math.max(parseInt(((ctx.match as string) ?? "").trim() || "15", 10) || 15, 1), 50);
    const last = store.lastRunForSession(c.sessionId) as { id: string; input: string; status: string } | undefined;
    if (!last) { await ctx.reply("no runs yet in this chat."); return; }
    const calls = store.toolCallsForRun(last.id, n);
    const lines = [`🧾 last run (${last.id.slice(0, 8)}, ${last.status}):`, `input: ${last.input.slice(0, 150)}`, ""];
    if (calls.length === 0) lines.push("(no tool calls recorded)");
    for (const t of calls) {
      const mark = t.success === null ? "…" : t.success ? "✓" : "✗";
      lines.push(`${mark} ${t.tool} [${t.risk}] ${t.approval ?? ""} ${t.duration_ms ?? "?"}ms exit=${t.exit_code ?? "?"}`);
    }
    for (const chunk of splitMessage(lines.join("\n"))) await ctx.reply(chunk);
  });

  bot.command("undo", async (ctx) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    const cp = store.latestCheckpoint(c.workspaceId) as { git_commit: string | null; created_at: string } | undefined;
    if (!cp?.git_commit) { await ctx.reply("no checkpoint with a git commit yet — /undo needs a checkpoint created before big changes."); return; }
    await ctx.reply(`⏪ restoring checkpoint from ${cp.created_at} (commit ${cp.git_commit.slice(0, 8)})…\nCurrent work is stashed first, so nothing is lost.`);
    const r = await rollbackToCommit(c.wsPath, cp.git_commit);
    await ctx.reply(r.ok ? `✅ restored.\n${r.output.slice(0, 1500)}` : `❌ restore failed:\n${r.output.slice(0, 1500)}`);
  });

  bot.command("approvals", async (ctx) => {
    if (!authed(ctx)) return;
    const list = store.pendingApprovals(20) as Array<{ id: string; tool: string; command: string; risk: string }>;
    if (list.length === 0) { await ctx.reply("no pending approvals."); return; }
    const lines = ["⚠️ pending approvals (reply /approve <id> or /reject <id>):", ""];
    for (const a of list) lines.push(`• \`${a.id.slice(0, 8)}\` [${a.risk}] ${a.tool}: ${a.command.slice(0, 100)}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  const resolve = (status: "approved" | "rejected") => async (ctx: Context) => {
    if (!authed(ctx)) return;
    const prefix = ((ctx.match as string) ?? "").trim();
    if (!prefix) { await ctx.reply(`usage: /${status} <id> — see /approvals`); return; }
    const id = store.resolveApprovalPrefix(prefix, status);
    await ctx.reply(id ? (status === "approved" ? `✅ approved ${id.slice(0, 8)} — resuming…` : `❌ rejected ${id.slice(0, 8)} — agent will work around it.`) : "no unique pending approval matches that id — see /approvals");
  };
  bot.command("approve", resolve("approved"));
  bot.command("reject", resolve("rejected"));

  bot.command("usage", async (ctx) => {
    if (!authed(ctx)) return;
    const c = sessionCtx(ctx);
    const totals = store.usageTotals(c.dbUser);
    const env = getEnv();
    const daily = store.dailyTokens(c.dbUser);
    await ctx.reply(
      `📈 usage\n\ntoday: ${daily}/${env.MAX_DAILY_TOKENS} tokens\nlifetime runs: ${totals.total.runs}\nlifetime tokens: ${totals.total.t_in + totals.total.t_out}\nlifetime cost: $${Number(totals.total.cost).toFixed(4)}`,
    );
  });

  bot.command("doctor", async (ctx) => {
    if (!authed(ctx)) return;
    try {
      const h = await checkHealth();
      const rows = Object.entries(h.detail ?? {}).map(([k, v]) => `${k}: ${v}`);
      await ctx.reply(`🩺 doctor — ${h.status}\n\ntelegram: ${h.telegram}\ndatabase: ${h.database}\nsandbox: ${h.sandbox}\nprovider: ${h.provider}\nworkspace: ${h.workspace}\npty: ${h.pty}\n\n${rows.join("\n")}`.slice(0, 3500));
    } catch (e) { await ctx.reply(`doctor failed: ${String(e).slice(0, 500)}`); }
  });

  bot.command("graph", async (ctx) => {
    if (!authed(ctx)) return;
    const q = ((ctx.match as string) ?? "").trim();
    if (!q) { await ctx.reply("usage: /graph <question>\nexample: /graph what connects auth to the database?"); return; }
    const c = sessionCtx(ctx);
    await ctx.reply("🔎 querying knowledge graph…");
    try {
      const { queryGraph } = await import("../integrations/graphify.js");
      const r = await queryGraph(c.wsPath, q);
      const out = r.success ? (r.output ?? "(empty)") : `graph unavailable: ${r.error}`;
      const { text, truncated } = truncateForTelegram(out);
      await ctx.reply(text);
      if (truncated) await ctx.replyWithDocument(new InputFile(Buffer.from(out, "utf8"), "graph-result.txt"));
    } catch (e) { await ctx.reply(`graph failed: ${String(e).slice(0, 500)}`); }
  });

  log.info({ event: "bot.commands", count: COMMANDS.length }, "slash commands registered");
}

/** Telegram Bot API command menu ( максимум clarity in the client UI). */
export async function applyBotMenu(bot: Bot): Promise<void> {
  try {
    await bot.api.setMyCommands(COMMANDS.map((c) => ({ command: c.command, description: `${c.short} — ${c.usage}`.slice(0, 256) })));
  } catch (e) {
    getLogger().warn({ event: "bot.menu.failed", err: String(e) }, "could not set bot command menu");
  }
}
