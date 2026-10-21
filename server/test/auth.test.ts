import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { test } from "node:test";
import {
  createApiCorsMiddleware,
  createSupabaseAuthMiddleware,
  productionDataUnavailable,
  readAllowedOrigins,
  verifySupabaseAccessToken,
  type SupabaseAuthConfig,
} from "../src/auth.js";

const config: SupabaseAuthConfig = {
  url: "https://example.supabase.co",
  anonKey: "public-anon-key",
};
const userId = "c47a7cc4-69e8-4b80-9aa1-4f59f6b7b44c";

function responseHarness() {
  const state: {
    status?: number;
    body?: unknown;
    ended?: boolean;
    locals: Record<string, unknown>;
    headers: Record<string, string>;
    varied: string[];
  } = { locals: {}, headers: {}, varied: [] };
  const response = {
    locals: state.locals,
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
    end() {
      state.ended = true;
      return this;
    },
    set(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return this;
    },
    vary(name: string) {
      state.varied.push(name);
      return this;
    },
  } as unknown as Response;
  return { response, state };
}

function requestHarness(authorization = "", origin?: string, method = "GET", host?: string): Request {
  return {
    method,
    get: (name: string) => {
      if (name.toLowerCase() === "authorization") return authorization;
      if (name.toLowerCase() === "origin") return origin;
      if (name.toLowerCase() === "host") return host;
      return undefined;
    },
  } as unknown as Request;
}

test("Supabase access token verification binds the user to the configured project", async () => {
  let requestedUrl = "";
  let requestedHeaders: Headers | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ id: userId, email: "ignored@example.test" }), { status: 200 });
  };

  assert.deepEqual(await verifySupabaseAccessToken("header.payload.signature", config, fetcher), { id: userId });
  assert.equal(requestedUrl, "https://example.supabase.co/auth/v1/user");
  assert.equal(requestedHeaders?.get("apikey"), config.anonKey);
  assert.equal(requestedHeaders?.get("authorization"), "Bearer header.payload.signature");
});

test("invalid tokens and malformed upstream identities are rejected", async () => {
  let fetchCalls = 0;
  const fetcher: typeof fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ id: "not-a-user-id" }), { status: 200 });
  };

  assert.equal(await verifySupabaseAccessToken("not-a-jwt", config, fetcher), null);
  assert.equal(fetchCalls, 0);
  await assert.rejects(() => verifySupabaseAccessToken("header.payload.signature", config, fetcher));
  assert.equal(fetchCalls, 1);
});

test("auth middleware rejects missing tokens and unavailable verification fail-closed", async () => {
  const noToken = responseHarness();
  let nextCalled = false;
  await createSupabaseAuthMiddleware({ config, fetcher: fetch })(
    requestHarness(), noToken.response, () => { nextCalled = true; },
  );
  assert.equal(noToken.state.status, 401);
  assert.equal(nextCalled, false);

  const unavailable = responseHarness();
  await createSupabaseAuthMiddleware({
    config,
    fetcher: async () => { throw new Error("offline"); },
  })(requestHarness("Bearer header.payload.signature"), unavailable.response, () => { nextCalled = true; });
  assert.equal(unavailable.state.status, 503);
  assert.equal(nextCalled, false);

  const unconfigured = responseHarness();
  await createSupabaseAuthMiddleware({ config: null })(
    requestHarness("Bearer header.payload.signature"),
    unconfigured.response,
    () => { nextCalled = true; },
  );
  assert.equal(unconfigured.state.status, 503);
  assert.equal(nextCalled, false);
});

test("auth middleware attaches only the verified Supabase user ID", async () => {
  const harness = responseHarness();
  let nextCalled = false;
  await createSupabaseAuthMiddleware({
    config,
    fetcher: async () => new Response(JSON.stringify({ id: userId, email: "ignored@example.test" }), { status: 200 }),
  })(
    requestHarness("Bearer header.payload.signature"),
    harness.response,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.deepEqual(harness.state.locals.supabaseUser, { id: userId });
});

test("authenticated production requests still fail closed until user-isolated storage exists", async () => {
  const harness = responseHarness();
  productionDataUnavailable()(requestHarness(), harness.response, () => undefined);
  assert.equal(harness.state.status, 503);
  assert.match(String((harness.state.body as { error: string }).error), /SQLite/);
  assert.match(String((harness.state.body as { error: string }).error), /No local data is exposed/);
});

test("CORS handles only configured origins and safely answers authenticated API preflight", () => {
  const harness = responseHarness();
  let nextCalled = false;
  createApiCorsMiddleware({ allowedOrigins: ["https://applypilot.example", "capacitor://localhost"] })(
    requestHarness("", "https://applypilot.example", "OPTIONS"),
    harness.response,
    () => { nextCalled = true; },
  );
  assert.equal(harness.state.status, 204);
  assert.equal(harness.state.ended, true);
  assert.equal(nextCalled, false);
  assert.equal(harness.state.headers["access-control-allow-origin"], "https://applypilot.example");
  assert.match(harness.state.headers["access-control-allow-headers"] ?? "", /Authorization/);
  assert.deepEqual(harness.state.varied, ["Origin"]);

  const denied = responseHarness();
  createApiCorsMiddleware({ allowedOrigins: ["https://applypilot.example"] })(
    requestHarness("", "https://evil.example"),
    denied.response,
    () => { nextCalled = true; },
  );
  assert.equal(denied.state.status, 403);
  assert.equal(denied.state.headers["access-control-allow-origin"], undefined);
});

test("same-origin requests pass without an explicit production allowlist", () => {
  const harness = responseHarness();
  let nextCalled = false;
  createApiCorsMiddleware({ allowedOrigins: [] })(
    requestHarness("", "https://applypilot.example", "GET", "APPLYPILOT.EXAMPLE:443"),
    harness.response,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.equal(harness.state.status, undefined);
  assert.equal(harness.state.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(harness.state.varied, ["Origin"]);
});

test("same-origin preflight is answered, while different host or port still requires allowlisting", () => {
  const preflight = responseHarness();
  let nextCalled = false;
  createApiCorsMiddleware({ allowedOrigins: [] })(
    requestHarness("", "https://applypilot.example", "OPTIONS", "applypilot.example"),
    preflight.response,
    () => { nextCalled = true; },
  );
  assert.equal(preflight.state.status, 204);
  assert.equal(preflight.state.ended, true);
  assert.equal(preflight.state.headers["access-control-allow-origin"], undefined);
  assert.equal(nextCalled, false);

  for (const host of ["api.applypilot.example", "applypilot.example:8443"]) {
    const denied = responseHarness();
    createApiCorsMiddleware({ allowedOrigins: [] })(
      requestHarness("", "https://applypilot.example", "GET", host),
      denied.response,
      () => { nextCalled = true; },
    );
    assert.equal(denied.state.status, 403, `${host} must not match the configured request origin`);
  }
});

test("configured Capacitor iOS origin is allowed for API preflight", () => {
  const preflight = responseHarness();
  createApiCorsMiddleware({ allowedOrigins: ["capacitor://localhost"] })(
    requestHarness("", "capacitor://localhost", "OPTIONS"),
    preflight.response,
    () => assert.fail("allowed native preflight must end before route middleware"),
  );

  assert.equal(preflight.state.status, 204);
  assert.equal(preflight.state.ended, true);
  assert.equal(preflight.state.headers["access-control-allow-origin"], "capacitor://localhost");
});

test("production CORS never defaults to a wildcard or development origin", () => {
  assert.deepEqual(readAllowedOrigins({ NODE_ENV: "production" }), []);
  assert.deepEqual(
    readAllowedOrigins({
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "https://applypilot.example,capacitor://localhost,http://localhost,http://evil.example",
    }),
    ["https://applypilot.example", "capacitor://localhost", "http://localhost"],
  );
});
