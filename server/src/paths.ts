import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server/src -> server -> ApplyPilot
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(HERE, "..");
export const ROOT = path.resolve(SERVER_DIR, "..");

export const DATA_DIR = process.env.APPLYPILOT_DATA_DIR ?? path.join(ROOT, "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
export const TAILORED_DIR = path.join(DATA_DIR, "tailored");
export const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, "browser-profile");
export const DB_PATH = process.env.APPLYPILOT_DB ?? path.join(DATA_DIR, "applypilot.db");
export const WEB_DIST_DIR = path.join(ROOT, "web", "dist");

export const RUNTIME_DIRS = [DATA_DIR, UPLOADS_DIR, TAILORED_DIR, SCREENSHOTS_DIR, BROWSER_PROFILE_DIR];

/** Create every runtime directory (idempotent). Called before the DB is opened. */
export function ensureDirs(): void {
  for (const dir of RUNTIME_DIRS) fs.mkdirSync(dir, { recursive: true });
  const dbDir = path.dirname(DB_PATH);
  fs.mkdirSync(dbDir, { recursive: true });
}

/** SPEC §13: `[^A-Za-z0-9._-]` → `_`, max 80 chars. */
export function sanitizeFilename(name: string, max = 80): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_");
  return cleaned.slice(0, max) || "file";
}
