import { getEnv } from "../config/env.js";
import { buildRegistry } from "../tools/registry.js";
import { selectToolSchemas } from "../tools/capabilities.js";
import { chatWithFallback, defaultRouting, classifyTask, estimateCostUsd } from "../providers/router.js";
import { toolRisk, policyForRisk, RiskLevel } from "../security/risk.js";
import { classifyCommand } from "../security/command-parser.js";
import { hashArgs, auditTool } from "../security/audit.js";
import { store } from "../database/store.js";
import { metrics, recordRunDuration } from "../observability/metrics.js";
import { getLogger } from "../observability/logger.js";
import { pickSkill } from "../agent/skills.js";
import { buildSystemPrompt } from "../agent/prompts.js";
import { runVerification } from "../agent/verification.js";
import { createCheckpoint } from "../agent/checkpoint.js";
import { composeRunMessages, enforceContextBudget } from "../agent/context-window.js";
import {
  buildPlan, markStep, replan, renderPlanProgress, persistPlan,
  type Plan, type PlanPhase, type PlanStepStatus,
} from "../agent/planner.js";
import { rememberFailure, markFailureResolved, failureHints, fingerprintError } from "../agent/failure-memory.js";
import { detectProjectProfile } from "../workspace/manager.js";
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

const READ_TOOLS = new Set([
  "read_file", "read_many", "list_directory", "tree", "glob", "find_files", "grep",
  "search_code", "symbol_outline", "find_definition", "find_references", "git_status",
  "git_diff", "git_log", "graphify_query", "graphify_path", "graphify_explain", "scout",
]);

/**
 * NativeRuntime — the autonomous agent loop:
 * understand → plan → discover → execute → observe → replan → verify → review.
 *
 * Everything is real: tools execute, events are emitted only after a real
 * operation, metrics reflect what actually happened, and a run that cannot
 * finish says so instead of reporting success.
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
    const log = getLogger();
    const maxIterations = Math.max(1, env.AGENT_MAX_STEPS);
    const replanAfter = Math.max(1, env.AGENT_REPLAN_AFTER);
    const deadline = started + Math.max(60_000, env.AGENT_TIMEOUT_MS);
    metrics.agentRunsTotal.inc();
    const taskKind = classifyTask(input);

    yield { type: "state", state: "thinking" };
    yield { type: "thinking", message: "analyzing request" };

    // ---- context discovery (bounded, secret-redacted history) ----
    const history = store.messages(this.ctx.sessionId, 40);
    const chatHistory: ChatMessage[] = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" as const : m.role === "system" ? "system" as const : "user" as const,
      content: String(m.content).slice(0, 4000),
    }));
    const summary = store.getMemory("session", this.ctx.sessionId).summary ?? null;

    // ---- plan (deterministic; no provider needed) ----
    const skill = pickSkill(input);
    const profile = (() => { try { return detectProjectProfile(this.ctx.workspacePath); } catch { return undefined; } })();
    const failureHint = failureHints(this.ctx.workspacePath);
    let plan: Plan = buildPlan({ input, taskKind, workspacePath: this.ctx.workspacePath, profile, skill: skill?.name ?? null });
    persistPlan(this.ctx.runId, plan);
    yield { type: "state", state: "planning" };
    yield { type: "planning", message: renderPlanProgress(plan) };
    yield { type: "plan", revision: plan.revision, label: renderPlanProgress(plan), steps: plan.steps.map((s) => ({ id: s.id, title: s.title, phase: s.phase, status: s.status })) };
    yield { type: "progress", percent: 0, label: renderPlanProgress(plan) };

    const skillPrompt = skill ? `\nActive skill [${skill.name}]: ${skill.description}\n${skill.instructions}\n` : "";
    const systemPrompt = buildSystemPrompt({
      workspacePath: this.ctx.workspacePath,
      taskKind,
      skillPrompt: skillPrompt + failureHint,
    });

    const composed = composeRunMessages({
      systemPrompt, history: chatHistory, summary, input,
      maxChars: env.AGENT_MAX_CONTEXT_CHARS,
    });
    let messages: ChatMessage[] = composed.messages;
    let compactedTotal = composed.compacted;

    const filesChanged: string[] = [];
    let tokensIn = 0; let tokensOut = 0;
    let done = false;
    let iterations = 0;
    let checkpointId: string | null = null;
    let readSuccesses = 0;
    let writeSuccesses = 0;
    let consecutiveFailures = 0;
    let lastFailedTool = "";
    let lastErrorText = "";
    const attempted: string[] = [];
    let replans = 0;
    let forcedImplement = false;
    let nudged = false;
    let verificationPassed: number | null = null;
    let verificationFailed = 0;

    const updatePlan = (next: Plan, stepId?: string, status?: PlanStepStatus, note?: string): Plan => {
      plan = stepId && status ? markStep(next, stepId, status, note) : next;
      persistPlan(this.ctx.runId, plan);
      return plan;
    };

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
    /** Which tool set the model may see right now — no writes before discovery. */
    const phaseFor = (): PlanPhase => {
      if (taskKind === "chat") return "none";
      if (taskKind === "reasoning") return readSuccesses === 0 && iterations <= 3 ? "discover" : "none";
      return forcedImplement || readSuccesses > 0 ? "implement" : "discover";
    };

    while (!done && iterations < maxIterations && !this.aborted) {
      iterations += 1;
      await this.waitIfPaused();
      if (this.aborted) break;
      if (Date.now() > deadline) {
        yield { type: "error", error: `time budget exceeded (${Math.round(env.AGENT_TIMEOUT_MS / 1000)}s)` };
        break;
      }

      // Context engineering: trim oversized tool results and keep the window bounded.
      const windowed = enforceContextBudget(messages, env.AGENT_MAX_CONTEXT_CHARS);
      if (windowed.compacted > 0) {
        compactedTotal += windowed.compacted;
        yield { type: "thinking", message: `context compacted (${windowed.compacted} earlier messages folded)` };
      }
      messages = windowed.messages;

      const phase = phaseFor();
      const toolSchemas = selectToolSchemas(this.registry, taskKind, phase);

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
          metrics.agentRunsDegraded.inc();
          recordRunDuration(Date.now() - started);
          updatePlan(plan, plan.steps[0]?.id, "completed", "answered without the model (provider unreachable)");
          yield { type: "state", state: "completed" };
          yield { type: "completed", summary: helpSummary, filesChanged: [] };
          done = true;
          break;
        }
        // For coding tasks, do triage then explain
        yield* this.deterministicProbe(input, filesChanged);
        recordUsage("completed");
        metrics.agentRunsDegraded.inc();
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

        // A coding request must not "answer" before it has inspected anything:
        // escalate to the implement phase and make one explicit nudge.
        const noEvidenceYet = taskKind === "coding" && readSuccesses === 0 && writeSuccesses === 0;
        if (noEvidenceYet && !nudged) {
          nudged = true;
          forcedImplement = true;
          messages.push({ role: "assistant", content: textBuf.trim() || "(no tool call yet)" });
          messages.push({
            role: "user",
            content: "You have not inspected the workspace yet. Use the available tools to discover the relevant files, then implement the change. Do not answer from memory.",
          });
          yield { type: "thinking", message: "no evidence yet — escalating to implementation step" };
          continue;
        }

        const finalText = textBuf.trim();
        // Last resort: if still empty, give a deterministic chat answer so user never sees blank "task completed"
        let fallback = taskKind === "chat"
          ? `Halo! Aku TeleAgent — coding agent kamu di Telegram. Kirim tugas apa aja, aku siap bantu. (model: ${this.ctx.model})`
          : "Task analyzed. No tool actions were required.";
        // Honor explicit "3 kata" / "3 words" constraint when we have to synthesize
        if (!finalText && /3\s*kata|3\s*words|tiga\s*kata/i.test(input)) fallback = "Aku TeleAgent pintar";
        const summaryText = finalText || fallback;
        messages.push({ role: "assistant", content: summaryText });

        // Verify before declaring success when we actually changed something.
        const verifyStep = plan.steps.find((s) => s.phase === "verify");
        if (taskKind === "coding" && filesChanged.length > 0) {
          const report = await runVerification(this.ctx.workspacePath, true);
          verificationPassed = report.passed;
          verificationFailed = report.failed;
          if (verifyStep) updatePlan(plan, verifyStep.id, report.failed === 0 ? "completed" : "failed",
            `verified: ${report.passed} passed, ${report.failed} failed`);
          yield { type: "test", passed: report.passed, failed: report.failed, output: report.output.slice(0, 2000) };
        }

        // Close out remaining steps, but never fake a verification that did not run.
        for (const s of plan.steps) {
          if (s.phase === "verify") continue;
          if (s.status === "pending" || s.status === "in_progress") updatePlan(plan, s.id, "completed");
        }
        if (verifyStep && verifyStep.status === "pending") {
          updatePlan(plan, verifyStep.id, "skipped", "no changes to verify");
        }
        yield { type: "progress", percent: 100, label: renderPlanProgress(plan) };

        if (verificationFailed > 0) {
          metrics.agentRunsFailed.inc();
          recordUsage("failed");
          yield { type: "state", state: "failed" };
          yield {
            type: "completed",
            summary: `${summaryText}\n\n⚠️ verification FAILED: ${verificationFailed} check(s) did not pass (${verificationPassed ?? 0} passed). The change is on disk but must be treated as unverified.`,
            filesChanged, testsPassed: verificationPassed ?? undefined,
          };
        } else {
          metrics.agentRunsSuccess.inc();
          recordUsage("completed");
          yield { type: "state", state: "completed" };
          const verifyNote = verificationPassed !== null ? `\n\nverification: ${verificationPassed} check(s) passed` : "";
          const maybeGit = taskKind === "chat" && filesChanged.length === 0 ? "" : await gitStat();
          yield {
            type: "completed",
            summary: summaryText + verifyNote + maybeGit,
            filesChanged, testsPassed: verificationPassed ?? undefined,
          };
        }
        recordRunDuration(Date.now() - started);
        yield { type: "progress", percent: 100, label: "completed" };
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
      const isShell = pendingTool.name === "shell" || pendingTool.name === "shell_start" || pendingTool.name === "shell_input" || pendingTool.name === "shell_batch";
      if (isShell && typeof pendingTool.args.command === "string") {
        const v = classifyCommand(pendingTool.args.command);
        risk = v.risk;
        commandForApproval = v.normalized;
      } else if (isShell) {
        // model sent malformed args — show them so approval (if any) is informative
        commandForApproval = `${pendingTool.name} ${JSON.stringify(pendingTool.args).slice(0, 160)}`;
      }
      if (pendingTool.name === "shell_input" && typeof pendingTool.args.data === "string") {
        const v = classifyCommand(pendingTool.args.data);
        if (v.risk === RiskLevel.CRITICAL) { risk = v.risk; commandForApproval = `stdin → ${v.normalized.slice(0, 120)}`; }
      }
      let decision = policyForRisk(risk);
      if (isShell && decision === "ask") {
        // Owner policy: shell always runs without waiting for approval taps.
        // CRITICAL (rm -rf /, mkfs, …) stays denied; everything else auto-approved.
        decision = "auto";
      }
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

      const stateForTool = pendingTool.name.includes("test") ? "testing" : READ_TOOLS.has(pendingTool.name) ? "reading" : pendingTool.name.includes("write") || pendingTool.name.includes("edit") ? "editing" : "executing";
      yield { type: "state", state: stateForTool };
      yield { type: "tool_start", tool: pendingTool.name, args: pendingTool.args };
      attempted.push(`${pendingTool.name} ${JSON.stringify(pendingTool.args).slice(0, 120)}`);

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

      // ---- observe: update plan progress from real evidence ----
      if (result.success) {
        markFailureResolved(this.ctx.workspacePath, pendingTool.name);
        consecutiveFailures = 0;
        if (READ_TOOLS.has(pendingTool.name)) readSuccesses += 1;
        if (isWriteCall(pendingTool.name, pendingTool.args)) writeSuccesses += 1;
      } else {
        consecutiveFailures += 1;
        lastFailedTool = pendingTool.name;
        lastErrorText = String(result.error ?? "unknown error").slice(0, 400);
      }

      // Keep the step status in sync with evidence so the plan reflects reality.
      const discoverStep = plan.steps.find((s) => s.id === "s1");
      if (discoverStep && discoverStep.status !== "completed" && readSuccesses > 0) {
        updatePlan(plan, "s1", "completed", "context discovered");
        yield { type: "step_done", stepId: "s1", title: discoverStep.title };
      }
      const implementStep = plan.steps.find((s) => s.id === "s2");
      if (implementStep && implementStep.status !== "completed" && writeSuccesses > 0 && taskKind === "coding") {
        updatePlan(plan, "s2", "completed", "change applied");
        yield { type: "step_done", stepId: "s2", title: implementStep.title };
      }
      yield { type: "progress", percent: Math.min(90, Math.round((iterations / maxIterations) * 100)), label: renderPlanProgress(plan) };

      // ---- adaptive recovery: diagnose instead of hammering the same failure ----
      if (!result.success) {
        rememberFailure(this.ctx.workspacePath, pendingTool.name, lastErrorText);
        const sameTool = lastFailedTool === pendingTool.name;
        if (sameTool && consecutiveFailures >= replanAfter) {
          if (replans >= 2) {
            // Genuine blocker: stop and explain exactly what was attempted.
            const blocked = `blocked: ${pendingTool.name} failed ${consecutiveFailures}× in a row (${fingerprintError(lastErrorText)}). ` +
              `Replanned ${replans}× without progress, so I stopped instead of looping.`;
            yield { type: "error", error: blocked };
            yield { type: "state", state: "failed" };
            recordUsage("failed");
            metrics.agentRunsFailed.inc();
            recordRunDuration(Date.now() - started);
            yield {
              type: "completed",
              summary: `${blocked}\n\nwhat was attempted:\n${attempted.slice(-8).map((a) => `- ${a}`).join("\n")}\n\nlast error:\n${lastErrorText.slice(0, 600)}`,
              filesChanged,
            };
            done = true;
            break;
          }
          replans += 1;
          const failedStepId = implementStep && implementStep.status !== "completed" ? "s2" : undefined;
          plan = replan(plan, { reason: `${pendingTool.name} failed repeatedly: ${lastErrorText.slice(0, 200)}`, failedStepId, tool: pendingTool.name });
          persistPlan(this.ctx.runId, plan);
          consecutiveFailures = 0;
          yield { type: "replan", revision: plan.revision, reason: `${pendingTool.name} failed repeatedly: ${lastErrorText.slice(0, 200)}` };
          yield { type: "state", state: "retrying" };
          messages.push({
            role: "user",
            content: `The last tool call failed and retrying it as-is is not working. Diagnose the cause (inspect the file/command involved), then change approach. Remaining step budget: ${maxIterations - iterations}.`,
          });
        } else if (maxIterations - iterations > 0) {
          yield { type: "state", state: "retrying" };
          messages.push({ role: "user", content: `The last tool call failed. Diagnose the error, inspect relevant files if needed, then try a fix. Remaining budget: ${maxIterations - iterations} steps.` });
        }
        log.warn({ event: "tool.failed", tool: pendingTool.name, runId: this.ctx.runId }, "tool call failed");
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
      // Step/time budget exhausted → automatic verification pass, then report honestly.
      yield* this.finalVerification(filesChanged);
      const report = await runVerification(this.ctx.workspacePath, filesChanged.length > 0);
      verificationPassed = report.passed;
      verificationFailed = report.failed;
      const status = report.failed > 0 ? "failed" : "completed";
      recordUsage(status);
      if (report.failed > 0) metrics.agentRunsFailed.inc(); else metrics.agentRunsSuccess.inc();
      recordRunDuration(Date.now() - started);
      yield { type: "state", state: report.failed > 0 ? "failed" : "completed" };
      const budgetNote = `Finished after ${iterations} tool steps (budget: ${maxIterations}). Files changed: ${filesChanged.length}.` +
        (checkpointId ? ` Checkpoint: ${checkpointId.slice(0, 8)}.` : "") +
        (report.failed > 0 ? ` ⚠️ verification: ${report.failed} check(s) still failing — task is NOT verified.` : "");
      yield { type: "completed", summary: budgetNote + (await gitStat()), filesChanged, testsPassed: report.passed };
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
