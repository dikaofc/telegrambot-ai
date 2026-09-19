import { spawn, type ChildProcess } from "node:child_process";

/**
 * PTY-backed process manager. Uses node-pty when available, otherwise falls
 * back to a piped child_process with streaming + stdin + signals (real
 * execution in both paths — never simulated).
 */
export interface PtySession {
  id: string;
  pid?: number;
  alive: boolean;
  write(data: string): void;
  interrupt(): void;
  kill(signal?: NodeJS.Signals): void;
  onData(cb: (data: string) => void): void;
  wait(timeoutMs?: number): Promise<{ exitCode: number; output: string }>;
}

let counter = 0;
let ptyImpl: unknown = null;
let ptyTried = false;

async function getPty(): Promise<unknown> {
  if (ptyTried) return ptyImpl;
  ptyTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-expect-error optional peer: node-pty may not be installed
    ptyImpl = await import("node-pty").then((m: any) => m.default ?? m);
  } catch { ptyImpl = null; }
  return ptyImpl;
}

export async function spawnPty(command: string, cwd: string, cols = 120, rows = 30): Promise<PtySession> {
  const pty = await getPty();
  const id = `pty-${Date.now()}-${++counter}`;
  if (pty && typeof (pty as { spawn?: unknown }).spawn === "function") {
    const spawnFn = (pty as { spawn: (...a: unknown[]) => unknown }).spawn;
    const proc = spawnFn("bash", ["-lc", command], {
      name: "xterm-256color", cols, rows, cwd,
      env: { ...process.env, TERM: "xterm-256color", WORKSPACE: cwd } as Record<string, string>,
    }) as { pid: number; write(s: string): void; kill(s?: string): void; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number; signal?: string }) => void): void };
    let output = "";
    let exitCode: number | null = null;
    const dataCbs: Array<(d: string) => void> = [];
    const exitCbs: Array<(code: number) => void> = [];
    proc.onData((d) => { output += d; for (const c of dataCbs) c(d); });
    proc.onExit((e) => { exitCode = e.exitCode !== 0 ? e.exitCode : (e.signal ? 143 : 0); for (const c of exitCbs) c(exitCode as number); });
    return {
      id, pid: proc.pid, alive: true,
      write: (d) => proc.write(d),
      interrupt: () => { try { process.kill(proc.pid, "SIGINT"); } catch { /* noop */ } },
      kill: (s = "SIGTERM") => { try { proc.kill(s); } catch { /* noop */ } },
      onData: (cb) => { dataCbs.push(cb); },
      wait: (timeoutMs = 600_000) => new Promise((resolve, reject) => {
        if (exitCode !== null) return resolve({ exitCode, output });
        const t = setTimeout(() => reject(new Error("pty timeout")), timeoutMs);
        exitCbs.push((code) => { clearTimeout(t); resolve({ exitCode: code, output }); });
      }),
    };
  }
  // fallback: piped process with identical interface
  const child: ChildProcess = spawn("bash", ["-lc", command], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const dataCbs: Array<(d: string) => void> = [];
  child.stdout?.on("data", (d) => { output += String(d); for (const c of dataCbs) c(String(d)); });
  child.stderr?.on("data", (d) => { output += String(d); for (const c of dataCbs) c(String(d)); });
  return {
    id, pid: child.pid, alive: true,
    write: (d) => { child.stdin?.write(d); },
    interrupt: () => { try { child.kill("SIGINT"); } catch { /* noop */ } },
    kill: (s = "SIGTERM") => { try { child.kill(s); } catch { /* noop */ } },
    onData: (cb) => { dataCbs.push(cb); },
    wait: (timeoutMs = 600_000) => new Promise((resolve, reject) => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } reject(new Error("process timeout")); }, timeoutMs);
      child.on("close", (code, signal) => { clearTimeout(t); resolve({ exitCode: code ?? (signal ? 143 : 0), output }); });
      child.on("error", (e) => { clearTimeout(t); reject(e); });
    }),
  };
}
