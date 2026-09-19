import { assertSafeUrl } from "../security/ssrf.js";
import type { ToolResult } from "./types.js";
import { ok, fail } from "./types.js";

export async function httpGet(url: string, timeoutMs = 15_000, trusted: string[] = []): Promise<ToolResult> {
  try {
    assertSafeUrl(url, trusted);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "teleagent/1.0" } });
      const text = await res.text();
      return res.ok ? ok(text.slice(0, 100_000)) : fail(`HTTP ${res.status}: ${text.slice(0, 2000)}`);
    } finally { clearTimeout(t); }
  } catch (e) { return fail(String(e)); }
}

export async function httpPost(url: string, body: unknown, timeoutMs = 15_000, trusted: string[] = []): Promise<ToolResult> {
  try {
    assertSafeUrl(url, trusted);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST", signal: ctrl.signal,
        headers: { "user-agent": "teleagent/1.0", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return res.ok ? ok(text.slice(0, 100_000)) : fail(`HTTP ${res.status}: ${text.slice(0, 2000)}`);
    } finally { clearTimeout(t); }
  } catch (e) { return fail(String(e)); }
}

export async function downloadFile(url: string, destPath: string, timeoutMs = 60_000, trusted: string[] = []): Promise<ToolResult> {
  const fs = await import("node:fs");
  try {
    assertSafeUrl(url, trusted);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) return fail(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(destPath, buf);
      return ok(`downloaded ${buf.length} bytes to ${destPath}`);
    } finally { clearTimeout(t); }
  } catch (e) { return fail(String(e)); }
}
