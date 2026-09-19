import { store } from "../database/store.js";
import type { ProjectProfile } from "../workspace/manager.js";

/**
 * Planning engine.
 *
 * A plan is built deterministically from the request, the task kind and the
 * detected project profile — no LLM round trip. That keeps planning fast, free,
 * testable and available even when every provider is down (the agent still
 * knows what it intended to do). The runtime executes steps, marks them done,
 * and calls replan() when reality diverges instead of blindly pushing on.
 */

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";
export type PlanPhase = "discover" | "implement" | "verify" | "none";

export interface PlanStep {
  id: string;
  title: string;
  /** Plan phase this step belongs to — drives tool selection. */
  phase: PlanPhase;
  status: PlanStepStatus;
  /** Tool names this step is expected to need (informational + selection hint). */
  tools: string[];
  note?: string;
}

export interface Plan {
  objective: string;
  taskKind: "coding" | "reasoning" | "chat";
  workspace: string;
  revision: number;
  steps: PlanStep[];
  assumptions: string[];
  risks: string[];
  completionCriteria: string[];
  verification: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanInput {
  input: string;
  taskKind: "coding" | "reasoning" | "chat";
  workspacePath: string;
  profile?: ProjectProfile;
  skill?: string | null;
}

const DISCOVER_TOOLS = ["list_directory", "tree", "read_file", "grep", "search_code", "glob", "graphify_query", "find_definition", "find_references", "git_status", "git_diff"];
const IMPLEMENT_TOOLS = ["read_file", "edit_file", "write_file", "apply_patch", "search_replace", "shell", "npm_install", "dep_add"];
const VERIFY_TOOLS = ["npm_test", "npm_build", "lint_tool", "typecheck_tool", "full_verify", "coverage_report"];

function step(id: string, title: string, phase: PlanPhase, tools: string[]): PlanStep {
  return { id, title, phase, status: "pending", tools };
}

/** Verification commands the plan promises to run, derived from the real profile. */
function verificationFor(profile: ProjectProfile | undefined): string[] {
  if (!profile) return [];
  const out: string[] = [];
  if (profile.typecheckCommand) out.push(profile.typecheckCommand);
  if (profile.lintCommand) out.push(profile.lintCommand);
  if (profile.testCommand) out.push(profile.testCommand);
  if (profile.buildCommand) out.push(profile.buildCommand);
  return out;
}

export function buildPlan(o: PlanInput): Plan {
  const now = new Date().toISOString();
  const objective = o.input.trim().slice(0, 500);
  const verification = verificationFor(o.profile);
  const steps: PlanStep[] = [];
  const assumptions: string[] = [];
  const risks: string[] = [];

  if (o.taskKind === "chat") {
    steps.push(step("s1", "Answer directly (no workspace changes)", "none", []));
    return {
      objective, taskKind: "chat", workspace: o.workspacePath, revision: 1, steps,
      assumptions: ["conversational request — no code changes expected"],
      risks: [], completionCriteria: ["a useful answer is delivered"],
      verification: [], createdAt: now, updatedAt: now,
    };
  }

  if (o.taskKind === "reasoning") {
    steps.push(step("s1", "Inspect the workspace and gather evidence", "discover", DISCOVER_TOOLS));
    steps.push(step("s2", "Analyse findings and produce the answer", "none", []));
    assumptions.push("read-only request — no files will be modified");
    risks.push("an incomplete picture may lead to a wrong conclusion");
    return {
      objective, taskKind: "reasoning", workspace: o.workspacePath, revision: 1, steps,
      assumptions, risks,
      completionCriteria: ["answer is grounded in files actually inspected"],
      verification: [], createdAt: now, updatedAt: now,
    };
  }

  // coding
  steps.push(step("s1", "Discover context: locate the relevant files and symbols", "discover", DISCOVER_TOOLS));
  steps.push(step("s2", "Implement the smallest change that satisfies the objective", "implement", IMPLEMENT_TOOLS));
  if (verification.length > 0) {
    steps.push(step("s3", "Verify: run the project's own checks", "verify", VERIFY_TOOLS));
    steps.push(step("s4", "Report implemented changes, files, and verification evidence", "none", []));
  } else {
    steps.push(step("s3", "Report implemented changes, files, and evidence", "none", []));
    assumptions.push("no test/build/typecheck commands detected for this workspace");
    risks.push("changes cannot be auto-verified — manual review required");
  }
  if (o.profile?.language) assumptions.push(`project language detected as ${o.profile.language}`);
  if (o.skill) assumptions.push(`skill '${o.skill}' workflow applies`);
  risks.push("edits may break unfamiliar call sites — verification is the safety net");
  if (!o.profile?.packageManager && !o.profile?.language) risks.push("unknown project type — discovery may misidentify the stack");

  return {
    objective, taskKind: "coding", workspace: o.workspacePath, revision: 1, steps,
    assumptions, risks,
    completionCriteria: verification.length > 0
      ? ["the objective is implemented", "the project's verification commands pass"]
      : ["the objective is implemented", "the diff is reported for review"],
    verification, createdAt: now, updatedAt: now,
  };
}

/** Immutable step update — the plan is always replaced, never mutated in place. */
export function markStep(plan: Plan, id: string, status: PlanStepStatus, note?: string): Plan {
  let touched = false;
  const steps = plan.steps.map((s) => {
    if (s.id !== id) return s;
    touched = true;
    return { ...s, status, note: note ?? s.note };
  });
  if (!touched) return plan;
  return { ...plan, steps, updatedAt: new Date().toISOString() };
}

export function nextStep(plan: Plan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "pending" || s.status === "in_progress");
}

/** The plan phase currently being worked on — drives which tools the model sees. */
export function activePhase(plan: Plan): PlanPhase {
  const s = nextStep(plan);
  return s ? s.phase : "verify";
}

export function planProgress(plan: Plan): { done: number; total: number; percent: number } {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
  return { done, total, percent: total === 0 ? 100 : Math.round((done / total) * 100) };
}

/**
 * Adapt the plan when reality disagrees with it: record why, mark the step that
 * failed, and insert an explicit diagnosis step rather than retrying blindly.
 */
export function replan(plan: Plan, o: { reason: string; failedStepId?: string; tool?: string }): Plan {
  let steps = plan.steps;
  if (o.failedStepId) {
    steps = steps.map((s) => (s.id === o.failedStepId ? { ...s, status: "failed" as PlanStepStatus, note: o.reason.slice(0, 300) } : s));
  }
  const target = nextStep({ ...plan, steps });
  const diagnosisTitle = o.tool
    ? `Diagnose the ${o.tool} failure and choose a different approach`
    : "Diagnose the failure and choose a different approach";
  const diagnosis: PlanStep = {
    id: `r${plan.revision}-${steps.length + 1}`,
    title: diagnosisTitle,
    phase: target?.phase ?? "implement",
    status: "pending",
    tools: ["read_file", "grep", "search_code", "shell"],
    note: o.reason.slice(0, 300),
  };
  // Diagnosis goes before the still-pending work, so the model fixes the cause first.
  const insertAt = steps.findIndex((s) => s.status === "pending" || s.status === "in_progress");
  const nextSteps = insertAt < 0 ? [...steps, diagnosis] : [...steps.slice(0, insertAt), diagnosis, ...steps.slice(insertAt)];
  return {
    ...plan,
    revision: plan.revision + 1,
    steps: nextSteps,
    updatedAt: new Date().toISOString(),
    risks: [...plan.risks.filter((r) => !r.startsWith("replan:")), `replan: ${o.reason.slice(0, 200)}`],
  };
}

/** Plan → todo payload (same shape the todo_write tool persists). */
export function planToTodos(plan: Plan): Array<{ content: string; status: "pending" | "in_progress" | "completed" }> {
  return plan.steps.map((s) => ({
    content: `[${s.phase}] ${s.title}`,
    status: s.status === "completed" ? "completed" : s.status === "in_progress" ? "in_progress" : "pending",
  }));
}

/** One-line progress label, e.g. "step 2/4 · implement: add the retry budget". */
export function renderPlanProgress(plan: Plan): string {
  const p = planProgress(plan);
  const cur = nextStep(plan);
  const label = cur ? `${cur.phase}: ${cur.title}` : "all steps done";
  return `step ${Math.min(p.done + 1, p.total)}/${p.total} · ${label}`;
}

export function renderPlanText(plan: Plan): string {
  const p = planProgress(plan);
  const lines = [
    `Objective: ${plan.objective || "(empty)"}`,
    `Workspace: ${plan.workspace}`,
    `Revision: ${plan.revision} · Progress: ${p.percent}% (${p.done}/${p.total})`,
    "",
    "Steps:",
  ];
  const icon: Record<PlanStepStatus, string> = { pending: "•", in_progress: "→", completed: "✓", failed: "✗", skipped: "-" };
  for (const s of plan.steps) lines.push(` ${icon[s.status]} [${s.phase}] ${s.title}${s.note ? ` — ${s.note}` : ""}`);
  if (plan.verification.length) {
    lines.push("", "Verification:");
    for (const v of plan.verification) lines.push(` - ${v}`);
  }
  if (plan.assumptions.length) {
    lines.push("", "Assumptions:");
    for (const a of plan.assumptions) lines.push(` - ${a}`);
  }
  if (plan.risks.length) {
    lines.push("", "Risks:");
    for (const r of plan.risks) lines.push(` - ${r}`);
  }
  if (plan.completionCriteria.length) {
    lines.push("", "Completion criteria:");
    for (const c of plan.completionCriteria) lines.push(` - ${c}`);
  }
  return lines.join("\n");
}

/** Persist the live plan so the dashboard/TUI/API can show real progress. */
export function persistPlan(runId: string, plan: Plan): void {
  try {
    store.setMemory("run", runId, "plan", JSON.stringify(plan));
  } catch { /* plan display must never break a run */ }
}

/** Restore the plan of a run (null when unknown/garbage). */
export function readPlanForRun(runId: string): Plan | null {
  try {
    return parsePlan(store.getMemory("run", runId).plan);
  } catch {
    return null;
  }
}

/** Guarded parse for plans restored from storage. */
export function parsePlan(raw: string | undefined | null): Plan | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Plan;
    if (!p || !Array.isArray(p.steps)) return null;
    return p;
  } catch {
    return null;
  }
}
