import { Router } from "express";
import { z } from "zod";
import type { AssistLogEntry, AssistSession, FormField } from "../../../shared/types.js";
import { all, get, nowIso, run } from "../db.js";
import { asyncHandler, badRequest, conflict, idParam, notFound, validate } from "../http.js";
import { dbAssist, dbJob } from "../services/core.js";

export const router = Router();

function getSession(jobId: number): AssistSession {
  const row = get<Record<string, unknown>>("SELECT * FROM assist_sessions WHERE job_id=? ORDER BY id DESC LIMIT 1", jobId);
  if (!row) throw notFound("Apply-assist session not found");
  return dbAssist(row);
}

function saveSession(jobId: number, status: AssistSession["status"], log: AssistLogEntry[], fields: FormField[] = [], mappings: AssistSession["mappings"] = []): AssistSession {
  const ts = nowIso();
  const existing = get<{ id: number }>("SELECT id FROM assist_sessions WHERE job_id=? AND status NOT IN ('closed','submitted') ORDER BY id DESC LIMIT 1", jobId);
  if (existing) {
    run("UPDATE assist_sessions SET status=?,field_map_json=?,log_json=?,updated_at=? WHERE id=?",
      status, JSON.stringify({ fields, mappings }), JSON.stringify(log), ts, existing.id);
    return dbAssist(get<Record<string, unknown>>("SELECT * FROM assist_sessions WHERE id=?", existing.id)!);
  }
  const result = run("INSERT INTO assist_sessions(job_id,status,field_map_json,log_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    jobId, status, JSON.stringify({ fields, mappings }), JSON.stringify(log), ts, ts);
  return dbAssist(get<Record<string, unknown>>("SELECT * FROM assist_sessions WHERE id=?", result.lastInsertRowid)!);
}

router.get("/assist/status", (_req, res) => {
  const row = get<Record<string, unknown>>("SELECT * FROM assist_sessions WHERE status NOT IN ('closed','submitted') ORDER BY updated_at DESC,id DESC LIMIT 1");
  res.json({ browserInstalled: false, active: row ? dbAssist(row) : null });
});

router.post("/assist/:jobId/start", asyncHandler(async (req, res) => {
  const jobId = idParam(req.params.jobId, "jobId");
  const jobRow = get<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", jobId);
  if (!jobRow) throw notFound("Job not found");
  const job = dbJob(jobRow);
  if (!job.url) throw badRequest("Add a public application URL before starting apply-assist");
  const existing = get<Record<string, unknown>>("SELECT * FROM assist_sessions WHERE job_id=? AND status NOT IN ('closed','submitted') ORDER BY id DESC LIMIT 1", jobId);
  if (existing) throw conflict("An apply-assist review session is already active for this job");
  const entry: AssistLogEntry = {
    at: nowIso(),
    level: "warn",
    message: "Manual application handoff opened. No browser was launched and no form was filled or submitted.",
  };
  res.status(201).json(saveSession(jobId, "ready_for_review", [entry]));
}));

router.get("/assist/:jobId", (req, res) => {
  const jobId = idParam(req.params.jobId, "jobId");
  const row = get<Record<string, unknown>>("SELECT * FROM assist_sessions WHERE job_id=? ORDER BY id DESC LIMIT 1", jobId);
  res.json(row ? dbAssist(row) : null);
});

router.post("/assist/:jobId/submit", asyncHandler(async (req, res) => {
  const jobId = idParam(req.params.jobId, "jobId");
  const body = validate(req.body ?? {}, z.object({ confirm: z.literal(true) }).strict());
  void body;
  const session = getSession(jobId);
  if (session.status !== "ready_for_review") throw conflict("Only a ready-for-review session can be confirmed");
  const ts = nowIso();
  if (!get("SELECT id FROM applications WHERE job_id=? LIMIT 1", jobId)) {
    const jobRow = get<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", jobId);
    if (!jobRow) throw notFound("Job not found");
    const kit = get<{ pdf_path: string | null }>("SELECT pdf_path FROM application_kits WHERE job_id=?", jobId);
    run("INSERT INTO applications(job_id,company,title,posting_id,route,resume_file,submitted_at,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      jobId, String(jobRow.company ?? ""), String(jobRow.title ?? ""), jobRow.posting_id as string | null,
      "assist", kit?.pdf_path ?? null, ts, "User confirmed they submitted manually on the job site; ApplyPilot did not submit the form.", ts, ts);
    run("UPDATE jobs SET status='applied',updated_at=? WHERE id=?", ts, jobId);
  }
  const log = [...session.log, { at: ts, level: "info" as const, message: "User attested that they submitted manually on the job site; ApplyPilot did not interact with the application form." }];
  const updated = saveSession(jobId, "submitted", log, session.fields, session.mappings);
  res.json(updated);
}));

router.post("/assist/:jobId/close", (req, res) => {
  const jobId = idParam(req.params.jobId, "jobId");
  const session = getSession(jobId);
  const updated = saveSession(jobId, "closed", [...session.log, {
    at: nowIso(), level: "info", message: "Human-review session closed.",
  }], session.fields, session.mappings);
  res.json(updated);
});
