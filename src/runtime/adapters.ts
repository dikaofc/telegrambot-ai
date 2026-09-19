import { execArgs } from "../tools/shell.js";
import type { AgentEvent, CLIAdapter } from "./types.js";

function outputEvents(source: string, output: string): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (/test.*(pass|ok)|✓|passed/i.test(output)) events.push({ type: "test", passed: 1, failed: 0, output: output.slice(-2000) });
  if (/fail|error|✗/i.test(output)) events.push({ type: "error", error: `[${source}] ${output.slice(-1000)}` });
  if (output.trim()) events.push({ type: "tool_output", tool: source, output: output.slice(-4000), success: true });
  return events;
}

class BaseAdapter implements CLIAdapter {
  constructor(public id: string, private bin: string, private probeArgs: string[]) {}
  async detect(): Promise<boolean> {
    try {
      const r = await execArgs(this.bin, this.probeArgs, process.cwd(), 10_000);
      return r.success;
    } catch { return false; }
  }
  parseOutput(output: string): AgentEvent[] { return outputEvents(this.id, output); }
}

export const cliAdapters: CLIAdapter[] = [
  new BaseAdapter("opencode", "opencode", ["--version"]),
  new BaseAdapter("codex", "codex", ["--version"]),
  new BaseAdapter("claude", "claude", ["--version"]),
  new BaseAdapter("gemini", "gemini", ["--version"]),
  new BaseAdapter("aider", "aider", ["--version"]),
  new BaseAdapter("generic", "sh", ["--version"]),
];

export async function detectCliRuntimes(): Promise<string[]> {
  const out: string[] = [];
  for (const a of cliAdapters) {
    if (a.id === "generic") continue;
    try { if (await a.detect()) out.push(a.id); } catch { /* noop */ }
  }
  return out;
}
