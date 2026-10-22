import { Router, type Request, type Response as ExpressResponse } from "express";
import JSZip from "jszip";
import { readSupabaseAuthConfig } from "../auth.js";
import { HttpError } from "../http.js";

const DATA_TABLES = [
  "settings",
  "profile",
  "rules",
  "stories",
  "resumes",
  "experience_bank",
  "jobs",
  "application_kits",
  "applications",
  "blocked_items",
  "parked_items",
  "agent_runs",
  "daily_reports",
  "assist_sessions",
] as const;
const DELETE_ORDER = [
  "assist_sessions",
  "blocked_items",
  "parked_items",
  "applications",
  "application_kits",
  "daily_reports",
  "agent_runs",
  "experience_bank",
  "resumes",
  "stories",
  "rules",
  "profile",
  "settings",
  "jobs",
] as const;
const BUCKET = "user-files";
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;
const MAX_STORAGE_FILES = 2_000;

export interface AccountRouteOptions {
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function accountContext(req: Request, res: ExpressResponse, env: NodeJS.ProcessEnv) {
  const userId = res.locals.supabaseUser?.id as string | undefined;
  const token = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
  const config = readSupabaseAuthConfig(env);
  if (!userId || !token || !config) throw new Error("Authenticated account context is unavailable");
  return { userId, token, config };
}

function storageObjectUrl(base: string, objectPath: string): string {
  return `${base}/storage/v1/object/authenticated/${BUCKET}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}

async function checkedFetch(fetcher: typeof fetch, input: string, init: RequestInit): Promise<Response> {
  const response = await fetcher(input, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return response;
}

async function listUserFiles(
  fetcher: typeof fetch,
  base: string,
  anonKey: string,
  token: string,
  userId: string,
): Promise<string[]> {
  const pending = [`${userId}`];
  const files: string[] = [];
  while (pending.length) {
    const prefix = pending.pop()!;
    for (let offset = 0; ; offset += 100) {
      const response = await checkedFetch(fetcher, `${base}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: "name", order: "asc" } }),
      });
      const entries: unknown = await response.json();
      if (!Array.isArray(entries)) throw new Error("Supabase Storage returned an invalid file listing");
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string") {
          throw new Error("Supabase Storage returned an invalid file listing");
        }
        const objectPath = `${prefix}/${entry.name}`;
        if ("id" in entry && entry.id === null) pending.push(objectPath);
        else {
          files.push(objectPath);
          if (files.length > MAX_STORAGE_FILES) throw new Error("Account storage exceeds the export limit");
        }
      }
      if (entries.length < 100) break;
    }
  }
  return files;
}

async function assertWorkspaceReady(
  fetcher: typeof fetch,
  base: string,
  anonKey: string,
  token: string,
): Promise<void> {
  try {
    const response = await checkedFetch(fetcher, `${base}/rest/v1/rpc/applypilot_workspace_ready`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (await response.json() !== true) throw new Error("Workspace readiness check failed");
  } catch {
    throw new HttpError(
      503,
      "Hosted account tools are unavailable. Apply the current Supabase migration and verify its RLS and private-storage policies.",
    );
  }
}

async function readRows(
  fetcher: typeof fetch,
  base: string,
  anonKey: string,
  token: string,
  table: string,
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let offset = 0; ; offset += 1_000) {
    const response = await checkedFetch(fetcher, `${base}/rest/v1/${table}?select=*&limit=1000&offset=${offset}`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` },
    });
    const page: unknown = await response.json();
    if (!Array.isArray(page)) throw new Error(`Supabase returned invalid ${table} data`);
    rows.push(...page);
    if (page.length < 1_000) return rows;
  }
}

function jsonAttachment(filename: string): string {
  return `attachment; filename="${filename}"`;
}

export function createAccountRouter(options: AccountRouteOptions = {}) {
  const router = Router();
  const fetcher = options.fetcher ?? fetch;
  const env = options.env ?? process.env;

  router.get("/account/export", async (req, res, next) => {
    try {
      const { userId, token, config } = accountContext(req, res, env);
      await assertWorkspaceReady(fetcher, config.url, config.anonKey, token);
      const zip = new JSZip();
      const workspace: Record<string, unknown[]> = {};
      for (const table of DATA_TABLES) {
        workspace[table] = await readRows(fetcher, config.url, config.anonKey, token, table);
      }
      zip.file("workspace.json", JSON.stringify({
        exportedAt: new Date().toISOString(),
        userId,
        workspace,
      }, null, 2));

      let storageBytes = 0;
      const filePaths = await listUserFiles(fetcher, config.url, config.anonKey, token, userId);
      for (const objectPath of filePaths) {
        const response = await checkedFetch(fetcher, storageObjectUrl(config.url, objectPath), {
          headers: { apikey: config.anonKey, authorization: `Bearer ${token}` },
        });
        const file = Buffer.from(await response.arrayBuffer());
        storageBytes += file.byteLength;
        if (storageBytes > MAX_EXPORT_BYTES) throw new Error("Account storage exceeds the export size limit");
        zip.file(`files/${objectPath.slice(userId.length + 1)}`, file);
      }

      const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      if (archive.byteLength > MAX_EXPORT_BYTES) throw new Error("Account export exceeds the size limit");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", jsonAttachment("applypilot-account-export.zip"));
      res.setHeader("Cache-Control", "private, no-store");
      res.send(archive);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/account", async (req, res, next) => {
    try {
      const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (!serviceKey) {
        res.status(503).json({ error: "Account deletion is unavailable: server-side Supabase admin credentials are not configured." });
        return;
      }
      const { userId, token, config } = accountContext(req, res, env);
      await assertWorkspaceReady(fetcher, config.url, config.anonKey, token);
      const files = await listUserFiles(fetcher, config.url, config.anonKey, token, userId);

      for (let index = 0; index < files.length; index += 100) {
        await checkedFetch(fetcher, `${config.url}/storage/v1/object/${BUCKET}`, {
          method: "DELETE",
          headers: {
            apikey: config.anonKey,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ prefixes: files.slice(index, index + 100) }),
        });
      }
      for (const table of DELETE_ORDER) {
        await checkedFetch(
          fetcher,
          `${config.url}/rest/v1/${table}?owner_id=eq.${encodeURIComponent(userId)}`,
          {
            method: "DELETE",
            headers: {
              apikey: config.anonKey,
              authorization: `Bearer ${token}`,
              prefer: "return=minimal",
            },
          },
        );
      }
      await checkedFetch(fetcher, `${config.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
      });
      res.status(200).json({ deleted: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
