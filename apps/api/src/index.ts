import { loadEnv } from "../../../src/config/env.js";
import { getLogger } from "../../../src/observability/logger.js";
import { openDatabase } from "../../../src/database/db.js";
import { buildApiServer } from "../../../src/api/server.js";

async function main(): Promise<void> {
  loadEnv();
  openDatabase();
  const api = await buildApiServer();
  const port = Number(process.env.PORT ?? 49374);
  await api.listen({ port, host: "0.0.0.0" });
  getLogger().info({ event: "api.listening", port }, "api listening");
}
void main().catch((e) => { console.error(e); process.exit(1); });
