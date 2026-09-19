import path from "node:path";

export interface UploadValidation { ok: boolean; reason?: string; }

export function validateFileName(name: string): UploadValidation {
  if (!name || name.length > 255) return { ok: false, reason: "invalid filename length" };
  if (name.includes("\0")) return { ok: false, reason: "null byte in filename" };
  if (path.isAbsolute(name)) return { ok: false, reason: "absolute path not allowed" };
  const norm = path.posix.normalize(name.replace(/\\/g, "/"));
  if (norm.startsWith("..") || norm.includes("../")) return { ok: false, reason: "path traversal detected" };
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return { ok: false, reason: "drive/absolute path" };
  return { ok: true };
}

export function assertSafeArchiveEntry(entry: string, destRoot: string): string {
  const v = validateFileName(entry);
  if (!v.ok) throw new Error(`unsafe archive entry '${entry}': ${v.reason}`);
  const resolved = path.resolve(destRoot, entry);
  const root = path.resolve(destRoot) + path.sep;
  if (!resolved.startsWith(root) && resolved !== path.resolve(destRoot)) {
    throw new Error(`path traversal: ${entry}`);
  }
  return resolved;
}

const ALLOWED_UPLOAD_EXT = new Set([".zip", ".gz", ".tgz", ".tar", ".py", ".js", ".ts", ".md", ".json", ".txt", ".log", ".diff", ".patch"]);

export function validateUploadSize(sizeBytes: number, maxMb: number): UploadValidation {
  if (sizeBytes > maxMb * 1024 * 1024) return { ok: false, reason: `file exceeds ${maxMb}MB` };
  return { ok: true };
}

export function validateUploadExt(name: string): UploadValidation {
  const low = name.toLowerCase();
  for (const ext of ALLOWED_UPLOAD_EXT) if (low.endsWith(ext)) return { ok: true };
  return { ok: false, reason: "extension not allowed" };
}

export function detectZipBomb(uncompressed: number, compressed: number): boolean {
  if (compressed <= 0) return uncompressed > 100 * 1024 * 1024;
  return uncompressed / compressed > 100 && uncompressed > 50 * 1024 * 1024;
}
