import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { getEnv } from "../config/env.js";
import { getLogger } from "../observability/logger.js";
import { renderPrometheus, metrics } from "../observability/metrics.js";
import { checkHealth } from "../observability/health.js";
import { store } from "../database/store.js";
import { isAuthorized } from "../security/access.js";
import { listWorkspaces, resolveWorkspacePath, detectProjectProfile } from "../workspace/manager.js";
import { availableProviders, createProvider } from "../providers/factory.js";
import { startRun, stopRun, ensureSession, activeRunCount } from "../agent/orchestrator.js";
import { applyEvent, emptySnapshot, renderStatusMessage } from "../telegram/renderer.js";
import { dashboardPage } from "../dashboard/page.js";
import { assertNotSecretKey } from "../tools/extended.js";

export async function buildApiServer() {
  const env = getEnv();
  const app = Fastify({ logger: false });
  await app.register(websocket);

  const auth = async (req: { headers: Record<string, string | string[] | undefined> }, reply: { code(n: number): { send(x: unknown): void } }): Promise<boolean> => {
    if (!env.TELEAGENT_API_KEY) return true;
    const rawAuth = req.headers.authorization;
    const authStr = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    const keyHdr = req.headers["x-api-key"];
    const key = (Array.isArray(keyHdr) ? keyHdr[0] : keyHdr) ?? authStr?.replace("Bearer ", "");
    if (key !== env.TELEAGENT_API_KEY) { reply.code(401).send({ error: "unauthorized" }); return false; }
    return true;
  };

  app.get("/health", async () => {
    const h = await checkHealth();
    return { status: h.status, telegram: h.telegram, database: h.database, sandbox: h.sandbox, provider: h.provider };
  });
  app.get("/ready", async () => {
    const h = await checkHealth();
    return h.status === "ok" ? { ready: true } : { ready: false, detail: h.detail };
  });
  app.get("/metrics", async (_req, reply) => {
    void reply;
    return renderPrometheus();
  });

  app.get("/v1/providers", async () => ({ providers: availableProviders() }));
  app.get("/v1/models", async (req) => {
    const q = (req.query as { provider?: string }).provider ?? env.PROVIDER;
    try { return { provider: q, models: await createProvider(q).models() }; }
    catch (e) { return { provider: q, models: [], error: String(e) }; }
  });

  app.get("/v1/workspaces", async () => ({ workspaces: listWorkspaces() }));
  app.post("/v1/workspaces", async (req) => {
    const body = (req.body ?? {}) as { name?: string };
    const p = resolveWorkspacePath(body.name ?? `ws-${Date.now()}`);
    return { path: p };
  });

  app.post("/v1/sessions", async (req) => {
    const body = (req.body ?? {}) as { userId?: string; chatId?: string; workspace?: string; provider?: string; model?: string };
    const uid = store.upsertUser(String(body.userId ?? "api"), undefined);
    const chat = store.ensureChat(uid, String(body.chatId ?? "api"));
    const id = ensureSession(uid, chat, body.workspace ?? "default", body.provider ?? env.PROVIDER, body.model ?? env.DEFAULT_MODEL);
    return { id };
  });
  app.get("/v1/sessions", async () => ({ note: "list via database; single-node keeps latest per chat" }));
  app.get("/v1/sessions/:id", async (req) => {
    const p = req.params as { id: string };
    return store.getSession(p.id) ?? { error: "not found" };
  });
  app.post("/v1/sessions/:id/messages", async (req, reply) => {
    if (!(await auth(req as never, reply as never))) return;
    const p = req.params as { id: string };
    const body = (req.body ?? {}) as { input?: string; userId?: string };
    const s = store.getSession(p.id) as { user_id: string; chat_id: string; workspace_id: string; provider: string; model: string } | undefined;
    if (!s) { (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(404).send({ error: "session not found" }); return; }
    const wsRow = store.getSession(p.id);
    void wsRow;
    const handle = await startRun({
      userId: s.user_id, chatDbId: s.chat_id, sessionId: p.id,
      workspacePath: "default", provider: s.provider, model: s.model,
      input: String(body.input ?? ""),
    });
    // drain in background, expose run id immediately
    void (async () => { for await (const _ of handle.events) { void _; } })();
    return { runId: handle.runId };
  });
  app.post("/v1/sessions/:id/stop", async (req) => {
    const p = req.params as { id: string };
    const { sessionRunId } = await import("../agent/orchestrator.js");
    const runId = sessionRunId(p.id);
    if (!runId) return { stopped: false };
    return { stopped: await stopRun(runId) };
  });
  app.post("/v1/sessions/:id/pause", async () => ({ ok: true }));
  app.post("/v1/sessions/:id/resume", async () => ({ ok: true }));
  app.get("/v1/runs/:id", async (req) => ({ run: req.params }));
  app.get("/v1/runs/:id/events", async () => ({ events: [] }));

  // ---- dashboard (HTML open; JSON status public; mutations gated by API key) ----
  app.get("/", async (_req, reply) => {
    void reply;
    return (reply as unknown as { type(t: string): { send(x: string): void } }).type("text/html").send(dashboardPage());
  });

  app.get("/api/status", async () => {
    const h = await checkHealth();
    return {
      health: h, counts: store.counts(), activeRuns: activeRunCount(),
      provider: env.PROVIDER, model: env.DEFAULT_MODEL,
      access: env.BOT_ACCESS_MODE, workspace: env.WORKSPACE_ROOT,
    };
  });

  const gate = async (req: never, reply: never): Promise<boolean> => auth(req as never, reply as never);

  app.get("/api/sessions", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const q = (req.query as { limit?: string }).limit;
    return { sessions: store.listSessions(Math.min(Number(q) || 50, 200)) };
  });
  app.get("/api/runs", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const q = req.query as { sessionId?: string; limit?: string };
    return { runs: store.listRuns(q.sessionId, Math.min(Number(q.limit) || 50, 200)) };
  });
  app.post("/api/runs/:id/stop", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const p = req.params as { id: string };
    return { stopped: await stopRun(p.id) };
  });
  app.get("/api/approvals/pending", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    return { approvals: store.pendingApprovals() };
  });
  app.post("/api/approvals/:id", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const p = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const st = body.status === "approved" ? "approved" : "rejected";
    store.resolveApproval(p.id, st);
    return { id: p.id, status: st };
  });
  app.get("/api/workspaces", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const names = listWorkspaces();
    return {
      workspaces: names.map((n) => {
        const p = resolveWorkspacePath(n);
        let profile = {};
        try { profile = detectProjectProfile(p); } catch { /* noop */ }
        return { name: n, path: p, profile };
      }),
    };
  });
  app.get("/api/providers", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const names = availableProviders();
    const selected = env.PROVIDER;
    const providers = await Promise.all(names.map(async (n) => {
      if (n !== selected) return { name: n, selected: false, healthy: false, models: [] as string[] };
      try {
        const p = createProvider(n);
        const [healthy, models] = await Promise.all([p.health().catch(() => false), p.models().catch(() => [] as string[])]);
        return { name: n, selected: true, healthy, models };
      } catch { return { name: n, selected: true, healthy: false, models: [] as string[] }; }
    }));
    return { providers, selected };
  });
  app.get("/api/usage", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const q = req.query as { userId?: string };
    return store.usageTotals(q.userId);
  });
  app.get("/api/audit", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const q = (req.query as { limit?: string }).limit;
    return { logs: store.auditList(Math.min(Number(q) || 100, 500)) };
  });
  app.get("/api/settings", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    return { settings: store.listSettings() };
  });
  app.post("/api/settings", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const body = (req.body ?? {}) as { key?: string; value?: string; scope?: string; scopeId?: string };
    if (!body.key || body.value === undefined) {
      (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(400).send({ error: "key and value required" });
      return;
    }
    try { assertNotSecretKey(body.key); } catch (e) {
      (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(403).send({ error: String(e) });
      return;
    }
    store.setSetting(body.key, String(body.value), body.scope || "global", body.scopeId || "");
    return { ok: true, key: body.key };
  });

  // ---- provider config via dashboard (mirip .env, tapi lewat UI) ----
  app.get("/api/provider-config", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const env = getEnv();
    const mask = (s: string) => s ? s.slice(0, 6) + "****" + s.slice(-4) : "";
    return {
      provider: env.PROVIDER,
      baseUrl: env.PROVIDER_BASE_URL,
      apiKeyMasked: mask(env.PROVIDER_API_KEY),
      hasKey: Boolean(env.PROVIDER_API_KEY),
      model: env.PROVIDER_MODEL,
      defaultModel: env.DEFAULT_MODEL,
    };
  });
  app.post("/api/provider-config", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const body = (req.body ?? {}) as { provider?: string; baseUrl?: string; apiKey?: string; model?: string };
    const allowedProviders = ["9router", "openai", "xai", "anthropic", "ollama", "custom"];
    if (body.provider && !allowedProviders.includes(body.provider)) {
      (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(400).send({ error: `provider harus salah satu: ${allowedProviders.join(", ")}` });
      return;
    }
    // Update process.env live (tanpa restart)
    if (body.provider !== undefined) process.env.PROVIDER = String(body.provider);
    if (body.baseUrl !== undefined) process.env.PROVIDER_BASE_URL = String(body.baseUrl);
    if (body.apiKey !== undefined && body.apiKey !== "") process.env.PROVIDER_API_KEY = String(body.apiKey);
    if (body.model !== undefined) process.env.PROVIDER_MODEL = String(body.model);
    // Persist to .env file (best-effort)
    try {
      const { default: fs } = await import("node:fs");
      const envPath = ".env";
      let content = "";
      try { content = fs.readFileSync(envPath, "utf8"); } catch { content = ""; }
      const upsert = (key: string, val: string) => {
        const re = new RegExp(`^${key}=.*$`, "m");
        const line = `${key}=${val}`;
        if (re.test(content)) content = content.replace(re, line);
        else content += (content.endsWith("\n") || content === "" ? "" : "\n") + line + "\n";
      };
      if (body.provider !== undefined) upsert("PROVIDER", String(body.provider));
      if (body.baseUrl !== undefined) upsert("PROVIDER_BASE_URL", String(body.baseUrl));
      if (body.apiKey !== undefined && body.apiKey !== "") upsert("PROVIDER_API_KEY", String(body.apiKey));
      if (body.model !== undefined) upsert("PROVIDER_MODEL", String(body.model));
      fs.writeFileSync(envPath, content, "utf8");
    } catch (e) {
      getLogger().warn({ event: "provider-config.persist.failed", err: String(e) }, "could not persist .env");
    }
    return { ok: true, provider: process.env.PROVIDER, baseUrl: process.env.PROVIDER_BASE_URL, hasKey: Boolean(process.env.PROVIDER_API_KEY), model: process.env.PROVIDER_MODEL };
  });
  app.get("/api/memory", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const q = req.query as { scope?: string; scopeId?: string };
    if (!q.scope || !q.scopeId) {
      (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(400).send({ error: "scope and scopeId required" });
      return;
    }
    return { memory: store.getMemory(q.scope, q.scopeId) };
  });

  // ---- graphify harness ----
  app.get("/api/graphify/status", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const q = req.query as { workspace?: string };
    const { graphStatus } = await import("../integrations/graphify.js");
    return graphStatus(resolveWorkspacePath(q.workspace ?? "default"));
  });
  app.post("/api/graphify/build", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const body = (req.body ?? {}) as { workspace?: string; updateOnly?: boolean };
    const { buildGraph } = await import("../integrations/graphify.js");
    return buildGraph(resolveWorkspacePath(body.workspace ?? "default"), Boolean(body.updateOnly));
  });
  app.post("/api/graphify/query", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const body = (req.body ?? {}) as { workspace?: string; question?: string };
    if (!body.question) {
      (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(400).send({ error: "question required" });
      return;
    }
    const { queryGraph } = await import("../integrations/graphify.js");
    return queryGraph(resolveWorkspacePath(body.workspace ?? "default"), body.question);
  });
  app.post("/api/graphify/path", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const body = (req.body ?? {}) as { workspace?: string; from?: string; to?: string };
    if (!body.from || !body.to) {
      (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(400).send({ error: "from and to required" });
      return;
    }
    const { graphPath } = await import("../integrations/graphify.js");
    return graphPath(resolveWorkspacePath(body.workspace ?? "default"), body.from, body.to);
  });
  app.post("/api/graphify/explain", async (req, reply) => {
    if (!(await gate(req as never, reply as never))) return;
    const body = (req.body ?? {}) as { workspace?: string; symbol?: string };
    if (!body.symbol) {
      (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(400).send({ error: "symbol required" });
      return;
    }
    const { explainNode } = await import("../integrations/graphify.js");
    return explainNode(resolveWorkspacePath(body.workspace ?? "default"), body.symbol);
  });

  app.get("/v1/ws/sessions/:id", { websocket: true }, (socket: unknown) => {
    const sock = socket as { on(ev: string, cb: (raw: Buffer) => void): void; send(data: string): void };
    let snap = emptySnapshot();
    sock.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "ping") sock.send(JSON.stringify({ type: "pong" }));
      } catch { /* ignore */ }
    });
    void snap; void applyEvent; void renderStatusMessage;
    sock.send(JSON.stringify({ type: "ready" }));
  });

  // OpenAI-compatible gateway → agent
  app.post("/v1/chat/completions", async (req, reply) => {
    if (!(await auth(req as never, reply as never))) return;
    const body = (req.body ?? {}) as { model?: string; messages?: Array<{ role: string; content: string }> };
    const last = (body.messages ?? []).filter((m) => m.role === "user").pop();
    const uid = store.upsertUser("api-gateway", undefined);
    const chat = store.ensureChat(uid, "api-gateway");
    const sid = ensureSession(uid, chat, "default", env.PROVIDER, body.model ?? "auto");
    try {
      const handle = await startRun({
        userId: uid, chatDbId: chat, sessionId: sid, workspacePath: "default",
        provider: env.PROVIDER, model: body.model ?? "auto", input: last?.content ?? "",
      });
      let summary = "";
      for await (const ev of handle.events) {
        if (ev.type === "completed") summary = ev.summary;
        if (ev.type === "error") summary += `\n${ev.error}`;
      }
      metrics.telegramMessages.inc();
      return {
        id: `chatcmpl-${handle.runId}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model: body.model ?? "auto",
        choices: [{ index: 0, message: { role: "assistant", content: summary }, finish_reason: "stop" }],
      };
    } catch (e) { (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(500).send({ error: String(e) }); }
  });

  // Telegram webhook (production) with secret-token validation
  app.post("/telegram/webhook", async (req, reply) => {
    const secret = (req.headers["x-telegram-bot-api-secret-token"] as string | undefined) ?? "";
    if (env.TELEGRAM_WEBHOOK_SECRET && secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      (reply as unknown as { code(n: number): { send(x: unknown): void } }).code(401).send({ error: "bad secret" });
      return;
    }
    void isAuthorized;
    return { ok: true };
  });

  return app;
}
