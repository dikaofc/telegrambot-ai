import { loadEnv } from "../../../src/config/env.js";
import { getLogger } from "../../../src/observability/logger.js";
import { openDatabase } from "../../../src/database/db.js";
import { buildApiServer } from "../../../src/api/server.js";
import { listenWithFallback } from "../../../src/api/listen.js";

async function main(): Promise<void> {
  const env = loadEnv();
  openDatabase();
  try {
    const { ensureWorkspaceDirs, listWorkspaces, resolveWorkspacePath } = await import("../../../src/workspace/manager.js");
    const { store } = await import("../../../src/database/store.js");
    ensureWorkspaceDirs();
    for (const name of listWorkspaces()) {
      try { store.ensureWorkspace(name, resolveWorkspacePath(name)); } catch { /* noop */ }
    }
  } catch { /* non-fatal */ }
  const api = await buildApiServer();
  const port = Number(env.PORT ?? 49375);
  const actualPort = await listenWithFallback(api, port, "0.0.0.0");
  getLogger().info({ event: "api.listening", port: actualPort }, "api listening");
  console.log(`dashboard:\nhttp://localhost:${actualPort}\n`);
}
void main().catch((e) => { console.error(e); process.exit(1); });
