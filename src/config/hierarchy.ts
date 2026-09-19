import type { AppEnv } from "./env.js";
import { isExplicit } from "./env.js";

/** Config hierarchy: env > config file > provider defaults > system defaults. */
export interface FileConfig {
  provider?: string;
  model?: string;
  agent?: string;
  workspace?: string;
  permissions?: Record<string, boolean>;
  approval?: Record<string, "auto" | "ask" | "deny">;
}

export const SYSTEM_DEFAULTS: Required<Pick<FileConfig, "provider" | "model" | "agent">> = {
  provider: "9router",
  model: "auto",
  agent: "auto",
};

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  "9router": "auto",
  openai: "gpt-4o-mini",
  xai: "grok-beta",
  anthropic: "claude-3-5-sonnet-latest",
  ollama: "llama3.1",
};

export function resolveProvider(env: AppEnv, file: FileConfig, sessionOverride?: string): string {
  if (sessionOverride) return sessionOverride;
  // hierarchy: environment > config file > provider defaults > system defaults
  if (isExplicit("DEFAULT_PROVIDER") && env.DEFAULT_PROVIDER) return env.DEFAULT_PROVIDER;
  if (env.DEFAULT_PROVIDER) return env.DEFAULT_PROVIDER;
  if (file.provider) return file.provider;
  return SYSTEM_DEFAULTS.provider;
}

export function resolveModel(env: AppEnv, file: FileConfig, sessionOverride?: string, provider?: string): string {
  if (sessionOverride) return sessionOverride;
  if (isExplicit("DEFAULT_MODEL") && env.DEFAULT_MODEL) return env.DEFAULT_MODEL;
  if (file.model) return file.model;
  if (env.DEFAULT_MODEL && env.DEFAULT_MODEL !== "auto") return env.DEFAULT_MODEL;
  if (provider && PROVIDER_DEFAULT_MODELS[provider]) return PROVIDER_DEFAULT_MODELS[provider] as string;
  return SYSTEM_DEFAULTS.model;
}

export interface ScopeOverrides {
  global?: FileConfig;
  workspace?: FileConfig;
  session?: FileConfig;
  user?: FileConfig;
}

export function mergeScopes(scopes: ScopeOverrides): FileConfig {
  // priority: user > session > workspace > global
  const order: Array<FileConfig | undefined> = [scopes.global, scopes.workspace, scopes.session, scopes.user];
  const out: FileConfig = {};
  for (const s of order) {
    if (!s) continue;
    if (s.provider) out.provider = s.provider;
    if (s.model) out.model = s.model;
    if (s.agent) out.agent = s.agent;
    if (s.workspace) out.workspace = s.workspace;
    if (s.permissions) out.permissions = { ...(out.permissions ?? {}), ...s.permissions };
    if (s.approval) out.approval = { ...(out.approval ?? {}), ...s.approval };
  }
  return out;
}
