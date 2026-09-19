/** Provider circuit breaker: stop hammering upstreams that keep failing.
 *
 * Single-node in-memory state (no DB write per failure). A provider trips
 * after N consecutive failures and is skipped for `cooldownMs`. Success
 * resets the counter immediately. When every candidate is in cooldown, the
 * router still tries the least-recently-tripped one (fail-open) rather than
 * refusing outright.
 */

export interface CircuitState {
  consecutiveFailures: number;
  cooldownUntil: number;
  totalSuccess: number;
  totalFailure: number;
  lastError: string;
  lastLatencyMs: number;
}

const tuning = { tripAfter: 3, cooldownMs: 60_000 };
const states = new Map<string, CircuitState>();

export function setCircuitTuning(t: Partial<typeof tuning>): void {
  Object.assign(tuning, t);
}

export function resetCircuits(): void {
  states.clear();
}

function st(name: string): CircuitState {
  let s = states.get(name);
  if (!s) {
    s = { consecutiveFailures: 0, cooldownUntil: 0, totalSuccess: 0, totalFailure: 0, lastError: "", lastLatencyMs: 0 };
    states.set(name, s);
  }
  return s;
}

export function isAvailable(name: string, now = Date.now()): boolean {
  const s = states.get(name);
  if (!s) return true;
  if (s.consecutiveFailures < tuning.tripAfter) return true;
  return now >= s.cooldownUntil;
}

export function recordSuccess(name: string, latencyMs: number): void {
  const s = st(name);
  s.consecutiveFailures = 0;
  s.cooldownUntil = 0;
  s.totalSuccess += 1;
  s.lastLatencyMs = latencyMs;
}

export function recordFailure(name: string, err: unknown): void {
  const s = st(name);
  s.consecutiveFailures += 1;
  s.totalFailure += 1;
  s.lastError = String(err).slice(0, 300);
  if (s.consecutiveFailures >= tuning.tripAfter) {
    s.cooldownUntil = Date.now() + tuning.cooldownMs;
  }
}

/** Earliest-cooldown provider first — used only when everything is tripped. */
export function leastTripped(names: string[]): string | null {
  let best: string | null = null;
  let bestAt = Infinity;
  for (const n of names) {
    const at = states.get(n)?.cooldownUntil ?? 0;
    if (at < bestAt) { bestAt = at; best = n; }
  }
  return best;
}

export function circuitSnapshot(now = Date.now()): Record<string, CircuitState & { available: boolean }> {
  const out: Record<string, CircuitState & { available: boolean }> = {};
  for (const [name, s] of states) out[name] = { ...s, available: isAvailable(name, now) };
  return out;
}
