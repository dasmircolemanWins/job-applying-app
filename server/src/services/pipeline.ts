import fs from "node:fs/promises";
import path from "node:path";
import type { HonestyReport, Job, JobPosting, JobStatus, ResumeDocument } from "../../../shared/types.js";
import { all, get, nowIso, run } from "../db.js";
import { badRequest, conflict, notFound } from "../http.js";
import { TAILORED_DIR } from "../paths.js";
import {
  analyzeResume, buildBank, honesty, makeAnswers, parseJob, qualify, selectResume, tailorResume,
} from "./agents.js";
import {
  dbBank, dbFacts, dbJob, dbKit, dbRules, dbStories, jobDetail,
} from "./core.js";
import { renderResume } from "./render.js";

function checkResumeDocument(value: unknown): value is ResumeDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as Partial<ResumeDocument>;
  const contact = doc.contact as unknown as { name?: unknown; email?: unknown; phone?: unknown; location?: unknown; links?: unknown } | undefined;
  return !!contact && typeof contact === "object"
    && ["name", "email", "phone", "location"].every(key => typeof contact[key as "name" | "email" | "phone" | "location"] === "string")
    && Array.isArray(contact.links) && contact.links.every(item => typeof item === "string")
    && typeof doc.summary === "string"
    && Array.isArray(doc.experience) && doc.experience.every(role => role && typeof role.company === "string"
      && typeof role.title === "string" && typeof role.start === "string" && typeof role.end === "string"
      && typeof role.location === "string" && Array.isArray(role.bullets) && role.bullets.every(item => typeof item === "string"))
    && Array.isArray(doc.education) && doc.education.every(item => item && ["school", "degree", "field", "year"].every(key => typeof (item as unknown as Record<string, unknown>)[key] === "string"))
    && Array.isArray(doc.skills) && doc.skills.every(item => typeof item === "string")
    && Array.isArray(doc.certifications) && doc.certifications.every(item => typeof item === "string")
    && Array.isArray(doc.projects) && doc.projects.every(item => item && typeof item.name === "string"
      && typeof item.description === "string" && Array.isArray(item.bullets) && item.bullets.every(bullet => typeof bullet === "string"));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function checkHonestyGate(document: ResumeDocument, source: ResumeDocument, jobId: number): HonestyReport {
  let report: HonestyReport;
  try {
    report = honesty(document, source, jobId);
  } catch {
    return { claims: [{ text: "Honesty analysis failed", section: "document", supported: false }], unsupportedCount: 1, verdict: "fail" };
  }
  const unsupported: HonestyReport["claims"] = report.claims.filter(claim => !claim.supported);
  const addFailure = (text: string, section: string) => unsupported.push({ text, section, supported: false });
  if (report.verdict !== "pass" && unsupported.length === 0) addFailure("Honesty checker returned a failing verdict", "document");
  if (report.unsupportedCount > unsupported.length) addFailure("Honesty checker reported unsupported claims", "document");
  for (const field of ["name", "email", "phone", "location"] as const) {
    if (document.contact[field] !== source.contact[field]) addFailure(`Changed ${field}`, "contact");
  }
  if (!same(document.contact.links, source.contact.links)) addFailure("Changed contact links", "contact");
  if (document.summary !== source.summary) addFailure("Changed summary", "summary");
  if (!same(document.education, source.education)) addFailure("Changed education", "education");
  if (!same(document.certifications, source.certifications)) addFailure("Changed certifications", "certifications");
  if (!same(document.projects, source.projects)) addFailure("Changed projects", "projects");
  if (document.experience.length !== source.experience.length) addFailure("Changed role count", "experience");
  for (let index = 0; index < document.experience.length; index++) {
    const role = document.experience[index];
    const base = source.experience[index];
    if (!role || !base) continue;
    if (role.company !== base.company || role.title !== base.title || role.start !== base.start
      || role.end !== base.end || role.location !== base.location) addFailure("Changed employer, role, dates, or location", "experience");
    const sourceBullets = new Set(base.bullets.map(bullet => bullet.trim().toLowerCase()));
    for (const bullet of role.bullets) {
      if (!sourceBullets.has(bullet.trim().toLowerCase())) addFailure(bullet, "experience");
    }
  }
  const sourceSkills = new Set(source.skills.map(skill => skill.trim().toLowerCase()));
  for (const skill of document.skills) {
    if (!sourceSkills.has(skill.trim().toLowerCase())) addFailure(skill, "skills");
  }
  const claims = [...report.claims.filter(claim => claim.supported), ...unsupported];
  return { claims, unsupportedCount: unsupported.length, verdict: unsupported.length ? "fail" : "pass" };
}

function loadJob(id: number): Job {
  const row = get<Record<string, unknown>>("SELECT * FROM jobs WHERE id=?", id);
  if (!row) throw notFound("Job not found");
  return dbJob(row);
}

function makeDedupeKey(company: string, title: string, location: string, postingId?: string): string {
  const normalizedCompany = company.toLowerCase().trim();
  return postingId
    ? `${normalizedCompany}|${postingId.toLowerCase().trim()}`
    : `${normalizedCompany}|${title.toLowerCase().trim()}|${location.toLowerCase().trim()}`;
}

function assertUniqueJob(key: string, id: number): void {
  if (get("SELECT id FROM jobs WHERE dedupe_key=? AND id<>?", key, id)) {
    throw conflict("A matching job already exists");
  }
}

function persistJob(job: Job, ts = nowIso()): void {
  run(`UPDATE jobs SET title=?,company=?,location=?,remote_type=?,pay_min=?,pay_max=?,pay_currency=?,
    parsed_json=?,qualification_json=?,ats_vendor=?,posting_id=?,status=?,status_reason=?,fit_score=?,
    updated_at=? WHERE id=?`,
  job.title, job.company, job.location, job.remoteType, job.payMin, job.payMax, job.payCurrency,
  job.parsed ? JSON.stringify(job.parsed) : null, job.qualification ? JSON.stringify(job.qualification) : null,
  job.atsVendor, job.postingId, job.status, job.statusReason, job.fitScore, ts, job.id);
  run("UPDATE jobs SET dedupe_key=? WHERE id=?", job.dedupeKey, job.id);
}

async function parseJobRecord(id: number): Promise<Job> {
  const job = loadJob(id);
  if (job.parsed) {
    assertUniqueJob(job.dedupeKey, id);
    return job;
  }
  const parsed = await parseJob(job.descriptionText, job.url ?? "", { title: job.title, company: job.company }, id);
  const title = job.title || parsed.title;
  const company = job.company || parsed.company;
  const location = parsed.location || job.location;
  const key = makeDedupeKey(company, title, location, parsed.postingId ?? job.postingId ?? undefined);
  assertUniqueJob(key, id);
  const updated: Job = {
    ...job, title, company, location,
    remoteType: parsed.remoteType,
    payMin: parsed.payMin ?? job.payMin,
    payMax: parsed.payMax ?? job.payMax,
    payCurrency: parsed.payCurrency ?? job.payCurrency,
    atsVendor: parsed.atsVendor,
    postingId: parsed.postingId ?? job.postingId,
    parsed: { ...parsed, title, company, location },
    dedupeKey: key,
    qualification: null,
    fitScore: null,
    status: "parsed",
    statusReason: null,
  };
  persistJob(updated);
  return updated;
}

function ruleBlockers(posting: JobPosting): string[] {
  const rules = dbRules();
  const facts = dbFacts();
  const blockers: string[] = [];
  const includesAny = (value: string, entries: string[]) => entries.some(entry => {
    const rule = entry.trim();
    if (!rule) return false;
    try { return new RegExp(rule, "i").test(value); }
    catch { return value.toLowerCase().includes(rule.toLowerCase()); }
  });

  if (includesAny(posting.company, rules.excludedCompanies)) blockers.push("Company is excluded by your rules");
  if (includesAny(posting.title, [...rules.blacklistTitles, ...rules.roleExclusions])) blockers.push("Role title matches an exclusion");
  if (facts.locationMode !== "any" && posting.remoteType !== "unknown" && facts.locationMode !== posting.remoteType) {
    blockers.push(`Location mode is ${posting.remoteType}, preference is ${facts.locationMode}`);
  }
  if (posting.remoteType !== "remote" && facts.regions.length && posting.location
    && !facts.regions.some(region => posting.location.toLowerCase().includes(region.toLowerCase()))) {
    blockers.push("Posting location is outside your preferred regions");
  }
  const floor = facts.payFloor ?? rules.salary.floor;
  const statedPayCeiling = posting.payMax ?? posting.payMin;
  if (floor !== null && statedPayCeiling !== undefined && statedPayCeiling < floor) {
    blockers.push("Stated compensation is below your pay floor");
  }
  return blockers;
}

async function qualifyJobRecord(job: Job): Promise<Job> {
  const posting = job.parsed ?? await parseJob(job.descriptionText, job.url ?? "", { title: job.title, company: job.company }, job.id);
  const agentResult = qualify(posting, dbFacts(), dbRules(), dbBank(), job.id);
  const hardBlockers = ruleBlockers(posting);
  const blockers = [...new Set([...agentResult.blockers, ...hardBlockers])];
  const result = {
    ...agentResult,
    blockers,
    qualifies: blockers.length === 0 && agentResult.qualifies,
  };
  const status: JobStatus = result.qualifies ? "qualified" : "skipped";
  const updated: Job = {
    ...job,
    parsed: posting,
    qualification: result,
    fitScore: result.fitScore,
    status,
    statusReason: blockers.join("; ") || (result.qualifies ? null : result.gaps.join(", ") || "Did not meet qualification threshold"),
  };
  persistJob(updated);
  return updated;
}

async function ensureExperienceBank(): Promise<{ id: number; label: string; doc: ResumeDocument }[]> {
  const resumes = all<Record<string, unknown>>("SELECT * FROM resumes ORDER BY is_base DESC,id");
  if (!resumes.length) throw badRequest("Upload a resume before building an application kit");
  const parsed = [];
  for (const row of resumes) {
    let doc: ResumeDocument;
    if (row.parsed_json) {
      try {
        const parsed: unknown = JSON.parse(String(row.parsed_json));
        if (!checkResumeDocument(parsed)) throw new Error("invalid shape");
        doc = parsed;
      } catch { throw badRequest(`Resume ${String(row.original_name)} has invalid analysis data; analyze it again`); }
    } else {
      doc = await analyzeResume(String(row.text ?? ""));
      run("UPDATE resumes SET parsed_json=?,skills_json=?,updated_at=? WHERE id=?",
        JSON.stringify(doc), JSON.stringify(doc.skills), nowIso(), Number(row.id));
    }
    parsed.push({ id: Number(row.id), label: String(row.label ?? ""), doc });
  }

  const existing = dbBank();
  const ids = parsed.map(resume => resume.id);
  const bankRow = get<{ built_from_json: string }>("SELECT built_from_json FROM experience_bank WHERE id=1");
  let builtIds: number[] = [];
  if (bankRow) {
    try { builtIds = JSON.parse(bankRow.built_from_json) as number[]; }
    catch { builtIds = []; }
  }
  if (!existing || ids.length !== builtIds.length || ids.some(id => !builtIds.includes(id))) {
    const bank = buildBank(parsed.map(({ id, doc }) => ({ resumeId: id, doc })));
    const ts = nowIso();
    run(`INSERT INTO experience_bank(id,bank_json,built_from_json,built_at,created_at,updated_at)
      VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET bank_json=excluded.bank_json,
      built_from_json=excluded.built_from_json,built_at=excluded.built_at,updated_at=excluded.updated_at`,
    JSON.stringify(bank), JSON.stringify(ids), ts, ts, ts);
  }
  return parsed;
}

function clearKitOutput(jobId: number, report: unknown, resumeId: number, selection: unknown): void {
  const ts = nowIso();
  run(`INSERT INTO application_kits(job_id,selected_resume_id,selection_json,tailored_json,honesty_json,
    keyword_json,answers_json,cover_letter,pdf_path,docx_path,status,created_at,updated_at)
    VALUES(?,?,?,NULL,?,NULL,'[]','',NULL,NULL,'draft',?,?)
    ON CONFLICT(job_id) DO UPDATE SET selected_resume_id=excluded.selected_resume_id,
    selection_json=excluded.selection_json,tailored_json=NULL,honesty_json=excluded.honesty_json,
    keyword_json=NULL,answers_json='[]',cover_letter='',pdf_path=NULL,docx_path=NULL,
    status='draft',updated_at=excluded.updated_at`,
  jobId, resumeId, JSON.stringify(selection), JSON.stringify(report), ts, ts);
}

async function removeRenderedFiles(paths: (string | null)[]): Promise<void> {
  for (const file of paths) {
    if (!file) continue;
    const resolved = path.resolve(file);
    if (path.dirname(resolved) === path.resolve(TAILORED_DIR)) await fs.unlink(resolved).catch(() => undefined);
  }
}

export async function buildJobKit(id: number) {
  let job = loadJob(id);
  if (!job.parsed) job = await parseJobRecord(id);
  const resumes = await ensureExperienceBank();
  job = await qualifyJobRecord(job);
  if (job.status !== "qualified") {
    const oldFiles = get<{ pdf_path: string | null; docx_path: string | null }>(
      "SELECT pdf_path,docx_path FROM application_kits WHERE job_id=?", id,
    );
    run("DELETE FROM application_kits WHERE job_id=?", id);
    await removeRenderedFiles([oldFiles?.pdf_path ?? null, oldFiles?.docx_path ?? null]);
    throw conflict(`Job did not qualify: ${job.statusReason ?? "hard rules or qualification threshold"}`);
  }

  const posting = job.parsed!;
  const selection = await selectResume(posting, resumes, id);
  const selected = resumes.find(resume => resume.id === selection.selectedResumeId);
  if (!selected) throw badRequest("No analyzed resume was selected");

  const tailoredResult = tailorResume(posting, selected.doc, id);
  const tailored = tailoredResult.document;
  const report = checkHonestyGate(tailored, selected.doc, id);
  const previous = get<{ pdf_path: string | null; docx_path: string | null }>(
    "SELECT pdf_path,docx_path FROM application_kits WHERE job_id=?", id,
  );
  if (report.verdict !== "pass" || report.unsupportedCount !== 0) {
    clearKitOutput(id, report, selected.id, selection);
    await removeRenderedFiles([previous?.pdf_path ?? null, previous?.docx_path ?? null]);
    run("UPDATE jobs SET status='skipped',status_reason='Honesty check failed; tailored output withheld',updated_at=? WHERE id=?", nowIso(), id);
    throw conflict("Honesty check failed; tailored output was withheld");
  }

  const generated = makeAnswers(posting.screeningQuestions, dbFacts(), dbStories(), posting, id, dbRules());

  // Persist no tailored content unless the report has passed. Rendering happens only after this gate.
  const rendered = await renderResume(id, job.company, job.title, tailored);
  const ts = nowIso();
  run(`INSERT INTO application_kits(job_id,selected_resume_id,selection_json,tailored_json,honesty_json,
    keyword_json,answers_json,cover_letter,pdf_path,docx_path,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'draft',?,?) ON CONFLICT(job_id) DO UPDATE SET
    selected_resume_id=excluded.selected_resume_id,selection_json=excluded.selection_json,
    tailored_json=excluded.tailored_json,honesty_json=excluded.honesty_json,keyword_json=excluded.keyword_json,
    answers_json=excluded.answers_json,cover_letter=excluded.cover_letter,pdf_path=excluded.pdf_path,
    docx_path=excluded.docx_path,status='draft',updated_at=excluded.updated_at`,
  id, selected.id, JSON.stringify(selection), JSON.stringify(tailored), JSON.stringify(report),
  JSON.stringify(tailoredResult.keywordCoverage), JSON.stringify(generated.answers),
  generated.coverLetter, rendered.pdfPath, rendered.docxPath, ts, ts);
  run("UPDATE jobs SET status='kit_ready',status_reason=NULL,updated_at=? WHERE id=?", ts, id);
  if (previous?.pdf_path !== rendered.pdfPath || previous?.docx_path !== rendered.docxPath) {
    await removeRenderedFiles([previous?.pdf_path ?? null, previous?.docx_path ?? null]);
  }
  const isLever = posting.atsVendor === "lever" || /(?:^|\.)jobs\.lever\.co$/i.test(new URL(job.url ?? posting.applyUrl ?? "https://invalid.local").hostname);
  if (isLever && !get("SELECT id FROM blocked_items WHERE job_id=? AND reason='lever'", id)) {
    const applyUrl = [posting.applyUrl, job.url].find(value => {
      if (!value) return false;
      try {
        const parsedUrl = new URL(value);
        return ["http:", "https:"].includes(parsedUrl.protocol)
          && !parsedUrl.username && !parsedUrl.password
          && (parsedUrl.hostname === "lever.co" || parsedUrl.hostname.endsWith(".lever.co"));
      } catch {
        return false;
      }
    }) ?? null;
    run(`INSERT INTO blocked_items(job_id,reason,action_text,link,resume_file,resolved,created_at,updated_at)
      VALUES(?,'lever',?,?,?,0,?,?)`,
    id, `Submit this Lever application manually. Use the tailored resume ${path.basename(rendered.pdfPath)}.`, applyUrl,
    rendered.pdfPath, ts, ts);
  }
  return dbKit(get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", id));
}

export function parseJobRecordForRoute(id: number): Promise<Job> {
  return parseJobRecord(id);
}

export async function qualifyJobForRoute(id: number): Promise<Job> {
  await ensureExperienceBank();
  return qualifyJobRecord(await parseJobRecord(id));
}

export async function runJobPipeline(id: number) {
  await ensureExperienceBank();
  const job = await qualifyJobForRoute(id);
  if (job.status === "qualified") await buildJobKit(id);
  return jobDetail(loadJob(id));
}
