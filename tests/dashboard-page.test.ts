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
      json: async () => (String(p).startsWith("/api/status") ? payload : {}),
      text: async () => "{}",
    }),
    setTimeout: () => 0,
    setInterval: () => 0,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractScript(), sandbox);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return el;
}

describe("dashboard page never blank", () => {
  it("inline script has valid syntax", () => {
    expect(() => new vm.Script(extractScript())).not.toThrow();
  });
  it("boots: tabs render, status pill updates, Status view fills", async () => {
    const el = await bootDashboard();
    const tabs = String(el("tabs").innerHTML);
    for (const t of TABS) expect(tabs).toContain(t);
    expect(String(el("p-status").textContent)).toBe("ok");
    expect(String(el("p-provider").textContent)).toContain("9router");
    expect(String(el("view").innerHTML)).toContain("Counts");
  }, 15000);
});
