export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  metadata?: {
    duration?: number;
    exitCode?: number;
    filesChanged?: string[];
  };
}

export interface ToolContext {
  workspacePath: string;
  runId?: string;
  sessionId?: string;
  userId?: string;
  timeoutMs?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(output = "", metadata?: ToolResult["metadata"]): ToolResult {
  return { success: true, output, metadata };
}

export function fail(error: string, metadata?: ToolResult["metadata"]): ToolResult {
  return { success: false, error, metadata };
}
