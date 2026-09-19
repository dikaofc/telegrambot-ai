import type { ToolResult } from "./types.js";
import { ok, fail } from "./types.js";

/**
 * Browser tool — isolated-worker ready architecture. A real worker can be
 * injected (puppeteer/playwright endpoint); without one the tool reports
 * unavailability instead of faking results.
 */
export interface BrowserWorker {
  navigate(url: string): Promise<string>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  extract(selector?: string): Promise<string>;
  screenshot(): Promise<Buffer>;
}

let worker: BrowserWorker | null = null;

export function setBrowserWorker(w: BrowserWorker | null): void { worker = w; }
export function hasBrowserWorker(): boolean { return worker !== null; }

function requireWorker(): BrowserWorker {
  if (!worker) throw new Error("browser worker not configured — set BROWSER_WS_URL / worker to enable");
  return worker;
}

export async function browserNavigate(url: string): Promise<ToolResult> {
  try { const content = await requireWorker().navigate(url); return ok(content.slice(0, 50_000)); }
  catch (e) { return fail(String(e)); }
}

export async function browserClick(selector: string): Promise<ToolResult> {
  try { await requireWorker().click(selector); return ok(`clicked ${selector}`); }
  catch (e) { return fail(String(e)); }
}

export async function browserType(selector: string, text: string): Promise<ToolResult> {
  try { await requireWorker().type(selector, text); return ok(`typed into ${selector}`); }
  catch (e) { return fail(String(e)); }
}

export async function browserExtract(selector?: string): Promise<ToolResult> {
  try { const t = await requireWorker().extract(selector); return ok(t.slice(0, 50_000)); }
  catch (e) { return fail(String(e)); }
}
