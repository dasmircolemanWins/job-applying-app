import { get, nowIso, run } from "./db.js";
import {
  DEFAULT_DAILY_TARGET,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_LEVELS,
  MOCK_MODES,
  type Effort,
  type MockMode,
} from "../../shared/types.js";

export {
  ROOT,
  SERVER_DIR,
  DATA_DIR,
  UPLOADS_DIR,
  TAILORED_DIR,
  SCREENSHOTS_DIR,
  BROWSER_PROFILE_DIR,
  DB_PATH,
  WEB_DIST_DIR,
  ensureDirs,
  sanitizeFilename,
} from "./paths.js";

export const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 4310;
export const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** Keys stored in the `settings` table. */
export const SETTING_KEYS = [
  "anthropic_api_key",
  "model",
  "effort",
  "auto_submit",
  "imap_host",
  "imap_port",
  "imap_user",
  "imap_password",
  "imap_folder",
  "daily_target",
  "mock_mode",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const SETTING_DEFAULTS: Record<SettingKey, string> = {
  anthropic_api_key: "",
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  auto_submit: "0",
  imap_host: "",
  imap_port: "993",
  imap_user: "",
  imap_password: "",
  imap_folder: "INBOX",
  daily_target: String(DEFAULT_DAILY_TARGET),
  mock_mode: "auto",
};

interface SettingRow {
  value: string | null;
}

/** Raw value from the settings table, or null when unset/empty. */
export function readSetting(key: SettingKey): string | null {
  const row = get<SettingRow>("SELECT value FROM settings WHERE key = ?", key);
  if (!row || row.value === null || row.value === "") return null;
  return row.value;
}

/** Stored value falling back to the documented default. */
export function readSettingOrDefault(key: SettingKey): string {
  return readSetting(key) ?? SETTING_DEFAULTS[key];
}

/** Upsert a setting; `null` or empty clears it. */
export function writeSetting(key: SettingKey, value: string | null): void {
  const ts = nowIso();
  run(
    `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value ?? "",
    ts,
    ts,
  );
}

/** API key: settings table first, then the environment. */
export function resolveApiKey(): string | null {
  const saved = readSetting("anthropic_api_key");
  if (saved) return saved.trim();
  const env = process.env.ANTHROPIC_API_KEY?.trim();
  return env ? env : null;
}

export function apiKeySource(): "settings" | "env" | "none" {
  if (readSetting("anthropic_api_key")) return "settings";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "env";
  return "none";
}

export function readMockMode(): MockMode {
  const raw = readSettingOrDefault("mock_mode");
  return (MOCK_MODES as readonly string[]).includes(raw) ? (raw as MockMode) : "auto";
}

/** Mock mode: `on` forces mock, `off` forces real, `auto` = mock only when no key. */
export function isMockActive(): boolean {
  const mode = readMockMode();
  if (mode === "on") return true;
  if (mode === "off") return false;
  return resolveApiKey() === null;
}

export function readModel(): string {
  return readSettingOrDefault("model");
}

export function readEffort(): Effort {
  const raw = readSettingOrDefault("effort");
  return (EFFORT_LEVELS as readonly string[]).includes(raw) ? (raw as Effort) : DEFAULT_EFFORT;
}

export function readAutoSubmit(): boolean {
  return readSettingOrDefault("auto_submit") === "1";
}

export function readDailyTarget(): number {
  const n = Number.parseInt(readSettingOrDefault("daily_target"), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_TARGET;
}

/** `sk-ant-…last4` for display; empty string when no key. */
export function maskApiKey(key: string | null): string {
  if (!key) return "";
  const last4 = key.slice(-4);
  return `sk-ant-…${last4}`;
}
