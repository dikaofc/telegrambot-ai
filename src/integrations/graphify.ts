import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolResult } from "../tools/types.js";

const execFileAsync = promisify(execFile);

export const GRAPHIFY_BIN = process.env.GRAPHIFY_BIN ?? "graphify";
export const GRAPHIFY_OUT_DIR = "graphify-out";

let availabilityCache: { at: number; ok: boolean; version?: string } | null = null;

/** Check the real `graphify` CLI (Python, PyPI `graphifyy`). Cached 60s. */
export async function graphifyAvailable(): Promise<{ ok: boolean; version?: string }> {
  if (availabilityCache && Date.now() - availabilityCache.at < 60_000) {
    return { ok: availabilityCache.ok, version: availabilityCache.version };
  }
  try {
    const { stdout } = await execFileAsync(GRAPHIFY_BIN, ["--version"], { timeout: 15_000 });
    availabilityCache = { at: Date.now(), ok: true, version: String(stdout).trim().slice(0, 100) };
  } catch {
    availabilityCache = { at: Date.now(), ok: false };
  }
  return { ok: availabilityCache.ok, version: availabilityCache.version };
}

export function resetGraphifyCache(): void { availabilityCache = null; }

export function installHint(): string {
  return [
    "graphify CLI not found. Install it (Python 3.10+ required):",
    "  uv tool install graphifyy     # recommended",
    "  # or: pipx install graphifyy",
    "Then re-run. Code indexing is fully local (tree-sitter, no API key).",
  ].join("\n");
}

function outDir(workspacePath: string): string {
  return path.join(workspacePath, GRAPHIFY_OUT_DIR);
}

export interface GraphStatus {
  available: boolean;
  version?: string;
  built: boolean;
  graphPath?: string;
  nodes?: number;
  edges?: number;
  sizeBytes?: number;
  reportExists?: boolean;
  htmlExists?: boolean;
}

/** Real status: probes the binary + parses graphify-out/graph.json when present. */
export async function graphStatus(workspacePath: string): Promise<GraphStatus> {
  const avail = await graphifyAvailable();
  const graphPath = path.join(outDir(workspacePath), "graph.json");
  if (!fs.existsSync(graphPath)) {
    return { available: avail.ok, version: avail.version, built: false };
  }
  try {
    const st = fs.statSync(graphPath);
    if (st.size > 100 * 1024 * 1024) {
      return {
        available: avail.ok, version: avail.version, built: true, graphPath,
        sizeBytes: st.size,
        reportExists: fs.existsSync(path.join(outDir(workspacePath), "GRAPH_REPORT.md")),
        htmlExists: fs.existsSync(path.join(outDir(workspacePath), "graph.html")),
      };
    }
    const raw = JSON.parse(fs.readFileSync(graphPath, "utf8")) as { nodes?: unknown[]; edges?: unknown[] };
    return {
      available: avail.ok, version: avail.version, built: true, graphPath,
      nodes: Array.isArray(raw.nodes) ? raw.nodes.length : undefined,
      edges: Array.isArray(raw.edges) ? raw.edges.length : undefined,
      sizeBytes: st.size,
      reportExists: fs.existsSync(path.join(outDir(workspacePath), "GRAPH_REPORT.md")),
      htmlExists: fs.existsSync(path.join(outDir(workspacePath), "graph.html")),
    };
  } catch (e) {
    return { available: avail.ok, version: avail.version, built: false, graphPath };
  }
}

async function runGraphify(args: string[], cwd: string, timeoutMs: number): Promise<ToolResult> {
  const avail = await graphifyAvailable();
  if (!avail.ok) return { success: false, error: installHint() };
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(GRAPHIFY_BIN, args, { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
    const out = (String(stdout) + (stderr ? `\n[stderr]\n${stderr}` : "")).slice(-20_000);
    return { success: true, output: out, metadata: { duration: Date.now() - started, exitCode: 0 } };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string; code?: number };
    const out = (String(err.stdout ?? "") + String(err.stderr ?? "")).slice(-20_000);
    return { success: false, error: (out || String(err.message ?? e)).slice(-20_000), metadata: { duration: Date.now() - started, exitCode: err.code ?? 1 } };
  }
}

/** Build the knowledge graph for a workspace. Code-only = local AST, no API key. */
export function buildGraph(workspacePath: string, updateOnly = false, timeoutMs = 600_000): Promise<ToolResult> {
  const args = updateOnly ? ["update", "."] : ["extract", ".", "--code-only"];
  return runGraphify(args, workspacePath, timeoutMs);
}

/** Query the graph in plain language (uses existing graphify-out/graph.json). */
export function queryGraph(workspacePath: string, question: string, timeoutMs = 120_000): Promise<ToolResult> {
  return runGraphify(["query", question, "--graph", path.join(outDir(workspacePath), "graph.json")], workspacePath, timeoutMs);
}

/** Shortest path between two concepts. */
export function graphPath(workspacePath: string, a: string, b: string, timeoutMs = 120_000): Promise<ToolResult> {
  return runGraphify(["path", a, b, "--graph", path.join(outDir(workspacePath), "graph.json")], workspacePath, timeoutMs);
}

/** Explain one concept from the graph. */
export function explainNode(workspacePath: string, symbol: string, timeoutMs = 120_000): Promise<ToolResult> {
  return runGraphify(["explain", symbol, "--graph", path.join(outDir(workspacePath), "graph.json")], workspacePath, timeoutMs);
}
