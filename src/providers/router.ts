import { createProvider } from "./factory.js";
import type { ChatRequest, LLMEvent } from "./types.js";
import { getLogger } from "../observability/logger.js";

export interface RoutingConfig {
  primary: string;
  fallback: string[];
  allowFallback: boolean;
}

/** Task-classifier → preferred model router with timeout → retry → fallback. */
export function classifyTask(input: string): "coding" | "reasoning" | "chat" {
  const t = input.toLowerCase();
  if (/code|bug|test|build|refactor|implement|fix|deploy|api|database|auth|review|project|file|npm|git|error|crash|leak/.test(t)) return "coding";
  // shell / filesystem / terminal intent needs tools — never "chat" (chat sends no tools)
  if (/shell|terminal|perintah|command|ketik|jalankan|eksekusi|execute|\bls\b|\bdir\b|\bcat\b|baca|tulis|tampilkan|list\b|cek isi|lihat isi|isi (folder|file|direktori|workspace)|query|graph/.test(t)) return "coding";
  if (/prove|math|analyze|compare|plan|design|architect/.test(t)) return "reasoning";
  return "chat";
}

export async function* chatWithFallback(request: ChatRequest, routing: RoutingConfig): AsyncIterable<LLMEvent> {
  const log = getLogger();
  const order = [routing.primary, ...(routing.allowFallback ? routing.fallback : [])];
  let lastError: unknown = null;
  for (const providerName of order) {
    const provider = createProvider(providerName);
    try {
      yield* provider.chat(request);
      return;
    } catch (e) {
      lastError = e;
      log.warn({ event: "provider.failed", provider: providerName, err: String(e) }, "provider failed, trying fallback");
      if (providerName !== order[order.length - 1]) {
        yield { type: "text", text: `\n\n⚠️ primary provider unavailable, switching to fallback (${providerName} → next)...\n\n` } as LLMEvent;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function defaultRouting(primary: string): RoutingConfig {
  return { primary, fallback: ["openai", "xai", "ollama"].filter((p) => p !== primary), allowFallback: true };
}

/** Rough cost estimate in USD (marked estimated; unknown models = 0). */
export function estimateCostUsd(provider: string, _model: string, tokensIn: number, tokensOut: number): number {
  void _model;
  const perMillion: Record<string, { in: number; out: number }> = {
    openai: { in: 0.15, out: 0.6 },
    anthropic: { in: 3, out: 15 },
    xai: { in: 2, out: 10 },
    "9router": { in: 0.5, out: 1.5 },
    ninerouter: { in: 0.5, out: 1.5 },
    ollama: { in: 0, out: 0 },
    custom: { in: 0, out: 0 },
  };
  const r = perMillion[provider] ?? { in: 0, out: 0 };
  return (tokensIn / 1_000_000) * r.in + (tokensOut / 1_000_000) * r.out;
}
