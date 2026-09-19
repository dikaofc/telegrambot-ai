import fs from "node:fs";
import path from "node:path";
import { execArgs } from "./shell.js";
import type { ToolResult } from "./types.js";
import { ok, fail } from "./types.js";

export async function globFiles(ws: string, pattern: string, max = 100): Promise<ToolResult> {
  // lightweight glob: support **, *, ? without extra deps
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*").replace(/\?/g, "[^/]");
  const re = new RegExp(`^${escaped}$`);
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(ws, full).replace(/\\/g, "/");
      if (e.isDirectory()) walk(full);
      else if (re.test(rel) || re.test(e.name)) { out.push(rel); if (out.length >= max) return; }
    }
  };
  try { walk(ws); return ok(out.join("\n")); } catch (e) { return fail(String(e)); }
}

export async function grepCode(ws: string, pattern: string, include = "*.{ts,js,py,go,rs,java}", max = 50): Promise<ToolResult> {
  try {
    const r = await execArgs("grep", ["-rn", "--include=" + include.replace(/^\*\./, "*.").split(",").flatMap((g) => g.trim() ? [`--include=${g.trim()}`] : []).length ? pattern : pattern, "-e", pattern, "."], ws, 30_000);
    // simpler: use rg if present else grep
    if (!r.success && /invalid|unrecognized/i.test(r.error ?? "")) {
      const r2 = await execArgs("grep", ["-rn", "-e", pattern, "."], ws, 30_000);
      if (!r2.success) return r2;
      return ok((r2.output ?? "").split("\n").slice(0, max).join("\n"));
    }
    void include;
    return ok((r.output ?? r.error ?? "").split("\n").slice(0, max).join("\n"));
  } catch (e) { return fail(String(e)); }
}

export async function findFiles(ws: string, name: string, max = 50): Promise<ToolResult> {
  const r = await execArgs("find", [".", "-path", "./node_modules", "-prune", "-o", "-path", "./.git", "-prune", "-o", "-name", name, "-print"], ws, 30_000);
  if (!r.success) return r;
  return ok((r.output ?? "").split("\n").filter(Boolean).slice(0, max).join("\n"));
}

export async function searchCode(ws: string, query: string): Promise<ToolResult> {
  // prefer ripgrep when installed
  const rg = await execArgs("rg", ["--no-heading", "--line-number", "-m", "50", query, "."], ws, 30_000);
  if (rg.success && (rg.output ?? "").trim()) return rg;
  return grepCode(ws, query);
}
