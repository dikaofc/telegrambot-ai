import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-plan-")) + "/p.db";
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-planws-"));
process.env.RATE_LIMIT_RUNS = "600";
process.env.RATE_LIMIT_MESSAGES = "600";

import {
  buildPlan, markStep, nextStep, planProgress, replan, planToTodos, renderPlanText,
  persistPlan, readPlanForRun, parsePlan, renderPlanProgress,
} from "../src/agent/planner.js";
import { categoryOf, isMutatingTool, selectToolNames, toolInventory } from "../src/tools/capabilities.js";
import { trimToolResult, enforceContextBudget, composeRunMessages } from "../src/agent/context-window.js";
import { fingerprintError, rememberFailure, markFailureResolved, recallRecurringFailures, recallAllFailures, failureHints } from "../src/agent/failure-memory.js";
import { buildRegistry } from "../src/tools/registry.js";
import { startRun, ensureSession } from "../src/agent/orchestrator.js";
import { metrics } from "../src/observability/metrics.js";
import { store } from "../src/database/store.js";
import { openDatabase } from "../src/database/db.js";
import type { ProjectProfile } from "../src/workspace/manager.js";

const PROFILE: ProjectProfile = {
  language: "typescript", framework: "node-server", packageManager: "npm",
  testCommand: "npm test", buildCommand: "npm run build",
  lintCommand: "npm run lint", typecheckCommand: "npm run typecheck",
};

beforeEach(() => { openDatabase(process.env.DATABASE_URL); });

describe("planning engine", () => {
  it("builds a chat plan with no tools and no verification", () => {
    const p = buildPlan({ input: "siapa kamu?", taskKind: "chat", workspacePath: "/ws", profile: PROFILE });
    expect(p.taskKind).toBe("chat");
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]?.tools).toHaveLength(0);
    expect(p.verification).toHaveLength(0);
    expect(p.completionCriteria.length).toBeGreaterThan(0);
  });

  it("builds an inspect-only plan for reasoning", () => {
    const p = buildPlan({ input: "compare these two designs", taskKind: "reasoning", workspacePath: "/ws", profile: PROFILE });
    expect(p.steps.map((s) => s.phase)).toEqual(["discover", "none"]);
    // read-only: nothing may be written while analysing
    expect(p.steps.flatMap((s) => s.tools)).not.toContain("write_file");
  });

  it("derives verification steps from the real project profile", () => {
    const p = buildPlan({ input: "fix the failing test", taskKind: "coding", workspacePath: "/ws", profile: PROFILE });
    expect(p.verification).toEqual(["npm run typecheck", "npm run lint", "npm test", "npm run build"]);
    expect(p.steps.some((s) => s.phase === "verify")).toBe(true);
    expect(p.completionCriteria.some((c) => /verification commands pass/.test(c))).toBe(true);
    expect(p.objective).toBe("fix the failing test");
  });

  it("is honest when no verification commands are detectable", () => {
    const p = buildPlan({ input: "write docs", taskKind: "coding", workspacePath: "/ws", profile: {} });
    expect(p.verification).toHaveLength(0);
    expect(p.steps.some((s) => s.phase === "verify")).toBe(false);
    expect(p.assumptions.some((a) => /no test\/build/.test(a))).toBe(true);
    expect(p.risks.some((r) => /cannot be auto-verified/.test(r))).toBe(true);
  });

  it("tracks progress immutably and exposes the next step", () => {
    const p = buildPlan({ input: "add a feature", taskKind: "coding", workspacePath: "/ws", profile: PROFILE });
    expect(planProgress(p)).toEqual({ done: 0, total: 4, percent: 0 });
    expect(nextStep(p)?.id).toBe("s1");

    const p2 = markStep(p, "s1", "completed");
    expect(p.steps[0]?.status).toBe("pending"); // original untouched
    expect(p2.steps[0]?.status).toBe("completed");
    expect(planProgress(p2).done).toBe(1);
    expect(nextStep(p2)?.id).toBe("s2");
    expect(renderPlanProgress(p2)).toContain("implement");

    // unknown ids are a no-op, never a crash
    expect(markStep(p, "nope", "completed")).toBe(p);
  });

  it("replans by inserting a diagnosis step and bumping the revision", () => {
    const p = buildPlan({ input: "fix bug", taskKind: "coding", workspacePath: "/ws", profile: PROFILE });
    const p2 = replan(p, { reason: "npm_test failed twice", failedStepId: "s1", tool: "npm_test" });
    expect(p2.revision).toBe(p.revision + 1);
    expect(p2.steps[0]?.status).toBe("failed");
    expect(p2.steps[0]?.note).toContain("npm_test failed twice");
    // diagnosis lands before the still-pending implement step
    const diagnosisIdx = p2.steps.findIndex((s) => /Diagnose the npm_test failure/.test(s.title));
    const implementIdx = p2.steps.findIndex((s) => s.id === "s2");
    expect(diagnosisIdx).toBeGreaterThanOrEqual(0);
    expect(diagnosisIdx).toBeLessThan(implementIdx);
    expect(p2.risks.some((r) => r.startsWith("replan:"))).toBe(true);
  });

  it("maps steps to todos and renders a readable plan", () => {
    const p = markStep(buildPlan({ input: "x", taskKind: "coding", workspacePath: "/ws", profile: PROFILE }), "s1", "completed");
    const todos = planToTodos(p);
    expect(todos).toHaveLength(4);
    expect(todos[0]?.status).toBe("completed");
    const text = renderPlanText(p);
    expect(text).toContain("Objective: x");
    expect(text).toContain("Verification:");
    expect(text).toContain("Completion criteria:");
  });

  it("persists and restores a plan for a run, rejecting garbage", () => {
    const p = buildPlan({ input: "persist me", taskKind: "coding", workspacePath: "/ws", profile: PROFILE });
    persistPlan("run-abc", p);
    const back = readPlanForRun("run-abc");
    expect(back?.objective).toBe("persist me");
    expect(back?.steps).toHaveLength(4);
    expect(readPlanForRun("missing-run")).toBeNull();
    store.setMemory("run", "bad-run", "plan", "{not json");
    expect(readPlanForRun("bad-run")).toBeNull();
    expect(parsePlan(undefined)).toBeNull();
    expect(parsePlan('{"objective":"x"}')).toBeNull();
  });
});

describe("tool selection by task type and phase", () => {
  it("exposes no tools for chat", () => {
    expect(selectToolNames("chat", "none")).toEqual([]);
    expect(selectToolNames("chat", "discover")).toEqual([]);
  });

  it("exposes only read-only tools while discovering", () => {
    const names = selectToolNames("coding", "discover");
    expect(names).toContain("read_file");
    expect(names).toContain("grep");
    expect(names).toContain("graphify_query");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("shell");
    expect(names).not.toContain("npm_test"); // verifying before changing is noise
    expect(names.every((n) => !isMutatingTool(n))).toBe(true);
  });

  it("adds implementation and verification tools once the change starts", () => {
    const names = selectToolNames("coding", "implement");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("shell");
    expect(names).toContain("npm_test");
    expect(names).toContain("read_file"); // discovery tools stay available
  });

  it("never gives reasoning tasks a mutating tool", () => {
    for (const phase of ["discover", "implement", "verify", "none"] as const) {
      const names = selectToolNames("reasoning", phase);
      expect(names).toContain("read_file");
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("shell");
      expect(names.every((n) => !isMutatingTool(n))).toBe(true);
    }
  });

  it("classifies every registered tool and stays complete against the registry", () => {
    const registry = buildRegistry();
    const inventory = toolInventory(registry);
    expect(inventory.length).toBe(registry.size);
    // every registry tool must be selectable in the full-implement universe
    const implement = new Set(selectToolNames("coding", "implement", registry.keys()));
    for (const name of registry.keys()) expect(implement.has(name), name).toBe(true);
    expect(categoryOf("read_file")).toBe("files");
    expect(categoryOf("npm_test")).toBe("verify");
    expect(categoryOf("totally-unknown-tool")).toBe("meta");
    expect(isMutatingTool("write_file")).toBe(true);
    expect(isMutatingTool("read_file")).toBe(false);
  });
});

describe("context window", () => {
  const msg = (role: "system" | "user" | "assistant" | "tool", content: string) => ({ role, content } as const);

  it("trims long tool output to head+tail with a visible marker", () => {
    const long = "A".repeat(5_000) + "B".repeat(5_000);
    const out = trimToolResult(long, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toContain("chars elided by context window");
    expect(out.startsWith("A")).toBe(true);
    expect(out.endsWith("B")).toBe(true);
    expect(trimToolResult("short", 1_000)).toBe("short");
  });

  it("keeps the system prompt and newest user turn while folding the rest", () => {
    const messages = [
      msg("system", "SYSTEM"),
      msg("user", "the original objective"),
      ...Array.from({ length: 20 }, (_, i) => msg("tool", `result ${i} ` + "x".repeat(4_000))),
      msg("user", "NEWEST"),
    ];
    const res = enforceContextBudget(messages, 10_000);
    expect(res.chars).toBeLessThanOrEqual(10_000);
    expect(res.compacted).toBeGreaterThan(0);
    expect(res.messages[0]?.content).toBe("SYSTEM");
    expect(res.messages[res.messages.length - 1]?.content).toBe("NEWEST");
    // compaction is announced, never silent
    expect(res.messages.some((m) => /context compacted/.test(m.content))).toBe(true);
  });

  it("leaves a small conversation untouched", () => {
    const messages = [msg("system", "s"), msg("user", "hi")];
    const res = enforceContextBudget(messages, 60_000);
    expect(res.compacted).toBe(0);
    expect(res.trimmed).toBe(false);
    expect(res.messages).toHaveLength(2);
  });

  it("composes run messages with the compacted session summary", () => {
    const { messages, compacted } = composeRunMessages({
      systemPrompt: "SYS", history: [msg("user", "old"), msg("assistant", "older")],
      summary: "we already fixed the parser", input: "now fix the writer", maxChars: 60_000,
    });
    expect(messages[0]?.content).toBe("SYS");
    expect(messages.some((m) => /we already fixed the parser/.test(m.content))).toBe(true);
    expect(messages[messages.length - 1]?.content).toBe("now fix the writer");
    expect(compacted).toBe(0);
  });
});

describe("failure memory", () => {
  it("fingerprints volatile parts so repeats collapse", () => {
    const a = fingerprintError("Error: ENOENT open '/tmp/x/src/a.ts' at line 42 (0xdeadbeef)");
    const b = fingerprintError("Error: ENOENT open '/home/y/src/b.ts' at line 7 (0xcafe1234)");
    expect(a).toBe(b);
    expect(a).toContain("<path>");
    expect(a).not.toContain("deadbeef");
  });

  it("counts repeats and only surfaces recurring unresolved patterns", () => {
    const scope = "ws-failure-1";
    rememberFailure(scope, "npm_test", "1 test failed: expected 2 got 3");
    expect(recallRecurringFailures(scope)).toHaveLength(0); // seen once → not recurring yet
    rememberFailure(scope, "npm_test", "1 test failed: expected 4 got 5");
    const recurring = recallRecurringFailures(scope);
    expect(recurring).toHaveLength(1);
    expect(recurring[0]?.tool).toBe("npm_test");
    expect(recurring[0]?.count).toBe(2);
    expect(failureHints(scope)).toContain("npm_test failed 2×");

    markFailureResolved(scope, "npm_test");
    expect(recallRecurringFailures(scope)).toHaveLength(0);
    expect(recallAllFailures(scope)[0]?.resolvedAt).toBeTruthy();
    expect(failureHints(scope)).toBe("");
  });
});

describe("adaptive runtime loop (real execution)", () => {
  it("emits and persists a real plan, and reports an unreachable provider honestly", async () => {
    const uid = store.upsertUser("plan-u", "u");
    const chat = store.ensureChat(uid, "plan-c");
    const sid = ensureSession(uid, chat, "plan-ws", "9router", "auto");
    process.env.PROVIDER_BASE_URL = "http://127.0.0.1:1/v1";

    const degradedBefore = metrics.agentRunsDegraded.get();
    const successBefore = metrics.agentRunsSuccess.get();

    const handle = await startRun({
      userId: uid, chatDbId: chat, sessionId: sid, workspacePath: "plan-ws",
      provider: "9router", model: "auto", input: "fix the failing test in this project",
    });
    const events: Array<{ type: string }> = [];
    for await (const e of handle.events) events.push(e);

    // a plan is announced and stored before any model call
    const planEvents = events.filter((e) => e.type === "plan");
    expect(planEvents.length).toBeGreaterThanOrEqual(1);
    const persisted = readPlanForRun(handle.runId);
    expect(persisted?.steps.length).toBeGreaterThan(0);
    expect(persisted?.taskKind).toBe("coding");

    // the provider was unreachable: this is NOT a success, and it is not silent
    expect(metrics.agentRunsSuccess.get()).toBe(successBefore);
    expect(metrics.agentRunsDegraded.get()).toBe(degradedBefore + 1);
    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(true);

    const run = store.getRun(handle.runId) as { status: string } | undefined;
    expect(run?.status).toBe("completed");

    delete process.env.PROVIDER_BASE_URL;
  }, 60_000);
});
