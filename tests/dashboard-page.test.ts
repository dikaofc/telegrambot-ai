import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { dashboardPage } from "../src/dashboard/page.js";

const TABS = ["Status", "Diagram", "Sessions", "Runs", "Approvals", "Workspaces", "Providers", "Usage", "Audit", "Settings", "Graphify"];

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
  it("boots: tabs render, status pill updates, Status view fills", async () => {
    const { el } = await bootDashboard();
    const tabs = String(el("tabs").innerHTML);
    for (const t of TABS) expect(tabs).toContain(t);
    expect(String(el("p-status").textContent)).toBe("ok");
    expect(String(el("p-provider").textContent)).toContain("9router");
    expect(String(el("view").innerHTML)).toContain("Counts");
  }, 15000);

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
