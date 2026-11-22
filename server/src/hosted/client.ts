import type { Request, Response } from "express";
import { readSupabaseAuthConfig } from "../auth.js";
import { HttpError } from "../http.js";

export interface HostedOptions {
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface HostedContext {
  base: string;
  anonKey: string;
  token: string;
  ownerId: string;
  fetcher: typeof fetch;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hostedContext(req: Request, res: Response, options: HostedOptions): HostedContext {
  const ownerId = res.locals.supabaseUser?.id;
  const token = res.locals.supabaseAccessToken ??
    /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
  const config = readSupabaseAuthConfig(options.env);
  if (!ownerId || !uuid.test(ownerId) || !token || !config) {
    throw new HttpError(503, "Hosted data access is unavailable. Verify Supabase configuration and authentication.");
  }
  return { base: config.url, anonKey: config.anonKey, token, ownerId, fetcher: options.fetcher ?? fetch };
}

function headers(ctx: HostedContext, extra?: RequestInit["headers"]): Headers {
  const result = new globalThis.Headers(extra);
  result.set("apikey", ctx.anonKey);
  result.set("authorization", `Bearer ${ctx.token}`);
  return result;
}

export async function hostedRequest(
  ctx: HostedContext,
  path: string,
  init: RequestInit = {},
): Promise<globalThis.Response> {
  let response: globalThis.Response;
  try {
    response = await ctx.fetcher(`${ctx.base}${path}`, {
      ...init,
      headers: headers(ctx, init.headers),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HttpError(503, "Hosted data service is temporarily unavailable.");
  }
  if (!response.ok) {
    if (response.status === 404) throw new HttpError(404, "Record not found");
    if (response.status === 409) throw new HttpError(409, "The requested change conflicts with existing workspace data.");
    if (response.status === 400 || response.status === 422) {
      throw new HttpError(400, "The hosted data service rejected this request.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(503, "Hosted data access is unavailable. Verify the workspace migration and RLS policies.");
    }
    throw new HttpError(503, "Hosted data service is temporarily unavailable.");
  }
  return response;
}

export function tablePath(ctx: HostedContext, table: string, filters: Record<string, string> = {}): string {
  const params = new URLSearchParams({ select: "*", ...filters, owner_id: `eq.${ctx.ownerId}` });
  return `/rest/v1/${table}?${params.toString()}`;
}

export async function selectRows<T extends Record<string, unknown>>(
  ctx: HostedContext,
  table: string,
  filters: Record<string, string> = {},
  suffix = "",
): Promise<T[]> {
  const response = await hostedRequest(ctx, `${tablePath(ctx, table, filters)}${suffix}`, {
    headers: { accept: "application/json" },
  });
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new HttpError(503, "Hosted data service returned an invalid response.");
  return rows as T[];
}

export async function selectPage<T extends Record<string, unknown>>(
  ctx: HostedContext,
  table: string,
  filters: Record<string, string>,
  suffix: string,
  limit: number,
  offset: number,
): Promise<{ rows: T[]; total: number }> {
  const response = await hostedRequest(
    ctx,
    `${tablePath(ctx, table, filters)}${suffix}&limit=${limit}&offset=${offset}`,
    { headers: { accept: "application/json", Prefer: "count=exact" } },
  );
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new HttpError(503, "Hosted data service returned an invalid response.");
  const totalText = response.headers.get("content-range")?.split("/")[1];
  const total = totalText && totalText !== "*" && Number.isFinite(Number(totalText)) ? Number(totalText) : rows.length;
  return { rows: rows as T[], total };
}

export async function selectAllRows<T extends Record<string, unknown>>(
  ctx: HostedContext,
  table: string,
  filters: Record<string, string> = {},
  suffix = "",
): Promise<T[]> {
  const result: T[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const page = await selectRows<T>(ctx, table, filters, `${suffix}&limit=1000&offset=${offset}`);
    result.push(...page);
    if (page.length < 1_000) return result;
  }
}

export async function insertRow<T extends Record<string, unknown>>(
  ctx: HostedContext,
  table: string,
  row: Record<string, unknown>,
): Promise<T> {
  const response = await hostedRequest(ctx, `/rest/v1/${table}?select=*`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ ...row, owner_id: ctx.ownerId }),
  });
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== "object") {
    throw new HttpError(503, "Hosted data service returned an invalid response.");
  }
  return rows[0] as T;
}

export async function updateRows<T extends Record<string, unknown>>(
  ctx: HostedContext,
  table: string,
  filters: Record<string, string>,
  patch: Record<string, unknown>,
): Promise<T[]> {
  const response = await hostedRequest(ctx, tablePath(ctx, table, filters), {
    method: "PATCH",
    headers: { "content-type": "application/json", accept: "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ ...patch, owner_id: ctx.ownerId }),
  });
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new HttpError(503, "Hosted data service returned an invalid response.");
  return rows as T[];
}

export async function deleteRows(
  ctx: HostedContext,
  table: string,
  filters: Record<string, string>,
): Promise<void> {
  await hostedRequest(ctx, tablePath(ctx, table, filters), { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

export function storageObjectPath(ownerId: string, category: string, filename: string): string {
  return `/storage/v1/object/user-files/${[ownerId, category, filename].map(encodeURIComponent).join("/")}`;
}

export function storageAuthenticatedPath(objectPath: string): string {
  return `/storage/v1/object/authenticated/user-files/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}
