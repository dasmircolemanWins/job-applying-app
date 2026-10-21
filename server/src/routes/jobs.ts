import { Router, type Request, type Response } from "express";
import fs from "node:fs/promises";
import { z } from "zod";
import { JOB_STATUSES } from "../../../shared/types.js";
import type { ApplicationRoute, Job, JobStatus, ResumeDocument } from "../../../shared/types.js";
import { all, get, nowIso, run } from "../db.js";
import { asyncHandler, badRequest, conflict, idParam, notFound, validate } from "../http.js";
import { dbApplication, dbJob, dbKit, dbFacts, dbRules, dbStories, jobDetail, jobSummary } from "../services/core.js";
import { makeAnswers, parseJob } from "../services/agents.js";
import { fetchJobText } from "../services/jobFetch.js";
import { buildJobKit, checkHonestyGate, parseJobRecordForRoute, qualifyJobForRoute, runJobPipeline } from "../services/pipeline.js";
import { analyzeResume } from "../services/agents.js";
import { renderResume } from "../services/render.js";
import { TAILORED_DIR } from "../paths.js";
import path from "node:path";

export const router = Router();
export async function createJobFromUrl(url: string, source: "url" | "email" = "url") {
  return addJob({ url }, source);
}

const createSchema = z.object({
  url: z.string().url().optional(), text: z.string().max(200000).optional(),
  title: z.string().trim().max(200).optional(), company: z.string().trim().max(200).optional(),
  board: z.string().max(100).optional(),
}).strict().refine(v => !!v.text?.trim() || !!v.url || !!v.title, "Provide a job description, URL, or title");
const appliedSchema = z.object({ route: z.enum(["ats", "site", "manual", "assist"]), notes: z.string().max(4000).optional() }).strict();
const parkSchema = z.object({ reason: z.string().trim().min(1).max(1000), retry_plan: z.string().max(2000).optional() }).strict();
const blockSchema = z.object({ reason: z.enum(["captcha", "identity", "lever", "login", "payment", "other"]), action_text: z.string().min(1).max(1000), link: z.string().url().optional() }).strict();
const resumeDocumentSchema = z.object({
  contact: z.object({ name: z.string(), email: z.string(), phone: z.string(), location: z.string(), links: z.array(z.string()) }).strict(),
  summary: z.string(), experience: z.array(z.object({
    company: z.string(), title: z.string(), start: z.string(), end: z.string(), location: z.string(), bullets: z.array(z.string()),
  }).strict()), education: z.array(z.object({ school: z.string(), degree: z.string(), field: z.string(), year: z.string() }).strict()),
  skills: z.array(z.string()), certifications: z.array(z.string()),
  projects: z.array(z.object({ name: z.string(), description: z.string(), bullets: z.array(z.string()) }).strict()),
}).strict();

function findJob(id: number): Job {
  const row = get<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", id);
  if (!row) throw notFound("Job not found");
  return dbJob(row);
}
function dedupe(company: string, title: string, location: string, postingId?: string): string {
  return postingId
    ? `${company.toLowerCase().trim()}|${postingId.toLowerCase().trim()}`
    : `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}|${location.toLowerCase().trim()}`;
}
async function addJob(input: z.infer<typeof createSchema>, source: "manual" | "url" | "bulk" | "email" = "manual") {
  const text = input.text?.trim() || (input.url ? await fetchJobText(input.url) : "");
  const title = input.title?.trim() ?? "";
  const company = input.company?.trim() ?? "";
  const location = "";
  const parsed = await parseJob(text, input.url ?? "", { title, company });
  const resolvedTitle = title || parsed.title;
  const resolvedCompany = company || parsed.company;
  const key = dedupe(resolvedCompany, resolvedTitle || input.url || "", parsed.location, parsed.postingId);
  if (get("SELECT id FROM jobs WHERE dedupe_key=?", key)) throw conflict("A matching job already exists");
  const ts = nowIso();
  const result = run(`INSERT INTO jobs(source,url,title,company,location,remote_type,description_text,ats_vendor,posting_id,board,status,dedupe_key,found_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?, 'new',?,?,?,?)`,
  source, input.url ?? null, resolvedTitle, resolvedCompany, parsed.location || location, parsed.remoteType, text, parsed.atsVendor, parsed.postingId ?? null, input.board ?? null, key, ts, ts, ts);
  return findJob(result.lastInsertRowid);
}

router.get("/jobs", asyncHandler((req, res) => {
  const query = validate(req.query, z.object({
    status: z.enum(JOB_STATUSES).or(z.literal("")).optional(), q: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  }));
  const where: string[] = [], params: (string | number)[] = [];
  if (query.status) { where.push("status=?"); params.push(query.status); }
  if (query.q) { where.push("(title LIKE ? OR company LIKE ? OR location LIKE ?)"); const q = `%${query.q}%`; params.push(q, q, q); }
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = get<{ count: number }>(`SELECT COUNT(*) AS count FROM jobs${clause}`, ...params)?.count ?? 0;
  const items = all<Record<string, unknown>>(`SELECT * FROM jobs${clause} ORDER BY found_at DESC,id DESC LIMIT ? OFFSET ?`, ...params, query.limit, query.offset);
  res.json({ items: items.map(jobSummary), total });
}));
router.post("/jobs", asyncHandler(async (req, res) => {
  const input = validate(req.body, createSchema);
  res.status(201).json(await addJob(input, input.url ? "url" : "manual"));
}));
router.post("/jobs/bulk", asyncHandler(async (req, res) => {
  const body = validate(req.body, z.object({ urls: z.array(z.string().url()).max(100) }).strict());
  const created: Job[] = [], duplicates: string[] = [], failed: { url: string; error: string }[] = [];
  for (const url of body.urls) {
    try { created.push(await addJob({ url }, "bulk")); }
    catch (e) { if (e instanceof Error && e.message.includes("matching job")) duplicates.push(url); else failed.push({ url, error: "Could not add this job URL" }); }
  }
  res.status(201).json({ created, duplicates, failed });
}));
router.post("/jobs/run-all", asyncHandler((req, res) => {
  const body = validate(req.body ?? {}, z.object({ statuses: z.array(z.enum(JOB_STATUSES)).optional() }).strict());
  if (batch.running) throw conflict("A job batch is already running");
  const statuses = body.statuses?.length ? body.statuses : ["new", "parsed", "qualified"];
  const placeholders = statuses.map(() => "?").join(",");
  const ids = all<{ id: number }>(`SELECT id FROM jobs WHERE status IN (${placeholders}) ORDER BY id`, ...statuses).map(r => r.id);
  batch = { running: true, done: 0, total: ids.length, current: null, errors: [] };
  void (async () => {
    try {
      for (const id of ids) {
        try {
          const j = findJob(id);
          batch.current = { jobId: id, title: j.title, company: j.company };
          const parsed = await parseJobRecordForRoute(id);
          const q = await qualifyJobForRoute(parsed.id);
          if (q.status === "qualified") await buildJobKit(parsed.id);
        } catch (e) {
          const error = e instanceof Error ? e.message : "Pipeline failed";
          batch.errors.push({ jobId: id, error });
          run("UPDATE jobs SET status_reason=?,updated_at=? WHERE id=?", error.slice(0, 1000), nowIso(), id);
        }
        batch.done++;
      }
    } finally {
      batch.running = false;
      batch.current = null;
    }
  })();
  res.json({ started: ids.length });
}));
let batch: { running: boolean; done: number; total: number; current: { jobId: number; title: string; company: string } | null; errors: { jobId: number; error: string }[] } = { running: false, done: 0, total: 0, current: null, errors: [] };
router.get("/jobs/run-status", (_req, res) => res.json(batch));

router.get("/jobs/:id", (req, res) => res.json(jobDetail(findJob(idParam(req.params.id)))));
router.put("/jobs/:id", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  const job = findJob(id);
  const body = validate(req.body, z.object({
    url: z.string().url().nullable().optional(), text: z.string().max(200000).optional(),
    title: z.string().trim().max(200).optional(), company: z.string().trim().max(200).optional(),
    location: z.string().max(300).optional(), board: z.string().max(100).nullable().optional(),
  }).strict());
  const url = body.url === undefined ? job.url : body.url;
  const text = body.text ?? (body.url && body.url !== job.url ? await fetchJobText(body.url) : job.descriptionText);
  const title = body.title ?? job.title;
  const company = body.company ?? job.company;
  const location = body.location ?? job.location;
  const key = dedupe(company, title, location, job.postingId ?? undefined);
  if (get("SELECT id FROM jobs WHERE dedupe_key=? AND id<>?", key, id)) throw conflict("A matching job already exists");
  const ts = nowIso();
  run("UPDATE jobs SET url=?,title=?,company=?,location=?,description_text=?,board=COALESCE(?,board),dedupe_key=?,parsed_json=NULL,qualification_json=NULL,fit_score=NULL,status='new',status_reason=NULL,updated_at=? WHERE id=?",
    url, title, company, location, text, body.board ?? null, key, ts, id);
  res.json(findJob(id));
}));
router.delete("/jobs/:id", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  if (!get("SELECT id FROM jobs WHERE id=?", id)) throw notFound("Job not found");
  const kit = get<{ pdf_path: string | null; docx_path: string | null }>("SELECT pdf_path,docx_path FROM application_kits WHERE job_id=?", id);
  run("DELETE FROM jobs WHERE id=?", id);
  for (const file of [kit?.pdf_path, kit?.docx_path]) {
    if (!file) continue;
    const resolved = path.resolve(file);
    if (path.dirname(resolved) === path.resolve(TAILORED_DIR)) await fs.unlink(resolved).catch(() => undefined);
  }
  res.status(204).end();
}));
router.post("/jobs/:id/parse", asyncHandler(async (req, res) => res.json(await parseJobRecordForRoute(idParam(req.params.id)))));
router.post("/jobs/:id/qualify", asyncHandler(async (req, res) => res.json(await qualifyJobForRoute(idParam(req.params.id)))));
router.post("/jobs/:id/build-kit", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  res.json(await buildJobKit(id));
}));
router.post("/jobs/:id/run", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  res.json(await runJobPipeline(id));
}));

router.put("/jobs/:id/kit", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  if (!get("SELECT id FROM jobs WHERE id=?", id)) throw notFound("Job not found");
  const current = dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id));
  if (!current) throw notFound("Application kit not found");
  const body = validate(req.body, z.object({
    tailored: resumeDocumentSchema.optional(),
    answers: z.array(z.object({ question: z.string(), answer: z.string(), source: z.string(), needsHuman: z.boolean(), humanReason: z.string().optional() })).optional(),
    coverLetter: z.string().max(20000).optional(),
  }).strict());
  const tailored = body.tailored ?? current.tailored;
  if (tailored && current.selectedResumeId != null) {
    const sourceRow = get<{ parsed_json: string | null; text: string }>("SELECT parsed_json,text FROM resumes WHERE id=?", current.selectedResumeId);
    if (!sourceRow) throw conflict("The selected source resume no longer exists");
    const source = sourceRow.parsed_json ? JSON.parse(sourceRow.parsed_json) as ResumeDocument : await analyzeResume(sourceRow.text);
    const report = checkHonestyGate(tailored, source, id);
    if (report.verdict !== "pass" || report.unsupportedCount !== 0) throw badRequest("Edited kit contains claims that are not supported by the selected resume");
    const job = findJob(id);
    const rendered = await renderResume(id, job.company, job.title, tailored);
    run("UPDATE application_kits SET tailored_json=?,honesty_json=?,answers_json=?,cover_letter=?,pdf_path=?,docx_path=?,updated_at=? WHERE job_id=?",
      JSON.stringify(tailored), JSON.stringify(report), JSON.stringify(body.answers ?? current.answers), body.coverLetter ?? current.coverLetter, rendered.pdfPath, rendered.docxPath, nowIso(), id);
  } else {
    run("UPDATE application_kits SET answers_json=?,cover_letter=?,updated_at=? WHERE job_id=?",
      JSON.stringify(body.answers ?? current.answers), body.coverLetter ?? current.coverLetter, nowIso(), id);
  }
  res.json(dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id)));
}));
router.post("/jobs/:id/kit/approve", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  const job = await qualifyJobForRoute(id);
  if (job.status !== "qualified") throw conflict(`Job did not qualify: ${job.statusReason ?? "hard rules"}`);
  const current = dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id));
  if (!current?.tailored || current.honesty?.verdict !== "pass" || current.honesty.unsupportedCount !== 0) {
    throw conflict("A passing honesty-checked kit is required before approval");
  }
  run("UPDATE application_kits SET status='approved',updated_at=? WHERE job_id=?", nowIso(), id);
  res.json(dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id)));
}));
function downloadKit(format: "pdf" | "docx") {
  return (req: Request, res: Response) => {
    const id = idParam(req.params.id);
    const kit = dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id));
    const file = format === "pdf" ? kit?.pdfPath : kit?.docxPath;
    if (!file || !kit?.tailored || kit.honesty?.verdict !== "pass" || kit.honesty.unsupportedCount !== 0) {
      throw notFound("No passing honesty-checked application file is available");
    }
    const resolved = path.resolve(file);
    if (path.dirname(resolved) !== path.resolve(TAILORED_DIR)) throw badRequest("Invalid application file path");
    res.download(resolved, path.basename(resolved));
  };
}
router.get("/jobs/:id/kit/pdf", downloadKit("pdf"));
router.get("/jobs/:id/kit/docx", downloadKit("docx"));

router.post("/jobs/:id/questions", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  const job = findJob(id);
  const posting = job.parsed ?? await parseJob(job.descriptionText, job.url ?? "", { title: job.title, company: job.company }, id);
  const questions = validate(req.body, z.object({ questions: z.array(z.string().trim().min(1).max(1000)).max(100) }).strict()).questions;
  const generated = makeAnswers(questions, dbFacts(), dbStories(), posting, id, dbRules());
  const kit = dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id));
  if (kit) run("UPDATE application_kits SET answers_json=?,updated_at=? WHERE job_id=?", JSON.stringify([...kit.answers, ...generated.answers]), nowIso(), id);
  res.json(generated.answers);
}));
router.post("/jobs/:id/mark-applied", asyncHandler((req, res) => {
  const id = idParam(req.params.id);
  const job = findJob(id);
  if (get("SELECT id FROM applications WHERE job_id=? LIMIT 1", id)) throw conflict("This job is already in the application ledger");
  const body = validate(req.body, appliedSchema);
  const ts = nowIso();
  const kit = dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id));
  const result = run("INSERT INTO applications(job_id,company,title,posting_id,route,resume_file,submitted_at,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    id, job.company, job.title, job.postingId, body.route as ApplicationRoute, kit?.pdfPath ?? null, ts, body.notes ?? "", ts, ts);
  run("UPDATE jobs SET status='applied',updated_at=? WHERE id=?", ts, id);
  res.status(201).json(dbApplication(get<Record<string, unknown>>("SELECT * FROM applications WHERE id=?", result.lastInsertRowid)!));
}));
router.post("/jobs/:id/park", asyncHandler((req, res) => {
  const id = idParam(req.params.id), job = findJob(id), body = validate(req.body, parkSchema), ts = nowIso();
  const result = run("INSERT INTO parked_items(job_id,reason,retry_plan,resolved,created_at,updated_at) VALUES(?,?,?,0,?,?)", id, body.reason, body.retry_plan ?? "", ts, ts);
  run("UPDATE jobs SET status='parked',status_reason=?,updated_at=? WHERE id=?", body.reason, ts, id);
  res.status(201).json({ id: result.lastInsertRowid, jobId: id, reason: body.reason, retryPlan: body.retry_plan ?? "", resolved: false, createdAt: ts, updatedAt: ts, company: job.company, title: job.title });
}));
router.post("/jobs/:id/block", asyncHandler((req, res) => {
  const id = idParam(req.params.id), job = findJob(id), body = validate(req.body, blockSchema), ts = nowIso();
  const kit = dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id));
  const result = run("INSERT INTO blocked_items(job_id,reason,action_text,link,resume_file,resolved,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)",
    id, body.reason, body.action_text, body.link ?? job.url, kit?.pdfPath ?? null, ts, ts);
  run("UPDATE jobs SET status='blocked',status_reason=?,updated_at=? WHERE id=?", body.reason, ts, id);
  res.status(201).json({ id: result.lastInsertRowid, jobId: id, reason: body.reason, actionText: body.action_text, link: body.link ?? job.url, resumeFile: kit?.pdfPath ?? null, resolved: false, createdAt: ts, updatedAt: ts, company: job.company, title: job.title });
}));
