import { detectProjectProfile } from "../workspace/manager.js";
import { execCommand } from "../tools/shell.js";

export interface VerificationReport { passed: number; failed: number; output: string; steps: Array<{ name: string; ok: boolean; output: string }> }

/** Automatic verification: format → typecheck → lint → test → build, adapted to the project. */
export async function runVerification(workspacePath: string, hasChanges: boolean): Promise<VerificationReport> {
  const profile = detectProjectProfile(workspacePath);
  const steps: VerificationReport["steps"] = [];
  let passed = 0; let failed = 0;
  const run = async (name: string, cmd: string | undefined) => {
    if (!cmd) return;
    const r = await execCommand(cmd, { cwd: workspacePath, timeoutMs: 300_000 });
    const okStep = r.success;
    if (okStep) passed += 1; else failed += 1;
    steps.push({ name, ok: okStep, output: (r.output ?? r.error ?? "").slice(0, 3000) });
  };
  if (!hasChanges) {
    await run("test", profile.testCommand);
    return { passed, failed, output: steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name}`).join("\n"), steps };
  }
  await run("typecheck", profile.typecheckCommand);
  await run("lint", profile.lintCommand);
  await run("test", profile.testCommand);
  await run("build", profile.buildCommand);
  if (steps.length === 0) {
    // unknown project type: at least confirm git state is readable
    await run("git-status", "git status --short --branch");
  }
  return { passed, failed, output: steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name}\n${s.output.slice(0, 500)}`).join("\n\n"), steps };
}

export function isDone(verification: VerificationReport, criticalErrors: string[]): boolean {
  return verification.failed === 0 && criticalErrors.length === 0;
}
