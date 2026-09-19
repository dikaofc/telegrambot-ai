import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  git?: { branch?: string; dirty?: boolean; lastCommit?: string };
  profile?: ProjectProfile;
}

export interface ProjectProfile {
  language?: string;
  framework?: string;
  packageManager?: string;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
}

export function resolveWorkspacePath(nameOrPath: string): string {
  const env = getEnv();
  if (path.isAbsolute(nameOrPath) && fs.existsSync(nameOrPath)) return path.resolve(nameOrPath);
  const candidate = path.resolve(env.WORKSPACE_ROOT, nameOrPath);
  if (fs.existsSync(candidate)) return candidate;
  // fuzzy: find directory containing the query
  try {
    const entries = fs.readdirSync(env.WORKSPACE_ROOT, { withFileTypes: true });
    const q = nameOrPath.toLowerCase();
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase().includes(q));
    if (hit) return path.join(env.WORKSPACE_ROOT, hit.name);
  } catch { /* root may not exist yet */ }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

export function listWorkspaces(): string[] {
  const env = getEnv();
  try {
    return fs.readdirSync(env.WORKSPACE_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return []; }
}

export function assertInsideWorkspace(workspaceRoot: string, target: string): string {
  const resolved = path.resolve(workspaceRoot, target);
  const root = path.resolve(workspaceRoot) + path.sep;
  if (!resolved.startsWith(root) && resolved !== path.resolve(workspaceRoot)) {
    throw new Error(`filesystem boundary violation: ${target}`);
  }
  return resolved;
}

export function detectProjectProfile(workspacePath: string): ProjectProfile {
  const p: ProjectProfile = {};
  const has = (f: string) => fs.existsSync(path.join(workspacePath, f));
  const readJson = (f: string): Record<string, unknown> | null => {
    try { return JSON.parse(fs.readFileSync(path.join(workspacePath, f), "utf8")) as Record<string, unknown>; }
    catch { return null; }
  };
  if (has("package.json")) {
    const pkg = readJson("package.json") ?? {};
    const deps = { ...((pkg.dependencies as object) ?? {}), ...((pkg.devDependencies as object) ?? {}) };
    p.language = (pkg as { language?: string }).language ?? "typescript";
    if ("next" in deps) p.framework = "next.js";
    else if ("react" in deps) p.framework = "react";
    else if ("vue" in deps) p.framework = "vue";
    else if ("express" in deps || "fastify" in deps) p.framework = "node-server";
    if (has("pnpm-lock.yaml")) p.packageManager = "pnpm";
    else if (has("yarn.lock")) p.packageManager = "yarn";
    else if (has("bun.lockb")) p.packageManager = "bun";
    else p.packageManager = "npm";
    const scripts = (pkg.scripts as Record<string, string>) ?? {};
    p.testCommand = scripts.test ? `${p.packageManager} test` : has("vitest.config.ts") ? `${p.packageManager} exec vitest run` : undefined;
    p.buildCommand = scripts.build ? `${p.packageManager} run build` : undefined;
    p.lintCommand = scripts.lint ? `${p.packageManager} run lint` : undefined;
    p.typecheckCommand = scripts.typecheck ? `${p.packageManager} run typecheck` : undefined;
  } else if (has("pyproject.toml") || has("requirements.txt")) {
    p.language = "python";
    p.packageManager = "pip";
    if (has("pytest.ini") || has("tests")) p.testCommand = "pytest";
    p.buildCommand = undefined;
  } else if (has("Cargo.toml")) {
    p.language = "rust"; p.packageManager = "cargo"; p.testCommand = "cargo test"; p.buildCommand = "cargo build";
  } else if (has("go.mod")) {
    p.language = "go"; p.packageManager = "go"; p.testCommand = "go test ./..."; p.buildCommand = "go build ./...";
  } else if (has("pom.xml")) {
    p.language = "java"; p.packageManager = "maven"; p.testCommand = "mvn test"; p.buildCommand = "mvn package";
  } else if (has("build.gradle")) {
    p.language = "java"; p.packageManager = "gradle"; p.testCommand = "./gradlew test"; p.buildCommand = "./gradlew build";
  } else if (has("composer.json")) {
    p.language = "php"; p.packageManager = "composer";
  }
  return p;
}

export function workspaceTree(workspacePath: string, maxEntries = 200): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (out.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      out.push(prefix + e.name);
      if (out.length >= maxEntries) return;
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + "/");
    }
  };
  walk(workspacePath, "");
  return out;
}
