import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../config/env.js";
import { store } from "../database/store.js";
import { projectRootDir, publishGraphToWorkspace, isTestEnv } from "../integrations/graphify.js";

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
/** Layout-style exception: the project TeleAgent runs from stays readable by
 * name and — like a mirror symlink pointing at it — through the workspace tree. */
function projectRootAllowed(): string | null {
  try {
    const proj = projectRootDir();
    return proj ? fs.realpathSync(proj) : null;
  } catch { return null; }
}

/**
 * Roots that are explicitly allowed to live outside WORKSPACE_ROOT, from
 * `WORKSPACE_EXTRA_ROOTS` (comma or semicolon separated). This is how a
 * deliberate "mirror another project into the workspace" symlink stays usable
 * without opening the boundary for every symlink a task might drop in here.
 * Entries that do not exist are ignored rather than silently trusted.
 */
export function allowedExtraRoots(): string[] {
  const env = getEnv();
  const roots = String(env.WORKSPACE_EXTRA_ROOTS ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p))
    .filter((p) => {
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    })
    .map((p) => { try { return fs.realpathSync(p); } catch { return p; } });
  return [...new Set(roots)];
}

function insideRoot(real: string, root: string): boolean {
  return real === root || real.startsWith(root + path.sep);
}

/**
 * Before realpath / after realpath forms of every root a workspace may resolve
 * into: the workspace root itself (which may not exist yet on a fresh install),
 * declared extras, and the project TeleAgent runs from.
 */
function allowedRealRoots(): string[] {
  const root = workspaceRoot();
  const roots = [path.resolve(root)];
  try { roots.push(fs.realpathSync(root)); } catch { /* not created yet */ }
  roots.push(...allowedExtraRoots());
  const proj = projectRootAllowed();
  if (proj) roots.push(proj);
  return [...new Set(roots)];
}

export function resolveWorkspacePath(nameOrPath: string): string {
  const root = workspaceRoot();
  const raw = String(nameOrPath ?? "").trim();
  if (!raw) throw new Error("workspace name required");
  // The project itself is addressable by its directory name: users mean the
  // repo (e.g. /workspace telegrambot-ai), not an empty same-named folder.
  // Explicit, documented exception to the root boundary below.
  try {
    const proj = projectRootDir();
    if (proj && raw === path.basename(proj)) return proj;
  } catch { /* fall through to normal resolution */ }
  // An allowlisted outside root is addressable by its directory name too.
  if (!path.isAbsolute(raw)) {
    const named = allowedExtraRoots().find((r) => path.basename(r) === raw);
    if (named) return named;
  }
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const allowed = allowedRealRoots();
  if (!allowed.some((r) => insideRoot(candidate, r))) {
    throw new Error(`workspace escape denied: ${raw} is outside ${root} (mirror yang memang dipakai bisa diizinkan lewat WORKSPACE_EXTRA_ROOTS)`);
  }
  fs.mkdirSync(candidate, { recursive: true });
  // Second pass on real paths so a symlink inside the root cannot point out of it
  // (compare realpaths, otherwise /var → /private/var breaks macOS).
  const real = fs.realpathSync(candidate);
  if (!allowed.some((r) => insideRoot(real, r))) {
    throw new Error(`workspace escape denied: ${raw} resolves outside ${root} (kalau ini mirror project yang memang dipakai, tambahkan root-nya ke WORKSPACE_EXTRA_ROOTS)`);
  }
  return candidate;
}

/**
 * Symlinked directories directly inside a workspace. These are normally mirrors
 * of a project that lives elsewhere; report whether the configuration actually
 * allows reading through them, so "project saya ada di workspace tapi agent
 * tidak bisa lihat" is answerable on screen.
 */
export function workspaceMirrors(workspacePath: string): Array<{ name: string; target: string; allowed: boolean }> {
  const allowed = allowedRealRoots();
  const out: Array<{ name: string; target: string; allowed: boolean }> = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(workspacePath, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    const full = path.join(workspacePath, e.name);
    let real: string;
    try { real = fs.realpathSync(full); } catch { continue; }
    try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
    out.push({ name: e.name, target: real, allowed: allowed.some((r) => insideRoot(real, r)) });
  }
  return out;
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
  // Publish the canonical project graph into `default` (fire-and-forget):
  // the extractor cannot follow the telegrambot-ai symlink, so without this
  // the default workspace graph would only ever contain dika.js.
  if (!isTestEnv()) {
    try {
      const root = projectRootDir();
      if (root) void publishGraphToWorkspace(root, resolveWorkspacePath("default")).catch(() => { /* best-effort */ });
    } catch { /* non-fatal */ }
  }
  return done;
}
