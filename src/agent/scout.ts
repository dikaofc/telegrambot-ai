import { getEnv } from "../config/env.js";
import { chatWithFallback, defaultRouting } from "../providers/router.js";
import { buildSystemPrompt } from "./prompts.js";
import { store } from "../database/store.js";
import { hashArgs, auditTool } from "../security/audit.js";
import type { ToolResult } from "../tools/types.js";
import type { ChatMessage } from "../providers/types.js";

/** Read-only tool subset a scout may use (no writes, no shell, no network). */
const SCOUT_TOOLS = new Set([
  "read_file", "list_directory", "tree", "read_many", "glob", "find_files",
  "grep", "search_code", "symbol_outline", "file_exists", "file_info",
  "project_profile", "git_status", "git_diff", "git_log",
]);

/**
 * Scout: a real bounded subagent loop (same provider brain, fresh context,
 * read-only tools, step budget). Returns a research digest — never writes.
 */
export async function scout(workspacePath: string, sessionId: string, goal: string, maxSteps = 8, runId?: string): Promise<ToolResult> {
  const started = Date.now();
  try {
    const s = store.getSession(sessionId) as { provider: string; model: string } | undefined;
    const provider = s?.provider ?? getEnv().PROVIDER;
    const model = s?.model ?? "auto";
    const { buildRegistry, toolSchemasForLLM } = await import("../tools/registry.js");
    const { toolRisk } = await import("../security/risk.js");
    const registry = buildRegistry();
    const schemas = toolSchemasForLLM(registry).filter((t) => SCOUT_TOOLS.has(t.name));
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt({ workspacePath, taskKind: "research", skillPrompt: "\nYou are a SCOUT subagent. Explore and report findings. NEVER write, modify, delete, or execute anything — read-only tools only. Be concise and cite file:line.\n" }),
      },
      { role: "user", content: `Research goal: ${goal}\n\nExplore the workspace and return a digest: key files, how it works, exact locations. Do not write any files.` },
    ];
    const findings: string[] = [];
    let tokensIn = 0; let tokensOut = 0;
    let steps = 0;
    let finalText = "";
    while (steps < Math.min(Math.max(maxSteps, 1), 12)) {
      steps += 1;
      let pending: { id: string; name: string; args: Record<string, unknown> } | null = null;
      let textBuf = "";
      const stream = chatWithFallback({ model, messages, tools: schemas }, defaultRouting(provider));
      for await (const ev of stream) {
        if (ev.type === "text" && ev.text) textBuf += ev.text;
        else if (ev.type === "tool_call" && ev.toolCall) pending = ev.toolCall;
        else if (ev.type === "usage" && ev.usage) { tokensIn += ev.usage.inputTokens; tokensOut += ev.usage.outputTokens; }
      }
      if (!pending) { finalText = textBuf; break; }
      finalText = textBuf;
      const def = registry.get(pending.name);
      if (!def || !SCOUT_TOOLS.has(pending.name)) {
        messages.push({ role: "tool", content: `tool not allowed for scout: ${pending.name}`, toolName: pending.name });
        continue;
      }
      const t0 = Date.now();
      let result: ToolResult;
      try {
        result = await def.execute(pending.args, { workspacePath, sessionId });
      } catch (e) { result = { success: false, error: String(e) }; }
      store.logTool(runId || `scout-${Date.now()}`, pending.name, hashArgs(pending.args), toolRisk(pending.name), { approval: "auto", success: result.success, durationMs: Date.now() - t0 });
      auditTool({ sessionId, tool: `scout/${pending.name}`, args: pending.args, risk: "SAFE", approval: "auto", result: result.output ?? result.error, durationMs: Date.now() - t0 });
      const out = (result.success ? result.output ?? "" : `ERROR: ${result.error ?? ""}`).slice(0, 4000);
      findings.push(`${pending.name}: ${out.slice(0, 300)}`);
      messages.push({ role: "tool", content: out || "(empty)", toolName: pending.name });
    }
    const digest = (finalText || findings.join("\n")).slice(0, 8000) || "(scout found nothing)";
    return {
      success: true,
      output: `🔎 scout digest (${steps} steps, +${tokensIn}/${tokensOut} tokens):\n${digest}`,
      metadata: { duration: Date.now() - started },
    };
  } catch (e) {
    return { success: false, error: `scout failed: ${String(e).slice(0, 1000)}` };
  }
}
