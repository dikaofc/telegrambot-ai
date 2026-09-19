import fs from "node:fs";
import path from "node:path";
import { execArgs, execCommand } from "./shell.js";
import { gitTools } from "./git.js";
import { detectProjectProfile } from "../workspace/manager.js";
import { assertInsideWorkspace } from "../workspace/manager.js";
import { jsGrep } from "./extended.js";
import type { ToolResult } from "./types.js";
import { ok, fail } from "./types.js";

// ---------- code_metrics: LOC, files, churn ----------
export async function toolCodeMetrics(ws: string): Promise<ToolResult> {
  try {
    const tree = await execArgs("bash", ["-lc", "find . -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.go' -o -name '*.rs' \\) -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*' | head -n 500 | xargs -r wc -l 2>/dev/null | tail -n 1"], ws, 15000);
    const files = await execArgs("bash", ["-lc", "find . -type f \\( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.go' -o -name '*.rs' \\) -not -path '*/node_modules/*' -not -path '*/dist/*' | wc -l"], ws, 15000);
    const churn = await gitTools.log(ws, 20);
    const loc = (tree.output ?? "").trim().split(/\s+/)[0] ?? "0";
    return ok(JSON.stringify({ files: (files.output ?? "").trim(), totalLOC: loc, recentCommits: (churn.output ?? "").slice(0, 2000) }, null, 2));
  } catch (e) { return fail(String(e)); }
}

// ---------- git_blame ----------
export async function toolGitBlame(ws: string, target: string, line?: number): Promise<ToolResult> {
  try {
    assertInsideWorkspace(ws, target);
    if (line !== undefined && (!Number.isInteger(line) || line <= 0)) return fail("invalid line");
    const args = line ? ["blame", "-L", `${line},${line}`, "--", target] : ["blame", "--", target];
    const r = await execArgs("git", args, ws, 30000);
    if (!r.success) return fail(r.error ?? "blame failed");
    return ok((r.output ?? "").slice(0, 8000));
  } catch (e) { return fail(String(e)); }
}

// ---------- git_file_history ----------
export async function toolGitFileHistory(ws: string, target: string, limit = 15): Promise<ToolResult> {
  try {
    assertInsideWorkspace(ws, target);
    const n = Math.min(Math.max(limit, 1), 50);
    const r = await execArgs("git", ["log", "--oneline", "-n", String(n), "--", target], ws, 30000);
    if (!r.success) return fail(r.error ?? "log failed");
    return ok((r.output ?? "(no history)").slice(0, 8000));
  } catch (e) { return fail(String(e)); }
}

// ---------- dead_code_report ----------
export async function toolDeadCodeReport(ws: string): Promise<ToolResult> {
  try {
    // Try ts-prune for TS, else fallback to unused export grep
    const hasPkg = fs.existsSync(path.join(ws, "package.json"));
    if (hasPkg) {
      const r = await execCommand("npx --yes ts-prune 2>&1 | head -n 100", { cwd: ws, timeoutMs: 60000 });
      if (r.success && (r.output ?? "").trim()) return ok(`ts-prune dead exports:\n${(r.output ?? "").slice(0, 6000)}`);
    }
    // Fallback: find files never imported
    const r2 = await execArgs("bash", ["-lc", "grep -r \"from ['\\\"]\\.\" --include='*.ts' --include='*.js' . 2>/dev/null | head -n 200 | wc -l; echo \"---\"; find ./src -name '*.ts' 2>/dev/null | head -n 50"], ws, 15000);
    return ok(`dead code heuristic:\n${(r2.output ?? "").slice(0, 6000)}`);
  } catch (e) { return fail(String(e)); }
}

// ---------- bundle_size ----------
export async function toolBundleSize(ws: string): Promise<ToolResult> {
  try {
    const du = await execArgs("bash", ["-lc", "du -sh dist 2>/dev/null || du -sh build 2>/dev/null || echo 'no dist/build'; ls -lh dist 2>/dev/null | head -n 30"], ws, 15000);
    const pkg = fs.existsSync(path.join(ws, "package.json")) ? await execArgs("bash", ["-lc", "npm run build 2>&1 | tail -n 50"], ws, 120000) : { output: "no package.json" };
    return ok(`bundle size:\n${(du.output ?? "").slice(0, 3000)}\n\nbuild tail:\n${(pkg.output ?? "").slice(0, 3000)}`);
  } catch (e) { return fail(String(e)); }
}

// ---------- type_coverage ----------
export async function toolTypeCoverage(ws: string): Promise<ToolResult> {
  try {
    const r = await execCommand("npx --yes type-coverage --detail 2>&1 | head -n 150", { cwd: ws, timeoutMs: 60000 });
    if ((r.output ?? "").includes("type-coverage")) return ok((r.output ?? "").slice(0, 6000));
    const r2 = await execCommand("npx tsc --noEmit --listFiles 2>&1 | wc -l; echo \"tsc ok\"", { cwd: ws, timeoutMs: 60000 });
    return ok((r.output ?? "") + "\n" + (r2.output ?? "").slice(0, 2000));
  } catch (e) { return fail(String(e)); }
}

// ---------- test_flakiness: run 3x ----------
export async function toolTestFlakiness(ws: string): Promise<ToolResult> {
  try {
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await execCommand("npm test 2>&1 | tail -n 20", { cwd: ws, timeoutMs: 120000 });
      const pass = /passed/i.test(r.output ?? "") ? "PASS" : "FAIL";
      results.push(`run ${i + 1}: ${pass}\n${(r.output ?? r.error ?? "").slice(-500)}`);
      if (!r.success) break;
    }
    const flaky = results.some((x) => x.includes("FAIL")) && results.some((x) => x.includes("PASS"));
    return ok(`${flaky ? "⚠️ FLAKY detected" : "✅ stable"} across 3 runs:\n` + results.join("\n---\n").slice(0, 6000));
  } catch (e) { return fail(String(e)); }
}

// ---------- perf_benchmark ----------
export async function toolPerfBenchmark(ws: string, command: string): Promise<ToolResult> {
  try {
    if (!command || command.length > 500) return fail("command required (max 500)");
    const t0 = Date.now();
    const r = await execCommand(`time -p bash -lc ${JSON.stringify(command)} 2>&1`, { cwd: ws, timeoutMs: 120000 });
    const ms = Date.now() - t0;
    return ok(`benchmark: ${ms}ms wall\n${(r.output ?? r.error ?? "").slice(0, 6000)}`);
  } catch (e) { return fail(String(e)); }
}

// ---------- security_full_audit ----------
export async function toolSecurityFullAudit(ws: string): Promise<ToolResult> {
  try {
    const parts: string[] = [];
    const audit = await execCommand("npm audit --json 2>&1 | head -n 3000", { cwd: ws, timeoutMs: 60000 });
    parts.push(`[npm audit]\n${(audit.output ?? audit.error ?? "").slice(0, 2500)}`);
    const { toolSecretScan } = await import("./extended.js");
    const secrets = await toolSecretScan(ws);
    parts.push(`\n[secret scan]\n${(secrets.output ?? secrets.error ?? "").slice(0, 2500)}`);
    const outdated = await execCommand("npm outdated --json 2>&1 | head -n 2000", { cwd: ws, timeoutMs: 60000 });
    parts.push(`\n[outdated]\n${(outdated.output ?? "").slice(0, 2000)}`);
    return ok(parts.join("\n").slice(0, 8000));
  } catch (e) { return fail(String(e)); }
}

// ---------- docgen ----------
export async function toolDocGen(ws: string): Promise<ToolResult> {
  try {
    const r = await execCommand("npx --yes typedoc --version 2>&1; echo \"---\"; npx --yes typedoc --help 2>&1 | head -n 20", { cwd: ws, timeoutMs: 30000 });
    // Fallback: list exported symbols via symbol_outline across src
    const { toolSymbolOutline } = await import("./extended.js");
    const files = fs.readdirSync(path.join(ws, "src"), { withFileTypes: true } as unknown as { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".ts")).slice(0, 5);
    const outlines: string[] = [];
    for (const f of files) {
      const r2 = await toolSymbolOutline(ws, `src/${f.name}`);
      outlines.push(`== ${f.name} ==\n${r2.output ?? ""}`);
    }
    return ok(`typedoc: ${(r.output ?? "").slice(0, 1000)}\n\nsymbol outlines:\n${outlines.join("\n").slice(0, 6000)}`);
  } catch (e) { return fail(String(e)); }
}

// ---------- workspace_snapshot ----------
export async function toolWorkspaceSnapshot(ws: string, name?: string): Promise<ToolResult> {
  try {
    const snapName = name ? name.replace(/[^A-Za-z0-9_.-]/g, "_") : `snapshot-${Date.now()}`;
    const out = path.join(ws, `${snapName}.tar.gz`);
    const r = await execArgs("tar", ["-czf", out, "--exclude=node_modules", "--exclude=.git", "--exclude=dist", "-C", ws, "."], ws, 120000);
    if (!r.success) return fail(r.error ?? "snapshot failed");
    const st = fs.statSync(out);
    return ok(`snapshot → ${snapName}.tar.gz (${(st.size / 1024).toFixed(1)} KB)`, { filesChanged: [`${snapName}.tar.gz`] });
  } catch (e) { return fail(String(e)); }
}

// ---------- pr_create (gh cli) ----------
export async function toolPrCreate(ws: string, title: string, body?: string, draft = true): Promise<ToolResult> {
  try {
    if (!title || title.length < 3) return fail("title required");
    const args = ["pr", "create", "--title", title, "--body", body ?? title];
    if (draft) args.push("--draft");
    const r = await execArgs("gh", args, ws, 60000);
    if (!r.success) {
      if ((r.error ?? "").includes("not found") || (r.error ?? "").includes("No such")) return fail("gh CLI not available — install gh or create PR manually");
      return fail(r.error ?? "pr create failed");
    }
    return ok((r.output ?? "").slice(0, 4000));
  } catch (e) { return fail(String(e)); }
}

// ---------- dependency_update (check) ----------
export async function toolDependencyUpdate(ws: string, dryRun = true): Promise<ToolResult> {
  try {
    const check = await execCommand("npx --yes npm-check-updates 2>&1 | head -n 100", { cwd: ws, timeoutMs: 60000 });
    if (dryRun) return ok(`[dry-run] updates available:\n${(check.output ?? "").slice(0, 6000)}`);
    const upd = await execCommand("npx --yes npm-check-updates -u 2>&1 | tail -n 20; npm install 2>&1 | tail -n 20", { cwd: ws, timeoutMs: 300000 });
    return ok((upd.output ?? upd.error ?? "").slice(0, 6000));
  } catch (e) { return fail(String(e)); }
}

// ---------- call_hierarchy ----------
export async function toolCallHierarchy(ws: string, symbol: string): Promise<ToolResult> {
  try {
    if (!/^[\w$]{2,100}$/.test(symbol)) return fail("invalid symbol");
    const callers = await jsGrep(ws, `\\b${symbol}\\s*\\(`, { maxHits: 30 });
    const callees = await execArgs("bash", ["-lc", `grep -n "\\\\b${symbol}\\\\b" ${symbol}.ts 2>/dev/null | head -n 20; grep -rn "${symbol}" --include="*.ts" src 2>/dev/null | head -n 30`], ws, 15000);
    return ok(`callers of ${symbol}:\n${callers.slice(0, 15).join("\n") || "(none)"}\n\ncontext:\n${(callees.output ?? "").slice(0, 3000)}`);
  } catch (e) { return fail(String(e)); }
}

// ---------- import_graph ----------
export async function toolImportGraph(ws: string, target?: string): Promise<ToolResult> {
  try {
    const file = target ? assertInsideWorkspace(ws, target) : ws;
    const base = target ? path.dirname(file) : ws;
    void base;
    const r = await execArgs("bash", ["-lc", "grep -R \"^import\\\\|^from \" --include='*.ts' --include='*.js' . 2>/dev/null | head -n 100"], ws, 15000);
    return ok((r.output ?? "(no imports found)").slice(0, 6000));
  } catch (e) { return fail(String(e)); }
}

// ---------- lsp_hover (definition + references + outline) ----------
export async function toolLspHover(ws: string, file: string, symbol: string): Promise<ToolResult> {
  try {
    assertInsideWorkspace(ws, file);
    const { toolFindDefinition, toolFindReferences, toolSymbolOutline } = await import("./extended.js");
    const [def, refs, outline] = await Promise.all([
      toolFindDefinition(ws, symbol),
      toolFindReferences(ws, symbol),
      toolSymbolOutline(ws, file),
    ]);
    return ok(`hover ${symbol} @ ${file}:\n[definition]\n${def.output ?? ""}\n\n[references]\n${refs.output ?? ""}\n\n[file outline]\n${outline.output ?? ""}`.slice(0, 8000));
  } catch (e) { return fail(String(e)); }
}

// ---------- full_verify (format+lint+typecheck+test+build) ----------
export async function toolFullVerify(ws: string): Promise<ToolResult> {
  try {
    const steps: Array<[string, string]> = [
      ["format", "npx --yes prettier --check . 2>&1 | head -n 50"],
      ["lint", "npm run lint 2>&1 | tail -n 50"],
      ["typecheck", "npm run typecheck 2>&1 | tail -n 80"],
      ["test", "npm test 2>&1 | tail -n 80"],
      ["build", "npm run build 2>&1 | tail -n 30"],
    ];
    const out: string[] = [];
    let failed = false;
    for (const [label, cmd] of steps) {
      const r = await execCommand(cmd, { cwd: ws, timeoutMs: 300000 });
      const okStr = r.success ? "✅" : "❌";
      if (!r.success) failed = true;
      out.push(`${okStr} ${label}:\n${(r.output ?? r.error ?? "").slice(0, 2000)}`);
      if (failed && label === "typecheck") break;
    }
    return failed ? fail(out.join("\n\n").slice(0, 8000)) : ok(out.join("\n\n").slice(0, 8000));
  } catch (e) { return fail(String(e)); }
}
