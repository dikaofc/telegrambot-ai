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
