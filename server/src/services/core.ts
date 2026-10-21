import { all, get, nowIso, parseJson, run } from "../db.js";
import type {
  AgentRun, Application, ApplicationKit, AssistSession, BlockedItem, ExperienceBank,
  Job, JobDetail, JobPosting, JobSummary, ParkedItem, Resume, ResumeDocument,
  ResumeSummary, Rules, StandingFacts, Story,
} from "../../../shared/types.js";

export function dbJob(row: Record<string, unknown>): Job {
  return {
    id: Number(row.id), source: row.source as Job["source"], url: row.url as string | null,
    title: String(row.title ?? ""), company: String(row.company ?? ""), location: String(row.location ?? ""),
    remoteType: row.remote_type as Job["remoteType"], payMin: row.pay_min as number | null,
    payMax: row.pay_max as number | null, payCurrency: row.pay_currency as string | null,
    atsVendor: row.ats_vendor as Job["atsVendor"], postingId: row.posting_id as string | null,
    board: row.board as string | null, status: row.status as Job["status"],
    statusReason: row.status_reason as string | null, fitScore: row.fit_score as number | null,
    foundAt: String(row.found_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    descriptionText: String(row.description_text ?? ""),
    parsed: parseJson<JobPosting | null>(row.parsed_json as string | null, null),
    qualification: parseJson(row.qualification_json as string | null, null),
    dedupeKey: String(row.dedupe_key ?? ""),
  };
}

export function dbResume(row: Record<string, unknown>, full = false): Resume | ResumeSummary {
  const skills = parseJson<string[]>(row.skills_json as string | null, []);
  const summary: ResumeSummary = {
    id: Number(row.id), label: String(row.label ?? ""), originalName: String(row.original_name),
    mime: String(row.mime), isBase: Number(row.is_base) === 1, analyzed: !!row.parsed_json,
    skills, skillsCount: skills.length, textLength: String(row.text ?? "").length, uploadedAt: String(row.uploaded_at),
  };
  return full ? {
    ...summary, filename: String(row.filename), text: String(row.text ?? ""),
    parsed: parseJson<ResumeDocument | null>(row.parsed_json as string | null, null),
  } : summary;
}

export function dbKit(row: Record<string, unknown> | undefined): ApplicationKit | null {
  if (!row) return null;
  return {
    id: Number(row.id), jobId: Number(row.job_id), selectedResumeId: row.selected_resume_id == null ? null : Number(row.selected_resume_id),
    selection: parseJson(row.selection_json as string | null, null), tailored: parseJson(row.tailored_json as string | null, null),
    honesty: parseJson(row.honesty_json as string | null, null), keywords: parseJson(row.keyword_json as string | null, null),
    answers: parseJson(row.answers_json as string | null, []), coverLetter: String(row.cover_letter ?? ""),
    pdfPath: row.pdf_path as string | null, docxPath: row.docx_path as string | null,
    status: row.status as ApplicationKit["status"], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function dbApplication(row: Record<string, unknown> | undefined): Application | null {
  return row ? {
    id: Number(row.id), jobId: Number(row.job_id), company: String(row.company), title: String(row.title),
    postingId: row.posting_id as string | null, route: row.route as Application["route"], resumeFile: row.resume_file as string | null,
    submittedAt: String(row.submitted_at), notes: String(row.notes ?? ""), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  } : null;
}

export function dbBlocked(row: Record<string, unknown>): BlockedItem {
  return { id: Number(row.id), jobId: Number(row.job_id), reason: row.reason as BlockedItem["reason"],
    actionText: String(row.action_text), link: row.link as string | null, resumeFile: row.resume_file as string | null,
    resolved: Number(row.resolved) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.company ? { company: String(row.company) } : {}), ...(row.title ? { title: String(row.title) } : {}) };
}

export function dbParked(row: Record<string, unknown>): ParkedItem {
  return { id: Number(row.id), jobId: Number(row.job_id), reason: String(row.reason), retryPlan: String(row.retry_plan),
    resolved: Number(row.resolved) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.company ? { company: String(row.company) } : {}), ...(row.title ? { title: String(row.title) } : {}) };
}

export function dbRun(row: Record<string, unknown>): AgentRun {
  return { id: Number(row.id), agent: String(row.agent), jobId: row.job_id == null ? null : Number(row.job_id),
    model: String(row.model), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
    durationMs: Number(row.duration_ms), ok: Number(row.ok) === 1, error: row.error as string | null,
    mock: Number(row.mock) === 1, createdAt: String(row.created_at) };
}

export function dbAssist(row: Record<string, unknown>): AssistSession {
  const data = parseJson<{fields?: AssistSession["fields"]; mappings?: AssistSession["mappings"]}>(row.field_map_json as string, {});
  return { id: Number(row.id), jobId: Number(row.job_id), status: row.status as AssistSession["status"],
    fields: data.fields ?? [], mappings: data.mappings ?? [], log: parseJson(row.log_json as string, []),
    screenshotPath: row.screenshot_path as string | null,
    screenshotUrl: row.screenshot_path ? `/api/screenshots/${Number(row.job_id)}.png` : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

export function dbFacts(): StandingFacts {
  const row = get<{facts_json: string}>("SELECT facts_json FROM profile WHERE id=1");
  return parseJson(row?.facts_json, {} as StandingFacts);
}
export function dbRules(): Rules {
  const row = get<{rules_json: string}>("SELECT rules_json FROM rules WHERE id=1");
  return parseJson(row?.rules_json, {} as Rules);
}
export function dbStories(): Story[] {
  return all<Record<string, unknown>>("SELECT * FROM stories ORDER BY id").map(r => ({
    id: Number(r.id), key: String(r.key), title: String(r.title), body: String(r.body),
    approved: Number(r.approved) === 1, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  }));
}
export function dbBank(): ExperienceBank | null {
  const row = get<{bank_json: string}>("SELECT bank_json FROM experience_bank WHERE id=1");
  return row ? parseJson<ExperienceBank | null>(row.bank_json, null) : null;
}

export function jobSummary(row: Record<string, unknown>): JobSummary {
  const job = dbJob(row);
  const { descriptionText: _description, parsed: _parsed, qualification: _qualification, dedupeKey: _key, ...summary } = job;
  return summary;
}

export function jobDetail(job: Job): JobDetail {
  const kitRow = get<Record<string, unknown>>("SELECT * FROM application_kits WHERE job_id=?", job.id);
  const appRow = get<Record<string, unknown>>("SELECT * FROM applications WHERE job_id=? ORDER BY submitted_at DESC LIMIT 1", job.id);
  const blockedRows = all<Record<string, unknown>>("SELECT * FROM blocked_items WHERE job_id=? ORDER BY id DESC", job.id);
  const parkedRows = all<Record<string, unknown>>("SELECT * FROM parked_items WHERE job_id=? ORDER BY id DESC", job.id);
  return { job, kit: dbKit(kitRow), application: dbApplication(appRow), blocked: blockedRows.map(dbBlocked), parked: parkedRows.map(dbParked) };
}

export function insertAgentRun(agent: string, jobId: number | null, ok: boolean, started: number, error: string | null = null): void {
  const ts = nowIso();
  run("INSERT INTO agent_runs(agent,job_id,model,input_tokens,output_tokens,duration_ms,ok,error,mock,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    agent, jobId, "deterministic-mock", 0, 0, Date.now() - started, ok ? 1 : 0, error, 1, ts, ts);
}
