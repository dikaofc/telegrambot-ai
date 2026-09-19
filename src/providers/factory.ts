import { getEnv, providerConfigFor } from "../config/env.js";
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

export function availableProviders(): string[] {
  const env = getEnv();
  const out: string[] = [];
  if (env.NINEROUTER_API_KEY || env.NINEROUTER_BASE_URL) out.push("9router");
  if (env.OPENAI_API_KEY) out.push("openai");
  if (env.XAI_API_KEY) out.push("xai");
  if (env.ANTHROPIC_API_KEY) out.push("anthropic");
  out.push("ollama");
  if (env.PROVIDER_BASE_URL) out.push("custom");
  return [...new Set(out)];
}
