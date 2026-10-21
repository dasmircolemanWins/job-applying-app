/** Tiny structured logger (SPEC §13: no console.log spam). */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : "info";
}

export function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel()]) return;
  const ts = new Date().toISOString();
  let suffix = "";
  if (meta && Object.keys(meta).length > 0) {
    try {
      suffix = " " + JSON.stringify(meta);
    } catch {
      suffix = " [unserializable meta]";
    }
  }
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${suffix}`;
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};

/** Normalise any thrown value to a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
