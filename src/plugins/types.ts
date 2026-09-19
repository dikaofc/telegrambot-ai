/** Plugin architecture: third-party tools without core changes. */
export interface PluginContext {
  registerTool(name: string, description: string, schema: Record<string, unknown>, execute: (args: Record<string, unknown>, ctx: { workspacePath: string }) => Promise<{ success: boolean; output?: string; error?: string }>): void;
}

export interface AgentPlugin {
  id: string;
  name: string;
  register(context: PluginContext): Promise<void>;
}

const plugins = new Map<string, AgentPlugin>();

export function registerPlugin(p: AgentPlugin): void { plugins.set(p.id, p); }
export function listPlugins(): AgentPlugin[] { return [...plugins.values()]; }

export async function loadPlugins(ctx: PluginContext,): Promise<void> {
  for (const p of plugins.values()) await p.register(ctx);
}
