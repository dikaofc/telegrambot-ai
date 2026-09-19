import { metrics } from "../observability/metrics.js";
import type { ChatRequest, LLMEvent, LLMProvider } from "./types.js";

export interface OAICompatOpts { id: string; name: string; baseUrl: string; apiKey: string; defaultModel: string; timeoutMs?: number; }

function resolveModel(req: ChatRequest, def: string): string {
  if (req.model && req.model !== "auto") return req.model;
  return def;
}

export class OpenAICompatibleProvider implements LLMProvider {
  id: string; name: string;
  private baseUrl: string; private apiKey: string; private defaultModel: string; private timeoutMs: number;

  constructor(o: OAICompatOpts) {
    this.id = o.id; this.name = o.name;
    this.baseUrl = o.baseUrl.replace(/\/$/, "");
    this.apiKey = o.apiKey; this.defaultModel = o.defaultModel;
    this.timeoutMs = o.timeoutMs ?? 120_000;
  }

  async *chat(request: ChatRequest): AsyncIterable<LLMEvent> {
    metrics.providerRequests.inc();
    const model = resolveModel(request, this.defaultModel);
    const tools = (request.tools ?? []).map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: { type: "object", properties: t.schema, additionalProperties: true } },
    }));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const onAbort = () => ctrl.abort();
    request.signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        signal: request.signal ?? ctrl.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          // strict upstreams (cehpoint, openai) reject role:"tool" without tool_call_id —
          // fold tool results into user messages so every upstream accepts them
          messages: request.messages.map((m) => (m.role === "tool"
            ? { role: "user", content: `[tool ${m.toolName ?? "result"}]\n${m.content}` }
            : { role: m.role, content: m.content })),
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? "auto" : undefined,
          stream: true,
          max_tokens: request.maxTokens ?? 4096,
          temperature: request.temperature ?? 0.2,
        }),
      });
      if (!res.ok || !res.body) {
        metrics.providerErrors.inc();
        throw new Error(`provider ${this.id} HTTP ${res.status}: ${(await res.text()).slice(0, 1000)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let inputTokens = 0; let outputTokens = 0;
      const toolBuffers = new Map<string, { name: string; args: string }>();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            if (json.usage) { inputTokens = json.usage.prompt_tokens ?? 0; outputTokens = json.usage.completion_tokens ?? 0; }
            for (const ch of json.choices ?? []) {
              if (ch.delta?.content) yield { type: "text", text: ch.delta.content };
              for (const tc of ch.delta?.tool_calls ?? []) {
                const id = (tc as { id?: string; index?: number }).id ?? `call-${(tc as { index?: number }).index ?? toolBuffers.size}`;
                const cur = toolBuffers.get(id) ?? { name: "", args: "" };
                if (tc.function?.name) cur.name = tc.function.name;
                // some providers (pollinations) send arguments as an object, not a string
                const fargs = (tc.function as { arguments?: unknown } | undefined)?.arguments;
                if (typeof fargs === "string") cur.args += fargs;
                else if (fargs && typeof fargs === "object") cur.args = JSON.stringify(fargs);
                toolBuffers.set(id, cur);
              }
              if (ch.finish_reason === "tool_calls" || ch.finish_reason === "stop") {
                for (const [id, tb] of toolBuffers) {
                  if (!tb.name) continue;
                  let args: Record<string, unknown> = {};
                  try { args = JSON.parse(tb.args || "{}") as Record<string, unknown>; } catch { args = { _raw: tb.args }; }
                  yield { type: "tool_call", toolCall: { id, name: tb.name, args } };
                }
                toolBuffers.clear();
              }
            }
          } catch { /* keep streaming on partial JSON */ }
        }
      }
      metrics.tokensUsed.inc({}, inputTokens + outputTokens);
      yield { type: "usage", usage: { inputTokens, outputTokens } };
      yield { type: "done" };
    } catch (e) {
      metrics.providerErrors.inc();
      throw e;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  async models(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: { authorization: `Bearer ${this.apiKey}` } });
      if (!res.ok) return [this.defaultModel];
      const j = await res.json() as { data?: Array<{ id: string }> };
      const ids = (j.data ?? []).map((d) => d.id);
      return ids.length ? ids : [this.defaultModel];
    } catch { return [this.defaultModel]; }
  }

  async health(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(`${this.baseUrl}/models`, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: ctrl.signal });
        return res.ok;
      } finally { clearTimeout(t); }
    } catch { return false; }
  }
}
