import { loadEnv } from "../../../src/config/env.js";
import { getLogger } from "../../../src/observability/logger.js";
import { openDatabase } from "../../../src/database/db.js";
import { recoverInterruptedRuns } from "../../../src/agent/recovery.js";

// Standalone worker: restores interrupted runs and idles ready for queue-driven work.
// Single-node deployments run the worker in-process; scale mode runs N replicas.
async function main(): Promise<void> {
  loadEnv();
  openDatabase();
  const recovered = recoverInterruptedRuns();
  getLogger().info({ event: "worker.ready", recovered: recovered.length }, "worker ready");
  await new Promise(() => undefined); // park; queue callbacks keep the loop alive via api/bot
}
void main().catch((e) => { console.error(e); process.exit(1); });
