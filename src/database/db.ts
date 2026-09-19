import fs from "node:fs";
import path from "node:path";

export type SQLInputValue = null | number | bigint | string | Uint8Array;
export interface StatementSync {
  run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
  all(...params: SQLInputValue[]): Array<Record<string, SQLInputValue>>;
}
export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

function loadDatabaseSync(): new (path: string) => DatabaseSync {
  // process.getBuiltinModule avoids static "node:sqlite" specifiers so the
  // Vite/Vitest transform pipeline never tries to resolve them.
  const mod = (process as unknown as { getBuiltinModule(id: string): { DatabaseSync: new (p: string) => DatabaseSync } }).getBuiltinModule("node:sqlite");
  if (!mod?.DatabaseSync) throw new Error("node:sqlite is unavailable (Node >= 22.5 required)");
  return mod.DatabaseSync;
}

let instance: DatabaseSync | null = null;
let dbPath = "";

/** Every table the harness writes to. Missing ones are repaired on open. */
export const EXPECTED_TABLES = [
  "users", "chats", "workspaces", "sessions", "messages", "agent_runs", "tool_calls",
  "approvals", "providers", "models", "settings", "usage", "audit_logs",
  "processed_updates", "checkpoints", "memory",
] as const;

/**
 * Locate `migrations/001_init.sql` by module path first, then cwd. cwd alone is
 * not good enough: `node dist/apps/api/src/index.js` from another directory (or a
 * unit file with a different WorkingDirectory) used to miss the file and fall
 * back to a stripped-down schema — which is how a database can end up with only
 * `users` and `sessions` and then 500 on "no such table: agent_runs".
 */
export function migrationSqlPath(): string | null {
  const candidates: string[] = [];
  try {
    // db.ts → src/database, db.js → dist/src/database: three levels up is the repo root
    candidates.push(new URL("../../../migrations/001_init.sql", import.meta.url).pathname);
  } catch { /* non-file runtime */ }
  candidates.push(path.resolve("migrations/001_init.sql"));
  candidates.push(path.resolve(process.cwd(), "migrations/001_init.sql"));
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* try next */ }
  }
  return null;
}

function missingTables(db: DatabaseSync): string[] {
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const have = new Set(rows.map((r) => String(r.name)));
    return EXPECTED_TABLES.filter((t) => !have.has(t));
  } catch {
    return [...EXPECTED_TABLES];
  }
}

/**
 * Apply the schema idempotently and prove it landed. Never leaves the process
 * running against a half-created database: either the tables exist afterwards or
 * this throws with the exact tables and file path that are broken.
 */
export function ensureSchema(db: DatabaseSync = getDb()): { applied: boolean; repaired: string[] } {
  const before = missingTables(db);
  if (before.length === 0) return { applied: false, repaired: [] };
  const sqlPath = migrationSqlPath();
  const sql = sqlPath ? fs.readFileSync(sqlPath, "utf8") : null;
  if (!sql) {
    throw new Error(
      `schema database tidak bisa dibuat: migrations/001_init.sql tidak ditemukan (cwd=${process.cwd()}). ` +
      `Tabel hilang: ${before.join(", ")}. Jalankan dari root project atau pastikan folder migrations ikut ter-deploy.`,
    );
  }
  db.exec(sql);
  const after = missingTables(db);
  if (after.length > 0) {
    throw new Error(`schema database belum lengkap setelah migrasi: ${after.join(", ")} (db=${dbPath || "?"})`);
  }
  return { applied: true, repaired: before };
}

export function openDatabase(dbUrl?: string): DatabaseSync {
  const url = dbUrl ?? process.env.DATABASE_URL ?? "./data/teleagent.db";
  if (instance && dbPath === url) return instance;
  if (url.startsWith("postgres")) {
    throw new Error("Postgres requires DATABASE_URL sqlite for single-node; configure Postgres via docker-compose for scale mode");
  }
  const file = url.replace(/^sqlite:/, "").replace(/^file:/, "");
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const Ctor = loadDatabaseSync();
  instance = new Ctor(file);
  dbPath = url;
  instance.exec("PRAGMA journal_mode = WAL;");
  instance.exec("PRAGMA busy_timeout = 5000;");
  runMigrations(instance);
  return instance;
}

/**
 * Repair a database that is missing tables *while the process is running* — so a
 * dashboard tab recovers instead of 500ing until the next restart. Cached: the
 * check runs once per process until a query actually reports a missing table.
 */
export function withSchemaRepair<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const msg = String((e as { message?: string }).message ?? e);
    if (!/no such table/i.test(msg)) throw e;
    ensureSchema();
    return fn();
  }
}

export function getDb(): DatabaseSync {
  if (!instance) return openDatabase();
  return instance;
}

export function closeDatabase(): void {
  try { instance?.close(); } catch { /* noop */ }
  instance = null;
  dbPath = "";
}

function runMigrations(db: DatabaseSync): void {
  ensureSchema(db);
}
