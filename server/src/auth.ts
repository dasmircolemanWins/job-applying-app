import type { RequestHandler } from "express";

export interface SupabaseUser {
  id: string;
}

declare global {
  namespace Express {
    interface Locals {
      supabaseUser?: SupabaseUser;
    }
  }
}

export interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
}

export interface AuthMiddlewareOptions {
  config?: SupabaseAuthConfig | null;
  fetcher?: typeof fetch;
}

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_UNAVAILABLE = "Hosted authentication is unavailable. Check SUPABASE_URL and SUPABASE_ANON_KEY.";
const ALLOWED_CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_CORS_HEADERS = "Authorization, Content-Type";

function normalizeOrigin(value: string, allowHttpLocalhost: boolean): string | null {
  try {
    const url = new URL(value);
    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
    const isNativeScheme = protocol === "capacitor:" || protocol === "ionic:";
    const isAllowedScheme = protocol === "https:" ||
      (protocol === "http:" && allowHttpLocalhost && isLocalhost) ||
      (isNativeScheme && isLocalhost);
    if (
      !isAllowedScheme ||
      !url.host ||
      (url.pathname !== "/" && !(isNativeScheme && url.pathname === "")) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) return null;
    return `${protocol}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function matchesRequestHost(origin: string, requestHost: string): boolean {
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(`${originUrl.protocol}//${requestHost}`);
    if (
      !requestUrl.host ||
      requestUrl.pathname !== "/" ||
      requestUrl.search ||
      requestUrl.hash ||
      requestUrl.username ||
      requestUrl.password
    ) return false;
    return requestUrl.host.toLowerCase() === originUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

export function readAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.CORS_ALLOWED_ORIGINS;
  if (configured === undefined && env.NODE_ENV !== "production") {
    return ["http://localhost:5173", "http://127.0.0.1:5173"];
  }
  if (!configured?.trim()) return [];

  const origins: string[] = [];
  for (const value of configured.split(",")) {
    const origin = normalizeOrigin(value.trim(), true);
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

export interface CorsMiddlewareOptions {
  allowedOrigins?: string[];
}

export function createApiCorsMiddleware(options: CorsMiddlewareOptions = {}): RequestHandler {
  const allowedOrigins = options.allowedOrigins ?? readAllowedOrigins();
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    res.vary("Origin");
    const requestOrigin = req.get("origin");
    if (!requestOrigin) {
      next();
      return;
    }

    const origin = normalizeOrigin(requestOrigin, true);
    if (!origin) {
      res.status(403).json({ error: "Origin is not allowed by the API CORS policy." });
      return;
    }

    const requestHost = req.get("host");
    if (requestHost && matchesRequestHost(origin, requestHost)) {
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    if (!allowed.has(origin)) {
      res.status(403).json({ error: "Origin is not allowed by the API CORS policy." });
      return;
    }

    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Methods", ALLOWED_CORS_METHODS);
    res.set("Access-Control-Allow-Headers", ALLOWED_CORS_HEADERS);
    res.set("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function readSupabaseAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseAuthConfig | null {
  const rawUrl = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  if (!rawUrl || !anonKey) return null;

  try {
    const url = new URL(rawUrl);
    const localHttp = env.NODE_ENV !== "production" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (
      (url.protocol !== "https:" && !(localHttp && url.protocol === "http:")) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) return null;
    return { url: url.origin, anonKey };
  } catch {
    return null;
  }
}

export async function verifySupabaseAccessToken(
  token: string,
  config: SupabaseAuthConfig,
  fetcher: typeof fetch = fetch,
): Promise<SupabaseUser | null> {
  if (!token || token.length > 16_384 || token.split(".").length !== 3) return null;

  const response = await fetcher(`${config.url}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: config.anonKey,
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("Supabase Auth verification failed");

  const user: unknown = await response.json();
  if (
    !user ||
    typeof user !== "object" ||
    !("id" in user) ||
    typeof user.id !== "string" ||
    !USER_ID_PATTERN.test(user.id)
  ) {
    throw new Error("Supabase Auth returned an invalid user");
  }
  return { id: user.id };
}

export function createSupabaseAuthMiddleware(options: AuthMiddlewareOptions = {}): RequestHandler {
  const config = options.config === undefined ? readSupabaseAuthConfig() : options.config;
  const fetcher = options.fetcher ?? fetch;

  return async (req, res, next) => {
    if (!config) {
      res.status(503).json({ error: AUTH_UNAVAILABLE });
      return;
    }

    const authorization = req.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    const token = match?.[1];
    if (!token || token.length > 16_384) {
      res.status(401).json({ error: "A valid Supabase access token is required." });
      return;
    }

    let user: SupabaseUser | null;
    try {
      user = await verifySupabaseAccessToken(token, config, fetcher);
    } catch {
      res.status(503).json({ error: "Hosted authentication could not be verified. Try again shortly." });
      return;
    }
    if (!user) {
      res.status(401).json({ error: "A valid Supabase access token is required." });
      return;
    }
    res.locals.supabaseUser = user;
    next();
  };
}

export const MULTI_USER_BACKEND_UNAVAILABLE =
  "Production data access is disabled: this deployment still uses the local SQLite data layer. " +
  "PostgreSQL user isolation and private Supabase Storage have not been implemented. No local data is exposed. " +
  "Before enabling APIs, migrate every repository to per-user PostgreSQL/RLS and private storage, and configure Supabase Auth.";

export function productionDataUnavailable(): RequestHandler {
  return (_req, res) => {
    res.status(503).json({ error: MULTI_USER_BACKEND_UNAVAILABLE });
  };
}
