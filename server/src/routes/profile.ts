import { Router } from "express";
import { z } from "zod";
import { DEFAULT_STANDING_FACTS } from "../../../shared/types.js";
import type { Rules, StandingFacts, Story } from "../../../shared/types.js";
import { all, get, nowIso, run } from "../db.js";
import { dbFacts, dbRules, dbStories } from "../services/core.js";
import { analyzeResume } from "../services/agents.js";
import { asyncHandler, badRequest, notFound, validate } from "../http.js";

export const router = Router();

const education = z.object({ school: z.string(), degree: z.string(), field: z.string(), year: z.string() });
const factsSchema = z.object({
  fullName: z.string(), email: z.string(), phone: z.string(), address: z.string(), timeZone: z.string(),
  workAuthorization: z.string(), sponsorshipAnswer: z.string(), requiresSponsorship: z.boolean().nullable(),
  targetTitles: z.array(z.string()), locationMode: z.enum(["remote", "hybrid", "onsite", "any"]),
  regions: z.array(z.string()), payFloor: z.number().nullable(), desiredPay: z.number().nullable(),
  payCurrency: z.string(), soonestStart: z.string(), howDidYouHear: z.string(), linkedinUrl: z.string(),
  portfolioUrl: z.string(), eeo: z.object({ gender: z.string(), race: z.string(), veteranStatus: z.string(), disabilityStatus: z.string() }),
  screeners: z.object({ accommodations: z.string(), startupExperience: z.string(), yearsBySkill: z.record(z.string(), z.number()), smsOk: z.boolean() }),
  education: z.array(education), summary: z.string(),
}).strict();
const rulesSchema = z.object({
  roleExclusions: z.array(z.string()), blacklistTitles: z.array(z.string()), excludedCompanies: z.array(z.string()),
  excludedSenders: z.array(z.string()), neverTouchFiltersNote: z.string(),
  salary: z.object({ floor: z.number().nullable(), desired: z.number().nullable(), currency: z.string(), answerStyle: z.enum(["range", "single", "decline"]), negotiable: z.boolean() }),
  customRules: z.array(z.object({ text: z.string(), createdAt: z.string() })),
}).strict();
const storySchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(20000), approved: z.boolean() }).strict();

router.get("/profile", (_req, res) => res.json(dbFacts()));
router.put("/profile", asyncHandler((req, res) => {
  const facts = validate(req.body, factsSchema) as StandingFacts;
  run("UPDATE profile SET facts_json=?,updated_at=? WHERE id=1", JSON.stringify(facts), nowIso());
  res.json(facts);
}));
router.get("/rules", (_req, res) => res.json(dbRules()));
router.put("/rules", asyncHandler((req, res) => {
  const rules = validate(req.body, rulesSchema) as Rules;
  run("UPDATE rules SET rules_json=?,updated_at=? WHERE id=1", JSON.stringify(rules), nowIso());
  res.json(rules);
}));
router.get("/stories", (_req, res) => res.json(dbStories()));
router.put("/stories/:key", asyncHandler((req, res) => {
  const key = String(req.params.key);
  if (!/^[a-z0-9_-]{1,80}$/i.test(key)) throw badRequest("Invalid story key");
  const body = validate(req.body, storySchema);
  const ts = nowIso();
  run(`INSERT INTO stories(key,title,body,approved,created_at,updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET title=excluded.title,body=excluded.body,approved=excluded.approved,updated_at=excluded.updated_at`,
  key, body.title, body.body, body.approved ? 1 : 0, ts, ts);
  const row = get<Record<string, unknown>>("SELECT * FROM stories WHERE key=?", key);
  if (!row) throw notFound("Story not found");
  res.json({ id: Number(row.id), key: String(row.key), title: String(row.title), body: String(row.body), approved: Number(row.approved) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at) } satisfies Story);
}));
router.post("/intake/suggest", asyncHandler(async (req, res) => {
  const input = z.object({ resumeIds: z.array(z.number().int().positive()).optional() }).strict().parse(req.body ?? {});
  const ids = input.resumeIds;
  const rows = ids?.length
    ? ids.map(id => get<Record<string, unknown>>("SELECT * FROM resumes WHERE id=?", id)).filter((r): r is Record<string, unknown> => !!r)
    : all<Record<string, unknown>>("SELECT * FROM resumes ORDER BY id");
  const analyzed = [];
  for (const row of rows) analyzed.push(await analyzeResume(String(row.text ?? "")));
  const current = dbFacts();
  const first = analyzed[0];
  const suggestion: Partial<StandingFacts> = first ? {
    ...DEFAULT_STANDING_FACTS,
    fullName: first.contact.name || current.fullName,
    email: first.contact.email || current.email,
    phone: first.contact.phone || current.phone,
    linkedinUrl: first.contact.links.find(x => /linkedin/i.test(x)) || current.linkedinUrl,
    portfolioUrl: first.contact.links.find(x => !/linkedin/i.test(x)) || current.portfolioUrl,
    summary: first.summary || current.summary,
    education: first.education.map(x => ({ school: x.school, degree: x.degree, field: x.field, year: x.year })),
  } : {};
  res.json(suggestion);
}));
