import type { FastifyInstance } from "fastify";
import { getLogger } from "../observability/logger.js";

/** Listen with EADDRINUSE fallback: try port..port+10, return actual port. */
export async function listenWithFallback(app: FastifyInstance, port: number, host = "0.0.0.0"): Promise<number> {
  const log = getLogger();
  let lastErr: unknown = null;
  for (let p = port; p < port + 10; p++) {
    try {
      await app.listen({ port: p, host });
      if (p !== port) {
        log.warn({ event: "api.port.fallback", from: port, to: p }, `port ${port} busy — using ${p}`);
        console.log(`\nport ${port} sibuk, pakai ${p} sebagai gantinya\n`);
      }
      return p;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "EADDRINUSE") { lastErr = e; continue; }
      throw e;
    }
  }
  console.error(`\nSemua port ${port}..${port + 9} sibuk. Matikan proses lama dulu, misal:\n  fuser -k ${port}/tcp\n  # atau: lsof -ti:${port} | xargs kill\n`);
  throw lastErr;
}
