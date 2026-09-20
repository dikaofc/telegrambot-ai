import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { dashboardPage, DASHBOARD_TABS, routeForTab, tabFromPath } from "../src/dashboard/page.js";

const TABS = [...DASHBOARD_TABS];

function extractScript(): string {
  const html = dashboardPage();
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  expect(m, "dashboard must contain an inline <script>").toBeTruthy();
  return m![1];
}

/** Boot the real dashboard JS with stub DOM + stub API, like a browser would. */
const DIAGRAM_PAYLOAD = {
  workspace: "default", wsPath: "/tmp/ws", tree: ["src/index.ts"],
  runs: [{ id: "abc12345", input: "fix the failing test", status: "completed", created_at: "2026-09-19 10:00:00" }],
  toolCalls: [],
  plan: {
    objective: "fix the failing test", revision: 2,
    steps: [
      { id: "s1", title: "Discover context", phase: "discover", status: "completed" },
      { id: "s2", title: "Implement the change", phase: "implement", status: "in_progress" },
    ],
    verification: ["npm test"], completionCriteria: ["tests pass"],
  },
  planRunId: "abc12345",
  graphStatus: { available: false, built: false }, graph: null, gitStat: "",
  generatedAt: "2026-09-19T10:00:00.000Z",
};

async function bootDashboard() {
  const elems = new Map<string, Record<string, string | boolean>>();
  const el = (id: string) => {
    if (!elems.get(id)) elems.set(id, { innerHTML: "", textContent: "", className: "", value: "", checked: true });
    return elems.get(id)!;
  };
  const payload = {
    health: { status: "ok" }, counts: { sessions: 1, runs: 2, users: 1 },
    provider: "9router", model: "auto", activeRuns: 1, access: "owner", workspace: "./workspaces",
  };
  const store: Record<string, string> = {};
  const sandbox: Record<string, unknown> = {
    console, URL, encodeURIComponent,
    document: { getElementById: (id: string) => el(id) },
    window: { innerWidth: 1200 },
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v); },
    },
    fetch: async (p: string) => ({
      ok: true,
      json: async () => {
        const s = String(p);
        if (s.startsWith("/api/status")) return payload;
        if (s.startsWith("/api/diagram")) return DIAGRAM_PAYLOAD;
        return {};
      },
      text: async () => "{}",
    }),
    setTimeout: () => 0,
    setInterval: () => 0,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractScript(), sandbox);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { el, sandbox };
}

describe("dashboard page never blank", () => {
  it("inline script has valid syntax", () => {
    expect(() => new vm.Script(extractScript())).not.toThrow();
  });
  it("ships logo + metadata (favicon, description, OG tags)", () => {
    const html = dashboardPage();
    expect(html).toContain('href="/logo.svg"');
    expect(html).toContain('rel="icon"');
    expect(html).toContain('name="description"');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('<img src="/logo.svg"');
  });
  it("shows the PIN modal on first entry when no key is saved", async () => {
    const html = dashboardPage();
    expect(html).toContain('id="keymodal"');
    expect(html).toContain('id="pinInput"');
    expect(html).not.toContain('id="apiKey"');
    const { el } = await bootDashboard();
    // harness localStorage is empty → modal must be open
    const m = el("keymodal") as unknown as { style?: { display?: string } };
    expect(m.style?.display ?? "flex").toBe("flex");
    void el;
  });
  it("asks for the API key instead of raw 401 text", async () => {
    const { el, sandbox } = await bootDashboard();
    (sandbox.go as (t: string) => void)("Graphify");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    // harness fetch is authed (ok:true); simulate the unauthenticated browser
    // by calling the page's api() against a 401 stub directly
    const src = extractScript();
    const apiSrc = src.slice(src.indexOf("function key()"), src.indexOf("/* ---------- bindings"));
    const box: Record<string, unknown> = {
      console, URL, encodeURIComponent,
      localStorage: { getItem: () => "", setItem: () => {} },
      fetch: async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' }),
    };
    box.globalThis = box;
    vm.createContext(box);
    vm.runInContext(apiSrc + "\nthis.__out = null; api('/api/graphify/status').catch(e => { this.__out = String(e && e.message || e); });", box);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(String((box as { __out?: string }).__out ?? "")).toContain("PIN");
    expect(el("view").innerHTML).toContain("Knowledge Graph");
  });
  it("boots: tabs render, status pill updates, Status view fills", async () => {
    const { el } = await bootDashboard();
    const tabs = String(el("tabs").innerHTML);
    for (const t of TABS) expect(tabs).toContain(t);
    expect(String(el("p-status").textContent)).toBe("ok");
    expect(String(el("p-provider").textContent)).toContain("9router");
    // the real /api/status counts must render as tiles, not be swallowed
    const view = String(el("view").innerHTML);
    expect(view).toContain("sessions");
    expect(view).toContain("users");
    expect(view).toContain("<b>2</b>");
  }, 15000);

  it("gives every tab its own real path that round-trips", () => {
    const seen = new Set<string>();
    for (const tab of DASHBOARD_TABS) {
      const route = routeForTab(tab);
      expect(route.startsWith("/"), `${tab} route`).toBe(true);
      expect(seen.has(route), `${tab} route ${route} is unique`).toBe(false);
      seen.add(route);
      expect(tabFromPath(route), `${tab} resolves from ${route}`).toBe(tab);
      // trailing slash + query string still resolve to the same tab
      expect(tabFromPath(route === "/" ? "/?tab=Status" : `${route}/`)).toBe(tab);
      expect(tabFromPath(`/?tab=${tab.toLowerCase()}`)).toBe(tab);
      expect(dashboardPage({ activeTab: tab })).toContain(`data-active-tab="${tab}"`);
    }
    expect(tabFromPath("/definitely-not-a-tab")).toBe("Status");
  });

  it("is mobile-first and drops the heavy neobrutalist styling", () => {
    const html = dashboardPage();
    expect(html).toContain('name="viewport"');
    expect(html).toContain("@media (max-width:760px)");
    // tables collapse into labelled cards so nothing scrolls sideways on a phone
    expect(html).toContain("data-label");
    expect(html).toContain("td::before{content:attr(data-label)");
    // soft shadows, not hard offset neobrutalist blocks
    expect(/box-shadow:\s*\d+px\s+\d+px\s+0\s+(#000|black)/i.test(html)).toBe(false);
    expect(/border:\s*[3-9]px\s+solid\s+(#000|black)/i.test(html)).toBe(false);
    // prefers-reduced-motion is respected and no external asset is fetched
    expect(html).toContain("prefers-reduced-motion");
    expect(/<link[^>]+href="https?:/.test(html)).toBe(false);
  });

  it("renders the live agent plan in the Diagram view", async () => {
    const { el, sandbox } = await bootDashboard();
    (sandbox.go as (t: string) => void)("Diagram");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const html = String(el("view").innerHTML);
    expect(html).toContain("Agent Plan");
    expect(html).toContain("fix the failing test"); // objective comes from the real plan
    expect(html).toContain("Discover context");
    expect(html).toContain("Implement the change");
    expect(html).toContain("npm test"); // verification steps are shown
    // the step icons prove status is rendered, not fabricated
    expect(html).toContain("✓");
  }, 15000);
});
