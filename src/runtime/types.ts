export type AgentState =
  | "idle" | "thinking" | "planning" | "reading" | "editing"
  | "executing" | "testing" | "waiting_approval" | "retrying"
  | "completed" | "failed" | "cancelled";

export interface PlanStepEvent {
  id: string;
  title: string;
  phase: string;
  status: string;
}

export type AgentEvent =
  | { type: "thinking"; message: string }
  | { type: "planning"; message: string }
  | { type: "plan"; revision: number; label: string; steps: PlanStepEvent[] }
  | { type: "replan"; revision: number; reason: string }
  | { type: "progress"; percent: number; label: string }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "step_done"; stepId: string; title: string }
  | { type: "tool_output"; tool: string; output: string; success: boolean }
  | { type: "file_change"; files: string[] }
  | { type: "command"; command: string; exitCode?: number }
  | { type: "test"; passed: number; failed: number; output: string }
  | { type: "approval_required"; approvalId: string; tool: string; command: string; risk: string; reason: string }
  | { type: "error"; error: string }
  | { type: "completed"; summary: string; filesChanged: string[]; testsPassed?: number }
  | { type: "state"; state: AgentState };

export interface AgentContext {
  sessionId: string;
  runId: string;
  workspacePath: string;
  provider: string;
  model: string;
  userId: string;
  systemPrompt?: string;
}

export interface AgentRuntime {
  initialize(context: AgentContext): Promise<void>;
  run(input: string): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface CLIAdapter {
  id: string;
  detect(): Promise<boolean>;
  parseOutput(output: string): AgentEvent[];
}
