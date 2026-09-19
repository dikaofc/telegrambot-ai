import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ChatRequest, LLMEvent, LLMProvider } from "./types.js";

/** Anthropic native Messages API provider with tool_use translation. */
export class AnthropicProvider implements LLMProvider {
  id = "anthropic"; name = "Anthropic";
  private baseUrl: string; private apiKey: string; private defaultModel: string;

  constructor(baseUrl: string, apiKey: string, defaultModel = "claude-3-5-sonnet-latest") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey; this.defaultModel = defaultModel;
  }

  async *chat(request: ChatRequest): AsyncIterable<LLMEvent> {
    const model = request.model && request.model !== "auto" ? request.model : this.defaultModel;
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const messages = request.messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user" as const, content: m.content,
    }));
    const tools = (request.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: { type: "object", properties: t.schema } }));
    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: request.maxTokens ?? 4096, system: system || undefined, messages, tools: tools.length ? tools : undefined }),
    });
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 1000)}`);
    const j = await res.json() as {
      content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    let tIn = 0; let tOut = 0;
    if (j.usage) { tIn = j.usage.input_tokens ?? 0; tOut = j.usage.output_tokens ?? 0; }
    for (const b of j.content ?? []) {
      if (b.type === "text" && b.text) yield { type: "text", text: b.text } as LLMEvent;
      if (b.type === "tool_use" && b.name) yield { type: "tool_call", toolCall: { id: b.id ?? `tu-${Date.now()}`, name: b.name, args: b.input ?? {} } } as LLMEvent;
    }
    yield { type: "usage", usage: { inputTokens: tIn, outputTokens: tOut } } as LLMEvent;
    yield { type: "done" } as LLMEvent;
  }

  async models(): Promise<string[]> { return [this.defaultModel]; }
  async health(): Promise<boolean> { return Boolean(this.apiKey); }
}

export { OpenAICompatibleProvider };
