import net from "node:net";

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "169.254.169.254"]);

export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h === "metadata.google.internal") return true;
  if (net.isIP(h)) {
    if (net.isIPv4(h)) {
      const [a, b] = h.split(".").map(Number);
      if (a === 10) return true;
      if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 127) return true;
    }
    if (h.startsWith("fc") || h.startsWith("fd") || h === "::1" || h.startsWith("fe80")) return true;
  }
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  return false;
}

export function assertSafeUrl(raw: string, trusted: string[] = []): URL {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol)) throw new Error(`blocked protocol: ${u.protocol}`);
  if (trusted.includes(u.hostname)) return u;
  if (isBlockedHost(u.hostname)) throw new Error(`SSRF blocked host: ${u.hostname}`);
  return u;
}
