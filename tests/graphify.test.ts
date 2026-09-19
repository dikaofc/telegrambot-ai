import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { graphifyAvailable, graphStatus, buildGraph, queryGraph, installHint, resetGraphifyCache } from "../src/integrations/graphify.js";
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
});
