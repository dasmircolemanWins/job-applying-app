import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  DEFAULT_DAILY_TARGET, DEFAULT_EFFORT, DEFAULT_MODEL, DEFAULT_RULES, DEFAULT_STANDING_FACTS,
  EFFORT_LEVELS, JOB_STATUSES, MASTER_BRAIN_AGENTS, MAX_RESUMES, MAX_UPLOAD_BYTES, MOCK_MODES,
} from "../../../shared/types.js";
import type {
  ApplicationRoute, ExperienceBank, JobPosting, JobStatus, MasterBrainAgentId, MasterBrainFinalDecision,
  MasterBrainRecommendation, MasterBrainRunReview, Qualification, ResumeDocument, ResumeSelection, Rules,
  ScreeningAnswer, StandingFacts, Story,
} from "../../../shared/types.js";
import { HttpError, asyncHandler, badRequest, conflict, idParam, notFound, validate } from "../http.js";
import { extractResumeTextFromBuffer, ALLOWED_RESUME_TYPES } from "../services/resumeParse.js";
import { renderResume } from "../services/render.js";
import {
  deleteRows, hostedContext, hostedRequest, insertRow, selectAllRows, selectPage, selectRows, storageAuthenticatedPath,
  storageObjectPath, updateRows, type HostedContext, type HostedOptions,
} from "./client.js";

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const jsonValue = <T>(value: unknown, fallback: T): T => value == null ? fallback : value as T;
const numberId = (row: Row) => Number(row.id);

function encodedEq(value: string | number): string {
  return `eq.${String(value)}`;
}

function blockedView(row: Row, job?: Row): Row {
  return {
    id: numberId(row), jobId: Number(row.job_id), reason: row.reason, actionText: row.action_text,
    link: row.link ?? null, resumeFile: row.resume_file ?? null, resolved: row.resolved === true,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(job ? { company: job.company, title: job.title } : {}),
  };
}

function parkedView(row: Row, job?: Row): Row {
  return {
    id: numberId(row), jobId: Number(row.job_id), reason: row.reason, retryPlan: row.retry_plan,
    resolved: row.resolved === true, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(job ? { company: job.company, title: job.title } : {}),
  };
}

function jobDedupeKey(company: string, title: string, text: string): string {
  const identity = `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}`;
  return identity !== "|" ? identity : `manual|${createHash("sha256").update(text).digest("hex")}`;
}

function safePrivatePath(ownerId: string, category: string, objectPath: string): boolean {
  const parts = objectPath.split("/");
  return parts.length >= 3 && parts[0] === ownerId && parts[1] === category &&
    parts.slice(2).every(part => part !== "." && part !== ".." && /^[a-zA-Z0-9._-]{1,200}$/.test(part));
}

async function one(ctx: HostedContext, table: string, filters: Record<string, string>): Promise<Row | undefined> {
  return (await selectRows<Row>(ctx, table, filters, "&limit=1"))[0];
}

async function required(ctx: HostedContext, table: string, filters: Record<string, string>, label: string): Promise<Row> {
  const row = await one(ctx, table, filters);
  if (!row) throw notFound(`${label} not found`);
  return row;
}

function resumeSummary(row: Row, full = false): Row {
  const skills = jsonValue<string[]>(row.skills_json, []);
  const result: Row = {
    id: numberId(row), label: String(row.label ?? ""), originalName: String(row.original_name),
    mime: String(row.mime), isBase: row.is_base === true, analyzed: !!row.parsed_json,
    skills, skillsCount: skills.length, textLength: String(row.text ?? "").length,
    uploadedAt: String(row.uploaded_at), fileUrl: `/api/resumes/${row.id}/file`,
  };
  if (full) Object.assign(result, {
    filename: String(row.original_name), text: String(row.text ?? ""), parsed: jsonValue(row.parsed_json, null),
  });
  return result;
}

function jobView(row: Row): Row {
  return {
    id: numberId(row), source: row.source, url: row.url ?? null, title: row.title ?? "", company: row.company ?? "",
    location: row.location ?? "", remoteType: row.remote_type ?? "unknown", payMin: row.pay_min ?? null,
    payMax: row.pay_max ?? null, payCurrency: row.pay_currency ?? null, atsVendor: row.ats_vendor ?? "unknown",
    postingId: row.posting_id ?? null, board: row.board ?? null, status: row.status,
    statusReason: row.status_reason ?? null, fitScore: row.fit_score ?? null, foundAt: row.found_at,
    createdAt: row.created_at, updatedAt: row.updated_at, descriptionText: row.description_text ?? "",
    parsed: jsonValue(row.parsed_json, null), qualification: jsonValue(row.qualification_json, null),
    dedupeKey: row.dedupe_key,
  };
}

function kitView(row: Row | undefined): Row | null {
  if (!row) return null;
  return {
    id: numberId(row), jobId: Number(row.job_id), selectedResumeId: row.selected_resume_id ?? null,
    selection: jsonValue(row.selection_json, null), tailored: jsonValue(row.tailored_json, null),
    honesty: jsonValue(row.honesty_json, null), keywords: jsonValue(row.keyword_json, null),
    answers: jsonValue(row.answers_json, []), coverLetter: row.cover_letter ?? "",
    pdfPath: row.pdf_path ?? null, docxPath: row.docx_path ?? null, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function applicationView(row: Row): Row {
  return {
    id: numberId(row), jobId: row.job_id == null ? null : Number(row.job_id), company: row.company ?? "",
    title: row.title ?? "", postingId: row.posting_id ?? null, route: row.route,
    resumeFile: row.resume_file ?? null, submittedAt: row.submitted_at, notes: row.notes ?? "",
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];
const tokens = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}/g) ?? []);
const resumeDocumentSchema = z.object({
  contact: z.object({
    name: z.string(), email: z.string(), phone: z.string(), location: z.string(), links: z.array(z.string()),
  }).strict(),
  summary: z.string(),
  experience: z.array(z.object({
    company: z.string(), title: z.string(), start: z.string(), end: z.string(), location: z.string(),
    bullets: z.array(z.string()),
  }).strict()),
  education: z.array(z.object({
    school: z.string(), degree: z.string(), field: z.string(), year: z.string(),
  }).strict()),
  skills: z.array(z.string()), certifications: z.array(z.string()),
  projects: z.array(z.object({ name: z.string(), description: z.string(), bullets: z.array(z.string()) }).strict()),
}).strict();

function decodeJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function analyzeResumeText(text: string): ResumeDocument {
  const lines = text.split(/\r?\n+/).map(line => line.trim()).filter(Boolean);
  const headings: Record<string, string[]> = {
    summary: ["summary", "professional summary", "profile", "objective"],
    experience: ["experience", "work experience", "professional experience", "employment history", "work history"],
    education: ["education", "academic background"],
    skills: ["skills", "technical skills", "core competencies"],
    certifications: ["certifications", "licenses"],
    projects: ["projects", "selected projects"],
  };
  const sections = new Map<string, string[]>();
  let active = "";
  for (const line of lines) {
    const heading = line.replace(/[:\s]+$/, "").trim().toLowerCase();
    const section = Object.entries(headings).find(([, names]) => names.includes(heading))?.[0];
    if (section) {
      active = section;
      if (!sections.has(active)) sections.set(active, []);
    } else if (/^[A-Z][A-Z &/]+$/.test(line) && line.length < 50) active = "";
    else if (active) sections.get(active)?.push(line);
  }
  const email = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
  const phone = text.match(/(?:\+?\d[\d ()-]{7,}\d)/)?.[0] ?? "";
  const links = unique(text.match(/(?:https?:\/\/|www\.)[^\s,)]+/gi) ?? []);
  const name = lines.find(line => !line.includes("@") && !/\d{3}/.test(line) && !/^https?:\/\//i.test(line)) ?? "";
  const skills = unique((sections.get("skills") ?? [])
    .flatMap(line => line.split(/[,;|•·]+/))
    .map(item => item.replace(/^[\s\-*]+/, "").trim()).filter(Boolean));
  const experience: ResumeDocument["experience"] = [];
  const datePattern = /\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\b.*(?:\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\b|\b(?:present|current)\b)/i;
  let previousLine = "";
  let current: ResumeDocument["experience"][number] | undefined;
  for (const line of sections.get("experience") ?? []) {
    if (datePattern.test(line)) {
      const beforeDate = line.split(/\b(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\b/i)[0]?.trim() ?? "";
      const header = beforeDate || previousLine;
      const parts = header.split(/\s+[|,]\s+/).map(part => part.trim()).filter(Boolean);
      const dates = line.match(/(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(?:19|20)\d{2}\b/gi) ?? [];
      current = {
        title: parts[0] ?? header, company: parts[1] ?? "", start: dates[0] ?? "",
        end: line.match(/\b(?:present|current)\b/i)?.[0] ?? dates[1] ?? "",
        location: "", bullets: [],
      };
      experience.push(current);
    } else if (/^[•●▪◦*-]\s*/.test(line) && current) {
      const bullet = line.replace(/^[•●▪◦*-]\s*/, "").trim();
      if (bullet) current.bullets.push(bullet);
    } else if (line && !current) previousLine = line;
  }
  return {
    contact: { name: name.slice(0, 120), email, phone, location: "", links },
    summary: (sections.get("summary") ?? []).join(" ").trim(),
    experience,
    education: (sections.get("education") ?? []).map(line => ({
      school: line.replace(/^[•●▪◦*-]\s*/, ""), degree: "", field: "",
      year: line.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? "",
    })),
    skills: skills.length ? skills : unique(tokens(text).filter(word => word.length > 2)).slice(0, 60),
    certifications: (sections.get("certifications") ?? []).map(line => line.replace(/^[•●▪◦*-]\s*/, "").trim()).filter(Boolean),
    projects: [],
  };
}

function buildExperienceBank(docs: { resumeId: number; doc: ResumeDocument }[]): ExperienceBank {
  const roles = new Map<string, ExperienceBank["roles"][number]>();
  const skills = new Map<string, ExperienceBank["skills"][number]["evidence"]>();
  const education: ExperienceBank["education"] = [];
  const certifications: string[] = [];
  const strongestResults: ExperienceBank["strongestResults"] = [];
  for (const { resumeId, doc } of docs) {
    for (const role of doc.experience) {
      const key = `${role.company.toLowerCase()}|${role.title.toLowerCase()}`;
      const existing = roles.get(key) ?? { ...role, bullets: [], sourceResumeIds: [] };
      existing.sourceResumeIds = unique([...existing.sourceResumeIds, resumeId]);
      for (const bullet of role.bullets) {
        let item = existing.bullets.find(value => value.text.toLowerCase() === bullet.toLowerCase());
        if (!item) {
          item = { text: bullet, sourceResumeIds: [], quantified: /\d|%|\$/.test(bullet) };
          existing.bullets.push(item);
        }
        item.sourceResumeIds = unique([...item.sourceResumeIds, resumeId]);
        if (item.quantified && !strongestResults.some(value => value.text === item?.text)) strongestResults.push(item);
      }
      roles.set(key, existing);
    }
    for (const skill of doc.skills) {
      const key = skill.toLowerCase();
      skills.set(key, [...(skills.get(key) ?? []), { resumeId, bullet: skill }]);
    }
    education.push(...doc.education);
    certifications.push(...doc.certifications);
  }
  return {
    roles: [...roles.values()],
    skills: [...skills].map(([, evidence]) => ({ name: evidence[0]?.bullet ?? "", evidence })).filter(item => item.name),
    education, certifications: unique(certifications), strongestResults: strongestResults.slice(0, 30),
    builtFromResumeIds: docs.map(item => item.resumeId), builtAt: now(),
  };
}

async function loadExperienceBank(ctx: HostedContext): Promise<{ bank: ExperienceBank; resumes: { id: number; label: string; doc: ResumeDocument }[] }> {
  const rows = await selectAllRows<Row>(ctx, "resumes", {}, "&order=is_base.desc,id.asc");
  if (!rows.length) throw badRequest("Upload a resume before building an application kit");
  const resumes: { id: number; label: string; doc: ResumeDocument }[] = [];
  for (const row of rows) {
    const parsed = resumeDocumentSchema.safeParse(decodeJson(row.parsed_json, null));
    const doc = parsed.success ? parsed.data : analyzeResumeText(String(row.text ?? ""));
    if (!parsed.success) {
      await updateRows(ctx, "resumes", { id: encodedEq(numberId(row)) }, {
        parsed_json: doc, skills_json: doc.skills, updated_at: now(),
      });
    }
    resumes.push({ id: numberId(row), label: String(row.label ?? ""), doc });
  }
  const bank = buildExperienceBank(resumes.map(({ id, doc }) => ({ resumeId: id, doc })));
  const current = await one(ctx, "experience_bank", {});
  const values = {
    bank_json: bank, built_from_json: bank.builtFromResumeIds, built_at: bank.builtAt, updated_at: bank.builtAt,
  };
  if (current) await updateRows(ctx, "experience_bank", { id: encodedEq(numberId(current)) }, values);
  else await insertRow(ctx, "experience_bank", { ...values, created_at: bank.builtAt });
  return { bank, resumes };
}

function parseManualJob(text: string, url: string, fallback: { title: string; company: string }): JobPosting {
  const lines = text.split(/\n+/).map(value => value.trim()).filter(Boolean);
  const location = text.match(/(?:location|based in)\s*[:\-]\s*([^\n,]{2,80})/i)?.[1]?.trim() ?? "";
  const remoteType: JobPosting["remoteType"] = /remote/i.test(text) ? "remote"
    : /hybrid/i.test(text) ? "hybrid" : /on[- ]site/i.test(text) ? "onsite" : "unknown";
  const pay = text.match(/\$\s?([\d,]+)(?:\s?[-–to]+\s?\$?\s?([\d,]+))?/);
  const skillLine = lines.find(line => /^(?:required skills?|key skills?|skills?)\s*:/i.test(line))
    ?? lines.find(line => /^(?:requirements?|qualifications?)\s*:/i.test(line));
  const listedSkills = unique((skillLine?.replace(/^[^:]+:\s*/, "") ?? "")
    .split(/[,;|•]|\band\b/i).map(skill => skill.replace(/^[\s\-*]+|[.!]+$/g, "").trim())
    .filter(skill => skill.length > 1 && skill.length <= 100));
  const stop = new Set(["the", "and", "for", "with", "you", "will", "this", "that", "from", "have", "are", "company", "location", "salary", "required", "skills", "role", "position"]);
  const allSkills = unique(tokens(text).filter(word => word.length > 2 && !stop.has(word)));
  let atsVendor: JobPosting["atsVendor"] = "unknown";
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const [needle, vendor] of [
      ["lever", "lever"], ["greenhouse", "greenhouse"], ["workday", "workday"],
      ["ashby", "ashby"], ["linkedin", "linkedin"], ["indeed", "indeed"],
    ] as const) {
      if (host.includes(needle)) { atsVendor = vendor; break; }
    }
    if (url && atsVendor === "unknown") atsVendor = "other";
  } catch { /* Manually pasted job descriptions commonly have no URL. */ }
  let postingId: string | undefined;
  try {
    const parsedUrl = new URL(url);
    for (const key of ["gh_jid", "jobId", "job_id", "postingId", "posting_id", "currentJobId", "jk"]) {
      const value = parsedUrl.searchParams.get(key);
      if (value && /^[a-z0-9-]{3,100}$/i.test(value)) { postingId = value; break; }
    }
    if (!postingId) {
      const candidate = parsedUrl.pathname.split("/").filter(Boolean).at(-1) ?? "";
      if (/^(?:\d{4,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(candidate)) postingId = candidate;
      else postingId = candidate.match(/(?:job|posting|req)[-_]?(\d{4,})/i)?.[1];
    }
  } catch { /* No URL to inspect. */ }
  return {
    title: fallback.title || lines[0]?.slice(0, 140) || "Untitled role",
    company: fallback.company, location, remoteType,
    ...(pay ? { payMin: Number(pay[1]?.replaceAll(",", "")), ...(pay[2] ? { payMax: Number(pay[2].replaceAll(",", "")) } : {}), payCurrency: "USD", payPeriod: "year" as const } : {}),
    employmentType: "", seniority: "", requiredSkills: (listedSkills.length ? listedSkills : allSkills).slice(0, 20),
    niceToHaveSkills: [], responsibilities: [],
    keywords: unique([...listedSkills, ...allSkills]).slice(0, 40),
    atsVendor, ...(postingId ? { postingId } : {}), ...(url ? { applyUrl: url } : {}),
    screeningQuestions: unique([...text.matchAll(/[^?\n]{10,180}\?/g)].map(match => match[0].trim()).slice(0, 20)),
  };
}

async function profileFacts(ctx: HostedContext): Promise<StandingFacts> {
  const value = decodeJson((await one(ctx, "profile", {}))?.facts_json, DEFAULT_STANDING_FACTS);
  const result = factsSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_STANDING_FACTS;
}

async function profileRules(ctx: HostedContext): Promise<Rules> {
  const value = decodeJson((await one(ctx, "rules", {}))?.rules_json, DEFAULT_RULES);
  const result = rulesSchema.safeParse(value);
  return result.success ? result.data : DEFAULT_RULES;
}

function ruleMatches(value: string, entries: string[]): boolean {
  return entries.some(entry => {
    const rule = entry.trim();
    if (!rule) return false;
    try { return new RegExp(rule, "i").test(value); }
    catch { return value.toLowerCase().includes(rule.toLowerCase()); }
  });
}

function qualifyManualJob(posting: JobPosting, facts: StandingFacts, rules: Rules, bank: ExperienceBank): Qualification {
  const blockers: string[] = [];
  if (ruleMatches(posting.company, rules.excludedCompanies)) blockers.push("Company is excluded by your rules");
  if (ruleMatches(posting.title, [...rules.blacklistTitles, ...rules.roleExclusions])) blockers.push("Role title matches an exclusion");
  if (facts.locationMode !== "any" && posting.remoteType !== "unknown" && facts.locationMode !== posting.remoteType) {
    blockers.push(`Location mode is ${posting.remoteType}, preference is ${facts.locationMode}`);
  }
  if (posting.remoteType !== "remote" && facts.regions.length && posting.location
    && !facts.regions.some(region => posting.location.toLowerCase().includes(region.toLowerCase()))) {
    blockers.push("Posting location is outside your preferred regions");
  }
  const floor = facts.payFloor ?? rules.salary.floor;
  const statedCeiling = posting.payMax ?? posting.payMin;
  if (floor !== null && statedCeiling !== undefined && statedCeiling < floor) blockers.push("Stated compensation is below your pay floor");
  const available = new Set(bank.skills.map(skill => skill.name.toLowerCase()));
  const matchedSkills = posting.requiredSkills.filter(skill => available.has(skill.toLowerCase()));
  const gaps = posting.requiredSkills.filter(skill => !available.has(skill.toLowerCase()));
  const fitScore = posting.requiredSkills.length ? Math.round(100 * matchedSkills.length / posting.requiredSkills.length) : 50;
  return {
    qualifies: blockers.length === 0 && fitScore >= 25, fitScore,
    reasons: [`${matchedSkills.length} of ${posting.requiredSkills.length} listed skills supported in the experience bank`],
    blockers, gaps, matchedSkills,
  };
}

function checkManualHonesty(document: ResumeDocument, base: ResumeDocument): Row {
  const claims: Row[] = [];
  const failures: Row[] = [];
  const fail = (text: string, section: string) => failures.push({ text, section, supported: false });
  const contactFields = ["name", "email", "phone", "location"] as const;
  for (const field of contactFields) {
    if (document.contact[field] !== base.contact[field]) fail(`Changed ${field}`, "contact");
  }
  if (JSON.stringify(document.contact.links) !== JSON.stringify(base.contact.links)) fail("Changed contact links", "contact");
  if (document.summary !== base.summary) fail("Changed summary", "summary");
  if (JSON.stringify(document.education) !== JSON.stringify(base.education)) fail("Changed education", "education");
  if (JSON.stringify(document.certifications) !== JSON.stringify(base.certifications)) fail("Changed certifications", "certifications");
  if (JSON.stringify(document.projects) !== JSON.stringify(base.projects)) fail("Changed projects", "projects");
  if (document.experience.length !== base.experience.length) fail("Changed role count", "experience");
  for (let index = 0; index < document.experience.length; index += 1) {
    const role = document.experience[index]!;
    const original = base.experience[index];
    if (!original || role.company !== original.company || role.title !== original.title
      || role.start !== original.start || role.end !== original.end || role.location !== original.location) {
      fail("Changed employer, role, dates, or location", "experience");
    }
    for (const bullet of role.bullets) {
      const supported = !!original?.bullets.includes(bullet);
      claims.push({ text: bullet, section: "experience", supported, ...(supported ? { source: "uploaded base resume" } : {}) });
      if (!supported) fail(bullet, "experience");
    }
  }
  for (const skill of document.skills) {
    const supported = base.skills.includes(skill);
    claims.push({ text: skill, section: "skills", supported, ...(supported ? { source: "uploaded base resume" } : {}) });
    if (!supported) fail(skill, "skills");
  }
  claims.push(...failures);
  return { claims, unsupportedCount: failures.length, verdict: failures.length ? "fail" : "pass" };
}

function tailorManualResume(posting: JobPosting, base: ResumeDocument): {
  document: ResumeDocument; honesty: Row; keywords: Row;
} {
  const keywords = unique([...posting.requiredSkills, ...posting.keywords].map(value => value.trim()).filter(Boolean));
  const score = (text: string) => keywords.reduce((total, keyword) => total + (text.toLowerCase().includes(keyword.toLowerCase()) ? 1 : 0), 0);
  const document: ResumeDocument = {
    ...base,
    skills: [...base.skills].sort((left, right) => score(right) - score(left)),
    experience: base.experience.map(role => ({ ...role, bullets: [...role.bullets].sort((left, right) => score(right) - score(left)) })),
  };
  const body = JSON.stringify(document).toLowerCase();
  const covered = keywords.filter(keyword => body.includes(keyword.toLowerCase()));
  const missing = keywords.filter(keyword => !body.includes(keyword.toLowerCase()));
  return {
    document,
    honesty: checkManualHonesty(document, base),
    keywords: { covered, missing, coveragePct: keywords.length ? Math.round(covered.length * 100 / keywords.length) : 100 },
  };
}

function makeManualAnswers(
  questions: string[], facts: StandingFacts, stories: Story[], posting: JobPosting, rules: Rules,
): { answers: ScreeningAnswer[]; coverLetter: string } {
  const approvedStories = stories.filter(story => story.approved);
  const storyKey = (question: string): string | undefined => {
    if (/outside of work|personal accomplishment|overcame|obstacle/i.test(question)) return "outside_work";
    if (/plan|execution|execute|move quickly|tight deadline/i.test(question)) return "planning_to_execution";
    if (/pipeline|system you built|process you built/i.test(question)) return "pipeline_built";
    if (/team|organization|function you built/i.test(question)) return "team_built";
    if (/case study|before and after|measurable|results you achieved/i.test(question)) return "case_study";
    if (/why (this|our) company|why (this|the) role/i.test(question)) return "why_company";
    return undefined;
  };
  const answers = questions.map((question): ScreeningAnswer => {
    if (/ssn|social security|password|identity|date of birth|government id/.test(question.toLowerCase())) {
      return { question, answer: "", source: "rule", needsHuman: true, humanReason: "Sensitive identity information must be entered by you." };
    }
    let answer = "";
    let source: ScreeningAnswer["source"] = "facts";
    if (/minimum|min acceptable|lowest salary/i.test(question)) {
      const floor = facts.payFloor ?? rules.salary.floor;
      const minimum = posting.payMin ?? floor;
      answer = minimum != null ? `${posting.payCurrency ?? facts.payCurrency} ${Math.max(minimum, floor ?? minimum)}` : "";
      source = "rule";
    } else if (/salary|compensation|pay/i.test(question)) answer = facts.desiredPay ? `${facts.payCurrency} ${facts.desiredPay}` : "";
    else if (/authorized|authorization|work eligibility/i.test(question)) answer = facts.workAuthorization;
    else if (/sponsor/i.test(question)) answer = facts.sponsorshipAnswer;
    else if (/start|available/i.test(question)) answer = facts.soonestStart;
    else if (/how did you hear/i.test(question)) answer = facts.howDidYouHear;
    else {
      const key = storyKey(question);
      const story = key ? approvedStories.find(item => item.key === key) : undefined;
      if (story) { answer = story.body; source = `story:${story.key}`; }
    }
    return { question, answer, source, needsHuman: !answer, ...(!answer ? { humanReason: "No approved source provides a truthful answer." } : {}) };
  });
  const whyCompany = approvedStories.find(story => story.key === "why_company");
  const coverLetter = whyCompany?.body
    ? `Dear Hiring Team,\n\n${whyCompany.body}\n\nI would welcome the opportunity to discuss how my documented experience aligns with the ${posting.title} role.\n\nSincerely,\n${facts.fullName}`
    : "";
  return { answers, coverLetter };
}

async function parseHostedJob(ctx: HostedContext, id: number): Promise<Row> {
  const current = await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
  const title = String(current.title ?? "").trim();
  const company = String(current.company ?? "").trim();
  const description = String(current.description_text ?? "");
  const posting = parseManualJob(description, String(current.url ?? ""), { title, company });
  const parsedTitle = title || posting.title;
  const parsedCompany = company || posting.company;
  const parsedLocation = posting.location || String(current.location ?? "");
  const parsed = { ...posting, title: parsedTitle, company: parsedCompany, location: parsedLocation };
  const dedupeKey = jobDedupeKey(parsedCompany, parsedTitle, description);
  const duplicate = await one(ctx, "jobs", { dedupe_key: encodedEq(dedupeKey) });
  if (duplicate && numberId(duplicate) !== id) throw conflict("A matching job already exists");
  const updated = await updateRows<Row>(ctx, "jobs", { id: encodedEq(id) }, {
    title: parsedTitle, company: parsedCompany, location: parsedLocation, remote_type: parsed.remoteType,
    pay_min: parsed.payMin ?? null, pay_max: parsed.payMax ?? null, pay_currency: parsed.payCurrency ?? null,
    parsed_json: parsed, qualification_json: null, fit_score: null, ats_vendor: parsed.atsVendor,
    posting_id: parsed.postingId ?? null, dedupe_key: dedupeKey, status: "parsed",
    status_reason: null, updated_at: now(),
  });
  return updated[0] ?? { ...current, title: parsedTitle, company: parsedCompany, location: parsedLocation, parsed_json: parsed, status: "parsed", dedupe_key: dedupeKey };
}

async function qualifyHostedJob(ctx: HostedContext, id: number): Promise<Row> {
  const parsedRow = await parseHostedJob(ctx, id);
  const posting = decodeJson<JobPosting | null>(parsedRow.parsed_json, null);
  if (!posting) throw badRequest("Job description could not be parsed");
  const [{ bank }, facts, rules] = await Promise.all([
    loadExperienceBank(ctx), profileFacts(ctx), profileRules(ctx),
  ]);
  const qualification = qualifyManualJob(posting, facts, rules, bank);
  const status: JobStatus = qualification.qualifies ? "qualified" : "skipped";
  const statusReason = qualification.blockers.join("; ") ||
    (qualification.qualifies ? null : qualification.gaps.join(", ") || "Did not meet qualification threshold");
  const updated = await updateRows<Row>(ctx, "jobs", { id: encodedEq(id) }, {
    qualification_json: qualification, fit_score: qualification.fitScore, status, status_reason: statusReason,
    updated_at: now(),
  });
  return updated[0] ?? { ...parsedRow, qualification_json: qualification, fit_score: qualification.fitScore, status, status_reason: statusReason };
}

async function storeRenderedKit(ctx: HostedContext, job: Row, document: ResumeDocument): Promise<{ pdfPath: string; docxPath: string }> {
  const rendered = await renderResume(numberId(job), String(job.company ?? ""), String(job.title ?? ""), document);
  const uploaded: string[] = [];
  try {
    const result: { pdfPath?: string; docxPath?: string } = {};
    for (const format of ["pdf", "docx"] as const) {
      const objectName = `${randomUUID()}.${format}`;
      const objectPath = `${ctx.ownerId}/kits/${objectName}`;
      await hostedRequest(ctx, storageObjectPath(ctx.ownerId, "kits", objectName), {
        method: "POST",
        headers: {
          "content-type": format === "pdf" ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "x-upsert": "false",
        },
        body: await readFile(format === "pdf" ? rendered.pdfPath : rendered.docxPath),
      });
      uploaded.push(objectPath);
      if (format === "pdf") result.pdfPath = objectPath;
      else result.docxPath = objectPath;
    }
    return { pdfPath: result.pdfPath!, docxPath: result.docxPath! };
  } catch (error) {
    let cleanupFailed = false;
    for (const objectPath of uploaded) {
      try {
        await hostedRequest(ctx, `/storage/v1/object/user-files/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
          method: "DELETE",
        });
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new HttpError(503, "Application files could not be fully cleaned up after an error. Contact support.");
    throw error;
  } finally {
    await Promise.all([rendered.pdfPath, rendered.docxPath].map(file => unlink(file).catch(() => undefined)));
  }
}

async function removeKitObjects(ctx: HostedContext, kit: Row | undefined): Promise<void> {
  for (const key of ["pdf_path", "docx_path"] as const) {
    const objectPath = String(kit?.[key] ?? "");
    if (!objectPath) continue;
    if (!safePrivatePath(ctx.ownerId, "kits", objectPath) || objectPath.split("/").length !== 3) {
      throw new HttpError(503, "Application file metadata is invalid.");
    }
    await hostedRequest(ctx, `/storage/v1/object/user-files/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
      method: "DELETE",
    });
  }
}

function unavailable(feature: string) {
  return (_req: Request, res: Response) => res.status(503).json({
    error: `${feature} is unavailable in hosted mode. Its processing workflow has not been migrated to user-isolated storage.`,
  });
}

const factsSchema = z.object({
  fullName: z.string(), email: z.string(), phone: z.string(), address: z.string(), timeZone: z.string(),
  workAuthorization: z.string(), sponsorshipAnswer: z.string(), requiresSponsorship: z.boolean().nullable(),
  targetTitles: z.array(z.string()), locationMode: z.enum(["remote", "hybrid", "onsite", "any"]),
  regions: z.array(z.string()), payFloor: z.number().nullable(), desiredPay: z.number().nullable(),
  payCurrency: z.string(), soonestStart: z.string(), howDidYouHear: z.string(), linkedinUrl: z.string(),
  portfolioUrl: z.string(), eeo: z.object({ gender: z.string(), race: z.string(), veteranStatus: z.string(), disabilityStatus: z.string() }),
  screeners: z.object({ accommodations: z.string(), startupExperience: z.string(), yearsBySkill: z.record(z.string(), z.number()), smsOk: z.boolean() }),
  education: z.array(z.object({ school: z.string(), degree: z.string(), field: z.string(), year: z.string() })),
  summary: z.string(),
}).strict();
const rulesSchema = z.object({
  roleExclusions: z.array(z.string()), blacklistTitles: z.array(z.string()), excludedCompanies: z.array(z.string()),
  excludedSenders: z.array(z.string()), neverTouchFiltersNote: z.string(),
  salary: z.object({ floor: z.number().nullable(), desired: z.number().nullable(), currency: z.string(), answerStyle: z.enum(["range", "single", "decline"]), negotiable: z.boolean() }),
  customRules: z.array(z.object({ text: z.string(), createdAt: z.string() })),
}).strict();
const storySchema = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(20000), approved: z.boolean() }).strict();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_RESUMES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const valid = (ext === ".pdf" && file.mimetype === "application/pdf")
      || (ext === ".docx" && file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      || (ext === ".txt" && file.mimetype === "text/plain");
    if (!valid || !ALLOWED_RESUME_TYPES.has(file.mimetype) || file.mimetype === "application/octet-stream") {
      cb(badRequest("Only matching PDF, DOCX, and TXT files are accepted"));
    } else cb(null, true);
  },
}).fields([{ name: "files[]", maxCount: MAX_RESUMES }, { name: "files", maxCount: MAX_RESUMES }]);
function filesFrom(req: Request): Express.Multer.File[] {
  const fields = req.files as Record<string, Express.Multer.File[]> | undefined;
  return fields ? Object.values(fields).flat() : [];
}

const brainAgents: Record<MasterBrainAgentId, { name: string; focus: string }> = {
  resume_analyst: { name: "Resume Analyst", focus: "Finds resumes that need structured analysis." },
  role_researcher: { name: "Role Researcher", focus: "Reviews job evidence supplied to your workspace; it does not browse external sites." },
  fit_analyst: { name: "Fit Analyst", focus: "Checks parsed roles that have not yet been compared with your profile." },
  application_strategist: { name: "Application Strategist", focus: "Finds qualified roles that are ready for a human-reviewed kit." },
  truth_guard: { name: "Truth Guard", focus: "Flags application kits with unsupported claims for your review." },
};

function masterBrainRecommendations(
  resumes: Row[],
  jobs: Row[],
  kits: Row[],
): MasterBrainRecommendation[] {
  const recommendations: MasterBrainRecommendation[] = [];
  for (const resume of resumes.filter(row => !row.parsed_json).slice(0, 3)) {
    recommendations.push({
      id: `resume-${numberId(resume)}`,
      agentId: "resume_analyst",
      title: `Analyze ${String(resume.original_name ?? "uploaded resume")}`,
      detail: "Extract its experience and skills into a reviewable structured draft.",
      href: "/resumes",
      priority: "normal",
    });
  }
  for (const job of jobs.filter(row => !row.parsed_json || !String(row.description_text ?? "").trim()).slice(0, 3)) {
    const missingDescription = !String(job.description_text ?? "").trim();
    recommendations.push({
      id: `role-${numberId(job)}`,
      agentId: "role_researcher",
      title: missingDescription ? `Add role evidence for ${String(job.title || "this role")}` : `Review ${String(job.title || "this role")}`,
      detail: missingDescription
        ? "Add the job description yourself. The agent only analyzes material you provide."
        : "Parse the job details you supplied before comparing requirements.",
      href: `/jobs/${numberId(job)}`,
      priority: "normal",
    });
  }
  for (const job of jobs.filter(row => row.parsed_json && !row.qualification_json).slice(0, 3)) {
    recommendations.push({
      id: `fit-${numberId(job)}`,
      agentId: "fit_analyst",
      title: `Check fit for ${String(job.title || "this role")}`,
      detail: "Compare its parsed requirements with your saved profile and application rules.",
      href: `/jobs/${numberId(job)}`,
      priority: "normal",
    });
  }
  const kitJobs = new Set(kits.map(row => Number(row.job_id)));
  for (const job of jobs.filter(row => row.status === "qualified" && !kitJobs.has(numberId(row))).slice(0, 3)) {
    recommendations.push({
      id: `kit-${numberId(job)}`,
      agentId: "application_strategist",
      title: `Prepare a draft for ${String(job.title || "this role")}`,
      detail: "Build a tailored kit for you to review; nothing is sent to an employer.",
      href: `/jobs/${numberId(job)}`,
      priority: "normal",
    });
  }
  for (const kit of kits) {
    const honesty = decodeJson<Record<string, unknown>>(kit.honesty_json, {});
    if (honesty.verdict === "pass" && Number(honesty.unsupportedCount ?? 0) === 0) continue;
    recommendations.push({
      id: `truth-${numberId(kit)}`,
      agentId: "truth_guard",
      title: "Review claims in a draft application kit",
      detail: "A kit has missing or unsupported-claim checks. Review the source resume before using it.",
      href: `/jobs/${Number(kit.job_id)}`,
      priority: "high",
    });
  }
  return recommendations.slice(0, 12);
}

function reviewAgentRuns(runs: Row[], jobs: Row[], kits: Row[]): MasterBrainRunReview[] {
  const jobsById = new Map(jobs.map(job => [numberId(job), job]));
  const kitsByJob = new Map(kits.map(kit => [Number(kit.job_id), kit]));
  return runs.map(run => {
    const jobId = run.job_id == null ? null : Number(run.job_id);
    const job = jobId == null ? undefined : jobsById.get(jobId);
    const kit = jobId == null ? undefined : kitsByJob.get(jobId);
    const agent = String(run.agent ?? "Specialist");
    const successful = run.ok === true;
    let verdict: MasterBrainRunReview["verdict"] = "needs_review";
    let rationale = "The run record does not store enough structured output to verify this result.";
    if (!successful) {
      verdict = "needs_review";
      rationale = "The specialist run failed. Review the job details and retry only if useful.";
    } else if (/honesty|truth/i.test(agent)) {
      const honesty = decodeJson<Record<string, unknown>>(kit?.honesty_json, {});
      const passed = honesty.verdict === "pass" && Number(honesty.unsupportedCount ?? 0) === 0;
      verdict = passed ? "supported" : "do_not_use";
      rationale = passed
        ? "The saved application kit currently passes its unsupported-claim check."
        : "The saved kit does not currently pass its unsupported-claim check; do not use it until reviewed and corrected.";
    } else if (/qualif/i.test(agent) && job) {
      const qualification = decodeJson<Record<string, unknown>>(job.qualification_json, {});
      const consistent = (qualification.qualifies === true && job.status === "qualified")
        || (qualification.qualifies === false && job.status !== "qualified");
      verdict = consistent ? "supported" : "needs_review";
      rationale = consistent
        ? "The saved qualification result and job status agree."
        : "The saved qualification result and job status disagree or are incomplete.";
    } else if (/jobparser|parsejob/i.test(agent) && job) {
      verdict = job.parsed_json ? "supported" : "needs_review";
      rationale = job.parsed_json
        ? "Parsed job data is present in the workspace."
        : "The job parser run succeeded, but no parsed job result is currently saved.";
    } else if (/resumeanalyst|analyzeresume/i.test(agent)) {
      verdict = "needs_review";
      rationale = "The run succeeded, but structured resume analysis output is not saved in the audit trail.";
    } else if (successful && job && /tailor|answer/i.test(agent)) {
      const honesty = decodeJson<Record<string, unknown>>(kit?.honesty_json, {});
      verdict = kit && honesty.verdict === "pass" && Number(honesty.unsupportedCount ?? 0) === 0
        ? "supported"
        : "needs_review";
      rationale = verdict === "supported"
        ? "The related kit exists and currently passes its unsupported-claim check."
        : "The related kit is missing or does not yet pass its unsupported-claim check.";
    }
    return {
      runId: numberId(run),
      specialist: agent,
      jobId,
      jobTitle: job ? String(job.title || "Untitled role") : null,
      runSucceeded: successful,
      verdict,
      rationale,
      href: job ? `/jobs/${numberId(job)}` : null,
    };
  });
}

function chooseMasterDecision(
  recommendations: MasterBrainRecommendation[],
  reviewedDecisions: MasterBrainRunReview[],
): MasterBrainFinalDecision {
  const unsafeKit = reviewedDecisions.find(review => review.verdict === "do_not_use");
  if (unsafeKit) {
    return {
      outcome: "hold_for_review",
      title: "Hold this application kit for review",
      rationale: unsafeKit.rationale,
      evidence: [`${unsafeKit.specialist} review #${unsafeKit.runId}`, unsafeKit.jobTitle ?? "Saved kit"],
      recommendationId: recommendations.find(item => item.agentId === "truth_guard")?.id ?? null,
    };
  }
  const next = recommendations[0];
  if (!next) {
    return {
      outcome: "no_action",
      title: "No action is currently needed",
      rationale: "No outstanding review step was found in the records the Brain can safely evaluate.",
      evidence: [`${reviewedDecisions.length} specialist run${reviewedDecisions.length === 1 ? "" : "s"} reviewed`],
      recommendationId: null,
    };
  }
  const outcome = next.agentId === "application_strategist"
    ? "prepare_draft"
    : next.agentId === "role_researcher" || next.agentId === "resume_analyst"
      ? "complete_missing_data"
      : "hold_for_review";
  const agentReview = reviewedDecisions.find(review => review.jobId != null && next.href === `/jobs/${review.jobId}`);
  return {
    outcome,
    title: next.title,
    rationale: next.detail,
    evidence: [
      `${brainAgents[next.agentId].name} recommendation`,
      ...(agentReview ? [`Master review: ${agentReview.verdict} — ${agentReview.rationale}`] : []),
    ],
    recommendationId: next.id,
  };
}

export function createHostedRouter(options: HostedOptions = {}) {
  const router = Router();
  const context = (req: Request, res: Response) => hostedContext(req, res, options);
  const readyUntil = new Map<string, number>();

  router.use(asyncHandler(async (req, res, next) => {
    const ctx = context(req, res);
    if ((readyUntil.get(ctx.base) ?? 0) > Date.now()) {
      next();
      return;
    }
    let ready = false;
    try {
      const response = await hostedRequest(ctx, "/rest/v1/rpc/applypilot_workspace_ready", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      ready = await response.json() === true;
      if (ready) {
        const limits = await hostedRequest(ctx, "/rest/v1/rpc/applypilot_hosted_constraints_ready", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        ready = await limits.json() === true;
      }
      if (ready) {
        const brain = await hostedRequest(ctx, "/rest/v1/rpc/applypilot_master_brain_ready", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        ready = await brain.json() === true;
      }
    } catch {
      ready = false;
    }
    if (!ready) {
      throw new HttpError(
        503,
        "Hosted workspace is unavailable. Apply all current Supabase migrations and verify their owner RLS and private-storage policies.",
      );
    }
    readyUntil.set(ctx.base, Date.now() + 30_000);
    next();
  }));

  router.get("/settings", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const rows = await selectRows<Row>(ctx, "settings");
    const values = new Map(rows.map(row => [String(row.key), String(row.value ?? "")]));
    const storedKey = values.get("anthropic_api_key") ?? "";
    const envKey = options.env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
    const mode = values.get("mock_mode") ?? "auto";
    const hasKey = !!(storedKey || envKey);
    const mockActive = mode === "on" || (mode === "auto" && !hasKey);
    res.json({
      anthropicApiKeyMasked: storedKey ? `sk-ant-…${storedKey.slice(-4)}` : "",
      hasApiKey: hasKey, apiKeySource: storedKey ? "settings" : envKey ? "env" : "none",
      model: values.get("model") || DEFAULT_MODEL, effort: values.get("effort") || DEFAULT_EFFORT,
      autoSubmit: values.get("auto_submit") === "1", imapHost: values.get("imap_host") || "",
      imapPort: Number(values.get("imap_port")) || 993, imapUser: values.get("imap_user") || "",
      imapPasswordSet: !!values.get("imap_password"), imapFolder: values.get("imap_folder") || "INBOX",
      dailyTarget: Number(values.get("daily_target")) || DEFAULT_DAILY_TARGET, mockMode: mode,
      mockActive, dataDir: "Private hosted workspace", browserInstalled: false,
    });
  }));
  const settingsSchema = z.object({
    anthropicApiKey: z.string().max(500).optional(), model: z.string().trim().min(1).max(120).optional(),
    effort: z.enum(EFFORT_LEVELS).optional(), autoSubmit: z.boolean().optional(), imapHost: z.string().max(255).optional(),
    imapPort: z.number().int().min(1).max(65535).optional(), imapUser: z.string().max(255).optional(),
    imapPassword: z.string().max(500).optional(), imapFolder: z.string().max(255).optional(),
    dailyTarget: z.number().int().min(1).max(10000).optional(), mockMode: z.enum(MOCK_MODES).optional(),
  }).strict();
  router.put("/settings", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const body = validate(req.body, settingsSchema);
    const mapping: Record<string, string | undefined> = {
      anthropic_api_key: body.anthropicApiKey?.trim(), model: body.model, effort: body.effort,
      auto_submit: body.autoSubmit === undefined ? undefined : body.autoSubmit ? "1" : "0",
      imap_host: body.imapHost, imap_port: body.imapPort?.toString(), imap_user: body.imapUser,
      imap_password: body.imapPassword, imap_folder: body.imapFolder,
      daily_target: body.dailyTarget?.toString(), mock_mode: body.mockMode,
    };
    for (const [key, value] of Object.entries(mapping)) {
      if (value === undefined) continue;
      const current = await one(ctx, "settings", { key: encodedEq(key) });
      if (current) await updateRows(ctx, "settings", { key: encodedEq(key) }, { value, updated_at: now() });
      else await insertRow(ctx, "settings", { key, value, created_at: now(), updated_at: now() });
    }
    const rows = await selectRows<Row>(ctx, "settings");
    const values = new Map(rows.map(row => [String(row.key), String(row.value ?? "")]));
    const saved = values.get("anthropic_api_key") ?? "";
    const envKey = options.env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
    const mode = values.get("mock_mode") || "auto";
    res.json({
      anthropicApiKeyMasked: saved ? `sk-ant-…${saved.slice(-4)}` : "",
      hasApiKey: !!(saved || envKey), apiKeySource: saved ? "settings" : envKey ? "env" : "none",
      model: values.get("model") || DEFAULT_MODEL, effort: values.get("effort") || DEFAULT_EFFORT,
      autoSubmit: values.get("auto_submit") === "1", imapHost: values.get("imap_host") || "",
      imapPort: Number(values.get("imap_port")) || 993, imapUser: values.get("imap_user") || "",
      imapPasswordSet: !!values.get("imap_password"), imapFolder: values.get("imap_folder") || "INBOX",
      dailyTarget: Number(values.get("daily_target")) || DEFAULT_DAILY_TARGET, mockMode: mode,
      mockActive: mode === "on" || (mode === "auto" && !(saved || envKey)),
      dataDir: "Private hosted workspace", browserInstalled: false,
    });
  }));
  router.post("/settings/test-key", unavailable("API-key testing"));

  router.get("/profile", asyncHandler(async (req, res) => {
    const row = await one(context(req, res), "profile", {});
    res.json(jsonValue(row?.facts_json, DEFAULT_STANDING_FACTS));
  }));
  router.put("/profile", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const facts = validate(req.body, factsSchema);
    const row = await one(ctx, "profile", {});
    if (row) await updateRows(ctx, "profile", { id: encodedEq(numberId(row)) }, { facts_json: facts, updated_at: now() });
    else await insertRow(ctx, "profile", { facts_json: facts });
    res.json(facts);
  }));
  router.get("/rules", asyncHandler(async (req, res) => {
    const row = await one(context(req, res), "rules", {});
    res.json(jsonValue(row?.rules_json, DEFAULT_RULES));
  }));
  router.put("/rules", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const rules = validate(req.body, rulesSchema);
    const row = await one(ctx, "rules", {});
    if (row) await updateRows(ctx, "rules", { id: encodedEq(numberId(row)) }, { rules_json: rules, updated_at: now() });
    else await insertRow(ctx, "rules", { rules_json: rules });
    res.json(rules);
  }));
  router.get("/stories", asyncHandler(async (req, res) => {
    const rows = await selectAllRows<Row>(context(req, res), "stories", {}, "&order=id.asc");
    res.json(rows.map(row => ({
      id: numberId(row), key: row.key, title: row.title, body: row.body, approved: row.approved === true,
      createdAt: row.created_at, updatedAt: row.updated_at,
    })));
  }));
  router.put("/stories/:key", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const key = String(req.params.key);
    if (!/^[a-z0-9_-]{1,80}$/i.test(key)) throw badRequest("Invalid story key");
    const body = validate(req.body, storySchema);
    const row = await one(ctx, "stories", { key: encodedEq(key) });
    const ts = now();
    const saved: Row = row
      ? (await updateRows<Row>(ctx, "stories", { id: encodedEq(numberId(row)) }, { ...body, updated_at: ts }))[0] ?? row
      : await insertRow<Row>(ctx, "stories", { ...body, key, created_at: ts, updated_at: ts });
    res.json({ id: numberId(saved), key: saved.key, title: saved.title, body: saved.body, approved: saved.approved, createdAt: saved.created_at, updatedAt: saved.updated_at });
  }));
  router.post("/intake/suggest", unavailable("Resume intake suggestions"));

  router.get("/resumes", asyncHandler(async (req, res) => {
    const rows = await selectAllRows<Row>(context(req, res), "resumes", {}, "&order=uploaded_at.asc,id.asc");
    res.json(rows.map(row => resumeSummary(row)));
  }));
  router.post("/resumes", upload, asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const files = filesFrom(req);
    if (!files.length) throw badRequest("Select at least one resume file in files[]");
    const existing = await selectAllRows<Row>(ctx, "resumes");
    if (existing.length + files.length > MAX_RESUMES) throw conflict(`At most ${MAX_RESUMES} resumes can be stored`);
    const inserted: Row[] = [];
    const uploaded: string[] = [];
    try {
      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        if ((ext === ".pdf" && file.buffer.subarray(0, 5).toString() !== "%PDF-")
          || (ext === ".docx" && file.buffer.subarray(0, 2).toString() !== "PK")
          || (ext === ".txt" && file.buffer.includes(0))) {
          throw badRequest(`Invalid ${ext.slice(1).toUpperCase()} file: ${path.basename(file.originalname)}`);
        }
        const safeOriginal = path.basename(file.originalname).slice(0, 255);
        const objectPath = `${ctx.ownerId}/resumes/${randomUUID()}${ext}`;
        const storagePath = storageObjectPath(ctx.ownerId, "resumes", objectPath.split("/").at(-1)!);
        const put = await hostedRequest(ctx, storagePath, {
          method: "POST",
          headers: { "content-type": file.mimetype, "x-upsert": "false" },
          body: file.buffer,
        });
        void put;
        uploaded.push(objectPath);
        const text = await extractResumeTextFromBuffer(file.buffer, ext, file.mimetype);
        const ts = now();
        const row = await insertRow<Row>(ctx, "resumes", {
          filename: objectPath, original_name: safeOriginal, mime: file.mimetype, text,
          label: path.basename(safeOriginal, ext), is_base: false, parsed_json: null,
          skills_json: [], uploaded_at: ts, created_at: ts, updated_at: ts,
        });
        inserted.push(row);
      }
    } catch (error) {
      let cleanupFailed = false;
      for (const row of inserted) {
        try {
          await deleteRows(ctx, "resumes", { id: encodedEq(numberId(row)) });
        } catch {
          cleanupFailed = true;
        }
      }
      for (const objectPath of uploaded) {
        const url = `/storage/v1/object/user-files/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
        try {
          await hostedRequest(ctx, url, { method: "DELETE" });
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) throw new HttpError(503, "Resume files or metadata could not be fully cleaned up after an error. Contact support.");
      throw error;
    }
    await deleteRows(ctx, "experience_bank", {});
    res.status(201).json(inserted.map(row => resumeSummary(row)));
  }));
  router.get("/resumes/:id/file", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const row = await required(ctx, "resumes", { id: encodedEq(idParam(req.params.id)) }, "Resume");
    const objectPath = String(row.filename);
    if (!safePrivatePath(ctx.ownerId, "resumes", objectPath) || objectPath.split("/").length !== 3) {
      throw new HttpError(503, "Resume file metadata is invalid.");
    }
    const response = await hostedRequest(ctx, storageAuthenticatedPath(objectPath));
    const bytes = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", String(row.mime));
    res.setHeader("Content-Length", String(bytes.byteLength));
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(String(row.original_name)).replace(/["\\]/g, "_")}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  }));
  router.get("/resumes/:id", asyncHandler(async (req, res) => {
    const row = await required(context(req, res), "resumes", { id: encodedEq(idParam(req.params.id)) }, "Resume");
    res.json(resumeSummary(row, true));
  }));
  router.patch("/resumes/:id", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const body = validate(req.body, z.object({ label: z.string().trim().max(200).optional(), is_base: z.boolean().optional() }).strict());
    const current = await required(ctx, "resumes", { id: encodedEq(id) }, "Resume");
    if (body.is_base === true) await updateRows(ctx, "resumes", {}, { is_base: false, updated_at: now() });
    const rows = await updateRows<Row>(ctx, "resumes", { id: encodedEq(id) }, { ...body, updated_at: now() });
    res.json(resumeSummary(rows[0] ?? { ...current, ...body }));
  }));
  router.delete("/resumes/:id", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const row = await required(ctx, "resumes", { id: encodedEq(idParam(req.params.id)) }, "Resume");
    const objectPath = String(row.filename);
    if (!safePrivatePath(ctx.ownerId, "resumes", objectPath) || objectPath.split("/").length !== 3) {
      throw new HttpError(503, "Resume file metadata is invalid.");
    }
    await hostedRequest(ctx, `/storage/v1/object/user-files/${objectPath.split("/").map(encodeURIComponent).join("/")}`, { method: "DELETE" });
    await deleteRows(ctx, "resumes", { id: encodedEq(numberId(row)) });
    await deleteRows(ctx, "experience_bank", {});
    res.status(204).end();
  }));
  router.post("/resumes/:id/analyze", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const row = await required(ctx, "resumes", { id: encodedEq(idParam(req.params.id)) }, "Resume");
    const parsed = analyzeResumeText(String(row.text ?? ""));
    await updateRows(ctx, "resumes", { id: encodedEq(numberId(row)) }, {
      parsed_json: parsed, skills_json: parsed.skills, updated_at: now(),
    });
    await deleteRows(ctx, "experience_bank", {});
    res.json(parsed);
  }));
  router.post("/resumes/analyze-all", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const rows = await selectAllRows<Row>(ctx, "resumes", {}, "&order=id.asc");
    let analyzed = 0;
    for (const row of rows) {
      if (row.parsed_json) continue;
      const parsed = analyzeResumeText(String(row.text ?? ""));
      await updateRows(ctx, "resumes", { id: encodedEq(numberId(row)) }, {
        parsed_json: parsed, skills_json: parsed.skills, updated_at: now(),
      });
      analyzed += 1;
    }
    if (analyzed) await deleteRows(ctx, "experience_bank", {});
    res.json({ analyzed });
  }));
  router.get("/experience-bank", asyncHandler(async (req, res) => {
    const row = await one(context(req, res), "experience_bank", {});
    res.json(decodeJson(row?.bank_json, null));
  }));
  router.post("/experience-bank/build", asyncHandler(async (req, res) => {
    const { bank } = await loadExperienceBank(context(req, res));
    res.json(bank);
  }));

  const createJobSchema = z.object({
    url: z.string().url().optional(), text: z.string().max(200000).optional(),
    title: z.string().trim().max(200).optional(), company: z.string().trim().max(200).optional(),
    board: z.string().max(100).optional(),
  }).strict().refine(value => !!value.text?.trim() || !!value.url || !!value.title, "Provide a job description, URL, or title");
  router.get("/jobs", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const query = validate(req.query, z.object({
      status: z.enum(JOB_STATUSES).or(z.literal("")).optional(), q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
    }));
    const filters: Record<string, string> = {};
    if (query.status) filters.status = encodedEq(query.status);
    if (query.q) {
      const escaped = query.q.replace(/[%_*(),]/g, "");
      if (escaped) filters.or = `(title.ilike.*${escaped}*,company.ilike.*${escaped}*,location.ilike.*${escaped}*)`;
    }
    const page = await selectPage<Row>(ctx, "jobs", filters, "&order=found_at.desc,id.desc", query.limit, query.offset);
    res.json({ items: page.rows.map(jobView), total: page.total });
  }));
  router.post("/jobs", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const body = validate(req.body, createJobSchema);
    if (body.url) throw new HttpError(503, "URL fetching and automatic job parsing are unavailable in hosted mode.");
    const title = body.title?.trim() ?? "";
    const company = body.company?.trim() ?? "";
    const text = body.text?.trim() ?? "";
    const key = jobDedupeKey(company, title, text);
    if ((await one(ctx, "jobs", { dedupe_key: encodedEq(key) }))) throw conflict("A matching job already exists");
    const ts = now();
    const row = await insertRow<Row>(ctx, "jobs", {
      source: "manual", url: null, title, company, location: "", remote_type: "unknown",
      description_text: text, ats_vendor: "unknown", posting_id: null, board: body.board ?? null,
      status: "new", status_reason: null, dedupe_key: key, found_at: ts, created_at: ts, updated_at: ts,
    });
    res.status(201).json(jobView(row));
  }));
  router.post("/jobs/bulk", unavailable("Bulk URL importing"));
  router.post("/jobs/run-all", unavailable("Automated job pipeline"));
  router.get("/jobs/run-status", (_req, res) => res.status(503).json({ error: "Job pipeline status is unavailable in hosted mode." }));
  router.get("/jobs/:id", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const row = await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
    const [kit, apps, blocked, parked] = await Promise.all([
      one(ctx, "application_kits", { job_id: encodedEq(id) }),
      selectRows<Row>(ctx, "applications", { job_id: encodedEq(id) }, "&order=submitted_at.desc&limit=1"),
      selectRows<Row>(ctx, "blocked_items", { job_id: encodedEq(id) }, "&order=id.desc"),
      selectRows<Row>(ctx, "parked_items", { job_id: encodedEq(id) }, "&order=id.desc"),
    ]);
    const blockedViews = await Promise.all(blocked.map(async item => blockedView(item, await one(ctx, "jobs", { id: encodedEq(Number(item.job_id)) }))));
    const parkedViews = await Promise.all(parked.map(async item => parkedView(item, await one(ctx, "jobs", { id: encodedEq(Number(item.job_id)) }))));
    res.json({ job: jobView(row), kit: kitView(kit), application: apps[0] ? applicationView(apps[0]) : null, blocked: blockedViews, parked: parkedViews });
  }));
  router.put("/jobs/:id", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const old = await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
    const body = validate(req.body, createJobSchema);
    if (body.url) throw new HttpError(503, "URL fetching and automatic job parsing are unavailable in hosted mode.");
    const title = body.title?.trim() ?? String(old.title);
    const company = body.company?.trim() ?? String(old.company);
    const text = body.text?.trim() ?? String(old.description_text ?? "");
    const dedupeKey = jobDedupeKey(company, title, text);
    const duplicate = await one(ctx, "jobs", { dedupe_key: encodedEq(dedupeKey) });
    if (duplicate && numberId(duplicate) !== id) throw conflict("A matching job already exists");
    const rows = await updateRows<Row>(ctx, "jobs", { id: encodedEq(id) }, {
      title, company, description_text: text, board: body.board ?? old.board, dedupe_key: dedupeKey,
      parsed_json: null, qualification_json: null, fit_score: null, status: "new", status_reason: null, updated_at: now(),
    });
    res.json(jobView(rows[0] ?? old));
  }));
  router.delete("/jobs/:id", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
    const kit = await one(ctx, "application_kits", { job_id: encodedEq(id) });
    await removeKitObjects(ctx, kit);
    await deleteRows(ctx, "jobs", { id: encodedEq(id) });
    res.status(204).end();
  }));
  router.post("/jobs/:id/parse", asyncHandler(async (req, res) => {
    res.json(jobView(await parseHostedJob(context(req, res), idParam(req.params.id))));
  }));
  router.post("/jobs/:id/qualify", asyncHandler(async (req, res) => {
    res.json(jobView(await qualifyHostedJob(context(req, res), idParam(req.params.id))));
  }));
  router.post("/jobs/:id/build-kit", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const qualified = await qualifyHostedJob(ctx, id);
    const qualification = decodeJson<Qualification | null>(qualified.qualification_json, null);
    if (!qualification?.qualifies) {
      throw conflict(`Job did not qualify: ${String(qualified.status_reason ?? "hard rules or qualification threshold")}`);
    }
    const { resumes } = await loadExperienceBank(ctx);
    if (!resumes.length) throw badRequest("Upload a resume before building an application kit");
    const posting = decodeJson<JobPosting | null>(qualified.parsed_json, null);
    if (!posting) throw badRequest("Job description could not be parsed");
    const ranked = resumes.map(({ id: resumeId, doc }) => {
      const searchable = JSON.stringify(doc).toLowerCase();
      const strengths = posting.keywords.filter(keyword => searchable.includes(keyword.toLowerCase()));
      return {
        resumeId, score: posting.keywords.length ? Math.round(100 * strengths.length / posting.keywords.length) : 50,
        strengths: strengths.slice(0, 12),
        weaknesses: posting.requiredSkills.filter(skill => !searchable.includes(skill.toLowerCase())).slice(0, 12),
      };
    }).sort((left, right) => right.score - left.score);
    const selectedResumeId = ranked[0]?.resumeId;
    const selected = resumes.find(item => item.id === selectedResumeId);
    if (!selected || selectedResumeId === undefined) throw badRequest("No analyzed resume was selected");
    const selection: ResumeSelection = {
      rankings: ranked, selectedResumeId,
      rationale: "Selected the uploaded resume with the strongest deterministic keyword match.",
    };
    const tailored = tailorManualResume(posting, selected.doc);
    const facts = await profileFacts(ctx);
    const rules = await profileRules(ctx);
    const stories = (await selectAllRows<Row>(ctx, "stories", {}, "&order=id.asc")).map((row): Story => ({
      id: numberId(row), key: String(row.key ?? ""), title: String(row.title ?? ""), body: String(row.body ?? ""),
      approved: row.approved === true, createdAt: String(row.created_at ?? ""), updatedAt: String(row.updated_at ?? ""),
    }));
    const generated = makeManualAnswers(posting.screeningQuestions, facts, stories, posting, rules);
    const ts = now();
    const current = await one(ctx, "application_kits", { job_id: encodedEq(id) });
    const artifacts = await storeRenderedKit(ctx, qualified, tailored.document);
    const values = {
      selected_resume_id: selectedResumeId, selection_json: selection, tailored_json: tailored.document,
      honesty_json: tailored.honesty, keyword_json: tailored.keywords, answers_json: generated.answers,
      cover_letter: generated.coverLetter, pdf_path: artifacts.pdfPath, docx_path: artifacts.docxPath,
      status: "draft", updated_at: ts,
    };
    let kit: Row;
    try {
      kit = current
        ? (await updateRows<Row>(ctx, "application_kits", { id: encodedEq(numberId(current)) }, values))[0] ?? { ...current, ...values }
        : await insertRow<Row>(ctx, "application_kits", { ...values, job_id: id, created_at: ts });
    } catch (error) {
      await removeKitObjects(ctx, { pdf_path: artifacts.pdfPath, docx_path: artifacts.docxPath });
      throw error;
    }
    await updateRows(ctx, "jobs", { id: encodedEq(id) }, { status: "kit_ready", status_reason: null, updated_at: ts });
    await removeKitObjects(ctx, current);
    res.json(kitView(kit));
  }));
  router.post("/jobs/:id/run", unavailable("Automated job pipeline"));
  router.put("/jobs/:id/kit", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const job = await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
    const current = await one(ctx, "application_kits", { job_id: encodedEq(id) });
    if (!current) throw notFound("Application kit not found");
    const body = validate(req.body, z.object({
      tailored: resumeDocumentSchema.optional(),
      answers: z.array(z.object({ question: z.string(), answer: z.string(), source: z.string(), needsHuman: z.boolean(), humanReason: z.string().optional() })).optional(),
      coverLetter: z.string().max(20000).optional(),
    }).strict());
    if (body.tailored === undefined && body.answers === undefined && body.coverLetter === undefined) {
      res.json(kitView(current));
      return;
    }
    let artifacts: { pdfPath: string; docxPath: string } | undefined;
    let honesty: Row | undefined;
    if (body.tailored !== undefined) {
      const selectedResumeId = Number(current.selected_resume_id);
      if (!Number.isSafeInteger(selectedResumeId) || selectedResumeId < 1) throw conflict("The application kit has no selected source resume");
      const { resumes } = await loadExperienceBank(ctx);
      const source = resumes.find(item => item.id === selectedResumeId);
      if (!source) throw conflict("The selected source resume no longer exists");
      honesty = checkManualHonesty(body.tailored, source.doc);
      if (honesty.verdict !== "pass" || Number(honesty.unsupportedCount) !== 0) {
        throw badRequest("Edited kit contains claims that are not supported by the selected resume");
      }
      artifacts = await storeRenderedKit(ctx, job, body.tailored);
    }
    const ts = now();
    let saved: Row;
    try {
      saved = (await updateRows<Row>(ctx, "application_kits", { id: encodedEq(numberId(current)) }, {
        ...(body.tailored === undefined ? {} : { tailored_json: body.tailored, honesty_json: honesty, pdf_path: artifacts?.pdfPath, docx_path: artifacts?.docxPath }),
        ...(body.answers === undefined ? {} : { answers_json: body.answers }),
        ...(body.coverLetter === undefined ? {} : { cover_letter: body.coverLetter }),
        status: "draft", updated_at: ts,
      }))[0] ?? { ...current, ...(body.tailored === undefined ? {} : {
        tailored_json: body.tailored, honesty_json: honesty, pdf_path: artifacts?.pdfPath, docx_path: artifacts?.docxPath,
      }), ...(body.answers === undefined ? {} : { answers_json: body.answers }),
      ...(body.coverLetter === undefined ? {} : { cover_letter: body.coverLetter }), status: "draft", updated_at: ts };
    } catch (error) {
      if (artifacts) await removeKitObjects(ctx, { pdf_path: artifacts.pdfPath, docx_path: artifacts.docxPath });
      throw error;
    }
    if (artifacts) await removeKitObjects(ctx, current);
    if (job.status !== "applied") await updateRows(ctx, "jobs", { id: encodedEq(id) }, { status: "kit_ready", updated_at: ts });
    res.json(kitView(saved));
  }));
  router.post("/jobs/:id/kit/approve", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const qualified = await qualifyHostedJob(ctx, id);
    const qualification = decodeJson<Qualification | null>(qualified.qualification_json, null);
    if (!qualification?.qualifies) {
      throw conflict(`Job did not qualify: ${String(qualified.status_reason ?? "hard rules or qualification threshold")}`);
    }
    const current = await one(ctx, "application_kits", { job_id: encodedEq(id) });
    const tailored = resumeDocumentSchema.safeParse(decodeJson(current?.tailored_json, null));
    const honesty = decodeJson<Row | null>(current?.honesty_json, null);
    const selectedResumeId = Number(current?.selected_resume_id);
    const sourceRow = current && Number.isSafeInteger(selectedResumeId) && selectedResumeId > 0
      ? await one(ctx, "resumes", { id: encodedEq(selectedResumeId) }) : undefined;
    const source = resumeDocumentSchema.safeParse(decodeJson(sourceRow?.parsed_json, null));
    if (!current || !tailored.success || !source.success || !honesty || honesty.verdict !== "pass" || Number(honesty.unsupportedCount) !== 0) {
      throw conflict("A passing honesty-checked kit is required before approval");
    }
    const verifiedHonesty = checkManualHonesty(tailored.data, source.data);
    if (verifiedHonesty.verdict !== "pass" || Number(verifiedHonesty.unsupportedCount) !== 0) {
      throw conflict("Application kit contains claims not supported by the selected resume");
    }
    const ts = now();
    const saved = (await updateRows<Row>(ctx, "application_kits", { id: encodedEq(numberId(current)) }, {
      status: "approved", honesty_json: verifiedHonesty, updated_at: ts,
    }))[0] ?? { ...current, status: "approved", updated_at: ts };
    await updateRows(ctx, "jobs", { id: encodedEq(id) }, { status: "kit_ready", status_reason: null, updated_at: ts });
    res.json(kitView(saved));
  }));
  const downloadKit = (format: "pdf" | "docx") => asyncHandler(async (req: Request, res: Response) => {
    const ctx = context(req, res);
    const jobId = idParam(req.params.id);
    await required(ctx, "jobs", { id: encodedEq(jobId) }, "Job");
    const kit = await one(ctx, "application_kits", { job_id: encodedEq(jobId) });
    const objectPath = String(kit?.[format === "pdf" ? "pdf_path" : "docx_path"] ?? "");
    const honesty = decodeJson<Row | null>(kit?.honesty_json, null);
    if (!objectPath || !kit?.tailored_json || honesty?.verdict !== "pass" || Number(honesty.unsupportedCount) !== 0
      || !safePrivatePath(ctx.ownerId, "kits", objectPath)) {
      throw notFound("No hosted application file is available");
    }
    const response = await hostedRequest(ctx, storageAuthenticatedPath(objectPath));
    const bytes = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="application.${format}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  });
  router.get("/jobs/:id/kit/pdf", downloadKit("pdf"));
  router.get("/jobs/:id/kit/docx", downloadKit("docx"));
  router.post("/jobs/:id/questions", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const job = await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
    const existingPosting = decodeJson<JobPosting | null>(job.parsed_json, null);
    const parsed = existingPosting ? job : await parseHostedJob(ctx, id);
    const posting = existingPosting ?? decodeJson<JobPosting | null>(parsed.parsed_json, null);
    if (!posting) throw badRequest("Job description could not be parsed");
    const questions = validate(req.body, z.object({
      questions: z.array(z.string().trim().min(1).max(1000)).max(100),
    }).strict()).questions;
    const [facts, rules] = await Promise.all([profileFacts(ctx), profileRules(ctx)]);
    const stories = (await selectAllRows<Row>(ctx, "stories", {}, "&order=id.asc")).map((row): Story => ({
      id: numberId(row), key: String(row.key ?? ""), title: String(row.title ?? ""), body: String(row.body ?? ""),
      approved: row.approved === true, createdAt: String(row.created_at ?? ""), updatedAt: String(row.updated_at ?? ""),
    }));
    const generated = makeManualAnswers(questions, facts, stories, posting, rules);
    const kit = await one(ctx, "application_kits", { job_id: encodedEq(id) });
    if (kit) {
      const previous = decodeJson<ScreeningAnswer[]>(kit.answers_json, []);
      await updateRows(ctx, "application_kits", { id: encodedEq(numberId(kit)) }, {
        answers_json: [...previous, ...generated.answers], updated_at: now(),
      });
    }
    res.json(generated.answers);
  }));
  router.post("/jobs/:id/mark-applied", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const job = await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
    const body = validate(req.body, z.object({
      route: z.enum(["ats", "site", "manual", "assist"]), notes: z.string().max(4000).optional(),
    }).strict());
    if (await one(ctx, "applications", { job_id: encodedEq(id) })) throw conflict("This job is already in the application ledger");
    const kit = await one(ctx, "application_kits", { job_id: encodedEq(id) });
    const ts = now();
    const app = await insertRow<Row>(ctx, "applications", {
      job_id: id, company: String(job.company ?? ""), title: String(job.title ?? ""),
      posting_id: job.posting_id ?? null, route: body.route as ApplicationRoute,
      resume_file: kit?.pdf_path ?? null, submitted_at: ts, notes: body.notes ?? "", created_at: ts, updated_at: ts,
    });
    await updateRows(ctx, "jobs", { id: encodedEq(id) }, { status: "applied", updated_at: ts });
    res.status(201).json(applicationView(app));
  }));
  const parkSchema = z.object({ reason: z.string().trim().min(1).max(1000), retry_plan: z.string().max(2000).optional() }).strict();
  router.post("/jobs/:id/park", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const job = await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
    const body = validate(req.body, parkSchema);
    const ts = now();
    const row = await insertRow<Row>(ctx, "parked_items", {
      job_id: id, reason: body.reason, retry_plan: body.retry_plan ?? "", resolved: false, created_at: ts, updated_at: ts,
    });
    await updateRows(ctx, "jobs", { id: encodedEq(id) }, { status: "parked", status_reason: body.reason, updated_at: ts });
    res.status(201).json({
      id: numberId(row), jobId: id, reason: row.reason, retryPlan: row.retry_plan, resolved: row.resolved,
      createdAt: row.created_at, updatedAt: row.updated_at, company: job.company, title: job.title,
    });
  }));
  const blockSchema = z.object({
    reason: z.enum(["captcha", "identity", "lever", "login", "payment", "other"]),
    action_text: z.string().min(1).max(1000), link: z.string().url().optional(),
  }).strict();
  router.post("/jobs/:id/block", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const job = await required(ctx, "jobs", { id: encodedEq(id) }, "Job");
    const body = validate(req.body, blockSchema);
    const ts = now();
    const row = await insertRow<Row>(ctx, "blocked_items", {
      job_id: id, reason: body.reason, action_text: body.action_text, link: body.link ?? null,
      resume_file: null, resolved: false, created_at: ts, updated_at: ts,
    });
    await updateRows(ctx, "jobs", { id: encodedEq(id) }, { status: "blocked", status_reason: body.reason, updated_at: ts });
    res.status(201).json({
      id: numberId(row), jobId: id, reason: row.reason, actionText: row.action_text, link: row.link,
      resumeFile: row.resume_file, resolved: false, createdAt: row.created_at, updatedAt: row.updated_at,
      company: job.company, title: job.title,
    });
  }));

  router.get("/ledger", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const query = validate(req.query, z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
    }));
    const page = await selectPage<Row>(ctx, "applications", {}, "&order=submitted_at.desc,id.desc", query.limit, query.offset);
    res.json({ items: page.rows.map(applicationView), total: page.total });
  }));
  router.get("/ledger/export", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const rows = await selectAllRows<Row>(ctx, "applications", {}, "&order=submitted_at.desc,id.desc");
    const headers = ["submitted_at", "company", "title", "posting_id", "route", "resume_file", "notes", "job_url"];
    const csvRows: Row[] = await Promise.all(rows.map(async (row): Promise<Row> => {
      const job = row.job_id == null ? undefined : await one(ctx, "jobs", { id: encodedEq(Number(row.job_id)) });
      return { ...row, job_url: job?.url ?? "" };
    }));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=applypilot-ledger.csv");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(`\ufeff${[headers.join(","), ...csvRows.map(row => headers.map(key => csvCell(row[key])).join(","))].join("\r\n")}`);
  }));

  router.get("/blocked", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const rows = await selectAllRows<Row>(ctx, "blocked_items", {}, "&order=resolved.asc,created_at.desc");
    const out = await Promise.all(rows.map(async row => {
      const job = await one(ctx, "jobs", { id: encodedEq(Number(row.job_id)) });
      return blockedView(row, job);
    }));
    res.json(out);
  }));
  router.post("/blocked/:id/resolve", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const row = await required(ctx, "blocked_items", { id: encodedEq(id) }, "Blocked item");
    const updated = (await updateRows<Row>(ctx, "blocked_items", { id: encodedEq(id) }, { resolved: true, updated_at: now() }))[0] ?? row;
    const job = await one(ctx, "jobs", { id: encodedEq(Number(row.job_id)) });
    res.json(blockedView(updated, job));
  }));
  router.get("/parked", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const rows = await selectAllRows<Row>(ctx, "parked_items", {}, "&order=resolved.asc,created_at.desc");
    const out = await Promise.all(rows.map(async row => {
      const job = await one(ctx, "jobs", { id: encodedEq(Number(row.job_id)) });
      return parkedView(row, job);
    }));
    res.json(out);
  }));
  router.post("/parked/:id/resolve", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const id = idParam(req.params.id);
    const row = await required(ctx, "parked_items", { id: encodedEq(id) }, "Parked item");
    const updated = (await updateRows<Row>(ctx, "parked_items", { id: encodedEq(id) }, { resolved: true, updated_at: now() }))[0] ?? row;
    const job = await one(ctx, "jobs", { id: encodedEq(Number(row.job_id)) });
    res.json(parkedView(updated, job));
  }));

  router.get("/reports/today", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const date = new Date().toISOString().slice(0, 10);
    const nextDate = new Date(`${date}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const rows = await selectRows<Row>(ctx, "applications", {}, `&submitted_at=gte.${date}T00%3A00%3A00Z&submitted_at=lt.${nextDate.toISOString()}`);
    const allApps = await selectAllRows<Row>(ctx, "applications");
    res.json({ date, submitted: rows.length, total: allApps.length, line: `${rows.length} today and ${allApps.length} total` });
  }));
  router.get("/reports/weekly", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const start = new Date();
    const mondayOffset = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    const apps = await selectAllRows<Row>(ctx, "applications", {}, "&order=submitted_at.asc");
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const week = new Date(start);
      week.setUTCDate(week.getUTCDate() - i * 7);
      const weekStart = week.toISOString().slice(0, 10);
      const next = new Date(week);
      next.setUTCDate(next.getUTCDate() + 7);
      const weekEnd = next.toISOString().slice(0, 10);
      const matching = apps.filter(row => String(row.submitted_at).slice(0, 10) >= weekStart && String(row.submitted_at).slice(0, 10) < weekEnd);
      weeks.push({ weekStart, submitted: matching.length, interviews: matching.filter(row => /interview/i.test(String(row.notes ?? ""))).length });
    }
    res.json({ weeks });
  }));
  router.post("/reports/interview", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const { jobId } = validate(req.body, z.object({ jobId: z.number().int().positive() }).strict());
    const row = (await selectRows<Row>(ctx, "applications", { job_id: encodedEq(jobId) }, "&order=submitted_at.desc&limit=1"))[0];
    if (!row) throw notFound("No ledger application exists for this job");
    const notes = String(row.notes ?? "");
    if (!/interview/i.test(notes)) await updateRows(ctx, "applications", { id: encodedEq(numberId(row)) }, {
      notes: `${notes}${notes ? "\n" : ""}Interview received`, updated_at: now(),
    });
    res.json({ ok: true });
  }));

  router.get("/brain", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const [resumes, jobs, kits, feedback, runs] = await Promise.all([
      selectAllRows<Row>(ctx, "resumes"),
      selectAllRows<Row>(ctx, "jobs"),
      selectAllRows<Row>(ctx, "application_kits"),
      selectRows<Row>(ctx, "brain_feedback"),
      selectRows<Row>(ctx, "agent_runs", {}, "&order=created_at.desc,id.desc&limit=50"),
    ]);
    const recommendations = masterBrainRecommendations(resumes, jobs, kits);
    const reviewedDecisions = reviewAgentRuns(runs, jobs, kits);
    const agents = MASTER_BRAIN_AGENTS.map(id => {
      const vote = feedback.find(row => row.agent === id);
      return {
        id,
        ...brainAgents[id],
        helpfulVotes: vote?.helpful === true ? 1 : 0,
        notHelpfulVotes: vote?.helpful === false ? 1 : 0,
        userRating: typeof vote?.helpful === "boolean" ? vote.helpful : null,
      };
    });
    const agentRank = new Map(agents.map((agent, index) => [
      agent.id,
      { index, score: agent.helpfulVotes - agent.notHelpfulVotes },
    ]));
    recommendations.sort((left, right) => {
      const priority = Number(right.priority === "high") - Number(left.priority === "high");
      if (priority) return priority;
      const leftRank = agentRank.get(left.agentId)!;
      const rightRank = agentRank.get(right.agentId)!;
      return rightRank.score - leftRank.score || leftRank.index - rightRank.index;
    });
    const roleCount = jobs.length;
    const resumeCount = resumes.length;
    res.json({
      generatedAt: now(),
      summary: `Reviewed ${resumeCount} resume${resumeCount === 1 ? "" : "s"} and ${roleCount} role${roleCount === 1 ? "" : "s"} from your private workspace.`,
      learningSignals: feedback.length,
      agents,
      recommendations,
      reviewedDecisions,
      finalDecision: chooseMasterDecision(recommendations, reviewedDecisions),
    });
  }));
  router.put("/brain/feedback", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const { agentId, helpful } = validate(req.body, z.object({
      agentId: z.enum(MASTER_BRAIN_AGENTS),
      helpful: z.boolean(),
    }).strict());
    const response = await hostedRequest(ctx, "/rest/v1/brain_feedback?on_conflict=owner_id%2Cagent&select=*", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify({ owner_id: ctx.ownerId, agent: agentId, helpful, updated_at: now() }),
    });
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== "object") {
      throw new HttpError(503, "Hosted data service returned an invalid feedback response.");
    }
    res.json({ agentId, helpful, learned: true });
  }));

  router.get("/agent-runs", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const { limit } = validate(req.query, z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }));
    const rows = await selectRows<Row>(ctx, "agent_runs", {}, `&order=created_at.desc,id.desc&limit=${limit}`);
    res.json(rows.map(row => ({
      id: numberId(row), agent: row.agent, jobId: row.job_id == null ? null : Number(row.job_id),
      model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, durationMs: row.duration_ms,
      ok: row.ok, error: row.error ?? null, mock: row.mock, createdAt: row.created_at,
    })));
  }));
  router.get("/logs", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const { limit, offset } = validate(req.query, z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
    }));
    const page = await selectPage<Row>(ctx, "agent_runs", {}, "&order=created_at.desc,id.desc", limit, offset);
    const rows = page.rows;
    res.json({ items: rows.map(row => ({
      id: numberId(row), agent: row.agent, jobId: row.job_id == null ? null : Number(row.job_id),
      model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      durationMs: row.duration_ms, ok: row.ok, error: row.error ?? null, mock: row.mock, createdAt: row.created_at,
    })), total: page.total });
  }));
  router.get("/dashboard", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const [apps, jobs, blocked, parked, resumes, bank, runs, settings] = await Promise.all([
      selectAllRows<Row>(ctx, "applications"),
      selectAllRows<Row>(ctx, "jobs"),
      selectAllRows<Row>(ctx, "blocked_items", { resolved: "eq.false" }),
      selectAllRows<Row>(ctx, "parked_items", { resolved: "eq.false" }),
      selectAllRows<Row>(ctx, "resumes"),
      selectRows<Row>(ctx, "experience_bank", {}, "&limit=1"),
      selectAllRows<Row>(ctx, "agent_runs", {}, "&order=created_at.desc,id.desc"),
      selectRows<Row>(ctx, "settings"),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const todayApps = apps.filter(row => String(row.submitted_at).slice(0, 10) === today).length;
    const statusCounts = Object.fromEntries(JOB_STATUSES.map(status => [status, 0])) as Record<JobStatus, number>;
    for (const row of jobs) if (String(row.status) in statusCounts) statusCounts[row.status as JobStatus]++;
    const vals = new Map(settings.map(row => [String(row.key), String(row.value ?? "")]));
    const mode = vals.get("mock_mode") || "auto";
    const hasKey = !!(vals.get("anthropic_api_key") || options.env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);
    const recentRuns = runs.slice(0, 8).map(row => ({
      id: numberId(row), agent: row.agent, jobId: row.job_id == null ? null : Number(row.job_id),
      model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens, durationMs: row.duration_ms,
      ok: row.ok, error: row.error ?? null, mock: row.mock, createdAt: row.created_at,
    }));
    res.json({
      today: todayApps, total: apps.length, byStatus: statusCounts, blockedCount: blocked.length,
      parkedCount: parked.length, resumesCount: resumes.length, bankBuilt: bank.length > 0,
      mockActive: mode === "on" || (mode === "auto" && !hasKey),
      tokensToday: runs.filter(row => String(row.created_at).slice(0, 10) === today)
        .reduce((sum, row) => sum + Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0), 0),
      recentRuns,
    });
  }));

  const assistView = (row: Row) => {
    const data = jsonValue<{ fields?: unknown[]; mappings?: unknown[] }>(row.field_map_json, {});
    return {
      id: numberId(row), jobId: Number(row.job_id), status: row.status,
      fields: data.fields ?? [], mappings: data.mappings ?? [],
      log: jsonValue(row.log_json, []), screenshotPath: row.screenshot_path ?? null,
      screenshotUrl: null, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  };
  router.get("/assist/status", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const rows = await selectRows<Row>(ctx, "assist_sessions", { status: "not.in.(closed,submitted)" }, "&order=updated_at.desc,id.desc&limit=1");
    res.json({ browserInstalled: false, active: rows[0] ? assistView(rows[0]) : null });
  }));
  router.post("/assist/:jobId/start", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const jobId = idParam(req.params.jobId, "jobId");
    const job = await required(ctx, "jobs", { id: encodedEq(jobId) }, "Job");
    if (!job.url) throw badRequest("Add a public application URL before starting apply-assist");
    const active = await selectRows<Row>(ctx, "assist_sessions", {
      job_id: encodedEq(jobId), status: "not.in.(closed,submitted)",
    }, "&order=id.desc&limit=1");
    if (active.length) throw conflict("An apply-assist review session is already active for this job");
    const ts = now();
    const row = await insertRow<Row>(ctx, "assist_sessions", {
      job_id: jobId, status: "ready_for_review", field_map_json: { fields: [], mappings: [] },
      log_json: [{ at: ts, level: "warn", message: "Manual application handoff opened. No browser was launched and no form was filled or submitted." }],
      created_at: ts, updated_at: ts,
    });
    res.status(201).json(assistView(row));
  }));
  router.get("/assist/:jobId", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const rows = await selectRows<Row>(ctx, "assist_sessions", { job_id: encodedEq(idParam(req.params.jobId, "jobId")) }, "&order=id.desc&limit=1");
    res.json(rows[0] ? assistView(rows[0]) : null);
  }));
  router.post("/assist/:jobId/submit", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const jobId = idParam(req.params.jobId, "jobId");
    validate(req.body ?? {}, z.object({ confirm: z.literal(true) }).strict());
    const rows = await selectRows<Row>(ctx, "assist_sessions", { job_id: encodedEq(jobId) }, "&order=id.desc&limit=1");
    const session = rows[0];
    if (!session) throw notFound("Apply-assist session not found");
    if (session.status !== "ready_for_review") throw conflict("Only a ready-for-review session can be confirmed");
    const job = await required(ctx, "jobs", { id: encodedEq(jobId) }, "Job");
    const prior = await one(ctx, "applications", { job_id: encodedEq(jobId) });
    const ts = now();
    if (!prior) {
      const kit = await one(ctx, "application_kits", { job_id: encodedEq(jobId) });
      await insertRow(ctx, "applications", {
        job_id: jobId, company: String(job.company ?? ""), title: String(job.title ?? ""),
        posting_id: job.posting_id ?? null, route: "assist", resume_file: kit?.pdf_path ?? null,
        submitted_at: ts,
        notes: "User confirmed they submitted manually on the job site; ApplyPilot did not submit the form.",
        created_at: ts, updated_at: ts,
      });
      await updateRows(ctx, "jobs", { id: encodedEq(jobId) }, { status: "applied", updated_at: ts });
    }
    const log = jsonValue<unknown[]>(session.log_json, []);
    const updated = (await updateRows<Row>(ctx, "assist_sessions", { id: encodedEq(numberId(session)) }, {
      status: "submitted",
      log_json: [...log, { at: ts, level: "info", message: "User attested that they submitted manually on the job site; ApplyPilot did not interact with the application form." }],
      updated_at: ts,
    }))[0] ?? session;
    res.json(assistView(updated));
  }));
  router.post("/assist/:jobId/close", asyncHandler(async (req, res) => {
    const ctx = context(req, res);
    const jobId = idParam(req.params.jobId, "jobId");
    const rows = await selectRows<Row>(ctx, "assist_sessions", { job_id: encodedEq(jobId) }, "&order=id.desc&limit=1");
    const session = rows[0];
    if (!session) throw notFound("Apply-assist session not found");
    const ts = now();
    const log = jsonValue<unknown[]>(session.log_json, []);
    const updated = (await updateRows<Row>(ctx, "assist_sessions", { id: encodedEq(numberId(session)) }, {
      status: "closed", log_json: [...log, { at: ts, level: "info", message: "Human-review session closed." }], updated_at: ts,
    }))[0] ?? session;
    res.json(assistView(updated));
  }));

  router.post("/email/test", unavailable("Mailbox integration"));
  router.post("/email/sweep", unavailable("Mailbox integration"));
  return router;
}
