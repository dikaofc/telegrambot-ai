import { store } from "../database/store.js";

/**
 * Failure memory (requirement: remember known failure patterns).
 *
 * When the same tool keeps failing for a reason that looks stable, record the
 * pattern so later runs can be warned before wasting steps on it. When the tool
 * later succeeds, the pattern is closed out. This is intentionally reviewable
 * (readable JSON in the memory table) and never touches security policy.
 */

export interface FailurePattern {
  tool: string;
  /** Stable, secret-free fingerprint of the error. */
  fingerprint: string;
  count: number;
  lastError: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
}

const MAX_PATTERNS = 25;

/** Collapse volatile parts (paths, numbers, hashes, durations) so repeats match. */
export function fingerprintError(error: string): string {
  return String(error ?? "")
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\/[^\s"']+/g, "<path>")
    .replace(/\s+/g, " ")
    .slice(0, 160)
    .trim();
}

function load(scopeId: string): FailurePattern[] {
  try {
    const raw = store.getMemory("failure", scopeId).patterns;
    if (!raw) return [];
    const arr = JSON.parse(raw) as FailurePattern[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(scopeId: string, patterns: FailurePattern[]): void {
  try {
    store.setMemory("failure", scopeId, "patterns", JSON.stringify(patterns.slice(-MAX_PATTERNS)));
  } catch { /* memory must never break a run */ }
}

export function rememberFailure(scopeId: string, tool: string, error: string): FailurePattern {
  const now = new Date().toISOString();
  const fp = fingerprintError(error);
  const patterns = load(scopeId);
  const existing = patterns.find((p) => p.tool === tool && p.fingerprint === fp);
  if (existing) {
    existing.count += 1;
    existing.lastSeenAt = now;
    existing.lastError = String(error).slice(0, 300);
    delete existing.resolvedAt;
    save(scopeId, patterns);
    return existing;
  }
  const created: FailurePattern = {
    tool, fingerprint: fp, count: 1,
    lastError: String(error).slice(0, 300),
    firstSeenAt: now, lastSeenAt: now,
  };
  save(scopeId, [...patterns, created]);
  return created;
}

/** Called when a previously failing tool succeeds — closes the pattern out. */
export function markFailureResolved(scopeId: string, tool: string): void {
  const patterns = load(scopeId);
  let touched = false;
  for (const p of patterns) {
    if (p.tool === tool && !p.resolvedAt) { p.resolvedAt = new Date().toISOString(); touched = true; }
  }
  if (touched) save(scopeId, patterns);
}

/** Unresolved patterns seen more than once — worth warning the model about. */
export function recallRecurringFailures(scopeId: string, minCount = 2): FailurePattern[] {
  return load(scopeId).filter((p) => !p.resolvedAt && p.count >= minCount).slice(-10);
}

export function recallAllFailures(scopeId: string): FailurePattern[] {
  return load(scopeId);
}

export function clearFailureMemory(scopeId: string): void {
  save(scopeId, []);
}

/** Prompt fragment listing known recurring failures, or "" when there are none. */
export function failureHints(scopeId: string): string {
  const recurring = recallRecurringFailures(scopeId);
  if (recurring.length === 0) return "";
  const lines = recurring.map((p) => `- ${p.tool} failed ${p.count}× before: ${p.fingerprint.slice(0, 140)}`);
  return `\nKnown failure patterns in this workspace (do not repeat blindly — pick a different approach):\n${lines.join("\n")}\n`;
}
