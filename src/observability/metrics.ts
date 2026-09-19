export interface Counter { inc(labels?: Record<string, string>, value?: number): void; get(): number; }

function makeCounter(): Counter {
  let v = 0;
  return { inc: (_l, n = 1) => { v += n; }, get: () => v };
}

export const metrics = {
  agentRunsTotal: makeCounter(),
  agentRunsSuccess: makeCounter(),
  agentRunsFailed: makeCounter(),
  /** Run finished but the objective was not attempted (provider/upstream blocker). */
  agentRunsDegraded: makeCounter(),
  toolCallsTotal: makeCounter(),
  toolFailures: makeCounter(),
  providerRequests: makeCounter(),
  providerErrors: makeCounter(),
  tokensUsed: makeCounter(),
  telegramMessages: makeCounter(),
  sandboxProcesses: makeCounter(),
};

const durations: number[] = [];

export function recordRunDuration(ms: number): void {
  durations.push(ms);
  if (durations.length > 1000) durations.shift();
}

export function avgRunDuration(): number {
  if (durations.length === 0) return 0;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

export function renderPrometheus(): string {
  const lines = [
    `agent_runs_total ${metrics.agentRunsTotal.get()}`,
    `agent_runs_success ${metrics.agentRunsSuccess.get()}`,
    `agent_runs_failed ${metrics.agentRunsFailed.get()}`,
    `agent_runs_degraded ${metrics.agentRunsDegraded.get()}`,
    `agent_run_duration_avg_ms ${avgRunDuration()}`,
    `tool_calls_total ${metrics.toolCallsTotal.get()}`,
    `tool_failures ${metrics.toolFailures.get()}`,
    `provider_requests ${metrics.providerRequests.get()}`,
    `provider_errors ${metrics.providerErrors.get()}`,
    `tokens_used ${metrics.tokensUsed.get()}`,
    `telegram_messages ${metrics.telegramMessages.get()}`,
    `sandbox_processes ${metrics.sandboxProcesses.get()}`,
  ];
  return lines.join("\n") + "\n";
}
