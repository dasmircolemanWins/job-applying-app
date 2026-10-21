import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { isMockActive, readEffort, readModel, resolveApiKey } from "../config.js";
import { nowIso, run } from "../db.js";
import { errorMessage, logger } from "../log.js";
import { mockAgent } from "./mock.js";
import type { Effort, TestKeyResult } from "../../../shared/types.js";

/** SPEC §5: never truncate silently; refuse prompts over ~150k chars. */
export const MAX_PROMPT_CHARS = 150_000;
const MAX_TOKENS = 16_000;
const MOCK_MODEL = "mock";

export interface RunAgentOptions<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  jobId?: number | null;
  effort?: Effort;
  /**
   * The structured input the agent function received. Passed to `mockAgent` so mocks
   * can derive deterministic output; when omitted, mocks receive `{system, user}`.
   */
  input?: unknown;
}

/** Thrown for every agent failure; `kind` lets callers branch without string matching. */
export class AgentError extends Error {
  readonly kind: "auth" | "rate_limit" | "refusal" | "api" | "schema" | "prompt_too_long" | "mock" | "unknown";
  readonly agent: string;
  constructor(kind: AgentError["kind"], agent: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.kind = kind;
    this.agent = agent;
  }
}

let cachedClient: { key: string; client: Anthropic } | null = null;

/** Anthropic client for the currently resolved key (re-created when the key changes). */
export function getClient(apiKey?: string): Anthropic {
  const key = apiKey ?? resolveApiKey();
  if (!key) throw new AgentError("auth", "client", "No Anthropic API key configured");
  if (cachedClient && cachedClient.key === key) return cachedClient.client;
  const client = new Anthropic({ apiKey: key, maxRetries: 2 });
  cachedClient = { key, client };
  return client;
}

interface RunLog {
  agent: string;
  jobId: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
  mock: boolean;
}

function logRun(entry: RunLog): void {
  const ts = nowIso();
  try {
    run(
      `INSERT INTO agent_runs (agent, job_id, model, input_tokens, output_tokens, duration_ms, ok, error, mock, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.agent,
      entry.jobId,
      entry.model,
      entry.inputTokens,
      entry.outputTokens,
      entry.durationMs,
      entry.ok ? 1 : 0,
      entry.error,
      entry.mock ? 1 : 0,
      ts,
      ts,
    );
  } catch (err) {
    logger.error("failed to write agent_runs row", { agent: entry.agent, error: errorMessage(err) });
  }
}

/** Seconds from a `retry-after` header on an SDK error, if present and sane. */
function retryAfterMs(err: Anthropic.APIError): number {
  const headers: unknown = err.headers;
  let raw: string | null | undefined;
  if (headers instanceof Headers) raw = headers.get("retry-after");
  else if (headers && typeof headers === "object") {
    raw = (headers as Record<string, string | undefined>)["retry-after"];
  }
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs, 60) * 1000;
  return 5000;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describeRefusal(message: Anthropic.Message): string {
  const details: unknown = message.stop_details;
  if (details && typeof details === "object") {
    const d = details as { category?: string | null; explanation?: string | null };
    const parts = [d.category ? `category: ${d.category}` : null, d.explanation ?? null].filter(Boolean);
    if (parts.length) return parts.join(" — ");
  }
  return "no explanation provided";
}

/**
 * Run one agent call and return the schema-typed result (SPEC §5).
 * Mock mode routes to `mockAgent`; the mock output is validated against the same schema.
 */
export async function runAgent<T>(name: string, opts: RunAgentOptions<T>): Promise<T> {
  const jobId = opts.jobId ?? null;
  const started = Date.now();

  if (opts.system.length + opts.user.length > MAX_PROMPT_CHARS) {
    const msg = `${name}: prompt is ${opts.system.length + opts.user.length} chars, over the ${MAX_PROMPT_CHARS} limit; split the input`;
    logRun({ agent: name, jobId, model: "", inputTokens: 0, outputTokens: 0, durationMs: 0, ok: false, error: msg, mock: false });
    throw new AgentError("prompt_too_long", name, msg);
  }

  if (isMockActive()) {
    try {
      const raw = mockAgent(name, opts.input ?? { system: opts.system, user: opts.user });
      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) {
        throw new AgentError("schema", name, `${name}: mock output failed schema validation: ${parsed.error.message}`);
      }
      logRun({
        agent: name, jobId, model: MOCK_MODEL, inputTokens: 0, outputTokens: 0,
        durationMs: Date.now() - started, ok: true, error: null, mock: true,
      });
      return parsed.data;
    } catch (err) {
      const e = err instanceof AgentError ? err : new AgentError("mock", name, `${name}: ${errorMessage(err)}`);
      logRun({
        agent: name, jobId, model: MOCK_MODEL, inputTokens: 0, outputTokens: 0,
        durationMs: Date.now() - started, ok: false, error: e.message, mock: true,
      });
      throw e;
    }
  }

  const model = readModel();
  const effort = opts.effort ?? readEffort();
  const client = getClient();

  const call = () =>
    client.messages.parse({
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: opts.user }],
      output_config: { effort, format: zodOutputFormat(opts.schema) },
    });

  let inputTokens = 0;
  let outputTokens = 0;
  try {
    let response: Awaited<ReturnType<typeof call>>;
    try {
      response = await call();
    } catch (err) {
      if (!(err instanceof Anthropic.RateLimitError)) throw err;
      const wait = retryAfterMs(err);
      logger.warn("rate limited; retrying once", { agent: name, waitMs: wait });
      await sleep(wait);
      response = await call();
    }

    inputTokens = response.usage.input_tokens;
    outputTokens = response.usage.output_tokens;

    if (response.stop_reason === "refusal") {
      throw new AgentError("refusal", name, `${name}: the model declined this request (${describeRefusal(response)})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new AgentError("api", name, `${name}: output exceeded ${MAX_TOKENS} tokens; reduce the input`);
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new AgentError("schema", name, `${name}: model output did not match the expected schema`);
    }
    const validated = opts.schema.safeParse(response.parsed_output);
    if (!validated.success) {
      throw new AgentError("schema", name, `${name}: output failed validation: ${validated.error.message}`);
    }

    logRun({
      agent: name, jobId, model, inputTokens, outputTokens,
      durationMs: Date.now() - started, ok: true, error: null, mock: false,
    });
    return validated.data;
  } catch (err) {
    const e = toAgentError(name, err);
    logRun({
      agent: name, jobId, model, inputTokens, outputTokens,
      durationMs: Date.now() - started, ok: false, error: e.message, mock: false,
    });
    throw e;
  }
}

function toAgentError(name: string, err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new AgentError("auth", name, `${name}: Anthropic rejected the API key (401). Check Settings.`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AgentError("rate_limit", name, `${name}: rate limited twice in a row; try again shortly`);
  }
  if (err instanceof Anthropic.APIError) {
    return new AgentError("api", name, `${name}: Anthropic API error ${err.status ?? ""}: ${err.message}`);
  }
  return new AgentError("unknown", name, `${name}: ${errorMessage(err)}`);
}

/**
 * One tiny real call to confirm the key works (POST /settings/test-key).
 * Never throws; mock mode reports ok:false with the reason.
 */
export async function testApiKey(apiKey?: string): Promise<TestKeyResult> {
  const model = readModel();
  const key = apiKey ?? resolveApiKey();
  if (!key) return { ok: false, model, message: "No API key saved or in the environment; mock mode is active." };
  if (!apiKey && isMockActive()) {
    return { ok: false, model, message: "Mock mode is forced on in Settings; set it to auto or off to use the key." };
  }
  const started = Date.now();
  try {
    const client = getClient(key);
    const res = await client.messages.create({
      model,
      max_tokens: 64,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    });
    logRun({
      agent: "TestKey", jobId: null, model, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens,
      durationMs: Date.now() - started, ok: true, error: null, mock: false,
    });
    return { ok: true, model, message: `Key works. ${res.usage.input_tokens + res.usage.output_tokens} tokens used.` };
  } catch (err) {
    const e = toAgentError("TestKey", err);
    logRun({
      agent: "TestKey", jobId: null, model, inputTokens: 0, outputTokens: 0,
      durationMs: Date.now() - started, ok: false, error: e.message, mock: false,
    });
    return { ok: false, model, message: e.message };
  }
}
