import assert from "node:assert/strict";
import express, { type ErrorRequestHandler } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { test } from "node:test";
import { createHostedRouter } from "../src/hosted/router.js";
import { DEFAULT_STANDING_FACTS } from "../../shared/types.js";

const userA = "c47a7cc4-69e8-4b80-9aa1-4f59f6b7b44c";
const userB = "d1f24c8a-0b22-4bf8-a131-47cc1cb49112";
const env = { NODE_ENV: "production", SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "public-anon-key" };

type Captured = { url: string; init?: RequestInit };
type Db = Map<string, Record<string, unknown>[]>;

async function withHostedServer(fetcher: typeof fetch, run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, res, next) => {
    const token = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
    res.locals.supabaseUser = { id: token === "token-a" ? userA : userB };
    res.locals.supabaseAccessToken = token;
    next();
  });
  app.use("/api", createHostedRouter({ fetcher, env }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : "Request failed" });
  };
  app.use(errors);
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function requestHeaders(token = "token-a") {
  return { authorization: `Bearer ${token}` };
}

function fakePostgrest(
  calls: Captured[],
  db: Db,
  storage = new Map<string, Buffer>(),
  failStorageDelete = false,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), env.SUPABASE_ANON_KEY);
    assert.match(headers.get("authorization") ?? "", /^Bearer token-[ab]$/);
    if (url.pathname.startsWith("/storage/v1/object/")) {
      const objectPath = decodeURIComponent(url.pathname.split("/user-files/")[1] ?? "");
      if (init?.method === "POST") {
        storage.set(objectPath, Buffer.from(init.body as ArrayBuffer));
        return new Response(JSON.stringify({ Key: objectPath }), { status: 200 });
      }
      if (url.pathname.includes("/authenticated/")) {
        const bytes = storage.get(objectPath);
        return bytes ? new Response(bytes) : new Response("", { status: 404 });
      }
      if (init?.method === "DELETE") {
        if (failStorageDelete) return new Response("", { status: 500 });
        storage.delete(objectPath);
        return new Response(null, { status: 200 });
      }
    }
    if (url.pathname === "/rest/v1/rpc/applypilot_workspace_ready"
      || url.pathname === "/rest/v1/rpc/applypilot_hosted_constraints_ready"
      || url.pathname === "/rest/v1/rpc/applypilot_master_brain_ready") {
      return new Response("true", { status: 200 });
    }

    assert.ok(url.pathname.startsWith("/rest/v1/"), `Unexpected URL ${url.pathname}`);
    const table = url.pathname.slice("/rest/v1/".length);
    const owner = url.searchParams.get("owner_id");
    if (init?.method === "POST") {
      const row = JSON.parse(String(init.body)) as Record<string, unknown>;
      const items = db.get(table) ?? [];
      const saved = { id: items.length + 1, ...row };
      items.push(saved);
      db.set(table, items);
      return new Response(JSON.stringify([saved]), { status: 201 });
    }
    const items = (db.get(table) ?? []).filter(row => row.owner_id === owner?.slice(3));
    const matches = items.filter(row => [...url.searchParams.entries()].every(([key, value]) => {
      if (key === "select" || key === "order" || key === "limit" || key === "offset") return true;
      if (key === "owner_id") return row.owner_id === value.slice(3);
      if (value.startsWith("eq.")) return String(row[key]) === value.slice(3);
      return true;
    }));
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
      for (const row of matches) Object.assign(row, patch);
      return new Response(JSON.stringify(matches), { status: 200 });
    }
    if (init?.method === "DELETE") {
      db.set(table, items.filter(row => !matches.includes(row)));
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(matches), { status: 200 });
  };
}

test("hosted profile writes force owner_id and isolate reads between users", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map();
  const fetcher = fakePostgrest(calls, db);
  await withHostedServer(fetcher, async base => {
    const payload = structuredClone(DEFAULT_STANDING_FACTS);
    payload.fullName = "Owner A";
    const saved = await fetch(`${base}/api/profile`, {
      method: "PUT", headers: { ...requestHeaders(), "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), payload);

    const response = await fetch(`${base}/api/profile`, { headers: requestHeaders("token-b") });
    assert.equal(response.status, 200);
    const other = await response.json() as { fullName: string };
    assert.notEqual(other.fullName, "Owner A");
  });

  const row = db.get("profile")?.[0];
  assert.equal(row?.owner_id, userA);
  const tableCalls = calls.filter(call => new URL(call.url).pathname === "/rest/v1/profile");
  assert.ok(tableCalls.filter(call => call.init?.method !== "POST").every(call => new URL(call.url).searchParams.get("owner_id") === `eq.${userA}` ||
    new URL(call.url).searchParams.get("owner_id") === `eq.${userB}`));
  assert.equal(new Headers(tableCalls[0]?.init?.headers).get("authorization"), "Bearer token-a");
});

test("hosted settings never return stored credentials", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map();
  await withHostedServer(fakePostgrest(calls, db), async base => {
    const secret = "sk-ant-hosted-never-return-this";
    const searchKey = "rapidapi-private-test-key";
    const adzunaKey = "adzuna-private-test-key";
    const update = await fetch(`${base}/api/settings`, {
      method: "PUT", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ anthropicApiKey: secret, jobSearchApiKey: searchKey, adzunaAppId: "adzuna-app-id", adzunaAppKey: adzunaKey }),
    });
    assert.equal(update.status, 200);
    const text = await update.text();
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(searchKey));
    assert.ok(!text.includes(adzunaKey));
    assert.match(text, /anthropicApiKeyMasked/);
    assert.equal(db.get("settings")?.[0]?.value, secret);
    assert.equal(db.get("settings")?.find(row => row.key === "jsearch_api_key")?.value, searchKey);
    assert.equal(db.get("settings")?.find(row => row.key === "adzuna_app_key")?.value, adzunaKey);
    const read = await fetch(`${base}/api/settings`, { headers: requestHeaders() });
    const settingsText = await read.text();
    assert.ok(!settingsText.includes(searchKey));
    assert.ok(!settingsText.includes(adzunaKey));
    assert.match(settingsText, /hasJobSearchApiKey/);
    assert.match(settingsText, /hasAdzunaCredentials/);
  });
  assert.ok(calls.filter(call => new URL(call.url).pathname.startsWith("/rest/v1/") && call.init?.method !== "POST")
    .every(call => new URL(call.url).searchParams.get("owner_id") === `eq.${userA}`));
});

test("resume upload stores private user-scoped file and another user cannot download it", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map();
  const storage = new Map<string, Buffer>();
  const fetcher = fakePostgrest(calls, db, storage);
  await withHostedServer(fetcher, async base => {
    const form = new FormData();
    form.append("files[]", new Blob(["This is a sufficiently long resume document for parsing."], { type: "text/plain" }), "resume.txt");
    const uploaded = await fetch(`${base}/api/resumes`, { method: "POST", headers: requestHeaders(), body: form });
    assert.equal(uploaded.status, 201);
    const resumes = await uploaded.json() as { id: number; fileUrl: string }[];
    assert.equal(resumes.length, 1);
    const resume = resumes[0]!;
    const download = await fetch(`${base}${resume.fileUrl}`, { headers: requestHeaders() });
    assert.equal(download.status, 200);
    assert.match(await download.text(), /resume document/);

    const denied = await fetch(`${base}${resume.fileUrl}`, { headers: requestHeaders("token-b") });
    assert.equal(denied.status, 404);
  });
  const row = db.get("resumes")?.[0];
  assert.equal(row?.owner_id, userA);
  assert.match(String(row?.filename), new RegExp(`^${userA}/resumes/`));
  assert.ok(calls.filter(call => new URL(call.url).pathname.startsWith("/rest/v1/") && call.init?.method !== "POST")
    .every(call => new URL(call.url).searchParams.get("owner_id")?.startsWith("eq.")));
  assert.ok(calls.some(call => new URL(call.url).pathname.includes(`/user-files/${userA}/resumes/`)));
});

test("resume deletion preserves metadata when private-file deletion fails", async () => {
  const calls: Captured[] = [];
  const objectPath = `${userA}/resumes/resume.txt`;
  const storage = new Map([[objectPath, Buffer.from("resume contents")]]);
  const db: Db = new Map([["resumes", [{
    id: 1, owner_id: userA, filename: objectPath, original_name: "resume.txt",
    mime: "text/plain", label: "resume", uploaded_at: new Date().toISOString(),
  }]]]);
  await withHostedServer(fakePostgrest(calls, db, storage, true), async base => {
    const response = await fetch(`${base}/api/resumes/1`, { method: "DELETE", headers: requestHeaders() });
    assert.equal(response.status, 503);
  });
  assert.equal(db.get("resumes")?.length, 1);
  assert.equal(storage.has(objectPath), true);
  assert.equal(calls.some(call =>
    new URL(call.url).pathname === "/rest/v1/resumes" && call.init?.method === "DELETE"), false);
});

test("resume upload rejects exceeding the owner limit before writing private files", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map();
  db.set("resumes", Array.from({ length: 10 }, (_, index) => ({
    id: index + 1, owner_id: userA, filename: `${userA}/resumes/${index}.txt`,
    original_name: `${index}.txt`, mime: "text/plain", text: "resume",
  })));
  const storage = new Map<string, Buffer>();
  await withHostedServer(fakePostgrest(calls, db, storage), async base => {
    const form = new FormData();
    form.append("files[]", new Blob(["A new resume document."], { type: "text/plain" }), "new.txt");
    const response = await fetch(`${base}/api/resumes`, { method: "POST", headers: requestHeaders(), body: form });
    assert.equal(response.status, 409);
  });
  assert.equal(storage.size, 0);
  assert.equal(calls.some(call => call.url.includes("/storage/v1/object/user-files/") && call.init?.method === "POST"), false);
});

test("cross-user record access fails closed even when the caller knows a row id", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map([["resumes", [{ id: 8, owner_id: userA, filename: `${userA}/resumes/file.txt` }]]]);
  await withHostedServer(fakePostgrest(calls, db), async base => {
    const response = await fetch(`${base}/api/resumes/8`, { headers: requestHeaders("token-b") });
    assert.equal(response.status, 404);
  });
  const request = calls.find(call => new URL(call.url).pathname === "/rest/v1/resumes");
  assert.equal(new URL(request!.url).searchParams.get("owner_id"), `eq.${userB}`);
});

test("hosted job creation and parsing are owner-scoped while automation remains unavailable", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map();
  await withHostedServer(fakePostgrest(calls, db), async base => {
    const created = await fetch(`${base}/api/jobs`, {
      method: "POST", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ title: "Engineer", company: "Example", text: "A hosted job description." }),
    });
    assert.equal(created.status, 201);
    const job = await created.json() as { id: number; title: string };
    assert.equal(job.title, "Engineer");

    const hidden = await fetch(`${base}/api/jobs/${job.id}`, { headers: requestHeaders("token-b") });
    assert.equal(hidden.status, 404);
    const parsed = await fetch(`${base}/api/jobs/${job.id}/parse`, { method: "POST", headers: requestHeaders() });
    assert.equal(parsed.status, 200);
    assert.equal((await parsed.json() as { status: string }).status, "parsed");
    const unsupported = await fetch(`${base}/api/jobs/${job.id}/run`, { method: "POST", headers: requestHeaders() });
    assert.equal(unsupported.status, 503);
    assert.match((await unsupported.json() as { error: string }).error, /automated job pipeline/i);
  });
  assert.equal(db.get("jobs")?.[0]?.owner_id, userA);
  const lookup = calls.find(call => new URL(call.url).pathname === "/rest/v1/jobs" && call.init?.method !== "POST");
  assert.ok(new URL(lookup!.url).searchParams.get("owner_id") === `eq.${userA}` ||
    new URL(lookup!.url).searchParams.get("owner_id") === `eq.${userB}`);
});

test("hosted posting research is user-triggered, owner-isolated, and rejects private network URLs", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map([["jobs", [{
    id: 7, owner_id: userA, source: "url", url: "http://127.0.0.1/private",
    title: "Engineer", company: "Example", description_text: "Saved description",
  }]]]);
  await withHostedServer(fakePostgrest(calls, db), async base => {
    const hidden = await fetch(`${base}/api/jobs/7/research`, {
      method: "POST", headers: requestHeaders("token-b"),
    });
    assert.equal(hidden.status, 404);

    const blockedResearch = await fetch(`${base}/api/jobs/7/research`, {
      method: "POST", headers: requestHeaders(),
    });
    assert.equal(blockedResearch.status, 400);
    assert.match((await blockedResearch.json() as { error: string }).error, /public host/i);

    const blockedAdd = await fetch(`${base}/api/jobs`, {
      method: "POST", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/private" }),
    });
    assert.equal(blockedAdd.status, 400);
    assert.match((await blockedAdd.json() as { error: string }).error, /public host/i);
  });
  assert.equal(db.get("jobs")?.length, 1);
  assert.equal(db.get("jobs")?.[0]?.description_text, "Saved description");
  assert.ok(calls.filter(call => new URL(call.url).pathname === "/rest/v1/jobs").every(call =>
    new URL(call.url).searchParams.get("owner_id") === `eq.${userA}` ||
    new URL(call.url).searchParams.get("owner_id") === `eq.${userB}`));
});

test("hosted job discovery uses the owner's provider key and deduplicates results", async () => {
  const calls: Captured[] = [];
  const providerCalls: Captured[] = [];
  const db: Db = new Map([
    ["settings", [{ id: 1, owner_id: userA, key: "jsearch_api_key", value: "private-test-key" }]],
    ["jobs", []],
  ]);
  const postgrest = fakePostgrest(calls, db);
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "jsearch.p.rapidapi.com") {
      providerCalls.push({ url: url.toString(), init });
      return new Response(JSON.stringify({ data: [{
        job_title: "Platform Engineer", employer_name: "Example Corp", job_city: "Seattle",
        job_state: "WA", job_country: "US", job_description: "<p>Build reliable TypeScript services.</p>",
        job_apply_link: "https://jobs.example.com/roles/123", job_publisher: "Example Board",
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return postgrest(input, init);
  };
  await withHostedServer(fetcher, async base => {
    const request = () => fetch(`${base}/api/jobs/discover`, {
      method: "POST", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ provider: "jsearch", query: "Platform Engineer", location: "Seattle", remoteOnly: true }),
    });
    const first = await request();
    assert.equal(first.status, 200);
    const firstResult = await first.json() as { found: number; added: number; duplicates: number; jobs: { title: string; board: string }[] };
    assert.deepEqual({ found: firstResult.found, added: firstResult.added, duplicates: firstResult.duplicates }, {
      found: 1, added: 1, duplicates: 0,
    });
    assert.equal(firstResult.jobs[0]?.title, "Platform Engineer");
    assert.equal(firstResult.jobs[0]?.board, "Example Board");

    const second = await request();
    assert.equal(second.status, 200);
    const secondResult = await second.json() as { added: number; duplicates: number };
    assert.equal(secondResult.added, 0);
    assert.equal(secondResult.duplicates, 1);

    const ownerB = await fetch(`${base}/api/jobs/discover`, {
      method: "POST", headers: { ...requestHeaders("token-b"), "content-type": "application/json" },
      body: JSON.stringify({ provider: "jsearch", query: "Platform Engineer" }),
    });
    assert.equal(ownerB.status, 400);
    assert.match((await ownerB.json() as { error: string }).error, /RapidAPI key/i);
  });
  assert.equal(providerCalls.length, 2);
  assert.equal(new Headers(providerCalls[0]?.init?.headers).get("X-RapidAPI-Key"), "private-test-key");
  assert.equal(new URL(providerCalls[0]!.url).searchParams.get("remote_jobs_only"), "true");
  assert.equal(db.get("jobs")?.length, 1);
  assert.equal(db.get("jobs")?.[0]?.owner_id, userA);
});

test("hosted job discovery normalizes Adzuna results into the private pipeline", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map([
    ["settings", [
      { id: 1, owner_id: userA, key: "adzuna_app_id", value: "private-app-id" },
      { id: 2, owner_id: userA, key: "adzuna_app_key", value: "private-app-key" },
    ]],
    ["jobs", []],
  ]);
  const postgrest = fakePostgrest(calls, db);
  const providerCalls: Captured[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.adzuna.com") {
      providerCalls.push({ url: url.toString(), init });
      return new Response(JSON.stringify({ results: [{
        title: "Registered Nurse", company: { display_name: "Community Health" },
        location: { display_name: "Portland, OR" }, description: "<p>Provide compassionate patient care.</p>",
        redirect_url: "https://jobs.example.com/nurse", category: { label: "Healthcare" },
      }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return postgrest(input, init);
  };
  await withHostedServer(fetcher, async base => {
    const response = await fetch(`${base}/api/jobs/discover`, {
      method: "POST", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ provider: "adzuna", query: "Registered Nurse", location: "Portland, OR" }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { added: number; jobs: { title: string; company: string; location: string; board: string }[] };
    assert.equal(result.added, 1);
    assert.deepEqual(result.jobs[0] && {
      title: result.jobs[0].title, company: result.jobs[0].company,
      location: result.jobs[0].location, board: result.jobs[0].board,
    }, { title: "Registered Nurse", company: "Community Health", location: "Portland, OR", board: "Healthcare" });
  });
  const providerUrl = new URL(providerCalls[0]!.url);
  assert.equal(providerUrl.searchParams.get("app_id"), "private-app-id");
  assert.equal(providerUrl.searchParams.get("app_key"), "private-app-key");
  assert.equal(db.get("jobs")?.[0]?.owner_id, userA);
  assert.doesNotMatch(JSON.stringify(db.get("jobs")), /private-app-key/);
});

test("stored resume analysis is deterministic and persists only to its owner", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map([["resumes", [{
    id: 42, owner_id: userA, filename: `${userA}/resumes/resume.txt`, original_name: "resume.txt",
    mime: "text/plain", label: "resume", text: [
      "Taylor Example", "taylor@example.com", "555-123-4567", "Summary", "Platform engineer.",
      "Experience", "Software Engineer | Acme", "2020 - Present", "• Built resilient services",
      "Skills", "TypeScript, React", "Education", "State University",
    ].join("\n"), parsed_json: null, skills_json: [],
  }]]]);
  await withHostedServer(fakePostgrest(calls, db), async base => {
    const response = await fetch(`${base}/api/resumes/42/analyze`, { method: "POST", headers: requestHeaders() });
    assert.equal(response.status, 200);
    const parsed = await response.json() as {
      contact: { name: string; email: string };
      skills: string[];
      experience: { company: string; title: string; bullets: string[] }[];
    };
    assert.equal(parsed.contact.name, "Taylor Example");
    assert.equal(parsed.contact.email, "taylor@example.com");
    assert.deepEqual(parsed.skills, ["TypeScript", "React"]);
    assert.equal(parsed.experience[0]?.company, "Acme");
    assert.equal(parsed.experience[0]?.title, "Software Engineer");
    assert.deepEqual(parsed.experience[0]?.bullets, ["Built resilient services"]);

    const hidden = await fetch(`${base}/api/resumes/42/analyze`, { method: "POST", headers: requestHeaders("token-b") });
    assert.equal(hidden.status, 404);
  });
  const saved = db.get("resumes")?.[0];
  assert.equal(saved?.owner_id, userA);
  assert.deepEqual(saved?.skills_json, ["TypeScript", "React"]);
  const updates = calls.filter(call => new URL(call.url).pathname === "/rest/v1/resumes" && call.init?.method === "PATCH");
  assert.ok(updates.every(call => new URL(call.url).searchParams.get("owner_id") === `eq.${userA}`));
});

test("manual job parse, qualify, kit, questions, approval and cross-user isolation", async () => {
  const calls: Captured[] = [];
  const storage = new Map<string, Buffer>();
  const resumeText = [
    "Taylor Example", "taylor@example.com", "555-123-4567", "Summary", "Frontend engineer.",
    "Experience", "Software Engineer | Acme", "2020 - Present", "• Built reliable TypeScript services",
    "Skills", "TypeScript, React", "Education", "State University",
  ].join("\n");
  const facts = structuredClone(DEFAULT_STANDING_FACTS);
  facts.workAuthorization = "Authorized to work in the United States";
  const db: Db = new Map([
    ["resumes", [{
      id: 11, owner_id: userA, filename: `${userA}/resumes/resume.txt`, original_name: "resume.txt",
      mime: "text/plain", label: "Primary", text: resumeText, parsed_json: null, skills_json: [],
      is_base: true, uploaded_at: new Date().toISOString(),
    }]],
    ["profile", [{ id: 1, owner_id: userA, facts_json: facts }]],
    ["stories", [{
      id: 1, owner_id: userA, key: "why_company", title: "Why Acme",
      body: "I am interested in Acme's thoughtful engineering work.", approved: true,
    }]],
  ]);
  await withHostedServer(fakePostgrest(calls, db, storage), async base => {
    const created = await fetch(`${base}/api/jobs`, {
      method: "POST", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "Senior Frontend Engineer", company: "Acme",
        text: "Senior Frontend Engineer\nLocation: Remote\nRequired skills: TypeScript, React\nBuild reliable products.",
      }),
    });
    assert.equal(created.status, 201);
    const job = await created.json() as { id: number };

    const parsedResponse = await fetch(`${base}/api/jobs/${job.id}/parse`, { method: "POST", headers: requestHeaders() });
    assert.equal(parsedResponse.status, 200);
    const parsed = await parsedResponse.json() as { status: string; parsed: { requiredSkills: string[]; remoteType: string } };
    assert.equal(parsed.status, "parsed");
    assert.deepEqual(parsed.parsed.requiredSkills, ["TypeScript", "React"]);
    assert.equal(parsed.parsed.remoteType, "remote");

    const qualifiedResponse = await fetch(`${base}/api/jobs/${job.id}/qualify`, { method: "POST", headers: requestHeaders() });
    assert.equal(qualifiedResponse.status, 200);
    const qualified = await qualifiedResponse.json() as {
      status: string; qualification: { qualifies: boolean; fitScore: number; matchedSkills: string[] };
    };
    assert.equal(qualified.status, "qualified");
    assert.equal(qualified.qualification.qualifies, true);
    assert.equal(qualified.qualification.fitScore, 100);
    assert.deepEqual(qualified.qualification.matchedSkills, ["TypeScript", "React"]);

    const builtResponse = await fetch(`${base}/api/jobs/${job.id}/build-kit`, { method: "POST", headers: requestHeaders() });
    assert.equal(builtResponse.status, 200);
    const kit = await builtResponse.json() as {
      jobId: number; selectedResumeId: number;
      tailored: { skills: string[]; experience: { company: string; title: string; start: string; end: string; location: string; bullets: string[] }[] };
      honesty: { verdict: string; unsupportedCount: number }; status: string; coverLetter: string;
      pdfPath: string; docxPath: string;
    };
    assert.equal(kit.jobId, job.id);
    assert.equal(kit.selectedResumeId, 11);
    assert.deepEqual(new Set(kit.tailored.skills), new Set(["TypeScript", "React"]));
    assert.equal(kit.honesty.verdict, "pass");
    assert.equal(kit.honesty.unsupportedCount, 0);
    assert.equal(kit.status, "draft");
    assert.match(kit.coverLetter, /Acme/);
    assert.match(kit.pdfPath, new RegExp(`^${userA}/kits/.*\\.pdf$`));
    assert.match(kit.docxPath, new RegExp(`^${userA}/kits/.*\\.docx$`));
    assert.ok(storage.has(kit.pdfPath));
    assert.ok(storage.has(kit.docxPath));
    const pdf = await fetch(`${base}/api/jobs/${job.id}/kit/pdf`, { headers: requestHeaders() });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.ok((await pdf.arrayBuffer()).byteLength > 0);

    const dishonestEdit = await fetch(`${base}/api/jobs/${job.id}/kit`, {
      method: "PUT", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ tailored: { ...kit.tailored, summary: "Invented a new qualification." } }),
    });
    assert.equal(dishonestEdit.status, 400);
    const alteredEmployer = {
      ...kit.tailored,
      experience: kit.tailored.experience.map((role, index) =>
        index === 0 ? { ...role, company: "Invented Employer" } : role),
    };
    const rejectedEmployer = await fetch(`${base}/api/jobs/${job.id}/kit`, {
      method: "PUT", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ tailored: alteredEmployer }),
    });
    assert.equal(rejectedEmployer.status, 400);
    const alteredTitle = {
      ...kit.tailored,
      experience: kit.tailored.experience.map((role, index) =>
        index === 0 ? { ...role, title: "Invented Role" } : role),
    };
    const rejectedTitle = await fetch(`${base}/api/jobs/${job.id}/kit`, {
      method: "PUT", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ tailored: alteredTitle }),
    });
    assert.equal(rejectedTitle.status, 400);
    const safeEdit = await fetch(`${base}/api/jobs/${job.id}/kit`, {
      method: "PUT", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ tailored: { ...kit.tailored, skills: [...kit.tailored.skills].reverse() } }),
    });
    assert.equal(safeEdit.status, 200);
    const editedKit = await safeEdit.json() as { pdfPath: string; docxPath: string; status: string };
    assert.equal(editedKit.status, "draft");
    assert.notEqual(editedKit.pdfPath, kit.pdfPath);
    assert.equal(storage.has(kit.pdfPath), false);
    assert.ok(storage.has(editedKit.pdfPath));

    const answersResponse = await fetch(`${base}/api/jobs/${job.id}/questions`, {
      method: "POST", headers: { ...requestHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ questions: ["Are you authorized to work?", "Please provide your Social Security number."] }),
    });
    assert.equal(answersResponse.status, 200);
    const answers = await answersResponse.json() as { answer: string; needsHuman: boolean; source: string }[];
    assert.equal(answers[0]?.answer, facts.workAuthorization);
    assert.equal(answers[0]?.needsHuman, false);
    assert.equal(answers[1]?.answer, "");
    assert.equal(answers[1]?.needsHuman, true);
    assert.equal(answers[1]?.source, "rule");

    const approvalResponse = await fetch(`${base}/api/jobs/${job.id}/kit/approve`, {
      method: "POST", headers: requestHeaders(),
    });
    assert.equal(approvalResponse.status, 200);
    assert.equal((await approvalResponse.json() as { status: string }).status, "approved");

    const hidden = await fetch(`${base}/api/jobs/${job.id}`, { headers: requestHeaders("token-b") });
    assert.equal(hidden.status, 404);
    const hiddenBuild = await fetch(`${base}/api/jobs/${job.id}/build-kit`, {
      method: "POST", headers: requestHeaders("token-b"),
    });
    assert.equal(hiddenBuild.status, 404);
    const hiddenApproval = await fetch(`${base}/api/jobs/${job.id}/kit/approve`, {
      method: "POST", headers: requestHeaders("token-b"),
    });
    assert.equal(hiddenApproval.status, 404);
    const hiddenDownload = await fetch(`${base}/api/jobs/${job.id}/kit/pdf`, { headers: requestHeaders("token-b") });
    assert.equal(hiddenDownload.status, 404);
  });
  assert.equal(db.get("jobs")?.[0]?.owner_id, userA);
  assert.equal(db.get("application_kits")?.[0]?.owner_id, userA);
  assert.equal(db.get("application_kits")?.[0]?.status, "approved");
  assert.equal(db.get("experience_bank")?.[0]?.owner_id, userA);
  const dataCalls = calls.filter(call => {
    const url = new URL(call.url);
    return url.pathname.startsWith("/rest/v1/") && !url.pathname.includes("/rpc/") && call.init?.method !== "POST";
  });
  assert.ok(dataCalls.every(call => /^eq\.[0-9a-f-]+$/i.test(new URL(call.url).searchParams.get("owner_id") ?? "")));
  assert.ok(dataCalls.some(call => new URL(call.url).searchParams.get("owner_id") === `eq.${userA}`));
  assert.ok(dataCalls.some(call => new URL(call.url).searchParams.get("owner_id") === `eq.${userB}`));
});

test("deleting a hosted job removes its private kit files before deleting the row", async () => {
  const calls: Captured[] = [];
  const pdfPath = `${userA}/kits/application.pdf`;
  const docxPath = `${userA}/kits/application.docx`;
  const storage = new Map([[pdfPath, Buffer.from("pdf")], [docxPath, Buffer.from("docx")]]);
  const db: Db = new Map([
    ["jobs", [{ id: 1, owner_id: userA, title: "Engineer", company: "Example" }]],
    ["application_kits", [{
      id: 1, owner_id: userA, job_id: 1, pdf_path: pdfPath, docx_path: docxPath,
    }]],
  ]);
  await withHostedServer(fakePostgrest(calls, db, storage), async base => {
    const response = await fetch(`${base}/api/jobs/1`, { method: "DELETE", headers: requestHeaders() });
    assert.equal(response.status, 204);
  });
  assert.equal(storage.size, 0);
  assert.equal(db.get("jobs")?.length, 0);
  const deletes = calls.filter(call =>
    new URL(call.url).pathname.startsWith("/storage/v1/object/user-files/") && call.init?.method === "DELETE");
  assert.equal(deletes.length, 2);
  assert.equal(calls.at(-1)?.init?.method, "DELETE");
});

test("hosted routes fail closed when the owner-isolation migration is not ready", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    calls.push(String(input));
    return new Response("false", { status: 200 });
  };
  await withHostedServer(fetcher, async base => {
    const response = await fetch(`${base}/api/profile`, { headers: requestHeaders() });
    assert.equal(response.status, 503);
    assert.match((await response.json() as { error: string }).error, /migration/i);
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.endsWith("/rest/v1/rpc/applypilot_workspace_ready"));
});

test("hosted routes fail closed if the per-user resume limit trigger is missing", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    calls.push(String(input));
    return new Response(calls.at(-1)?.endsWith("/applypilot_workspace_ready") ? "true" : "false", { status: 200 });
  };
  await withHostedServer(fetcher, async base => {
    const response = await fetch(`${base}/api/profile`, { headers: requestHeaders() });
    assert.equal(response.status, 503);
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.endsWith("/rest/v1/rpc/applypilot_hosted_constraints_ready"));
});

test("master brain recommendations and feedback stay within each owner's workspace", async () => {
  const calls: Captured[] = [];
  const db: Db = new Map([
    ["resumes", [{ id: 1, owner_id: userA, original_name: "resume.txt", parsed_json: null }]],
    ["jobs", [
      { id: 2, owner_id: userA, title: "Engineer", company: "Example", description_text: "TypeScript role", status: "new", parsed_json: null },
      { id: 3, owner_id: userA, title: "Designer", company: "Elsewhere", description_text: "Design role", status: "qualified", parsed_json: { requiredSkills: [] }, qualification_json: { qualifies: true } },
    ]],
    ["application_kits", [{ id: 1, owner_id: userA, job_id: 3, honesty_json: { verdict: "fail", unsupportedCount: 1 } }]],
    ["agent_runs", [
      { id: 4, owner_id: userA, agent: "HonestyChecker", job_id: 3, ok: true, created_at: "2026-02-01T10:00:00Z" },
      { id: 5, owner_id: userB, agent: "Qualifier", job_id: null, ok: false, created_at: "2026-02-01T11:00:00Z" },
    ]],
    ["brain_feedback", [{ id: 1, owner_id: userA, agent: "application_strategist", helpful: true }]],
  ]);
  const fetcher = fakePostgrest(calls, db);
  await withHostedServer(fetcher, async base => {
    const ownerA = await fetch(`${base}/api/brain`, { headers: requestHeaders() });
    assert.equal(ownerA.status, 200);
    const reportA = await ownerA.json() as {
      learningSignals: number; agents: { id: string; userRating: boolean | null }[];
      recommendations: { agentId: string; priority: string }[];
      reviewedDecisions: { runId: number; verdict: string }[];
      finalDecision: { outcome: string; title: string };
    };
    assert.equal(reportA.learningSignals, 1);
    assert.equal(reportA.agents.find(agent => agent.id === "application_strategist")?.userRating, true);
    assert.ok(reportA.recommendations.some(item => item.agentId === "resume_analyst"));
    assert.ok(reportA.recommendations.some(item => item.agentId === "truth_guard" && item.priority === "high"));
    assert.deepEqual(reportA.reviewedDecisions.map(review => review.runId), [4]);
    assert.equal(reportA.reviewedDecisions[0]?.verdict, "do_not_use");
    assert.equal(reportA.finalDecision.outcome, "hold_for_review");

    const saved = await fetch(`${base}/api/brain/feedback`, {
      method: "PUT", headers: { ...requestHeaders("token-b"), "content-type": "application/json" },
      body: JSON.stringify({ agentId: "role_researcher", helpful: true }),
    });
    assert.equal(saved.status, 200);

    const ownerB = await fetch(`${base}/api/brain`, { headers: requestHeaders("token-b") });
    assert.equal(ownerB.status, 200);
    const reportB = await ownerB.json() as {
      learningSignals: number; recommendations: { agentId: string }[];
      agents: { id: string; userRating: boolean | null }[];
      reviewedDecisions: { runId: number; verdict: string }[];
      finalDecision: { outcome: string };
    };
    assert.equal(reportB.learningSignals, 1);
    assert.deepEqual(reportB.recommendations, []);
    assert.equal(reportB.agents.find(agent => agent.id === "role_researcher")?.userRating, true);
    assert.deepEqual(reportB.reviewedDecisions.map(review => review.runId), [5]);
    assert.equal(reportB.finalDecision.outcome, "no_action");

    const refreshedA = await fetch(`${base}/api/brain`, { headers: requestHeaders() });
    const reportAAfter = await refreshedA.json() as { learningSignals: number };
    assert.equal(reportAAfter.learningSignals, 1);
  });
  assert.ok(calls.filter(call =>
    new URL(call.url).pathname === "/rest/v1/brain_feedback" && call.init?.method === "POST")
    .every(call => JSON.parse(String(call.init?.body)).owner_id === userB));
});
