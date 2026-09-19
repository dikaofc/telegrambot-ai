import fs from "node:fs";
import path from "node:path";
import { assertInsideWorkspace } from "../workspace/manager.js";
import { isProtectedPath } from "../security/secrets.js";
import { ok, fail, type ToolResult } from "./types.js";

export async function readFile(ws: string, target: string, maxBytes = 500_000): Promise<ToolResult> {
  try {
    const resolved = assertInsideWorkspace(ws, target);
    if (isProtectedPath(resolved) && process.env.ALLOW_PROTECTED !== "1") {
      return fail(`protected path denied: ${target}`);
    }
    const st = fs.statSync(resolved);
    if (st.size > maxBytes) {
      const fd = fs.openSync(resolved, "r");
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, 0);
      fs.closeSync(fd);
      return ok(buf.toString("utf8") + `\n...[truncated ${st.size - maxBytes} bytes]`, { duration: 0 });
    }
    return ok(fs.readFileSync(resolved, "utf8"));
  } catch (e) { return fail(String(e)); }
}

export async function writeFile(ws: string, target: string, content: string): Promise<ToolResult> {
  try {
    const resolved = assertInsideWorkspace(ws, target);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    return ok(`wrote ${target} (${content.length} bytes)`, { filesChanged: [target] });
  } catch (e) { return fail(String(e)); }
}

export async function editFile(ws: string, target: string, oldText: string, newText: string, replaceAll = false): Promise<ToolResult> {
  try {
    const resolved = assertInsideWorkspace(ws, target);
    const cur = fs.readFileSync(resolved, "utf8");
    if (!cur.includes(oldText)) return fail("oldString not found");
    const next = replaceAll ? cur.split(oldText).join(newText) : cur.replace(oldText, newText);
    fs.writeFileSync(resolved, next, "utf8");
    return ok(`edited ${target}`, { filesChanged: [target] });
  } catch (e) { return fail(String(e)); }
}

export async function deleteFile(ws: string, target: string): Promise<ToolResult> {
  try {
    const resolved = assertInsideWorkspace(ws, target);
    fs.rmSync(resolved, { recursive: true, force: true });
    return ok(`deleted ${target}`, { filesChanged: [target] });
  } catch (e) { return fail(String(e)); }
}

export async function moveFile(ws: string, src: string, dest: string): Promise<ToolResult> {
  try {
    const s = assertInsideWorkspace(ws, src);
    const d = assertInsideWorkspace(ws, dest);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.renameSync(s, d);
    return ok(`moved ${src} -> ${dest}`, { filesChanged: [src, dest] });
  } catch (e) { return fail(String(e)); }
}

export async function copyFile(ws: string, src: string, dest: string): Promise<ToolResult> {
  try {
    const s = assertInsideWorkspace(ws, src);
    const d = assertInsideWorkspace(ws, dest);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.cpSync(s, d, { recursive: true });
    return ok(`copied ${src} -> ${dest}`, { filesChanged: [dest] });
  } catch (e) { return fail(String(e)); }
}

export async function listDirectory(ws: string, target = "."): Promise<ToolResult> {
  try {
    const resolved = assertInsideWorkspace(ws, target);
    const entries = fs.readdirSync(resolved, { withFileTypes: true }).map((e) => `${e.isDirectory() ? "[dir] " : "[file] "}${e.name}`);
    return ok(entries.join("\n"));
  } catch (e) { return fail(String(e)); }
}

export async function fileExists(ws: string, target: string): Promise<ToolResult> {
  try {
    const resolved = assertInsideWorkspace(ws, target);
    return ok(String(fs.existsSync(resolved)));
  } catch (e) { return fail(String(e)); }
}

export async function fileInfo(ws: string, target: string): Promise<ToolResult> {
  try {
    const resolved = assertInsideWorkspace(ws, target);
    const st = fs.statSync(resolved);
    return ok(JSON.stringify({ size: st.size, mtime: st.mtime, isDir: st.isDirectory() }));
  } catch (e) { return fail(String(e)); }
}
