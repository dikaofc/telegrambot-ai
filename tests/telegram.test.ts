import { describe, it, expect } from "vitest";
import { renderEventLine, applyEvent, emptySnapshot, renderStatusMessage, renderFinalSummary, renderFailure } from "../src/telegram/renderer.js";
import { truncateForTelegram, progressBar, splitMessage } from "../src/utils/large-output.js";
import { runControlsKeyboard, approvalKeyboard, settingsKeyboard } from "../src/telegram/keyboards.js";
import { matchFastShellCommand } from "../src/telegram/gateway.js";

describe("telegram renderer rules", () => {
  it("maps tools to operational status (no raw CoT)", () => {
    expect(renderEventLine({ type: "tool_start", tool: "read_file", args: { target: "src/auth.ts" } })).toContain("📖");
    expect(renderEventLine({ type: "tool_start", tool: "shell", args: { command: "npm test" } })).toContain("▶️");
    expect(renderEventLine({ type: "tool_start", tool: "edit_file", args: { target: "a" } })).toContain("🛠");
    expect(renderEventLine({ type: "thinking", message: "x" })).toContain("✨");
  });
  it("status snapshot aggregation", () => {
    let s = emptySnapshot();
    s = applyEvent(s, { type: "state", state: "testing" });
    s = applyEvent(s, { type: "file_change", files: ["a.ts"] });
    s = applyEvent(s, { type: "test", passed: 3, failed: 1, output: "x" });
    const msg = renderStatusMessage(s);
    expect(msg).toContain("status: testing");
    expect(msg).toContain("ubah: 1 file");
    expect(msg).toContain("error: 1");
  });
  it("final + failure summaries", () => {
    expect(renderFinalSummary({ filesChanged: ["a"], durationMs: 61000, tokens: 42800, model: "auto" })).toContain("Beres!");
    expect(renderFailure({ attempted: ["npm test"], lastError: "boom", remains: "todo" })).toContain("Belum beres");
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

describe("fast shell path (ls -la must never enter the plan loop)", () => {
  it("accepts trivial read-only one-liners", () => {
    expect(matchFastShellCommand("ls -la")).toBe("ls -la");
    expect(matchFastShellCommand("ls")).toBe("ls");
    expect(matchFastShellCommand("pwd")).toBe("pwd");
    expect(matchFastShellCommand("whoami")).toBe("whoami");
    expect(matchFastShellCommand("echo halo")).toBe("echo halo");
    expect(matchFastShellCommand("cat dika.js")).toBe("cat dika.js");
    expect(matchFastShellCommand("cat uploads/a.txt")).toBe("cat uploads/a.txt");
  });
  it("rejects everything else (falls through to the agent)", () => {
    for (const t of [
      "rm -rf /", "ls -la; rm -rf /", "ls | grep x", "cat ../../etc/passwd",
      "cat /etc/passwd", "cat a b", "tolong ls", "coba ketik ls -la",
      "ls $HOME", "echo `whoami`", "git status", "npm test", "",
    ]) expect(matchFastShellCommand(t), t).toBeNull();
  });
});
