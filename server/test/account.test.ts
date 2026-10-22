import assert from "node:assert/strict";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { test } from "node:test";
import JSZip from "jszip";
import { createAccountRouter } from "../src/routes/account.js";

const userId = "c47a7cc4-69e8-4b80-9aa1-4f59f6b7b44c";
const baseEnv = {
  NODE_ENV: "production",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "public-anon-key",
};

async function withAccountServer(
  fetcher: typeof fetch,
  env: NodeJS.ProcessEnv,
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.supabaseUser = { id: userId };
    next();
  });
  app.use(createAccountRouter({ fetcher, env }));
  const testErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : 500).json({ error: error instanceof Error ? error.message : "Request failed" });
  };
  app.use(testErrorHandler);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function listReply(prefix: string) {
  if (prefix === userId) return [{ name: "resumes", id: null }];
  if (prefix === `${userId}/resumes`) return [{ name: "source.txt", id: "object-id" }];
  return [];
}

test("account export includes user-isolated rows and private files in a no-store archive", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/rest/v1/rpc/applypilot_workspace_ready")) return new Response("true", { status: 200 });
    if (url.endsWith("/storage/v1/object/list/user-files")) {
      const body = JSON.parse(String(init?.body)) as { prefix: string };
      return new Response(JSON.stringify(listReply(body.prefix)), { status: 200 });
    }
    if (url.includes("/storage/v1/object/authenticated/user-files/")) {
      return new Response("resume-content", { status: 200 });
    }
    if (url.includes("/rest/v1/")) return new Response("[]", { status: 200 });
    throw new Error(`Unexpected URL ${url}`);
  };

  await withAccountServer(fetcher, baseEnv, async base => {
    const response = await fetch(`${base}/account/export`, { headers: { authorization: "Bearer user-token" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    const exportData = JSON.parse(await zip.file("workspace.json")!.async("text")) as {
      userId: string;
      workspace: Record<string, unknown[]>;
    };
    assert.equal(exportData.userId, userId);
    assert.ok(Object.hasOwn(exportData.workspace, "jobs"));
    assert.ok(Object.hasOwn(exportData.workspace, "resumes"));
    assert.equal(await zip.file("files/resumes/source.txt")!.async("text"), "resume-content");
  });

  assert.ok(requests.some(({ url }) => url.includes(`/rest/v1/jobs?`)));
  assert.ok(requests.some(({ url }) => url.endsWith("/rest/v1/rpc/applypilot_workspace_ready")));
  assert.ok(requests.some(({ url }) =>
    url.endsWith(`${userId}/resumes/source.txt`) &&
    url.includes("/storage/v1/object/authenticated/user-files/"),
  ));
  assert.ok(requests.every(({ init }) => new Headers(init?.headers).get("authorization") === "Bearer user-token"));
});

test("account deletion fails closed before touching data without server admin credentials", async () => {
  let fetchCalls = 0;
  const fetcher: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response("[]");
  };
  await withAccountServer(fetcher, baseEnv, async base => {
    const response = await fetch(`${base}/account`, { method: "DELETE", headers: { authorization: "Bearer user-token" } });
    assert.equal(response.status, 503);
    assert.equal(fetchCalls, 0);
  });
});

test("account deletion removes only the authenticated user's storage and rows before Auth identity", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const serviceKey = "server-only-admin-key";
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/rest/v1/rpc/applypilot_workspace_ready")) return new Response("true", { status: 200 });
    if (url.endsWith("/storage/v1/object/list/user-files")) {
      const body = JSON.parse(String(init?.body)) as { prefix: string };
      return new Response(JSON.stringify(listReply(body.prefix)), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
  const env = { ...baseEnv, SUPABASE_SERVICE_ROLE_KEY: serviceKey };

  await withAccountServer(fetcher, env, async base => {
    const response = await fetch(`${base}/account`, { method: "DELETE", headers: { authorization: "Bearer user-token" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true });
  });

  const adminCall = calls.at(-1)!;
  assert.match(adminCall.url, new RegExp(`/auth/v1/admin/users/${userId}$`));
  assert.equal(new Headers(adminCall.init?.headers).get("authorization"), `Bearer ${serviceKey}`);
  const rowDeletes = calls.filter(({ url, init }) => url.includes("/rest/v1/") && init?.method === "DELETE");
  assert.ok(rowDeletes.length > 0);
  assert.ok(rowDeletes.every(({ url }) => url.includes(`owner_id=eq.${userId}`)));
  const storageDelete = calls.find(({ url, init }) => url.endsWith("/storage/v1/object/user-files") && init?.method === "DELETE");
  assert.ok(storageDelete);
  assert.deepEqual(JSON.parse(String(storageDelete.init?.body)), { prefixes: [`${userId}/resumes/source.txt`] });
  assert.ok(calls.slice(0, -1).every(({ init }) => new Headers(init?.headers).get("apikey") !== serviceKey));
});

test("account deletion does not mutate data when hosted isolation readiness is false", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    calls.push(url);
    return new Response("false", { status: 200 });
  };
  const env = { ...baseEnv, SUPABASE_SERVICE_ROLE_KEY: "server-only-admin-key" };
  await withAccountServer(fetcher, env, async base => {
    const response = await fetch(`${base}/account`, { method: "DELETE", headers: { authorization: "Bearer user-token" } });
    assert.equal(response.status, 503);
  });
  assert.deepEqual(calls, ["https://example.supabase.co/rest/v1/rpc/applypilot_workspace_ready"]);
});
