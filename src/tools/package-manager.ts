import fs from "node:fs";
import path from "node:path";
import { execArgs } from "./shell.js";
import type { ToolResult } from "./types.js";

/** Deterministic package-manager layer: executor picks the real command, not the model. */
export function detectPackageManager(ws: string): string {
  if (fs.existsSync(path.join(ws, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(ws, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(ws, "bun.lockb"))) return "bun";
  if (fs.existsSync(path.join(ws, "package-lock.json"))) return "npm";
  return "npm";
}

export async function runTest(ws: string, override?: string): Promise<ToolResult> {
  if (override) return execArgs("bash", ["-lc", override], ws, 300_000);
  const pm = detectPackageManager(ws);
  const pkgPath = path.join(ws, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) return execArgs("bash", ["-lc", `${pm} test`], ws, 300_000);
    } catch { /* fallthrough */ }
    if (fs.existsSync(path.join(ws, "vitest.config.ts"))) return execArgs("bash", ["-lc", `${pm} exec vitest run`], ws, 300_000);
  }
  if (fs.existsSync(path.join(ws, "pytest.ini")) || fs.existsSync(path.join(ws, "tests"))) {
    const py = await execArgs("pytest", ["-q"], ws, 300_000);
    if (py.success || !(py.error ?? "").includes("not found")) return py;
  }
  if (fs.existsSync(path.join(ws, "Cargo.toml"))) return execArgs("cargo", ["test"], ws, 300_000);
  if (fs.existsSync(path.join(ws, "go.mod"))) return execArgs("go", ["test", "./..."], ws, 300_000);
  return { success: false, error: "no test runner detected for this workspace" };
}

export async function runBuild(ws: string, override?: string): Promise<ToolResult> {
  if (override) return execArgs("bash", ["-lc", override], ws, 300_000);
  const pm = detectPackageManager(ws);
  const pkgPath = path.join(ws, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) return execArgs("bash", ["-lc", `${pm} run build`], ws, 300_000);
    } catch { /* noop */ }
  }
  if (fs.existsSync(path.join(ws, "Cargo.toml"))) return execArgs("cargo", ["build"], ws, 300_000);
  if (fs.existsSync(path.join(ws, "go.mod"))) return execArgs("go", ["build", "./..."], ws, 300_000);
  return { success: false, error: "no build command detected for this workspace" };
}

export async function installDeps(ws: string): Promise<ToolResult> {
  const pm = detectPackageManager(ws);
  const cmd: Record<string, string[]> = {
    npm: ["install"], pnpm: ["install"], yarn: ["install"], bun: ["install"],
  };
  return execArgs(pm, cmd[pm] ?? ["install"], ws, 600_000);
}
