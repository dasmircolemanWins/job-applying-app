import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DB_PATH, ensureDirs } from "./paths.js";
import { logger } from "./log.js";
import {
  DEFAULT_RULES,
  DEFAULT_STANDING_FACTS,
  DEFAULT_STORIES,
} from "../../shared/types.js";

export type DbParam = SQLInputValue;

ensureDirs();

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

/** ISO 8601 UTC timestamp for `created_at` / `updated_at`. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse a JSON column; returns `fallback` for null/empty/invalid text. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function all<T>(sql: string, ...params: DbParam[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(sql: string, ...params: DbParam[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export function run(sql: string, ...params: DbParam[]): RunResult {
  const r = db.prepare(sql).run(...params);
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/** Run `fn` inside a transaction; rolls back on throw. */
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Migrations (SPEC §3) — idempotent, run on startup.
// ---------------------------------------------------------------------------

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facts_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rules_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS resumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    is_base INTEGER NOT NULL DEFAULT 0,
    parsed_json TEXT,
    skills_json TEXT,
    uploaded_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS experience_bank (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_json TEXT NOT NULL,
    built_from_json TEXT NOT NULL DEFAULT '[]',
    built_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'manual',
    url TEXT,
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    remote_type TEXT NOT NULL DEFAULT 'unknown',
    pay_min REAL,
    pay_max REAL,
    pay_currency TEXT,
    description_text TEXT NOT NULL DEFAULT '',
    parsed_json TEXT,
    qualification_json TEXT,
    ats_vendor TEXT NOT NULL DEFAULT 'unknown',
    posting_id TEXT,
    board TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    status_reason TEXT,
    fit_score REAL,
    dedupe_key TEXT NOT NULL,
    found_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key)`,
  `CREATE TABLE IF NOT EXISTS application_kits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
    selected_resume_id INTEGER,
    selection_json TEXT,
    tailored_json TEXT,
    honesty_json TEXT,
    keyword_json TEXT,
    answers_json TEXT NOT NULL DEFAULT '[]',
    cover_letter TEXT NOT NULL DEFAULT '',
    pdf_path TEXT,
    docx_path TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
    company TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    posting_id TEXT,
    route TEXT NOT NULL DEFAULT 'manual',
    resume_file TEXT,
    submitted_at TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_applications_submitted ON applications(submitted_at)`,
  `CREATE TABLE IF NOT EXISTS blocked_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT 'other',
    action_text TEXT NOT NULL DEFAULT '',
    link TEXT,
    resume_file TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS parked_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    reason TEXT NOT NULL DEFAULT '',
    retry_plan TEXT NOT NULL DEFAULT '',
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    job_id INTEGER,
    model TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    mock INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at)`,
  `CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    submitted INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    line_text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assist_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'starting',
    field_map_json TEXT NOT NULL DEFAULT '{}',
    log_json TEXT NOT NULL DEFAULT '[]',
    screenshot_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

export function migrate(): void {
  transaction(() => {
    for (const sql of MIGRATIONS) db.exec(sql);
  });
}

/** Seed profile row id=1, rules row id=1 and the six playbook stories (idempotent). */
export function seed(): void {
  const ts = nowIso();
  transaction(() => {
    run(
      "INSERT OR IGNORE INTO profile (id, facts_json, created_at, updated_at) VALUES (1, ?, ?, ?)",
      JSON.stringify(DEFAULT_STANDING_FACTS),
      ts,
      ts,
    );
    run(
      "INSERT OR IGNORE INTO rules (id, rules_json, created_at, updated_at) VALUES (1, ?, ?, ?)",
      JSON.stringify(DEFAULT_RULES),
      ts,
      ts,
    );
    for (const s of DEFAULT_STORIES) {
      run(
        "INSERT OR IGNORE INTO stories (key, title, body, approved, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        s.key,
        s.title,
        s.body,
        s.approved ? 1 : 0,
        ts,
        ts,
      );
    }
  });
}

export function initDb(): void {
  migrate();
  seed();
  logger.info("database ready", { path: DB_PATH });
}

initDb();
