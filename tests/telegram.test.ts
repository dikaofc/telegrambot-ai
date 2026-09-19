import { describe, it, expect } from "vitest";
import { renderEventLine, applyEvent, emptySnapshot, renderStatusMessage, renderFinalSummary, renderFailure } from "../src/telegram/renderer.js";
import { truncateForTelegram, progressBar, splitMessage } from "../src/utils/large-output.js";
import { runControlsKeyboard, approvalKeyboard, settingsKeyboard } from "../src/telegram/keyboards.js";

describe("telegram renderer rules", () => {
  it("maps tools to operational status (no raw CoT)", () => {
    expect(renderEventLine({ type: "tool_start", tool: "read_file", args: { target: "src/auth.ts" } })).toContain("📖");
    expect(renderEventLine({ type: "tool_start", tool: "shell", args: { command: "npm test" } })).toContain("▶️");
    expect(renderEventLine({ type: "tool_start", tool: "edit_file", args: { target: "a" } })).toContain("🛠");
    expect(renderEventLine({ type: "thinking", message: "x" })).toContain("🧠");
  });
  it("status snapshot aggregation", () => {
    let s = emptySnapshot();
    s = applyEvent(s, { type: "state", state: "testing" });
    s = applyEvent(s, { type: "file_change", files: ["a.ts"] });
    s = applyEvent(s, { type: "test", passed: 3, failed: 1, output: "x" });
    const msg = renderStatusMessage(s);
    expect(msg).toContain("phase: testing");
    expect(msg).toContain("files changed: 1");
    expect(msg).toContain("errors: 1");
  });
  it("final + failure summaries", () => {
    expect(renderFinalSummary({ filesChanged: ["a"], durationMs: 61000, tokens: 42800, model: "auto" })).toContain("task completed");
    expect(renderFailure({ attempted: ["npm test"], lastError: "boom", remains: "todo" })).toContain("task incomplete");
  });
});

describe("large output handling", () => {
  it("truncates over limit and splits", () => {
    const big = "x".repeat(5000);
    const t = truncateForTelegram(big);
    expect(t.truncated).toBe(true);
    expect(t.text.length).toBeLessThan(big.length);
    expect(splitMessage(big, 4000).length).toBe(2);
    expect(progressBar(78)).toContain("█");
  });
});

describe("keyboards", () => {
  it("run/approval/settings keyboards exist", () => {
    expect(runControlsKeyboard("r")[0]?.length).toBe(3);
    expect(approvalKeyboard("a")[0]?.length).toBe(2);
    expect(settingsKeyboard().length).toBeGreaterThan(2);
  });
});
