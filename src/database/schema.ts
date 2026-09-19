export const SCHEMA_TABLES = [
  "users", "chats", "sessions", "messages", "agent_runs",
  "tool_calls", "approvals", "workspaces", "providers",
  "models", "settings", "usage", "audit_logs", "processed_updates",
  "checkpoints", "memory",
] as const;

export interface SessionRow {
  id: string; user_id: string; chat_id: string; workspace_id: string;
  provider: string; model: string; runtime: string; status: string;
  created_at?: string; updated_at?: string;
}
export interface MessageRow {
  id: string; session_id: string; role: string; content: string; created_at?: string;
}
export interface AgentRunRow {
  id: string; session_id: string; input: string; status: string;
  started_at?: string; finished_at?: string; tokens_input?: number; tokens_output?: number;
}
export interface ToolCallRow {
  id: string; run_id: string; tool: string; args_hash: string; risk: string;
  approval?: string; success?: number; exit_code?: number; duration_ms?: number; created_at?: string;
}
export interface ApprovalRow {
  id: string; run_id: string; tool: string; command: string; risk: string; status: string; created_at?: string;
}
