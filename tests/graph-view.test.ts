import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-graphview-"));
process.env.DATABASE_URL = path.join(ROOT, "db", "t.db");
process.env.WORKSPACE_ROOT = path.join(ROOT, "ws");
process.env.TELEAGENT_API_KEY = "";
process.env.BOT_ACCESS_MODE = "owner";
process.env.OWNER_IDS = "";

const WS = path.join(process.env.WORKSPACE_ROOT as string, "graphws");
const OUT = path.join(WS, "graphify-out");

function writeFixture(): void {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "graph.json"), JSON.stringify({
    directed: true, multigraph: false, graph: {}, built_at_commit: "abcdef1234567890",
    nodes: [
      { id: "n1", label: "Alpha", community: 0, community_name: "core", file_type: "code", source_file: "src/a.ts", source_location: "L3" },
      { id: "n2", label: "Beta", community: 0, community_name: "core", file_type: "code", source_file: "src/b.ts" },
      { id: "n3", label: "Gamma", community: 1, community_name: "ui", file_type: "code", source_file: "src/c.ts" },
      { id: "n4", label: "Delta", community: 1, community_name: "ui", file_type: "concept" },
    ],
    links: [
      { source: "n1", target: "n2", relation: "calls", weight: 1, confidence: "EXTRACTED" },
      { source: "n1", target: "n3", relation: "imports", weight: 1 },
      { source: "n2", target: "n3", relation: "calls", weight: 1 },
      { source: "ghost", target: "n1", relation: "calls", weight: 1 },
    ],
  }), "utf8");
  fs.writeFileSync(path.join(OUT, ".graphify_labels.json"), JSON.stringify({ "0": "core", "1": "ui" }), "utf8");
  fs.writeFileSync(path.join(OUT, ".graphify_analysis.json"), JSON.stringify({
    cohesion: { "0": 0.31234567, "1": 0.1701 },
    gods: [{ id: "n1", label: "Alpha", degree: 3 }, { id: "n2", label: "Beta", degree: 2 }, { id: "n3", label: "Gamma", degree: 2 }, { id: "n4", label: "Delta", degree: 0 }],
    surprises: [{ source: "Alpha", target: "Gamma", relation: "imports", why: "menembus batas komunitas" }],
    questions: [{ type: "bridge_node", question: "Kenapa Gamma menghubungkan core dan ui?", why: "betweenness tinggi" }],
  }), "utf8");
}

beforeAll(() => {
  writeFixture();
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("graph view payload", () => {
  it("computes degree from the real links and keeps only whole edges", async () => {
    const { graphView } = await import("../src/integrations/graphify.js");
    const view = graphView(WS, { limit: 4 });
    const byLabel = new Map(view.nodes.map((n) => [n.label, n]));
    expect(byLabel.get("Alpha")?.degree).toBe(3); // n1→n2, n1→n3, ghost→n1
    expect(byLabel.get("Delta")?.degree).toBe(0);
    expect(view.totals).toEqual({ nodes: 4, links: 4, communities: 2 });
    // the ghost edge is counted in the totals but cannot be drawn: no endpoint node
    expect(view.shown).toEqual({ nodes: 4, links: 3 });
    expect(view.truncated).toBe(false);
    expect(view.builtAtCommit).toBe("abcdef123456");
    // edges are [from, to, relation] indices, always inside the node array
    for (const l of view.links) {
      expect(l.length).toBe(3);
      for (const i of [l[0], l[1]]) {
        expect(Number.isInteger(i)).toBe(true);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(view.nodes.length);
      }
      expect(typeof l[2]).toBe("string");
    }
    const labels = view.nodes.map((n) => n.label);
    expect(view.links.map((l) => [labels[l[0]], labels[l[1]], l[2]])).toContainEqual(["Alpha", "Beta", "calls"]);
  });

  it("truncates by degree and says so instead of pretending", async () => {
    const { graphView } = await import("../src/integrations/graphify.js");
    const view = graphView(WS, { limit: 2 });
    expect(view.shown.nodes).toBe(2);
    expect(view.truncated).toBe(true);
    // heaviest first: Alpha (3) then a degree-2 node, never the isolated one
    expect(view.nodes[0].label).toBe("Alpha");
    expect(view.nodes.some((n) => n.label === "Delta")).toBe(false);
    // no edge may point outside the nodes actually sent
    expect(view.links.every((l) => l[0] < view.nodes.length && l[1] < view.nodes.length)).toBe(true);
    expect(view.totals.nodes).toBe(4); // totals always describe the whole graph
  });

  it("carries communities, cohesion and graphify's own insights", async () => {
    const { graphView } = await import("../src/integrations/graphify.js");
    const view = graphView(WS);
    expect(view.communities.map((c) => c.name)).toEqual(["core", "ui"]);
    expect(view.communities[0].count).toBe(2);
    expect(view.communities[0].cohesion).toBeCloseTo(0.3123, 4);
    expect(view.insights.gods[0]).toEqual({ id: "n1", label: "Alpha", degree: 3 });
    expect(view.insights.surprises[0].why).toContain("batas komunitas");
    expect(view.insights.questions[0].question).toContain("Gamma");
  });

  it("treats a missing graph as not-built, and a broken one as an error", async () => {
    const { graphView, GraphNotBuiltError } = await import("../src/integrations/graphify.js");
    expect(() => graphView(path.join(process.env.WORKSPACE_ROOT as string, "empty"))).toThrow(GraphNotBuiltError);
    const broken = path.join(process.env.WORKSPACE_ROOT as string, "broken", "graphify-out");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "graph.json"), "{not json", "utf8");
    expect(() => graphView(path.join(process.env.WORKSPACE_ROOT as string, "broken"))).toThrow();
    fs.writeFileSync(path.join(broken, "graph.json"), JSON.stringify({ nodes: [], links: [] }), "utf8");
    expect(() => graphView(path.join(process.env.WORKSPACE_ROOT as string, "broken"))).toThrow(/tidak berisi node/);
  });
});

describe("graphify viewer page", () => {
  it("ships a valid script and the shared design system", async () => {
    const { graphifyPage } = await import("../src/dashboard/graph-page.js");
    const { dashboardPage } = await import("../src/dashboard/page.js");
    const html = graphifyPage();
    const script = /<script>([\s\S]*)<\/script>/.exec(html);
    expect(script, "viewer must contain an inline script").toBeTruthy();
    expect(() => new vm.Script(script![1])).not.toThrow();
    // same palette as the dashboard, loaded from the one shared stylesheet
    const token = /--accent:\s*#[0-9a-f]{6}/i.exec(dashboardPage());
    expect(token, "dashboard defines the accent token").toBeTruthy();
    expect(html).toContain(token![0]);
    expect(html).toContain("--radius:");
    expect(html).toContain("var(--accent)");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("is mobile-first and free of the CLI page's own dark theme", async () => {
    const { graphifyPage } = await import("../src/dashboard/graph-page.js");
    const html = graphifyPage();
    expect(html).toContain('name="viewport"');
    expect(html).toContain("@media (max-width:760px)");
    // phone: the rail becomes a bottom sheet instead of a fixed 280px column
    expect(html).toMatch(/translateY\(calc\(100% - \d+px\)\)/); // peek strip, not a full cover
    expect(html).toContain(".rail.open{transform:none}");
    // no neobrutalist hard shadows
    expect(/box-shadow:\s*\d+px\s+\d+px\s+0\s+(#000|black)/i.test(html)).toBe(false);
  });

  it("loads nothing from the network and keeps no CLI styling", async () => {
    const { graphifyPage } = await import("../src/dashboard/graph-page.js");
    const html = graphifyPage();
    expect(/>\s*<script[^>]+src=/.test(html)).toBe(false);
    expect(/<link[^>]+href="https?:/.test(html)).toBe(false);
    expect(html).not.toContain("unpkg");
    expect(html).not.toContain("vis-network");
    // the graphify CLI palette we replaced
    for (const slop of ["#0f0f1a", "#1a1a2e", "#2a2a4e", "#3a3a5e"]) expect(html).not.toContain(slop);
  });

  it("takes the workspace from the URL and works embedded in the dashboard", async () => {
    const { graphifyPage } = await import("../src/dashboard/graph-page.js");
    const html = graphifyPage();
    expect(html).toContain("QS.get('workspace')");
    expect(html).toContain("QS.get('embed')");
    expect(html).toContain(".embed .ghead{display:none}"); // iframe shows no second header
    expect(html).toContain("/api/graphify/view?workspace=");
    expect(html).toContain("/api/graphify/raw");
  });
});

/** Boot the real viewer script with a stub DOM + canvas, like a browser would. */
async function bootViewer(payload: unknown, search = "?workspace=graphws") {
  const { graphifyPage } = await import("../src/dashboard/graph-page.js");
  const script = /<script>([\s\S]*)<\/script>/.exec(graphifyPage())![1];
  const elems = new Map<string, Record<string, unknown>>();
  const ctxCalls: string[] = [];
  const ctx = new Proxy<Record<string, unknown>>({}, {
    get: (_t, prop: string) => {
      if (prop === "setTransform") return () => ctxCalls.push("setTransform");
      return (...args: unknown[]) => { ctxCalls.push(String(prop)); void args; };
    },
    set: () => true,
  });
  const el = (id: string) => {
    if (!elems.get(id)) {
      const e: Record<string, unknown> = {
        id, innerHTML: "", textContent: "", hidden: true, value: "", checked: true,
        style: {}, clientWidth: 900, clientHeight: 600, tabIndex: 0,
        className: "", attrs: {} as Record<string, string>,
        setAttribute(k: string, v: string) { (this.attrs as Record<string, string>)[k] = v; },
        getAttribute(k: string) { return (this.attrs as Record<string, string>)[k] ?? null; },
        hasAttribute(k: string) { return k in (this.attrs as Record<string, string>); },
        removeAttribute(k: string) { delete (this.attrs as Record<string, string>)[k]; },
        addEventListener() {}, removeEventListener() {},
        setPointerCapture() {}, closest: () => null, querySelector: () => null,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        getContext: () => ctx, focus() {}, blur() {}, appendChild() {},
      };
      elems.set(id, e);
    }
    return elems.get(id)!;
  };
  let frames = 0;
  const sandbox: Record<string, unknown> = {
    console, URLSearchParams, Math, JSON, Set, Map, Number, String, Object, Array, Infinity, isFinite, NaN,
    document: {
      getElementById: (id: string) => el(id),
      addEventListener() {}, activeElement: null,
      documentElement: {
        _a: {} as Record<string, string>,
        getAttribute(k: string) { return (this as unknown as { _a: Record<string, string> })._a[k] ?? null; },
        setAttribute(k: string, v: string) { (this as unknown as { _a: Record<string, string> })._a[k] = v; },
        removeAttribute(k: string) { delete (this as unknown as { _a: Record<string, string> })._a[k]; },
        className: "",
      },
    },
    window: {
      innerWidth: 1200, devicePixelRatio: 1,
      matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
      addEventListener() {},
    },
    location: { search },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (fn: () => void) => { if (frames++ < 80) fn(); return frames; },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => payload, text: async () => "" }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  return { el, sandbox, ctxCalls };
}

describe("viewer runtime", () => {
  it("boots, lays out and draws without errors, and fills every panel from real data", async () => {
    const { graphView } = await import("../src/integrations/graphify.js");
    const payload = graphView(WS, { limit: 4 });
    const { el, sandbox, ctxCalls } = await bootViewer(payload);

    expect((sandbox.PAY as { nodes: unknown[] }).nodes.length).toBe(4);
    expect(String(el("g-title").textContent)).toBe("Graphify · graphws");
    expect(String(el("g-meta").innerHTML)).toContain("4 node");
    expect(String(el("g-meta").innerHTML)).toContain("2 komunitas");
    expect(String(el("g-shown").textContent)).toContain("4 / 4 node");
    expect(el("g-empty").hidden).toBe(true);
    expect(el("g-canvas").hidden).toBe(false);

    // communities + insights come straight from the analysis fixture
    const comms = String(el("g-communities").innerHTML);
    expect(comms).toContain("core");
    expect(comms).toContain("ui");
    expect(comms).toContain("0.312");
    const ins = String(el("g-insights").innerHTML);
    expect(ins).toContain("Alpha");
    expect(ins).toContain("batas komunitas");

    // selecting a node fills the detail pane with its real neighbours
    (sandbox.focusNodeAt as (i: number, open?: boolean) => void)(0, true);
    const detail = String(el("g-detail").innerHTML);
    expect(detail).toContain("Alpha");
    expect(detail).toContain("src/a.ts:L3");
    expect(detail).toContain("3 link"); // ghost→Alpha is a real incoming edge
    expect(detail).toContain("data-node=");
    expect(detail).toContain("calls"); // the relation travels with each edge

    // the canvas was actually painted, not just initialised
    expect(ctxCalls.filter((c) => c === "arc").length).toBeGreaterThan(0);
    expect(ctxCalls).toContain("fillText");
  }, 15000);

  it("filters by community and reports truncation honestly", async () => {
    const { graphView } = await import("../src/integrations/graphify.js");
    const payload = graphView(WS, { limit: 2 });
    const { el, sandbox } = await bootViewer(payload);
    expect(String(el("g-note").textContent)).toContain("Menampilkan 2 node");
    expect(String(el("g-note").textContent)).toContain("4");

    (sandbox.focusCommunity as (id: number) => void)(0);
    (sandbox.draw as () => void)();
    expect(String(el("g-shown").textContent)).toContain("2 / 4 node");
    (sandbox.clearCommunityFocus as () => void)();
    expect(String(el("g-shown").textContent)).toContain("2 / 4 node"); // limit still applies
  }, 15000);

  it("shows the build hint instead of a blank canvas when there is no graph", async () => {
    const { el, sandbox } = await bootViewer(null, "?workspace=empty");
    void sandbox;
    // the stub fetch resolves with no payload, so the viewer must surface an error
    expect(el("g-empty").hidden).toBe(false);
    expect(String(el("g-empty").innerHTML)).toContain("belum bisa ditampilkan");
  }, 15000);
});

describe("graphify routes", () => {
  it("serves the viewer shell openly, the data gated, and the raw CLI output", async () => {
    const { buildApiServer } = await import("../src/api/server.js");
    const { openDatabase } = await import("../src/database/db.js");
    openDatabase(process.env.DATABASE_URL);
    const app = await buildApiServer();

    // shell: no workspace data at all, so it can be framed without an API key
    const shell = await app.inject({ method: "GET", url: "/api/graphify/html?workspace=graphws" });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["content-type"]).toContain("text/html");
    expect(shell.body).toContain("g-canvas");
    // the shell is data-free: labels and file paths only ever come from the gated JSON
    expect(shell.body).not.toContain("Gamma");
    expect(shell.body).not.toContain("src/a.ts");

    const view = await app.inject({ method: "GET", url: "/api/graphify/view?workspace=graphws" });
    expect(view.statusCode).toBe(200);
    const payload = JSON.parse(view.body);
    expect(payload.totals.nodes).toBe(4);
    expect(payload.nodes.length).toBe(4);
    expect(payload.communities.length).toBe(2);

    const capped = await app.inject({ method: "GET", url: "/api/graphify/view?workspace=graphws&limit=1" });
    expect(JSON.parse(capped.body).shown.nodes).toBe(1);

    const notBuilt = await app.inject({ method: "GET", url: "/api/graphify/view?workspace=empty" });
    expect(notBuilt.statusCode).toBe(404);
    expect(JSON.parse(notBuilt.body).error).toContain("graph.json belum ada");

    const escaping = await app.inject({ method: "GET", url: "/api/graphify/view?workspace=../etc" });
    expect(escaping.statusCode).toBe(400);

    const raw = await app.inject({ method: "GET", url: "/api/graphify/raw?workspace=graphws" });
    expect(raw.statusCode).toBe(404); // fixture has graph.json but no graph.html

    await app.close();
  }, 60000);
});
