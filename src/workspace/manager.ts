import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { store } from "../database/store.js";

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

/** Absolute workspace root, never the filesystem root. */
export function workspaceRoot(): string {
  const env = getEnv();
  const configured = (!env.WORKSPACE_ROOT || env.WORKSPACE_ROOT === "/") ? "./workspaces" : env.WORKSPACE_ROOT;
  return path.resolve(configured);
}

/**
 * Resolve a workspace name (or an absolute path) to a directory *inside* the
 * workspace root. Names are exact — no substring fuzzy matching, which would
 * silently resolve to the wrong workspace. Anything that escapes the root
 * ("../..", "/etc", a symlinked-out dir) is rejected, because the workspace
 * boundary is what isolates one user's files from the rest of the host.
 */
export function resolveWorkspacePath(nameOrPath: string): string {
  const root = workspaceRoot();
  const raw = String(nameOrPath ?? "").trim();
  if (!raw) throw new Error("workspace name required");
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new Error(`workspace escape denied: ${raw} is outside ${root}`);
  }
  fs.mkdirSync(candidate, { recursive: true });
  // Second pass on real paths so a symlink inside the root cannot point out of it
  // (compare realpaths, otherwise /var → /private/var breaks macOS).
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(candidate);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`workspace escape denied: ${raw} resolves outside ${root}`);
  }
  return candidate;
}

export function listWorkspaces(): string[] {
  const env = getEnv();
  // Never scan filesystem root — that would list /bin, /etc, etc.
  if (!env.WORKSPACE_ROOT || env.WORKSPACE_ROOT === "/") return [];
  try {
    return fs.readdirSync(workspaceRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch { return []; }
}

export function assertInsideWorkspace(wsPath: string, target: string): string {
  const resolved = path.resolve(wsPath, target);
  const base = path.resolve(wsPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
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

/** Ensure workspace root + default dir exist. Call store.ensureWorkspace separately to register in DB. */
export function ensureWorkspaceDirs(): string {
  const root = workspaceRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* noop */ }
  try { fs.mkdirSync(path.join(root, "default"), { recursive: true }); } catch { /* noop */ }
  return root;
}

/** Register every filesystem workspace in DB so dashboard/TUI never look empty. */
export function syncFilesystemWorkspaces(userId?: string): string[] {
  ensureWorkspaceDirs();
  const done: string[] = [];
  try {
    const names = listWorkspaces();
    for (const name of (names.length ? names : ["default"])) {
      try { store.ensureWorkspace(name, resolveWorkspacePath(name), userId); done.push(name); } catch { /* noop */ }
    }
  } catch { /* non-fatal */ }
  return done;
}
