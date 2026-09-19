import { getEnv } from "../config/env.js";
import { store } from "../database/store.js";

interface Bucket { count: number; windowStart: number; }

const msgBuckets = new Map<string, Bucket>();
const runBuckets = new Map<string, Bucket>();

function hit(bucket: Map<string, Bucket>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = bucket.get(key);
  if (!b || now - b.windowStart > windowMs) {
    bucket.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

export function checkMessageRate(userId: string): boolean {
  const env = getEnv();
  return hit(msgBuckets, userId, env.RATE_LIMIT_MESSAGES, 60_000);
}

export function checkRunRate(userId: string): boolean {
  const env = getEnv();
  return hit(runBuckets, userId, env.RATE_LIMIT_RUNS, 3_600_000);
}

export function checkTokenQuota(userId: string): { ok: boolean; used: number; limit: number } {
  const env = getEnv();
  const used = store.dailyTokens(userId);
  return { ok: used < env.MAX_DAILY_TOKENS, used, limit: env.MAX_DAILY_TOKENS };
}

export function resetRateState(): void {
  msgBuckets.clear();
  runBuckets.clear();
}
