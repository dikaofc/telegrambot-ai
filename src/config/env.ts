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
  DEFAULT_PROVIDER: z.string().default("9router"),
  AGENT_MAX_RETRIES: z.coerce.number().default(5),
  AGENT_TIMEOUT_MS: z.coerce.number().default(1_800_000),
  NINEROUTER_BASE_URL: z.string().default("http://localhost:20128/v1"),
  NINEROUTER_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().default(""),
  XAI_BASE_URL: z.string().default("https://api.x.ai/v1"),
  XAI_API_KEY: z.string().default(""),
  ANTHROPIC_BASE_URL: z.string().default("https://api.anthropic.com"),
  ANTHROPIC_API_KEY: z.string().default(""),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434/v1"),
  OLLAMA_API_KEY: z.string().default("ollama"),
  PROVIDER_NAME: z.string().default(""),
  PROVIDER_BASE_URL: z.string().default(""),
  PROVIDER_API_KEY: z.string().default(""),
  PROVIDER_MODEL: z.string().default(""),
  WORKSPACE_ROOT: z.string().default("/workspaces"),
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
  RATE_LIMIT_RUNS: z.coerce.number().default(10),
  MAX_DAILY_TOKENS: z.coerce.number().default(1_000_000),
  TELEAGENT_API_KEY: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
  PORT: z.coerce.number().default(49374),
});

export type AppEnv = z.infer<typeof EnvSchema>;

let cached: AppEnv | null = null;
let explicitKeys: Set<string> = new Set();

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }
  cached = parsed.data;
  explicitKeys = new Set(Object.keys(source));
  return parsed.data;
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

export function providerConfigFor(name: string, env: AppEnv): { baseUrl: string; apiKey: string; defaultModel: string } {
  switch (name) {
    case "9router":
    case "ninerouter":
      return { baseUrl: env.NINEROUTER_BASE_URL, apiKey: env.NINEROUTER_API_KEY, defaultModel: "auto" };
    case "openai":
      return { baseUrl: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY, defaultModel: "gpt-4o-mini" };
    case "xai":
      return { baseUrl: env.XAI_BASE_URL, apiKey: env.XAI_API_KEY, defaultModel: "grok-beta" };
    case "anthropic":
      return { baseUrl: env.ANTHROPIC_BASE_URL, apiKey: env.ANTHROPIC_API_KEY, defaultModel: "claude-3-5-sonnet-latest" };
    case "ollama":
      return { baseUrl: env.OLLAMA_BASE_URL, apiKey: env.OLLAMA_API_KEY, defaultModel: "llama3.1" };
    case "custom":
      return {
        baseUrl: env.PROVIDER_BASE_URL || env.PROVIDER_NAME,
        apiKey: env.PROVIDER_API_KEY,
        defaultModel: env.PROVIDER_MODEL || "auto",
      };
    default:
      if (env.PROVIDER_BASE_URL) {
        return { baseUrl: env.PROVIDER_BASE_URL, apiKey: env.PROVIDER_API_KEY, defaultModel: env.PROVIDER_MODEL || "auto" };
      }
      return { baseUrl: env.NINEROUTER_BASE_URL, apiKey: env.NINEROUTER_API_KEY, defaultModel: "auto" };
  }
}
