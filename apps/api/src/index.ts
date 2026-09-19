import { loadEnv } from "../../../src/config/env.js";
import { getLogger } from "../../../src/observability/logger.js";
import { openDatabase } from "../../../src/database/db.js";
import { buildApiServer } from "../../../src/api/server.js";
import { listenWithFallback } from "../../../src/api/listen.js";

async function main(): Promise<void> {
  const env = loadEnv();
  openDatabase();
  try {
    const { syncFilesystemWorkspaces } = await import("../../../src/workspace/manager.js");
    syncFilesystemWorkspaces();
  } catch { /* non-fatal */ }
  const api = await buildApiServer();
  const port = Number(env.PORT ?? 49375);
  const actualPort = await listenWithFallback(api, port, env.HOST);
  getLogger().info({ event: "api.listening", port: actualPort }, "api listening");
  console.log(`dashboard:\nhttp://localhost:${actualPort}\n`);
}
void main().catch((e) => { console.error(e); process.exit(1); });
