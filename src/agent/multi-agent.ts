/** Multi-agent orchestration: research → coding → testing → review (sequential, resource-aware). */
export type SubAgentRole = "research" | "coding" | "testing" | "review";

export interface SubAgentPlan { role: SubAgentRole; goal: string; tools: string[]; }

export function planMultiAgent(input: string): SubAgentPlan[] {
  const t = input.toLowerCase();
  const needsReview = /review|perbaiki semua|audit/.test(t);
  const needsResearch = /cek|analisis|analy[sz]e|investigate|kenapa|why/.test(t);
  const plans: SubAgentPlan[] = [];
  if (needsResearch) plans.push({ role: "research", goal: "inspect workspace, reproduce, find root cause", tools: ["list_directory", "read_file", "grep", "search_code", "shell"] });
  plans.push({ role: "coding", goal: "implement minimal fix/feature", tools: ["read_file", "edit_file", "write_file", "shell"] });
  plans.push({ role: "testing", goal: "run tests/build and report evidence", tools: ["npm_test", "npm_build", "shell"] });
  if (needsReview) plans.push({ role: "review", goal: "review diff for regressions", tools: ["git_diff", "read_file"] });
  return plans;
}

export const AGENT_PROFILES: Record<string, { provider: string; model: string; tools: string[] }> = {
  coding: { provider: "9router", model: "auto", tools: ["filesystem", "shell", "git"] },
  reviewer: { provider: "openai", model: "reviewer-model", tools: ["filesystem", "git"] },
  researcher: { provider: "9router", model: "auto", tools: ["filesystem", "search", "shell"] },
  tester: { provider: "9router", model: "auto", tools: ["shell", "filesystem"] },
};
