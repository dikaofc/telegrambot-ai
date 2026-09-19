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

/* ------------------------------------------------------------------ *
 * First-party viewer data. The `graphify` CLI writes graph.json plus a
 * generated graph.html whose styling is its own; we render our own
 * responsive page from the real data instead of shipping a second theme.
 * ------------------------------------------------------------------ */

export class GraphNotBuiltError extends Error {
  constructor(workspacePath: string) {
    super(`graph.json belum ada di ${path.join(workspacePath, GRAPHIFY_OUT_DIR)} — jalankan graphify_build dulu`);
    this.name = "GraphNotBuiltError";
  }
}

/** Default node ceiling for the viewer: keeps the payload small on mobile. */
export const GRAPH_VIEW_DEFAULT_LIMIT = 400;
const GRAPH_VIEW_MAX_LIMIT = 2000;

interface RawGraphNode {
  id?: unknown; label?: unknown; community?: unknown; community_name?: unknown;
  file_type?: unknown; source_file?: unknown; source_location?: unknown;
}
interface RawGraphLink { source?: unknown; target?: unknown; relation?: unknown; confidence?: unknown; weight?: unknown }

function readJsonIfPresent(file: string): unknown {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export interface GraphViewNode {
  id: string; label: string; community: number; communityName: string;
  fileType: string; sourceFile?: string; sourceLocation?: string; degree: number;
}
export interface GraphViewLink {
  source: string; target: string; relation: string; confidence?: string; weight: number;
}
export interface GraphViewCommunity { id: number; name: string; count: number; cohesion?: number }

export interface GraphViewPayload {
  workspace: string;
  builtAtCommit?: string;
  /** Real totals of the whole graph, before the viewer node ceiling. */
  totals: { nodes: number; links: number; communities: number };
  /** How much of the graph this payload actually carries. */
  shown: { nodes: number; links: number };
  limit: number;
  truncated: boolean;
  nodes: GraphViewNode[];
  links: GraphViewLink[];
  communities: GraphViewCommunity[];
  insights: {
    gods: Array<{ id: string; label: string; degree: number }>;
    surprises: Array<{ source: string; target: string; relation?: string; why?: string }>;
    questions: Array<{ type: string; question: string; why?: string }>;
  };
  generatedAt: string;
}

/**
 * Read the real graphify output and shape it for the viewer.
 * Node degree is computed from the links (graphify only adds it when drawing),
 * and the heaviest nodes are kept so a phone never has to lay out 800 nodes.
 */
export function graphView(workspacePath: string, opts: { limit?: number } = {}): GraphViewPayload {
  const graphPath = path.join(outDir(workspacePath), "graph.json");
  if (!fs.existsSync(graphPath)) throw new GraphNotBuiltError(workspacePath);
  const st = fs.statSync(graphPath);
  if (st.size > 100 * 1024 * 1024) throw new Error(`graph.json terlalu besar (${Math.round(st.size / 1048576)}MB) untuk viewer`);
  const raw = JSON.parse(fs.readFileSync(graphPath, "utf8")) as {
    nodes?: RawGraphNode[]; links?: RawGraphLink[]; built_at_commit?: unknown;
  };
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawLinks = Array.isArray(raw.links) ? raw.links : [];
  if (rawNodes.length === 0) throw new Error("graph.json tidak berisi node — build ulang dengan graphify_build");

  const labels = (readJsonIfPresent(path.join(outDir(workspacePath), ".graphify_labels.json")) ?? {}) as Record<string, unknown>;
  const analysis = (readJsonIfPresent(path.join(outDir(workspacePath), ".graphify_analysis.json")) ?? {}) as {
    cohesion?: Record<string, unknown>;
    gods?: Array<{ id?: unknown; label?: unknown; degree?: unknown }>;
    surprises?: Array<{ source?: unknown; target?: unknown; relation?: unknown; why?: unknown }>;
    questions?: Array<{ type?: unknown; question?: unknown; why?: unknown }>;
  };

  // degree from the links, and community membership from the nodes
  const degree = new Map<string, number>();
  const links: GraphViewLink[] = [];
  for (const l of rawLinks) {
    const source = str(l.source), target = str(l.target);
    if (!source || !target) continue;
    degree.set(source, (degree.get(source) ?? 0) + 1);
    if (target !== source) degree.set(target, (degree.get(target) ?? 0) + 1);
    links.push({ source, target, relation: str(l.relation, "related"), confidence: str(l.confidence) || undefined, weight: num(l.weight, 1) });
  }

  const communityCount = new Map<number, number>();
  const allNodes = rawNodes.map((n) => {
    const id = str(n.id);
    const community = num(n.community, -1);
    communityCount.set(community, (communityCount.get(community) ?? 0) + 1);
    return {
      id,
      label: str(n.label, id),
      community,
      communityName: str(n.community_name) || str(labels[String(community)], community >= 0 ? `community ${community}` : "unassigned"),
      fileType: str(n.file_type, "code"),
      sourceFile: str(n.source_file) || undefined,
      sourceLocation: str(n.source_location) || undefined,
      degree: degree.get(id) ?? 0,
    } satisfies GraphViewNode;
  });

  const limit = Math.min(Math.max(1, Math.round(opts.limit ?? GRAPH_VIEW_DEFAULT_LIMIT)), GRAPH_VIEW_MAX_LIMIT);
  const ranked = [...allNodes].sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
  const nodes = ranked.slice(0, limit);
  const kept = new Set(nodes.map((n) => n.id));
  const shownLinks = links.filter((l) => kept.has(l.source) && kept.has(l.target));

  const cohesion = analysis.cohesion ?? {};
  const communities: GraphViewCommunity[] = [...communityCount.entries()]
    .map(([id, count]) => {
      const name = str(labels[String(id)]) || allNodes.find((n) => n.community === id)?.communityName || (id >= 0 ? `community ${id}` : "unassigned");
      const c = cohesion[String(id)];
      return { id, name, count, cohesion: typeof c === "number" && Number.isFinite(c) ? Number(c.toFixed(4)) : undefined };
    })
    .sort((a, b) => b.count - a.count || a.id - b.id);

  const insights = {
    gods: (Array.isArray(analysis.gods) ? analysis.gods : []).slice(0, 8).map((g) => ({
      id: str(g.id), label: str(g.label, str(g.id)), degree: num(g.degree),
    })),
    surprises: (Array.isArray(analysis.surprises) ? analysis.surprises : []).slice(0, 6).map((s) => ({
      source: str(s.source), target: str(s.target), relation: str(s.relation) || undefined, why: str(s.why) || undefined,
    })),
    questions: (Array.isArray(analysis.questions) ? analysis.questions : []).slice(0, 6).map((q) => ({
      type: str(q.type, "question"), question: str(q.question), why: str(q.why) || undefined,
    })),
  };

  return {
    workspace: path.basename(workspacePath),
    builtAtCommit: str(raw.built_at_commit).slice(0, 12) || undefined,
    totals: { nodes: allNodes.length, links: links.length, communities: communityCount.size },
    shown: { nodes: nodes.length, links: shownLinks.length },
    limit,
    truncated: nodes.length < allNodes.length,
    nodes,
    links: shownLinks,
    communities,
    insights,
    generatedAt: new Date().toISOString(),
  };
}

/** Path of the graphify-generated HTML, kept available as the raw output. */
export function graphHtmlPath(workspacePath: string): string {
  return path.join(outDir(workspacePath), "graph.html");
}

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
