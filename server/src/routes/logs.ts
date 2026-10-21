import { Router } from "express";
import { z } from "zod";
import { JOB_STATUSES } from "../../../shared/types.js";
import type { JobStatus } from "../../../shared/types.js";
import { all, get, nowIso, run } from "../db.js";
import { asyncHandler, idParam, notFound, validate } from "../http.js";
import { isMockActive } from "../config.js";
import { dbApplication, dbBlocked, dbParked, dbRun } from "../services/core.js";

export const router = Router();

router.get("/ledger", asyncHandler((req, res) => {
  const q = validate(req.query, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }));
  const total = get<{ count: number }>("SELECT COUNT(*) AS count FROM applications")?.count ?? 0;
  const rows = all<Record<string, unknown>>("SELECT * FROM applications ORDER BY submitted_at DESC,id DESC LIMIT ? OFFSET ?", q.limit, q.offset);
  res.json({ items: rows.map(r => dbApplication(r)!), total });
}));
router.get("/blocked", (_req, res) => {
  const rows = all<Record<string, unknown>>(`SELECT b.*,j.company,j.title FROM blocked_items b JOIN jobs j ON j.id=b.job_id ORDER BY b.resolved,b.created_at DESC`);
  res.json(rows.map(dbBlocked));
});
router.post("/blocked/:id/resolve", (req, res) => {
  const id = idParam(req.params.id);
  const row = get<{ id: number }>("SELECT id FROM blocked_items WHERE id=?", id);
  if (!row) throw notFound("Blocked item not found");
  run("UPDATE blocked_items SET resolved=1,updated_at=? WHERE id=?", nowIso(), id);
  const updated = all<Record<string, unknown>>("SELECT b.*,j.company,j.title FROM blocked_items b JOIN jobs j ON j.id=b.job_id WHERE b.id=?", id)[0];
  res.json(dbBlocked(updated!));
});
router.get("/parked", (_req, res) => {
  const rows = all<Record<string, unknown>>(`SELECT p.*,j.company,j.title FROM parked_items p JOIN jobs j ON j.id=p.job_id ORDER BY p.resolved,p.created_at DESC`);
  res.json(rows.map(dbParked));
});
router.post("/parked/:id/resolve", (req, res) => {
  const id = idParam(req.params.id);
  if (!get("SELECT id FROM parked_items WHERE id=?", id)) throw notFound("Parked item not found");
  run("UPDATE parked_items SET resolved=1,updated_at=? WHERE id=?", nowIso(), id);
  const row = all<Record<string, unknown>>("SELECT p.*,j.company,j.title FROM parked_items p JOIN jobs j ON j.id=p.job_id WHERE p.id=?", id)[0];
  res.json(dbParked(row!));
});

const utcDate = () => new Date().toISOString().slice(0, 10);
router.get("/reports/today", (_req, res) => {
  const date = utcDate();
  const submitted = get<{ count: number }>("SELECT COUNT(*) AS count FROM applications WHERE substr(submitted_at,1,10)=?", date)?.count ?? 0;
  const total = get<{ count: number }>("SELECT COUNT(*) AS count FROM applications")?.count ?? 0;
  res.json({ date, submitted, total, line: `${submitted} today and ${total} total` });
});
router.get("/reports/weekly", (_req, res) => {
  const start = new Date();
  const mondayOffset = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const week = new Date(start);
    week.setUTCDate(week.getUTCDate() - i * 7);
    const weekStart = week.toISOString().slice(0, 10);
    const next = new Date(week);
    next.setUTCDate(next.getUTCDate() + 7);
    const weekEnd = next.toISOString().slice(0, 10);
    const submitted = get<{ count: number }>("SELECT COUNT(*) AS count FROM applications WHERE substr(submitted_at,1,10)>=? AND substr(submitted_at,1,10)<?", weekStart, weekEnd)?.count ?? 0;
    const interviews = get<{ count: number }>("SELECT COUNT(*) AS count FROM applications WHERE substr(submitted_at,1,10)>=? AND substr(submitted_at,1,10)<? AND lower(notes) LIKE '%interview%'", weekStart, weekEnd)?.count ?? 0;
    weeks.push({ weekStart, submitted, interviews });
  }
  res.json({ weeks });
});
router.post("/reports/interview", asyncHandler((req, res) => {
  const body = validate(req.body, z.object({ jobId: z.number().int().positive() }).strict());
  const application = get<{ id: number; notes: string }>("SELECT id,notes FROM applications WHERE job_id=? ORDER BY submitted_at DESC LIMIT 1", body.jobId);
  if (!application) throw notFound("No ledger application exists for this job");
  const notes = application.notes.toLowerCase().includes("interview") ? application.notes : `${application.notes}${application.notes ? "\n" : ""}Interview received`;
  run("UPDATE applications SET notes=?,updated_at=? WHERE id=?", notes, nowIso(), application.id);
  res.json({ ok: true });
}));
const logQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
router.get("/agent-runs", asyncHandler((req, res) => {
  const { limit } = validate(req.query, logQuery);
  const rows = all<Record<string, unknown>>("SELECT * FROM agent_runs ORDER BY created_at DESC,id DESC LIMIT ?", limit);
  res.json(rows.map(dbRun));
}));
router.get("/logs", asyncHandler((req, res) => {
  const { limit, offset } = validate(req.query, logQuery);
  const total = get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs")?.count ?? 0;
  const rows = all<Record<string, unknown>>("SELECT * FROM agent_runs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", limit, offset);
  res.json({ items: rows.map(dbRun), total });
}));
router.get("/dashboard", (_req, res) => {
  const today = utcDate();
  const submittedToday = get<{ count: number }>("SELECT COUNT(*) AS count FROM applications WHERE substr(submitted_at,1,10)=?", today)?.count ?? 0;
  const total = get<{ count: number }>("SELECT COUNT(*) AS count FROM applications")?.count ?? 0;
  const byStatus = Object.fromEntries(JOB_STATUSES.map(status => [status, 0])) as Record<JobStatus, number>;
  for (const row of all<{ status: string; count: number }>("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status")) {
    if (row.status in byStatus) byStatus[row.status as JobStatus] = row.count;
  }
  const blockedCount = get<{ count: number }>("SELECT COUNT(*) AS count FROM blocked_items WHERE resolved=0")?.count ?? 0;
  const parkedCount = get<{ count: number }>("SELECT COUNT(*) AS count FROM parked_items WHERE resolved=0")?.count ?? 0;
  const resumesCount = get<{ count: number }>("SELECT COUNT(*) AS count FROM resumes")?.count ?? 0;
  const bankBuilt = !!get("SELECT id FROM experience_bank WHERE id=1");
  const tokensToday = get<{ count: number }>("SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS count FROM agent_runs WHERE substr(created_at,1,10)=?", today)?.count ?? 0;
  const recentRuns = all<Record<string, unknown>>("SELECT * FROM agent_runs ORDER BY created_at DESC,id DESC LIMIT 8").map(dbRun);
  res.json({ today: submittedToday, total, byStatus, blockedCount, parkedCount, resumesCount, bankBuilt, mockActive: isMockActive(), tokensToday, recentRuns });
});
