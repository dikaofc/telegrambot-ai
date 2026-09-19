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
  instance.exec("PRAGMA journal_mode = WAL;");
  dbPath = url;
  runMigrations(instance);
  return instance;
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
  const candidates = [
    path.resolve("migrations/001_init.sql"),
    path.resolve(process.cwd(), "migrations/001_init.sql"),
  ];
  let sql: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { sql = fs.readFileSync(c, "utf8"); break; }
  }
  if (!sql) sql = fallbackSchema();
  db.exec(sql);
}

function fallbackSchema(): string {
  return `
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, telegram_id TEXT UNIQUE, username TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT, chat_id TEXT, workspace_id TEXT, provider TEXT, model TEXT, runtime TEXT, status TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
  `;
}
