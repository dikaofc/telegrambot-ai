import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspacePath, detectProjectProfile, assertInsideWorkspace, workspaceTree } from "../src/workspace/manager.js";
import { runVerification } from "../src/agent/verification.js";
import { AgentStateMachine, canTransition } from "../src/agent/state-machine.js";
import { detectCliRuntimes } from "../src/runtime/adapters.js";
import { loadSkillPrompt, listSkills } from "../src/agent/skills.js";
import { checkHealth } from "../src/observability/health.js";
import { renderPrometheus, metrics } from "../src/observability/metrics.js";

describe("workspace management", () => {
  it("resolves + fuzzy matches + enforces boundary", () => {
    process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-wsroot-"));
    fs.mkdirSync(path.join(process.env.WORKSPACE_ROOT, "my-project"));
    expect(resolveWorkspacePath("my-project")).toContain("my-project");
    expect(() => assertInsideWorkspace(process.env.WORKSPACE_ROOT + "/my-project", "../../etc")).toThrow();
    expect(workspaceTree(process.env.WORKSPACE_ROOT + "/my-project").length).toBe(0);
  });
  it("detects project profiles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-prof-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run", build: "tsc" }, dependencies: { react: "*" } }));
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    const p = detectProjectProfile(dir);
    expect(p.packageManager).toBe("pnpm");
    expect(p.framework).toBe("react");
    expect(p.testCommand).toContain("test");
    const py = fs.mkdtempSync(path.join(os.tmpdir(), "tele-py-"));
    fs.writeFileSync(path.join(py, "pyproject.toml"), "[project]");
    expect(detectProjectProfile(py).language).toBe("python");
  });
});

describe("agent core", () => {
  it("state machine transitions", () => {
    expect(canTransition("idle", "thinking")).toBe(true);
    expect(canTransition("idle", "completed")).toBe(false);
    const m = new AgentStateMachine();
    expect(m.transition("thinking")).toBe(true);
    expect(m.current).toBe("thinking");
  });
  it("skills load + route", () => {
    expect(listSkills("skills").length).toBeGreaterThan(3);
    expect(loadSkillPrompt("fix the failing build", "skills")).toContain("debugging");
    expect(loadSkillPrompt("create a react component", "skills")).toContain("frontend");
  });
  it("cli adapter detection runs (no crash)", async () => {
    const found = await detectCliRuntimes();
    expect(Array.isArray(found)).toBe(true);
  });
  it("verification adapts to project (real exec)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tele-ver-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    const rep = await runVerification(dir, true);
    expect(rep.steps.length).toBeGreaterThan(0);
  }, 60000);
});

describe("observability", () => {
  it("health + metrics", async () => {
    process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? os.tmpdir();
    const h = await checkHealth();
    expect(h.database).toBe(true);
    expect(h.workspace).toBe(true);
    metrics.agentRunsTotal.inc();
    expect(renderPrometheus()).toContain("agent_runs_total");
  });
});
