import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tele-loopws-"));
process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-loopdb-")) + "/l.db";
process.env.WORKSPACE_ROOT = wsRoot;
process.env.RATE_LIMIT_RUNS = "600";
process.env.RATE_LIMIT_MESSAGES = "600";
process.env.AGENT_MAX_STEPS = "12";
process.env.AGENT_REPLAN_AFTER = "3";

/**
 * Scripted provider: records which tools the model was offered on each turn and
 * replays a fixed conversation. Everything else in the router (classifyTask,
 * defaultRouting, cost estimation) stays real.
 */
const h = vi.hoisted(() => ({
  offered: [] as string[][],
  script: [] as Array<{ text?: string; tool?: string; args?: Record<string, unknown> }>,
  cursor: 0,
}));

vi.mock("../src/providers/router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/providers/router.js")>();
  return {
    ...actual,
    chatWithFallback: async function* (req: { tools?: Array<{ name: string }> }) {
      h.offered.push((req.tools ?? []).map((t) => t.name));
      const turn = h.script[h.cursor++];
      if (!turn) { yield { type: "text", text: "(script exhausted)" }; return; }
      if (turn.text) yield { type: "text", text: turn.text };
      if (turn.tool) yield { type: "tool_call", toolCall: { id: `call-${h.cursor}`, name: turn.tool, args: turn.args ?? {} } };
    },
  };
});

import { startRun, ensureSession } from "../src/agent/orchestrator.js";
import { readPlanForRun } from "../src/agent/planner.js";
import { store } from "../src/database/store.js";
import { openDatabase } from "../src/database/db.js";
import type { AgentEvent } from "../src/runtime/types.js";

beforeEach(() => {
  openDatabase(process.env.DATABASE_URL);
  h.offered = [];
  h.cursor = 0;
  h.script = [];
  // the session runs in <root>/loop-ws, so the readable fixture must live there
  const ws = path.join(wsRoot, "loop-ws");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# demo project\n\nhello world\n", "utf8");
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "loop", scripts: { test: "vitest run" } }), "utf8");
});

async function runScript(input: string, script: typeof h.script): Promise<{ events: AgentEvent[]; runId: string; sessionId: string }> {
  h.script = script;
  h.cursor = 0;
  const uid = store.upsertUser(`loop-u-${Math.random().toString(36).slice(2, 8)}`, "u");
  const chat = store.ensureChat(uid, `loop-c-${Math.random().toString(36).slice(2, 8)}`);
  const sid = ensureSession(uid, chat, "loop-ws", "9router", "auto");
  const handle = await startRun({
    userId: uid, chatDbId: chat, sessionId: sid, workspacePath: "loop-ws",
    provider: "9router", model: "auto", input,
  });
  const events: AgentEvent[] = [];
  for await (const e of handle.events) events.push(e);
  return { events, runId: handle.runId, sessionId: sid };
}

describe("adaptive loop: tool visibility follows the plan phase", () => {
  it("hides write tools until the workspace has actually been read", async () => {
    const { events } = await runScript("fix the failing test in this project", [
      { tool: "read_file", args: { target: "README.md" } },
      { text: "The README explains the project. Nothing to change yet." },
    ]);

    expect(h.offered.length).toBeGreaterThanOrEqual(2);
    // turn 1 = discovery: read-only
    expect(h.offered[0]).toContain("read_file");
    expect(h.offered[0]).not.toContain("write_file");
    expect(h.offered[0]).not.toContain("shell");
    // turn 2 = implement: writes unlocked because evidence exists
    expect(h.offered[1]).toContain("write_file");
    expect(h.offered[1]).toContain("shell");
    expect(h.offered[1]).toContain("read_file"); // reads never disappear

    const planEvents = events.filter((e) => e.type === "plan");
    expect(planEvents.length).toBe(1);
    expect(events.some((e) => e.type === "completed")).toBe(true);
    expect(events.some((e) => e.type === "replan")).toBe(false);
  });

  it("offers no tools at all for conversational requests", async () => {
    await runScript("siapa kamu?", [{ text: "Aku TeleAgent — coding agent di Telegram." }]);
    expect(h.offered.length).toBeGreaterThanOrEqual(1);
    expect(h.offered[0]).toEqual([]);
  });

  it("nudges instead of accepting an answer before any inspection", async () => {
    // First turn: the model answers without touching any tool. The loop must not
    // accept that as a finished coding task.
    const { events } = await runScript("refactor the database layer", [
      { text: "I think the database layer looks fine." },
      { tool: "read_file", args: { target: "README.md" } },
      { text: "Now I have real context." },
    ]);
    expect(h.offered.length).toBeGreaterThanOrEqual(3);
    // the nudge unlocks implementation tools even though no read succeeded yet
    expect(h.offered[1]).toContain("write_file");
    expect(events.some((e) => e.type === "thinking" && /escalating/.test(e.message))).toBe(true);
    expect(events.filter((e) => e.type === "completed").length).toBe(1);
  });
});

describe("adaptive loop: replanning on repeated failure", () => {
  it("revises the plan instead of hammering the same failing tool", async () => {
    const { events, runId } = await runScript("fix the broken importer", [
      { tool: "read_file", args: { target: "does-not-exist.ts" } },
      { tool: "read_file", args: { target: "does-not-exist.ts" } },
      { tool: "read_file", args: { target: "does-not-exist.ts" } },
      { text: "I could not find the importer; it may live in another workspace." },
    ]);

    const replans = events.filter((e) => e.type === "replan");
    expect(replans.length).toBe(1);
    expect(replans[0]).toMatchObject({ revision: 2 });
    expect(String((replans[0] as { reason: string }).reason)).toMatch(/read_file failed repeatedly/);

    // the revised plan is persisted with the diagnosis step inserted
    const plan = readPlanForRun(runId);
    expect(plan?.revision).toBe(2);
    expect(plan?.steps.some((s) => /Diagnose the read_file failure/.test(s.title))).toBe(true);
    expect(plan?.risks.some((r) => r.startsWith("replan:"))).toBe(true);

    // and the run still terminates with a real answer
    expect(events.some((e) => e.type === "completed")).toBe(true);
  });

  it("stops with an explicit blocker after repeated replanning fails", async () => {
    const failing = Array.from({ length: 12 }, () => ({ tool: "read_file", args: { target: "nope.ts" } }));
    const { events } = await runScript("fix the broken importer", failing);
    expect(events.filter((e) => e.type === "replan").length).toBe(2);
    const error = events.find((e) => e.type === "error" && /blocked:/.test(e.error));
    expect(error).toBeTruthy();
    expect(events.some((e) => e.type === "state" && e.state === "failed")).toBe(true);
  });
});
