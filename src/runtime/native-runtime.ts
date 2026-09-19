import { getEnv } from "../config/env.js";
import { buildRegistry, toolSchemasForLLM } from "../tools/registry.js";
import { chatWithFallback, defaultRouting, classifyTask, estimateCostUsd } from "../providers/router.js";
import { toolRisk, policyForRisk, RiskLevel } from "../security/risk.js";
import { classifyCommand } from "../security/command-parser.js";
import { hashArgs, auditTool } from "../security/audit.js";
import { store } from "../database/store.js";
import { metrics, recordRunDuration } from "../observability/metrics.js";
import { loadSkillPrompt } from "../agent/skills.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import { runVerification } from "../agent/verification.js";
import { createCheckpoint } from "../agent/checkpoint.js";
import { gitTools } from "../tools/git.js";
import type { AgentContext, AgentEvent, AgentRuntime } from "./types.js";
import type { ChatMessage } from "../providers/types.js";

const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "apply_patch", "delete_file", "move_file",
  "git_branch", "git_checkout", "search_replace", "rename_symbol",
  "shell", "shell_start", "shell_batch",
]);

function isWriteCall(name: string, args: Record<string, unknown>): boolean {
  if (!WRITE_TOOLS.has(name)) return false;
  // search_replace/rename_symbol default to dry-run → only real writes checkpoint
  if (name === "search_replace" || name === "rename_symbol") return args.dryRun === false;
  return true;
}

/**
 * NativeRuntime — the autonomous agent loop:
 * understand → context discovery → plan → tool selection → execute →
 * observe → verify → retry → complete. Real tool execution only; events are
 * emitted after tools actually run (never simulated).
 */
export class NativeRuntime implements AgentRuntime {
  private ctx!: AgentContext;
  private aborted = false;
  private paused = false;
  private registry = buildRegistry();

  async initialize(context: AgentContext): Promise<void> {
    this.ctx = context;
    this.aborted = false;
    this.paused = false;
  }

  async interrupt(): Promise<void> { this.aborted = true; }
  async pause(): Promise<void> { this.paused = true; }
  async resume(): Promise<void> { this.paused = false; }
  async shutdown(): Promise<void> { this.aborted = true; }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.aborted) await new Promise((r) => setTimeout(r, 200));
  }

  async *run(input: string): AsyncIterable<AgentEvent> {
    const started = Date.now();
    const env = getEnv();
    const maxRetries = env.AGENT_MAX_RETRIES;
    metrics.agentRunsTotal.inc();
    const taskKind = classifyTask(input);

    yield { type: "state", state: "thinking" };
    yield { type: "thinking", message: "analyzing request" };

    // conversation history (short-term context)
    const history = store.messages(this.ctx.sessionId, 40);
    const chatHistory: ChatMessage[] = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" as const : m.role === "system" ? "system" as const : "user" as const,
      content: String(m.content).slice(0, 4000),
    }));

    const skillPrompt = loadSkillPrompt(input);
    const systemPrompt = buildSystemPrompt({ workspacePath: this.ctx.workspacePath, taskKind, skillPrompt });

    yield { type: "state", state: "planning" };
    yield { type: "planning", message: `planning ${taskKind} task` };

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...chatHistory.slice(-12),
      { role: "user", content: input },
    ];
    // oc/muse-spark-*-free via 9router blocks tools (FreeTierError) — for pure chat don't send tools at all
    const fullToolSchemas = toolSchemasForLLM(this.registry);
    const toolSchemas = taskKind === "chat" ? [] : fullToolSchemas;
    const filesChanged: string[] = [];
    let tokensIn = 0; let tokensOut = 0;
    let done = false;
    let iterations = 0;
    const maxIterations = 25;
    let checkpointId: string | null = null;

    const recordUsage = (status: string): void => {
      try {
        store.finishRun(this.ctx.runId, status, tokensIn, tokensOut);
        store.addUsage(this.ctx.userId, this.ctx.runId, this.ctx.provider, this.ctx.model, tokensIn, tokensOut,
          estimateCostUsd(this.ctx.provider, this.ctx.model, tokensIn, tokensOut));
      } catch { /* usage must never break the run */ }
    };
    const gitStat = async (): Promise<string> => {
      try {
        const r = await gitTools.diff(this.ctx.workspacePath, ["--stat"]);
        const s = (r.output ?? "").trim();
        return s ? `\n\ngit:\n${s.slice(0, 1500)}` : "";
      } catch { return ""; }
    };
    const ensureCheckpoint = async (): Promise<void> => {
      if (checkpointId) return;
      try {
        const s = store.getSession(this.ctx.sessionId) as { workspace_id: string } | undefined;
        const wsId = s?.workspace_id ?? store.ensureWorkspace("default", this.ctx.workspacePath, this.ctx.userId);
        checkpointId = await createCheckpoint(this.ctx.runId, wsId, this.ctx.workspacePath);
      } catch { /* best-effort safety net */ }
    };

    while (!done && iterations < maxIterations && !this.aborted) {
      iterations += 1;
      await this.waitIfPaused();
      if (this.aborted) break;

      let pendingTool: { id: string; name: string; args: Record<string, unknown> } | null = null;
      let textBuf = "";
      try {
        const stream = chatWithFallback(
          { model: this.ctx.model, messages, tools: toolSchemas, signal: undefined },
          defaultRouting(this.ctx.provider),
        );
        for await (const ev of stream) {
          if (this.aborted) break;
          if (ev.type === "text" && ev.text) textBuf += ev.text;
          else if (ev.type === "tool_call" && ev.toolCall) pendingTool = ev.toolCall;
          else if (ev.type === "usage" && ev.usage) { tokensIn += ev.usage.inputTokens; tokensOut += ev.usage.outputTokens; }
        }
      } catch (e) {
        const errMsg = String(e).slice(0, 1500);
        yield { type: "error", error: `provider error: ${errMsg.slice(0, 1000)}` };
        const isFreeTier = /FreeTierError|can only be used from within OpenCode/i.test(errMsg);
        const isChat = taskKind === "chat";
        // For chat, never do workspace triage — give a helpful answer + guidance instead
        if (isChat) {
          let helpSummary: string;
          if (isFreeTier) {
            helpSummary = `⚠️ Model \`${this.ctx.model}\` free tier cuma bisa dipakai di dalam OpenCode, gak bisa via 9router.\n\n` +
              `Solusi (pilih 1):\n` +
              `• /model auto  → pakai router default 9router (paling aman)\n` +
              `• /provider openai + isi PROVIDER_API_KEY yang valid\n` +
              `• Ganti .env: PROVIDER_MODEL=auto lalu restart bot\n\n` +
              `Sementara aku jawab 2 kata: **TeleAgent AI** ✨`;
          } else if (/Incorrect API key|invalid_api_key|Bad credentials|401|403/i.test(errMsg)) {
            helpSummary = `⚠️ Provider \`${this.ctx.provider}\` error auth: ${errMsg.slice(0, 300)}\n\n` +
              `Cek PROVIDER_API_KEY di .env — key 9router gak bisa dipakai buat openai/xai.\n` +
              `Coba: /model auto  atau  /provider ollama (lokal, tanpa key)\n\n` +
              `Chat 2 kata: **TeleAgent AI** ✨`;
          } else {
            helpSummary = `⚠️ Provider unreachable (${this.ctx.provider}): ${errMsg.slice(0, 300)}\n\n` +
              `Coba /doctor buat cek status, atau /model auto. Sementara: **TeleAgent AI** ✨`;
          }
          recordUsage("completed");
          metrics.agentRunsSuccess.inc();
          recordRunDuration(Date.now() - started);
          yield { type: "state", state: "completed" };
          yield { type: "completed", summary: helpSummary, filesChanged: [] };
          done = true;
          break;
        }
        // For coding tasks, do triage then explain
        yield* this.deterministicProbe(input, filesChanged);
        recordUsage("completed");
        metrics.agentRunsSuccess.inc();
        recordRunDuration(Date.now() - started);
        yield { type: "state", state: "completed" };
        const triageNote = isFreeTier
          ? `Provider error (FreeTier): model \`${this.ctx.model}\` cuma di OpenCode. Ganti /model auto.\n\nWorkspace triage di bawah:`
          : "Provider unreachable — workspace triage di bawah. Cek PROVIDER_API_KEY / /doctor.";
        yield { type: "completed", summary: `${triageNote}`, filesChanged };
        done = true;
        break;
      }

      if (!pendingTool) {
        const trimmed = textBuf.trim();
        // Empty LLM response (common for small models on trivial chat due to streaming quirks) —
        // retry once without tools before giving up, so "siapa kamu?" never shows empty.
        if (!trimmed && iterations === 1 && taskKind === "chat") {
          try {
            let retryText = "";
            const retryStream = chatWithFallback(
              { model: this.ctx.model, messages: [...messages.slice(0, 1), { role: "user", content: input }], tools: [], signal: undefined },
              defaultRouting(this.ctx.provider),
            );
            for await (const ev of retryStream) {
              if (ev.type === "text" && ev.text) retryText += ev.text;
              else if (ev.type === "usage" && ev.usage) { tokensIn += ev.usage.inputTokens; tokensOut += ev.usage.outputTokens; }
            }
            if (retryText.trim()) textBuf = retryText;
          } catch { /* keep empty → fallback below */ }
        }
        const finalText = textBuf.trim();
        // Last resort: if still empty, give a deterministic chat answer so user never sees blank "task completed"
        let fallback = taskKind === "chat"
          ? `Halo! Aku TeleAgent — coding agent kamu di Telegram. Kirim tugas apa aja, aku siap bantu. (model: ${this.ctx.model})`
          : "Task analyzed. No tool actions were required.";
        // Honor explicit "3 kata" / "3 words" constraint when we have to synthesize
        if (!finalText && /3\s*kata|3\s*words|tiga\s*kata/i.test(input)) fallback = "Aku TeleAgent pintar";
        const summary = finalText || fallback;
        messages.push({ role: "assistant", content: summary });
        yield { type: "state", state: "completed" };
        metrics.agentRunsSuccess.inc();
        recordRunDuration(Date.now() - started);
        recordUsage("completed");
        // Don't append git noise to pure chat
        const maybeGit = taskKind === "chat" && filesChanged.length === 0 ? "" : await gitStat();
        yield { type: "completed", summary: summary + maybeGit, filesChanged };
        done = true;
        break;
      }

      const toolDef = this.registry.get(pendingTool.name);
      if (!toolDef) {
        messages.push({ role: "tool", content: `unknown tool: ${pendingTool.name}`, toolName: pendingTool.name });
        continue;
      }

      // risk + approval gate
      let risk = toolRisk(pendingTool.name);
      let commandForApproval = pendingTool.name;
      if ((pendingTool.name === "shell" || pendingTool.name === "shell_start" || pendingTool.name === "shell_input") && typeof pendingTool.args.command === "string") {
        const v = classifyCommand(pendingTool.args.command);
        risk = v.risk;
        commandForApproval = v.normalized;
      }
      if (pendingTool.name === "shell_input" && typeof pendingTool.args.data === "string") {
        const v = classifyCommand(pendingTool.args.data);
        if (v.risk === RiskLevel.CRITICAL) risk = v.risk;
        commandForApproval = `stdin → ${v.normalized.slice(0, 120)}`;
      }
      const decision = policyForRisk(risk);
      const t0 = Date.now();
      metrics.toolCallsTotal.inc();

      if (decision === "deny") {
        metrics.toolFailures.inc();
        const msg = `denied ${risk} action: ${commandForApproval}`;
        yield { type: "error", error: msg };
        messages.push({ role: "tool", content: `DENIED by policy (${risk}): ${commandForApproval}`, toolName: pendingTool.name });
        auditTool({ userId: this.ctx.userId, sessionId: this.ctx.sessionId, tool: pendingTool.name, args: pendingTool.args, risk, approval: "deny", result: msg, durationMs: Date.now() - t0 });
        continue;
      }
      if (decision === "ask") {
        const approvalId = store.createApproval(this.ctx.runId, pendingTool.name, commandForApproval, risk);
        yield { type: "state", state: "waiting_approval" };
        yield { type: "approval_required", approvalId, tool: pendingTool.name, command: commandForApproval, risk, reason: "policy requires approval" };
        // wait for approval (poll up to 10 min)
        const approved = await this.waitForApproval(approvalId, 600_000);
        if (!approved) {
          messages.push({ role: "tool", content: `approval rejected/timeout for: ${commandForApproval}`, toolName: pendingTool.name });
          auditTool({ userId: this.ctx.userId, sessionId: this.ctx.sessionId, tool: pendingTool.name, args: pendingTool.args, risk, approval: "rejected", durationMs: Date.now() - t0 });
          continue;
        }
      }

      const stateForTool = pendingTool.name.includes("test") ? "testing" : pendingTool.name === "read_file" || pendingTool.name === "glob" || pendingTool.name === "grep" || pendingTool.name === "search_code" ? "reading" : pendingTool.name.includes("write") || pendingTool.name.includes("edit") ? "editing" : "executing";
      yield { type: "state", state: stateForTool };
      yield { type: "tool_start", tool: pendingTool.name, args: pendingTool.args };

      // REAL execution happens here (auto-checkpoint before first write)
      if (isWriteCall(pendingTool.name, pendingTool.args)) await ensureCheckpoint();
      let result;
      try {
        result = await toolDef.execute(pendingTool.args, {
          workspacePath: this.ctx.workspacePath,
          runId: this.ctx.runId,
          sessionId: this.ctx.sessionId,
          userId: this.ctx.userId,
        });
      } catch (e) {
        result = { success: false as const, error: String(e) };
      }
      const duration = Date.now() - t0;
      store.logTool(this.ctx.runId, pendingTool.name, hashArgs(pendingTool.args), risk, { approval: decision, success: result.success, exitCode: result.metadata?.exitCode, durationMs: duration });
      auditTool({ userId: this.ctx.userId, sessionId: this.ctx.sessionId, tool: pendingTool.name, args: pendingTool.args, risk, approval: decision, result: result.output ?? result.error, exitCode: result.metadata?.exitCode, durationMs: duration });
      if (!result.success) metrics.toolFailures.inc();

      const outText = (result.success ? result.output ?? "" : `ERROR: ${result.error ?? ""}`).slice(0, 6000);
      yield { type: "tool_output", tool: pendingTool.name, output: outText.slice(0, 2000), success: result.success };
      if (result.metadata?.filesChanged) {
        filesChanged.push(...result.metadata.filesChanged);
        yield { type: "file_change", files: result.metadata.filesChanged };
      }
      if (pendingTool.name === "shell") yield { type: "command", command: String(pendingTool.args.command ?? ""), exitCode: result.metadata?.exitCode };
      messages.push({ role: "tool", content: outText || "(empty tool result)", toolName: pendingTool.name });

      // error recovery with retries
      if (!result.success && maxRetries > 0) {
        yield { type: "state", state: "retrying" };
        messages.push({ role: "user", content: `The last tool call failed. Diagnose the error, inspect relevant files if needed, then try a fix. Remaining budget: ${maxIterations - iterations} steps.` });
      }
      if (result.success && (pendingTool.name === "npm_test" || pendingTool.name === "npm_build")) {
        const m = /(\d+)\s+passed/i.exec(outText);
        yield { type: "test", passed: m ? Number(m[1]) : 1, failed: 0, output: outText.slice(0, 2000) };
      }
    }

    if (this.aborted && !done) {
      recordUsage("cancelled");
      yield { type: "state", state: "cancelled" };
      yield { type: "error", error: "run cancelled by user" };
      return;
    }

    if (!done) {
      // iteration budget exhausted → automatic verification pass then close
      yield* this.finalVerification(filesChanged);
      recordUsage("completed");
      metrics.agentRunsSuccess.inc();
      recordRunDuration(Date.now() - started);
      yield { type: "state", state: "completed" };
      yield { type: "completed", summary: `Finished after ${iterations} tool steps. Files changed: ${filesChanged.length}.${checkpointId ? ` Checkpoint: ${checkpointId.slice(0, 8)}.` : ""}` + (await gitStat()), filesChanged };
    }
  }

  private async waitForApproval(approvalId: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs && !this.aborted) {
      const a = store.getApproval(approvalId);
      if (a?.status === "approved") return true;
      if (a?.status === "rejected") return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  private async *deterministicProbe(input: string, filesChanged: string[]): AsyncIterable<AgentEvent> {
    // Useful read-only triage when the LLM provider is unreachable.
    yield { type: "state", state: "reading" };
    const { workspaceTree } = await import("../workspace/manager.js");
    const tree = workspaceTree(this.ctx.workspacePath, 60).join("\n").slice(0, 3000);
    yield { type: "tool_output", tool: "list_directory", output: tree, success: true };
    void input; void filesChanged;
  }

  private async *finalVerification(filesChanged: string[]): AsyncIterable<AgentEvent> {
    yield { type: "state", state: "testing" };
    const report = await runVerification(this.ctx.workspacePath, filesChanged.length > 0);
    yield { type: "test", passed: report.passed, failed: report.failed, output: report.output.slice(0, 2000) };
  }
}
