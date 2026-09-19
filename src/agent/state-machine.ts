import type { AgentState } from "../runtime/types.js";

const TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["thinking", "cancelled"],
  thinking: ["planning", "reading", "executing", "failed", "cancelled", "completed"],
  planning: ["reading", "editing", "executing", "testing", "failed", "cancelled"],
  reading: ["editing", "executing", "testing", "planning", "failed", "cancelled", "completed"],
  editing: ["executing", "testing", "retrying", "failed", "cancelled"],
  executing: ["testing", "reading", "editing", "retrying", "waiting_approval", "failed", "cancelled", "completed"],
  testing: ["retrying", "completed", "failed", "cancelled", "editing"],
  waiting_approval: ["executing", "cancelled", "failed", "retrying"],
  retrying: ["reading", "editing", "executing", "testing", "completed", "failed", "cancelled"],
  completed: ["thinking", "idle"],
  failed: ["thinking", "idle"],
  cancelled: ["idle", "thinking"],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export class AgentStateMachine {
  private state: AgentState = "idle";
  get current(): AgentState { return this.state; }
  transition(to: AgentState): boolean {
    if (!canTransition(this.state, to)) return false;
    this.state = to;
    return true;
  }
  force(to: AgentState): void { this.state = to; }
}
