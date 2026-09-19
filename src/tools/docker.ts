import { execArgs } from "./shell.js";
import type { ToolResult } from "./types.js";

export async function dockerAvailable(): Promise<boolean> {
  const r = await execArgs("docker", ["info"], process.cwd(), 10_000);
  return r.success;
}

export async function dockerRun(image: string, cmd: string[], opts: { memory?: string; cpus?: string; workdir?: string; volumes?: string[] } = {}): Promise<ToolResult> {
  const args = ["run", "--rm"];
  if (opts.memory) args.push("--memory", opts.memory);
  if (opts.cpus) args.push("--cpus", opts.cpus);
  if (opts.workdir) args.push("-w", opts.workdir);
  for (const v of opts.volumes ?? []) args.push("-v", v);
  args.push(image, ...cmd);
  return execArgs("docker", args, process.cwd(), 600_000);
}
