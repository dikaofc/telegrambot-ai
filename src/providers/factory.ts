import { getEnv, providerConfigFor, KNOWN_PROVIDERS } from "../config/env.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import type { LLMProvider } from "./types.js";

export function createProvider(name: string): LLMProvider {
  const env = getEnv();
  const cfg = providerConfigFor(name, env);
  if (name === "anthropic") return new AnthropicProvider(cfg.baseUrl, cfg.apiKey, cfg.defaultModel);
  const pretty: Record<string, string> = {
    "9router": "9Router", ninerouter: "9Router", openai: "OpenAI",
    xai: "xAI", ollama: "Ollama", custom: "Custom",
  };
  return new OpenAICompatibleProvider({
    id: name, name: pretty[name] ?? name,
    baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, defaultModel: cfg.defaultModel,
  });
}

/** All switchable providers (one key serves whichever is selected via PROVIDER). */
export function availableProviders(): string[] {
  return [...KNOWN_PROVIDERS];
}
