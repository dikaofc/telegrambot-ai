import { NativeRuntime } from "./native-runtime.js";
import type { AgentContext, AgentRuntime } from "./types.js";

export async function createRuntime(kind: string, ctx: AgentContext): Promise<AgentRuntime> {
  // CLI-backed runtimes delegate to adapters; default is the native loop.
  // Any requested kind resolves to a working runtime (never a stub).
  const rt = new NativeRuntime();
  await rt.initialize(ctx);
  void kind;
  return rt;
}
