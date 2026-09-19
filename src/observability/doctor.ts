import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { getEnv } from "../config/env.js";
import { getDb } from "../database/db.js";
import { workspaceRoot } from "../workspace/manager.js";
import { createProvider } from "../providers/factory.js";
import { circuitSnapshot } from "../providers/circuit.js";

export type DoctorStatus = "pass" | "warn" | "fail";
export interface DoctorCheck { name: string; status: DoctorStatus; detail: string; hint?: string; }
export interface DoctorReport { status: "ok" | "warn" | "fail"; checks: DoctorCheck[]; generatedAt: string; }

const GB = 1024 ** 3;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const gate = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms); });
  return Promise.race([p, gate]).finally(() => clearTimeout(t!)) as Promise<T>;
}

async function checkDatabase(): Promise<DoctorCheck> {
  try {
    const r = getDb().prepare("SELECT 1 AS ok, COUNT(*) AS sessions FROM sessions").get() as { ok: number; sessions: number };
    return { name: "database", status: "pass", detail: `sqlite readable, ${r.sessions} sessions` };
  } catch (e) { return { name: "database", status: "fail", detail: String(e).slice(0, 200), hint: "cek DATABASE_URL + permission file data/" }; }
}

async function checkWorkspace(): Promise<DoctorCheck> {
  try {
    const root = workspaceRoot();
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, ".teleagent-write-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return { name: "workspace", status: "pass", detail: `writable: ${root}` };
  } catch (e) { return { name: "workspace", status: "fail", detail: String(e).slice(0, 200), hint: "cek WORKSPACE_ROOT + permission" }; }
}

async function checkDisk(): Promise<DoctorCheck> {
  try {
    const st = fs.statfsSync(workspaceRoot());
    const freeGb = (st.bavail * st.bsize) / GB;
    const detail = `${freeGb.toFixed(1)} GB free`;
    if (freeGb < 0.5) return { name: "disk", status: "fail", detail, hint: "disk hampir penuh — bersihkan data/logs" };
    if (freeGb < 2) return { name: "disk", status: "warn", detail, hint: "ruang disk menipis" };
    return { name: "disk", status: "pass", detail };
  } catch { return { name: "disk", status: "warn", detail: "statfs unavailable on this platform" }; }
}

async function checkMemory(): Promise<DoctorCheck> {
  const freeMb = Math.round(os.freemem() / 1024 ** 2);
  const totalMb = Math.round(os.totalmem() / 1024 ** 2);
  const detail = `${freeMb} MB free / ${totalMb} MB total`;
  if (freeMb < 128) return { name: "memory", status: "fail", detail, hint: "RAM kritis — kurangi MAX_CONCURRENT_RUNS" };
  if (freeMb < 256) return { name: "memory", status: "warn", detail };
  return { name: "memory", status: "pass", detail };
}

async function checkProvider(): Promise<DoctorCheck[]> {
  const env = getEnv();
  const out: DoctorCheck[] = [];
  try {
    const p = createProvider(env.PROVIDER);
    const healthy = await withTimeout(p.health(), 10_000, "provider health");
    const models = healthy ? await withTimeout(p.models(), 10_000, "provider models").catch(() => [] as string[]) : [];
    out.push(healthy
      ? { name: "provider", status: "pass", detail: `${env.PROVIDER} reachable, ${models.length} models` }
      : { name: "provider", status: "fail", detail: `${env.PROVIDER} unreachable`, hint: "cek PROVIDER_API_KEY / PROVIDER_BASE_URL / /providers" });
  } catch (e) {
    out.push({ name: "provider", status: "fail", detail: String(e).slice(0, 200), hint: "cek PROVIDER_API_KEY / PROVIDER_BASE_URL" });
  }
  const tripped = Object.entries(circuitSnapshot()).filter(([, s]) => !s.available).map(([n]) => n);
  out.push(tripped.length
    ? { name: "circuit", status: "warn", detail: `cooldown: ${tripped.join(", ")}`, hint: "upstream flaky — fallback aktif" }
    : { name: "circuit", status: "pass", detail: "no tripped providers" });
  return out;
}

async function checkGraphify(): Promise<DoctorCheck> {
  try {
    const bin = process.env.GRAPHIFY_BIN || "graphify";
    const out = await withTimeout(new Promise<string>((res, rej) => {
      execFile(bin, ["--version"], { timeout: 8000 }, (e, stdout, stderr) => e ? rej(e) : res(String(stdout || stderr).trim()));
    }), 10_000, "graphify version");
    return { name: "graphify", status: "pass", detail: out.slice(0, 100) || "binary present" };
  } catch {
    return { name: "graphify", status: "warn", detail: "graphify CLI tidak ditemukan", hint: "graph tab butuh GRAPHIFY_BIN; agent tetap jalan tanpa itu" };
  }
}

async function checkSandbox(): Promise<DoctorCheck> {
  try {
    const { execCommand } = await import("../tools/shell.js");
    const r = await execCommand("echo doctor-ok", { cwd: workspaceRoot(), timeoutMs: 15_000 });
    return r.success && (r.output ?? "").includes("doctor-ok")
      ? { name: "sandbox", status: "pass", detail: "shell exec ok" }
      : { name: "sandbox", status: "fail", detail: (r.error ?? r.output ?? "command failed").slice(0, 200) };
  } catch (e) { return { name: "sandbox", status: "fail", detail: String(e).slice(0, 200) }; }
}

async function checkPty(): Promise<DoctorCheck> {
  try {
    const m = await import("node:child_process");
    m.execSync("echo pty-ok", { timeout: 8000 });
    let detail = "child_process fallback";
    try {
      // @ts-expect-error optional peer dependency: node-pty may not be installed
      await import("node-pty");
      detail = "node-pty available";
    } catch { /* fallback */ }
    return { name: "pty", status: "pass", detail };
  } catch (e) { return { name: "pty", status: "fail", detail: String(e).slice(0, 200) }; }
}

function checkTelegram(): DoctorCheck {
  const t = getEnv().TELEGRAM_BOT_TOKEN;
  if (/^\d+:[A-Za-z0-9_-]{20,}$/.test(t)) return { name: "telegram", status: "pass", detail: "token present, format valid" };
  if (t) return { name: "telegram", status: "warn", detail: "token present tapi format aneh", hint: "cek format token dari BotFather" };
  return { name: "telegram", status: "fail", detail: "TELEGRAM_BOT_TOKEN kosong", hint: "isi di .env lalu restart" };
}

function checkNode(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 22
    ? { name: "node", status: "pass", detail: `v${process.versions.node}` }
    : { name: "node", status: "fail", detail: `v${process.versions.node} — butuh >=22`, hint: "upgrade Node (node:sqlite butuh 22.5+)" };
}

/** Full self-diagnostics with actionable PASS/WARN/FAIL per subsystem. */
export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    checkTelegram(),
    checkNode(),
    await checkDatabase(),
    await checkWorkspace(),
    await checkDisk(),
    await checkMemory(),
    ...(await checkProvider()),
    await checkGraphify(),
    await checkSandbox(),
    await checkPty(),
  ];
  const status = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  return { status, checks, generatedAt: new Date().toISOString() };
}

export function renderDoctorText(r: DoctorReport): string {
  const icon = (s: DoctorStatus): string => (s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌");
  const lines = [`🩺 doctor — ${r.status}`, ""];
  for (const c of r.checks) {
    lines.push(`${icon(c.status)} ${c.name}: ${c.detail}`);
    if (c.hint) lines.push(`   → ${c.hint}`);
  }
  return lines.join("\n").slice(0, 3500);
}
