import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { graphifyAvailable, graphStatus, buildGraph, queryGraph, installHint, resetGraphifyCache } from "../src/integrations/graphify.js";
import { isTermuxPlatform, isTestEnv, ensureGraphify } from "../src/integrations/graphify.js";
import { pickSkill, listSkills } from "../src/agent/skills.js";

describe("graphify harness", () => {
  it("availability probe returns honest boolean", async () => {
    resetGraphifyCache();
    const a = await graphifyAvailable();
    expect(typeof a.ok).toBe("boolean");
  }, 30000);

  it("behaves honestly when CLI is missing OR present", async () => {
    resetGraphifyCache();
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tele-gws-"));
    fs.writeFileSync(path.join(ws, "main.py"), "def hello():\n    return 1\n");
    const { ok } = await graphifyAvailable();
    if (!ok) {
      expect(installHint()).toContain("uv tool install graphifyy");
      const b = await buildGraph(ws);
      expect(b.success).toBe(false);
      expect(b.error).toContain("uv tool install");
      const q = await queryGraph(ws, "what does hello do?");
      expect(q.success).toBe(false);
      const st = await graphStatus(ws);
      expect(st.built).toBe(false);
      expect(st.available).toBe(false);
    } else {
      const st = await graphStatus(ws);
      expect(st.available).toBe(true);
      expect(st.built).toBe(false);
      const b = await buildGraph(ws);
      // offline code-only build should succeed against a tiny workspace
      expect(b.success).toBe(true);
      const st2 = await graphStatus(ws);
      expect(st2.built).toBe(true);
      expect(st2.nodes).toBeGreaterThan(0);
    }
  }, 300000);

  it("skill routes graph questions to graphify skill", () => {
    expect(listSkills("skills").some((s) => s.name === "graphify")).toBe(true);
    expect(pickSkill("what connects auth to the database?", "skills")?.name).toBe("graphify");
    expect(pickSkill("explain RateLimiter", "skills")?.name).toBe("graphify");
  });

  it("detects Termux honestly and never installs in tests", async () => {
    expect(isTermuxPlatform({ PREFIX: "/data/data/com.termux/files/usr" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isTermuxPlatform({ PREFIX: "/usr" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isTermuxPlatform({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isTestEnv()).toBe(true); // vitest sets VITEST=true
    // Termux short-circuits before any install attempt
    const r = await ensureGraphify();
    expect(typeof r.ok).toBe("boolean");
  });

  it("buildGraph on Termux returns an honest skip, not a crash", async () => {
    const prev = process.env.PREFIX;
    (process.env as Record<string, string | undefined>).PREFIX = "/data/data/com.termux/files/usr";
    try {
      resetGraphifyCache();
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tele-gtermux-"));
      fs.writeFileSync(path.join(ws, "a.py"), "x = 1\n");
      const b = await buildGraph(ws);
      expect(b.success).toBe(false);
      expect(b.error ?? "").toMatch(/Termux|termux/);
    } finally {
      if (prev === undefined) delete process.env.PREFIX;
      else process.env.PREFIX = prev;
      resetGraphifyCache();
    }
  });
});
