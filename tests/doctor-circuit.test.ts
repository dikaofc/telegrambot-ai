import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = fs.mkdtempSync(path.join(os.tmpdir(), "tele-docdb-")) + "/d.db";
process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "tele-docws-"));

import { openDatabase } from "../src/database/db.js";
import { store } from "../src/database/store.js";
import { runIdForLookup } from "../src/agent/orchestrator.js";
import {
  isAvailable, recordSuccess, recordFailure, resetCircuits,
  setCircuitTuning, circuitSnapshot, leastTripped,
} from "../src/providers/circuit.js";
import { runDoctor } from "../src/observability/doctor.js";

function restore(): void {
  setCircuitTuning({ tripAfter: 3, cooldownMs: 60_000 });
  resetCircuits();
}

describe("provider circuit breaker", () => {
  it("trips after N failures, recovers after cooldown", async () => {
    setCircuitTuning({ tripAfter: 3, cooldownMs: 60 });
    try {
      expect(isAvailable("cb-a")).toBe(true);
      recordFailure("cb-a", "e1");
      recordFailure("cb-a", "e2");
      expect(isAvailable("cb-a")).toBe(true);
      recordFailure("cb-a", "e3");
      expect(isAvailable("cb-a")).toBe(false);
      await new Promise((r) => setTimeout(r, 100));
      expect(isAvailable("cb-a")).toBe(true);
    } finally { restore(); }
  });
  it("success resets the trip counter", () => {
    setCircuitTuning({ tripAfter: 2, cooldownMs: 60_000 });
    try {
      recordFailure("cb-b", "e1");
      recordSuccess("cb-b", 5);
      recordFailure("cb-b", "e2");
      expect(isAvailable("cb-b")).toBe(true);
    } finally { restore(); }
  });
  it("snapshot exposes availability + leastTripped picks earliest", () => {
    setCircuitTuning({ tripAfter: 1, cooldownMs: 60_000 });
    try {
      recordFailure("cb-c", "boom");
      const snap = circuitSnapshot();
      expect(snap["cb-c"]?.available).toBe(false);
      expect(snap["cb-c"]?.totalFailure).toBe(1);
      expect(leastTripped(["cb-c", "cb-fresh"])).toBe("cb-fresh");
    } finally { restore(); }
  });
});

describe("doctor", () => {
  it("returns honest PASS/WARN/FAIL per subsystem", async () => {
    openDatabase(process.env.DATABASE_URL);
    const r = await runDoctor();
    expect(["ok", "warn", "fail"]).toContain(r.status);
    expect(r.checks.length).toBeGreaterThan(5);
    for (const c of r.checks) expect(["pass", "warn", "fail"]).toContain(c.status);
    for (const n of ["database", "workspace", "disk", "memory", "node", "telegram"]) {
      expect(r.checks.map((c) => c.name)).toContain(n);
    }
    const fails = r.checks.filter((c) => c.status === "fail").length;
    expect(r.status).toBe(fails ? "fail" : r.checks.some((c) => c.status === "warn") ? "warn" : "ok");
  }, 60000);
});

describe("approval expiry predicate", () => {
  it("unknown runs are not alive; rows readable", () => {
    openDatabase(process.env.DATABASE_URL);
    expect(runIdForLookup("00000000-0000-0000-0000-000000000000")).toBe(false);
    const id = store.createApproval("00000000-0000-0000-0000-000000000001", "shell", "ls", "LOW");
    const ap = store.getApproval(id) as { run_id: string; status: string };
    expect(ap.run_id).toBe("00000000-0000-0000-0000-000000000001");
    expect(runIdForLookup(ap.run_id)).toBe(false);
  });
});
