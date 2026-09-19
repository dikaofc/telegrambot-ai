import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_WEBHOOK_URL: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  BOT_ACCESS_MODE: z.enum(["owner", "private", "public", "allowlist"]).default("owner"),
  OWNER_IDS: z.string().default(""),
  ALLOWED_USER_IDS: z.string().default(""),
  ALLOWED_CHAT_IDS: z.string().default(""),
  DEFAULT_AGENT: z.string().default("auto"),
  DEFAULT_MODEL: z.string().default("auto"),
  // single universal provider config: PROVIDER selects a built-in preset
  // (9router | openai | xai | anthropic | ollama | custom); the three
  // PROVIDER_* vars override the preset or define a custom /v1 endpoint.
  PROVIDER: z.string().default("9router"),
  PROVIDER_BASE_URL: z.string().default(""),
  PROVIDER_API_KEY: z.string().default(""),
  PROVIDER_MODEL: z.string().default("auto"),
  PROVIDER_MODEL_FALLBACK: z.string().default("cph/cehpoint-ai"),
  AGENT_MAX_RETRIES: z.coerce.number().default(5),
  AGENT_TIMEOUT_MS: z.coerce.number().default(1_800_000),
  WORKSPACE_ROOT: z.string().default("./workspaces"),
  DATABASE_URL: z.string().default("./data/teleagent.db"),
  REDIS_URL: z.string().default(""),
  SANDBOX_ENABLED: z.coerce.boolean().default(true),
  SANDBOX_RUNTIME: z.string().default("local"),
  SANDBOX_MEMORY: z.string().default("4g"),
  SANDBOX_CPUS: z.coerce.number().default(2),
  MAX_CONCURRENT_RUNS: z.coerce.number().default(5),
  MAX_UPLOAD_MB: z.coerce.number().default(100),
  MAX_EXTRACTED_MB: z.coerce.number().default(500),
  MAX_OUTPUT_MB: z.coerce.number().default(10),
  RATE_LIMIT_MESSAGES: z.coerce.number().default(30),
  RATE_LIMIT_RUNS: z.coerce.number().default(60),
  MAX_DAILY_TOKENS: z.coerce.number().default(1_000_000),
  TELEAGENT_API_KEY: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().default(49375),
  // Listen address. Loopback by default so an unconfigured instance is never
  // exposed to the network (set 0.0.0.0 in containers / behind a proxy).
  HOST: z.string().default("127.0.0.1"),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;
let explicitKeys: Set<string> = new Set();

/** Minimal .env loader (no deps). Never overrides real environment. */
function loadDotEnvFile(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../.env"),
  ];
  for (const f of candidates) {
    let content = "";
    try { content = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] = val;
    }
    break;
  }
}

function normalizeEnv(data: AppEnv): AppEnv {
  // WORKSPACE_ROOT="/" would expose the whole filesystem — migrate to ./workspaces
  if (!data.WORKSPACE_ROOT || data.WORKSPACE_ROOT === "/") {
    data.WORKSPACE_ROOT = "./workspaces";
    process.env.WORKSPACE_ROOT = "./workspaces";
  }
  return data;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  if (source === process.env) loadDotEnvFile();
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }
  cached = normalizeEnv(parsed.data);
  explicitKeys = new Set(Object.keys(source));
  return cached;
}

/** Always reflects live process.env (environment beats all other scopes). */
export function getEnv(): AppEnv {
  return loadEnv(process.env);
}

/** True when the variable was explicitly set in the environment. */
export function isExplicit(key: string): boolean {
  if (explicitKeys.size === 0 && cached) {
    // getEnv() path: derive from live env
    return process.env[key] !== undefined && process.env[key] !== "";
  }
  return explicitKeys.has(key);
}

export function parseIdList(raw: string): Array<number | string> {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^-?\d+$/.test(s) ? Number(s) : s));
}

/** Built-in endpoint presets. One API key (PROVIDER_API_KEY) serves all of them. */
const PRESETS: Record<string, { baseUrl: string; defaultModel: string }> = {
  "9router": { baseUrl: "http://localhost:20128/v1", defaultModel: "auto" },
  ninerouter: { baseUrl: "http://localhost:20128/v1", defaultModel: "auto" },
  openai: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  xai: { baseUrl: "https://api.x.ai/v1", defaultModel: "grok-beta" },
  anthropic: { baseUrl: "https://api.anthropic.com", defaultModel: "claude-3-5-sonnet-latest" },
  ollama: { baseUrl: "http://localhost:11434/v1", defaultModel: "llama3.1" },
};

export const KNOWN_PROVIDERS = ["9router", "openai", "xai", "anthropic", "ollama", "custom"];

export function providerConfigFor(name: string, env: AppEnv): { baseUrl: string; apiKey: string; defaultModel: string } {
  const preset = PRESETS[name];
  const selected = name === env.PROVIDER;
  // An explicit PROVIDER_BASE_URL overrides the preset, but only for the
  // selected provider (or for custom/unknown names which have no preset).
  const baseUrl = preset
    ? (selected && isExplicit("PROVIDER_BASE_URL") && env.PROVIDER_BASE_URL ? env.PROVIDER_BASE_URL : preset.baseUrl)
    : env.PROVIDER_BASE_URL;
  const defaultModel = isExplicit("PROVIDER_MODEL") && env.PROVIDER_MODEL
    ? env.PROVIDER_MODEL
    : (preset?.defaultModel ?? "auto");
  return { baseUrl, apiKey: env.PROVIDER_API_KEY, defaultModel };
}
