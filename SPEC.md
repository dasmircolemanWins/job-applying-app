# ApplyPilot — Build Specification (v1)

ApplyPilot is a LOCAL web application (runs on the user's own machine) that turns the
"Apply to Jobs on Autopilot" playbook into software. It helps one job seeker submit many
high-quality, truthful applications per week with minimal daily effort.

The user uploads 5–10 resumes. AI agents (Claude) build an "experience bank" from all of
them, pick the best resume per job, generate a tailored resume that only uses facts that
appear in the user's own resumes, write screening answers and cover letters from the user's
standing facts and approved stories, keep a duplicate-proof ledger, and (optionally) pre-fill
online application forms in a real browser for the user to review and submit.

## 0. Non-negotiable principles

1. **Truthful only.** Tailored resumes, answers and cover letters may only contain facts that
   trace back to the user's uploaded resumes, standing facts, or approved stories. Every
   tailored resume passes an automated "honesty check" that lists every claim with its source;
   unsupported claims are removed before the user sees the result.
2. **Review-before-submit by default.** The apply-assist browser pre-fills forms and STOPS
   before the final submit button. The user clicks submit. An "auto-submit" toggle exists in
   Settings, default OFF, with a clear warning that job sites' terms may restrict automation.
3. **No security downgrades.** The app never asks the user to disable two-factor
   authentication, never stores passwords for job boards, never bypasses paywalls, and never
   solves CAPTCHAs. Items that need a human (CAPTCHA, identity items, blocked sites) go to the
   Blocked list with the exact link and the tailored resume attached.
4. **Local-first.** All data lives in a SQLite file under `./data/`. The only outbound calls
   are to the Anthropic API, to job-posting URLs the user added, and (optional) to the user's
   own IMAP mailbox for job-alert emails.
5. **Mock mode.** When `ANTHROPIC_API_KEY` is absent (and no key saved in Settings), agents
   run in deterministic mock mode so the whole UI can be exercised without spending tokens.

## 1. Tech stack (fixed — do not substitute)

- Node.js 24 (installed at `C:\Program Files\nodejs`), npm 11. TypeScript 5, ESM everywhere
  (`"type": "module"`). No `__dirname`; derive from `import.meta.url`.
- **Server:** Express 5, `node:sqlite` (`DatabaseSync` — built into Node 24, NO better-sqlite3),
  `multer` (uploads), `pdf-parse` (PDF text), `mammoth` (DOCX text), `pdfkit` (PDF output),
  `docx` (DOCX output), `cheerio` (HTML → text for job URLs), `imapflow` + `mailparser`
  (job-alert email ingestion), `@anthropic-ai/sdk` + `zod` (agents), `playwright`
  (apply-assist; browser binaries installed separately with `npx playwright install chromium`).
  Dev/run with `tsx` (no compile step needed): `npm run dev` = `tsx watch src/index.ts`,
  `npm start` = `tsx src/index.ts`, `npm run typecheck` = `tsc --noEmit`.
- **Web:** Vite 6 + React 19 + TypeScript + `react-router-dom` v7. Plain CSS (one global
  stylesheet + CSS variables). No Tailwind, no component library. Dev server proxies `/api`
  to `http://localhost:4310`.
- **Root:** npm workspaces `server`, `web`. Root scripts: `dev` (runs both with `concurrently`),
  `build` (web build + server typecheck), `start` (serves built web from server).
- Server port **4310**. Vite dev port **5173**.
- Shared TypeScript types live in `shared/types.ts` and are imported by BOTH packages via
  relative path (`../../shared/types.js` from server src, `../../shared/types` from web src).
  Server tsconfig: `"rootDir": ".."`, `"include": ["src", "../shared"]`,
  `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`. Web tsconfig includes `../shared`.

## 2. Directory layout

```
ApplyPilot/
  package.json            (workspaces: server, web; root scripts)
  SPEC.md                 (this file)
  README.md               (setup + daily routine, written for the end user)
  .env.example
  .gitignore              (node_modules, data/, dist/, .env)
  shared/types.ts         (all shared types + enums)
  data/                   (runtime: applypilot.db, uploads/, tailored/)  — gitignored
  server/
    package.json  tsconfig.json
    src/index.ts                 (express app, static web serving in prod, error handler)
    src/config.ts                (paths, port, env, settings loader)
    src/db.ts                    (DatabaseSync open, migrations, typed query helpers)
    src/routes/*.ts              (one router per resource — see §4)
    src/services/resumeParse.ts  (pdf/docx/txt → text)
    src/services/jobFetch.ts     (URL → cleaned posting text + ATS detection + posting id)
    src/services/emailAlerts.ts  (IMAP sweep → job URLs)
    src/services/render.ts       (ResumeDocument → PDF + DOCX files)
    src/services/pipeline.ts     (per-job state machine, calls agents, writes logs)
    src/services/reports.ts      (daily one-liner, weekly numbers)
    src/services/applyAssist.ts  (playwright session manager)
    src/agents/client.ts         (Anthropic client factory, mock switch, run logging)
    src/agents/schemas.ts        (Zod schemas for every agent output)
    src/agents/*.ts              (one file per agent — see §5)
    src/agents/mock.ts           (deterministic mock implementations)
  web/
    package.json  tsconfig.json  vite.config.ts  index.html
    src/main.tsx  src/App.tsx  src/styles.css
    src/api.ts                   (typed fetch wrapper for every endpoint in §4)
    src/components/*.tsx         (Shell/Sidebar, StatusPill, DataTable, Modal, Toast, etc.)
    src/pages/*.tsx              (see §7)
```

## 3. Data model (SQLite, `data/applypilot.db`)

All tables have `id INTEGER PRIMARY KEY AUTOINCREMENT`, `created_at TEXT` (ISO),
`updated_at TEXT`. JSON columns are TEXT holding JSON. Migrations run on startup in `db.ts`
(idempotent `CREATE TABLE IF NOT EXISTS`).

- `settings(key TEXT UNIQUE, value TEXT)` — api key (`anthropic_api_key`), model
  (`model`, default `claude-opus-5-5`), `effort` (default `high`), `auto_submit` ('0'/'1'),
  `imap_host`, `imap_port`, `imap_user`, `imap_password`, `imap_folder`,
  `daily_target` (default 70), `mock_mode` ('auto'|'on'|'off').
- `profile(id=1, facts_json)` — StandingFacts (see shared types): full name, email, phone,
  address, time zone, work authorization answer, sponsorship answer, target titles[],
  location mode (remote|hybrid|onsite|any), regions[], pay floor, desired pay, soonest start,
  EEO answers, screener answers (accommodations, startup experience, years by skill, SMS ok),
  education[], summary.
- `rules(id=1, rules_json)` — Rules: role exclusions[], blacklist titles[], excluded
  companies[], excluded senders/sites[], never-touch-filters note, salary rules, custom
  standing rules[] (free text, each with created date).
- `stories(id, key, title, body, approved INTEGER)` — the six approved stories (+ custom).
- `resumes(id, filename, original_name, mime, text, label, is_base INTEGER, parsed_json,
  skills_json, uploaded_at)` — max 10 rows enforced by API (min 1 to run pipeline; UI nudges
  for 5+). `parsed_json` is a ResumeDocument produced by the ResumeAnalyst agent.
- `experience_bank(id=1, bank_json, built_from_json, built_at)` — merged ExperienceBank.
- `jobs(id, source ('manual'|'url'|'email'|'bulk'), url, title, company, location,
  remote_type, pay_min, pay_max, pay_currency, description_text, parsed_json (JobPosting),
  ats_vendor, posting_id, board, status, status_reason, fit_score, dedupe_key, found_at)`.
  `status` ∈ `new | parsed | qualified | skipped | kit_ready | applied | parked | blocked`.
  `dedupe_key` = lowercase `company|posting_id` if posting_id else `company|title|location`.
- `application_kits(id, job_id UNIQUE, selected_resume_id, selection_json
  (ResumeSelection), tailored_json (ResumeDocument), honesty_json (HonestyReport),
  keyword_json (KeywordCoverage), answers_json (ScreeningAnswer[]), cover_letter,
  pdf_path, docx_path, status ('draft'|'approved'))`.
- `applications(id, job_id, company, title, posting_id, route ('ats'|'site'|'manual'|
  'assist'), resume_file, submitted_at, notes)` — the LEDGER. Only genuine submissions.
- `blocked_items(id, job_id, reason ('captcha'|'identity'|'lever'|'login'|'payment'|
  'other'), action_text, link, resume_file, resolved INTEGER)`.
- `parked_items(id, job_id, reason, retry_plan, resolved INTEGER)`.
- `agent_runs(id, agent, job_id NULL, model, input_tokens, output_tokens, duration_ms,
  ok INTEGER, error, mock INTEGER)` — audit log; powers a token/cost panel.
- `daily_reports(id, date UNIQUE, submitted, total, line_text)`.
- `assist_sessions(id, job_id, status ('starting'|'filling'|'ready_for_review'|
  'submitted'|'failed'|'closed'), field_map_json, log_json, screenshot_path)`.

## 4. REST API (all under `/api`, JSON; errors as `{error: string}` with 4xx/5xx)

Settings & profile
- `GET /settings` → Settings (api key masked as `sk-ant-…last4`, booleans, `mockActive`)
- `PUT /settings` body: partial Settings → Settings
- `POST /settings/test-key` → `{ok, model, message}` (one tiny real call; mock → ok:false w/ reason)
- `GET /profile` → StandingFacts | `PUT /profile` → StandingFacts
- `GET /rules` → Rules | `PUT /rules` → Rules
- `GET /stories` → Story[] | `PUT /stories/:key` body {title, body, approved} → Story
- `POST /intake/suggest` body {resumeIds?} → StandingFacts draft inferred from resumes (agent)

Resumes
- `GET /resumes` → ResumeSummary[] (no full text)
- `POST /resumes` multipart `files[]` (pdf/docx/txt, ≤ 5 MB each) → ResumeSummary[]
  (rejects when total would exceed 10)
- `GET /resumes/:id` → Resume (with text + parsed_json)
- `PATCH /resumes/:id` body {label?, is_base?} → ResumeSummary
- `DELETE /resumes/:id`
- `POST /resumes/:id/analyze` → ResumeDocument (runs ResumeAnalyst, stores parsed_json)
- `POST /resumes/analyze-all` → {analyzed: number}
- `POST /experience-bank/build` → ExperienceBank (runs ExperienceBankBuilder over all parsed)
- `GET /experience-bank` → ExperienceBank | null

Jobs
- `GET /jobs?status=&q=&limit=&offset=` → {items: JobSummary[], total}
- `POST /jobs` body {url?, text?, title?, company?, board?} → Job (fetches URL if given,
  stores description, computes dedupe_key; 409 on duplicate dedupe_key)
- `POST /jobs/bulk` body {urls: string[]} → {created: Job[], duplicates: string[], failed: {url, error}[]}
- `GET /jobs/:id` → JobDetail (job + kit + application + blocked/parked entries)
- `DELETE /jobs/:id`
- `POST /jobs/:id/parse` → Job (JobParser agent → parsed_json, status parsed)
- `POST /jobs/:id/qualify` → Job (Qualifier agent → qualified/skipped + fit_score)
- `POST /jobs/:id/build-kit` → ApplicationKit (ResumeSelector → ResumeTailor → HonestyChecker
  → AnswerWriter; renders PDF/DOCX; status kit_ready)
- `POST /jobs/:id/run` → JobDetail (parse → qualify → build-kit in one call; stops at skip)
- `POST /jobs/run-all` body {statuses?: string[]} → {started: number} (background; progress via
  `GET /jobs/run-status` → {running, done, total, current, errors[]})
- `PUT /jobs/:id/kit` body partial kit (edited tailored_json/answers/cover_letter) → kit (re-renders files)
- `POST /jobs/:id/kit/approve` → kit (status approved)
- `GET /jobs/:id/kit/pdf` / `GET /jobs/:id/kit/docx` → file download
- `POST /jobs/:id/questions` body {questions: string[]} → ScreeningAnswer[] (AnswerWriter for
  ad-hoc questions; merged into kit)
- `POST /jobs/:id/mark-applied` body {route, notes?} → Application (ledger row; status applied)
- `POST /jobs/:id/park` body {reason, retry_plan?} → ParkedItem
- `POST /jobs/:id/block` body {reason, action_text, link?} → BlockedItem

Email alerts
- `POST /email/test` → {ok, message, mailboxCount?}
- `POST /email/sweep` body {sinceDays?: number} → {emailsScanned, urlsFound, jobsCreated: Job[], duplicates: number}

Apply assist (Playwright)
- `GET /assist/status` → {browserInstalled: boolean, active: AssistSession | null}
- `POST /assist/:jobId/start` → AssistSession (launches headed Chromium, navigates, maps & fills, stops at review)
- `GET /assist/:jobId` → AssistSession (with log and screenshot url)
- `POST /assist/:jobId/submit` → AssistSession (clicks submit ONLY if auto_submit setting is on
  or body {confirm: true}; then logs to ledger)
- `POST /assist/:jobId/close` → AssistSession

Logs & reports
- `GET /ledger?limit=&offset=` → {items: Application[], total}
- `GET /blocked` → BlockedItem[] | `POST /blocked/:id/resolve`
- `GET /parked` → ParkedItem[] | `POST /parked/:id/resolve`
- `GET /reports/today` → {date, submitted, total, line: "X today and Y total"}
- `GET /reports/weekly` → {weeks: {weekStart, submitted, interviews}[]} (interviews from
  `applications.notes` containing "interview" OR a manual `POST /reports/interview` {jobId})
- `GET /dashboard` → {today, total, byStatus: Record<status, number>, blockedCount,
  parkedCount, resumesCount, bankBuilt: boolean, mockActive: boolean, tokensToday, recentRuns: AgentRun[]}
- `GET /agent-runs?limit=` → AgentRun[]

## 5. Agents (server/src/agents) — all via `client.messages.parse` + `zodOutputFormat`

Common: `agents/client.ts` exports `runAgent<T>(name, {system, user, schema, jobId?, effort?})`.
It resolves the API key (settings → env), picks mock vs real, calls
`client.messages.parse({ model, max_tokens: 16000, system: [{type:'text', text: system,
cache_control:{type:'ephemeral'}}], messages:[{role:'user', content: user}],
output_config: { effort, format: zodOutputFormat(schema) } })`, checks `stop_reason ===
'refusal'` (throw with explanation), validates `parsed_output`, logs an `agent_runs` row with
usage, and returns the typed object. Omit the `thinking` parameter entirely (Opus 5.5 is
adaptive by default; `disabled` is a 400). Use typed SDK errors (`Anthropic.AuthenticationError`,
`Anthropic.RateLimitError`, `Anthropic.APIError`) — never string-match. Retry once on
RateLimitError after `retry-after`. Never truncate inputs silently; if a prompt exceeds ~150k
chars, throw a clear error. Import: `import Anthropic from "@anthropic-ai/sdk"` and
`import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"`.

Agents (each file exports one async function and its Zod schema lives in `schemas.ts`):

1. **ResumeAnalyst** `analyzeResume(text) → ResumeDocument`
   `{ contact{name,email,phone,location,links[]}, summary, experience[{company,title,start,end,
   location,bullets[]}], education[{school,degree,field,year}], skills[], certifications[],
   projects[{name,description,bullets[]}] }`. Extract only; never embellish.
2. **ExperienceBankBuilder** `buildBank(docs: {resumeId, doc}[]) → ExperienceBank`
   Merges roles across resumes (same company+title → union of bullets, deduped), a master
   skills list with `evidence` (which resume ids/bullets support each skill), education,
   certifications, "strongest results" (quantified bullets). Each bullet keeps
   `sourceResumeIds[]`.
3. **JobParser** `parseJob(text, url?) → JobPosting`
   `{ title, company, location, remoteType('remote'|'hybrid'|'onsite'|'unknown'),
   payMin?, payMax?, payCurrency?, payPeriod?, employmentType, seniority, requiredSkills[],
   niceToHaveSkills[], responsibilities[], keywords[] (ATS keywords, 15–40), yearsExperience?,
   atsVendor ('greenhouse'|'lever'|'workday'|'ashby'|'workable'|'icims'|'smartrecruiters'|
   'bamboohr'|'linkedin'|'indeed'|'other'|'unknown'), postingId?, applyUrl?, screeningQuestions[] }`.
4. **Qualifier** `qualify(job: JobPosting, facts, rules, bank) → Qualification`
   `{ qualifies: boolean, fitScore 0–100, reasons[], blockers[] (hard rule violations:
   location, pay floor, exclusion, blacklist), gaps[] (missing required skills),
   matchedSkills[] }`. Hard rules are ALSO enforced in code in pipeline.ts (belt and braces).
5. **ResumeSelector** `selectResume(job, resumes: {id,label,doc}[]) → ResumeSelection`
   `{ rankings[{resumeId, score 0–100, strengths[], weaknesses[]}], selectedResumeId, rationale }`.
6. **ResumeTailor** `tailorResume(job, baseDoc, bank, facts) → {document: ResumeDocument,
   changes[{type:'added_keyword'|'reordered'|'rephrased'|'added_bullet_from_bank',
   detail, source}], keywordCoverage{covered[], missing[], coveragePct}}`.
   Rules in the system prompt: keep the base resume's roles, dates, employers and numbers
   exactly; you may re-order bullets, add JD keywords where the bank proves the user has the
   skill, pull in bullets from other resumes in the bank for the same employer, rewrite the
   summary to target the role. NEVER invent experience, employers, dates, numbers, degrees or
   certifications. Single-column ATS-safe structure (no tables/graphics implied).
7. **HonestyChecker** `checkHonesty(tailored, bank, baseDoc) → HonestyReport`
   `{ claims[{text, section, supported: boolean, source?: string}], unsupportedCount,
   verdict: 'pass'|'fail' }`. Adversarial: assume claims are unsupported unless found in the
   bank/base. pipeline.ts removes unsupported bullets/skills (or reverts to base bullet) and
   re-runs the check once; the final report is stored and shown in the UI.
8. **AnswerWriter** `writeAnswers(job, facts, rules, stories, questions[], bank) →
   { answers[{question, answer, source: 'facts'|'story:<key>'|'bank'|'rule', needsHuman:
   boolean, humanReason? }], coverLetter }`. Salary, authorization, sponsorship, start date,
   "how did you hear" use the rule table from the playbook. Anything needing SSN/passwords/
   identity → needsHuman true, answer empty.
9. **IntakeSuggester** `suggestFacts(docs) → Partial<StandingFacts>` (prefills the profile
   from resumes; user must confirm).
10. **FormMapper** `mapForm(fields: FormField[], facts, kit, job) → { mappings[{fieldId,
    action:'fill'|'select'|'check'|'upload_resume'|'upload_cover'|'skip'|'needs_human',
    value?, reason?}] }`. Used by applyAssist.

Mock mode (`agents/mock.ts`): returns plausible deterministic data derived from the inputs
(e.g., keyword coverage computed by simple string matching, the first resume selected, the
base document returned as the tailored one with the summary prefixed by the job title).
Mock must satisfy the same Zod schemas.

## 6. Pipeline (services/pipeline.ts)

`runJob(jobId)`:
1. parse (if not parsed) → 2. hard-rule check in code (location mode, pay floor when pay
stated, exclusions/blacklist by title regex, excluded companies, dedupe against ledger +
jobs) → 3. Qualifier → if `!qualifies` set `skipped` with `status_reason` and stop →
4. ResumeSelector over all analyzed resumes (if the bank is missing, build it first) →
5. ResumeTailor → 6. HonestyChecker (+ one repair pass) → 7. AnswerWriter (questions from
the posting + the standard playbook set: desired salary, minimum salary, authorization,
sponsorship, start date, how did you hear, why this company) → 8. render PDF + DOCX to
`data/tailored/<Company>-<Title>-<YYYY-MM-DD>.pdf|.docx` (sanitized filename) → 9. save kit,
status `kit_ready`. Lever postings (`atsVendor === 'lever'` or url contains `jobs.lever.co`)
still get a kit but are auto-added to Blocked with reason `lever` and the direct link, per
the playbook. Each step is wrapped so a failure stores `status_reason` and does not crash the
batch. `runAll` processes sequentially (one at a time) and exposes progress.

## 7. Web UI (pages) — look & feel

Theme: deep navy background `#0b1220`, panel `#121a2b`, border `#1f2a40`, text `#e6edf7`,
muted `#8b9bb4`, accent green `#2ee6a6`, warning amber `#f5b942`, danger `#ff6b6b`. Font:
system UI stack. Left sidebar (logo "ApplyPilot", nav), top bar with the daily report line
("12 today and 148 total") and a Mock-mode badge when active. Everything responsive down to
1024px. Loading and error states on every page. Toasts for actions.

Pages (react-router):
- `/` **Dashboard** — stat tiles (today, total, kits ready, blocked, parked, resumes, bank
  status), status breakdown bar, "Run all new jobs" button with progress, recent agent runs,
  setup checklist (API key, ≥1 resume, bank built, profile, rules, stories) with links.
- `/resumes` **Resumes** — drag-and-drop upload (multi, 5–10 guidance, counter "7 / 10"),
  table (label, file, skills count, analyzed?, base?), actions: set base, relabel, analyze,
  delete; "Analyze all" and "Build experience bank" buttons; bank viewer (roles, skills with
  evidence counts, strongest results).
- `/profile` **Profile & Rules** — tabs: Standing facts (form), Rules (location mode, pay
  floor, exclusions, blacklist, excluded companies, custom standing rules list with add/remove),
  Stories (six templated editors with "approved" toggle). "Suggest from resumes" button.
- `/jobs` **Jobs** — add job (URL / paste text / bulk URLs), email sweep button, filter by
  status, table (company, title, location, pay, fit score, status pill, found date), row
  actions (run, open, delete), bulk "Run selected".
- `/jobs/:id` **Job detail** — posting summary + parsed skills; qualification card (score,
  reasons, blockers, gaps); resume selection rankings; tailored resume editor (sections,
  editable bullets) with keyword coverage chips and the honesty report (claims list with
  sources, unsupported highlighted); answers list (editable, needsHuman flagged); cover letter
  editor; download PDF/DOCX; buttons: Approve kit, Apply with assist, Mark applied (route),
  Park, Block.
- `/apply/:id` **Apply assist** — status timeline, field mapping table (field → value →
  action), log, screenshot, big "I reviewed it — submit" (only when auto_submit off), close.
- `/logs` **Logs** — tabs: Ledger, Blocked (resolve), Parked (resolve), Agent runs (tokens).
- `/settings` **Settings** — API key (masked, test button), model/effort, mock mode, daily
  target, auto-submit toggle with warning text, IMAP alert mailbox (host/port/user/app
  password/folder + test), browser status (installed? + instructions
  `npx playwright install chromium`), data folder path.

## 8. Apply assist (services/applyAssist.ts)

- `playwright` is a normal dependency but browsers are optional; detect with
  `chromium.executablePath()` existence → `browserInstalled`.
- Launch headed (`headless: false`) persistent context at `data/browser-profile` so the
  user's own logins persist between runs (the user signs in manually the first time).
- Navigate to the job's apply URL; wait for network idle; collect form fields: inputs,
  textareas, selects, file inputs, radio/checkbox groups — with label text (via `<label for>`,
  aria-label, placeholder, nearest text), name, id, type, options, required.
- Call FormMapper; execute mappings (fill/select/check/upload file from kit). Log each.
- Detect CAPTCHA iframes (`recaptcha`, `hcaptcha`, `turnstile`) → status `ready_for_review`
  with a note that a human must solve it; never attempt to solve.
- Stop at `ready_for_review`; take a screenshot to `data/screenshots/<jobId>.png`.
- `submit` clicks the button whose text matches /submit|apply|send application/i only when
  allowed; then waits 5s, screenshots, logs ledger row with route `assist`.
- Only one active session at a time.

## 9. Email alert sweep (services/emailAlerts.ts)

IMAP via `imapflow` using an app password the user enters in Settings (document that Gmail
needs an App Password; never ask to lower account security). Search messages since N days
from known alert senders (linkedin, indeed, glassdoor, ziprecruiter, builtin, dice, wellfound,
jobright, roberthalf, jobtarget, monster, careerbuilder) OR subject matching /job|alert|
opportunit/i. Extract http(s) links, keep those that look like postings (host allowlist +
path heuristics), normalize tracking params, de-dupe, create jobs with `source: 'email'`
(fetch each URL through jobFetch; failures recorded). Return summary.

## 10. Job fetch (services/jobFetch.ts)

`fetch` with a desktop UA, 15s timeout; cheerio: drop script/style/nav/footer; prefer
`<main>`/`article`/elements with id/class containing `job|posting|description`; collapse
whitespace; detect ATS vendor from hostname; extract posting id (last path segment with
digits/uuid, or `jk=`/`currentJobId=` query params); extract JSON-LD `JobPosting` when
present (title, hiringOrganization.name, jobLocation, baseSalary). Return
`{text, title?, company?, location?, atsVendor, postingId?, applyUrl, raw: html length}`.
If the page is a JS shell (< 400 chars of text), return `needsManualPaste: true`.

## 11. Rendering (services/render.ts)

`renderPdf(doc: ResumeDocument, outPath)` with pdfkit: Letter, 0.6in margins, Helvetica,
name 18pt bold, contact line 9.5pt, section headings 11pt bold uppercase with a thin rule,
bullets as real "•" characters in a single column. `renderDocx(doc, outPath)` with `docx`
mirroring the same structure. Deterministic; no graphics/tables.

## 12. Testing & verification

- `server`: `npm run typecheck` must pass. `node --test` smoke tests in `server/test/*.test.ts`
  run via `tsx --test` for: db migrations, hard-rule checks, dedupe key, jobFetch HTML
  cleaning (fixture), render produces non-empty PDF/DOCX, mock agents satisfy schemas.
- `web`: `npm run build` must pass (tsc + vite).
- Root `npm run verify` = typecheck + tests + web build.

## 13. Conventions

- Zod schemas are the single source of truth for agent outputs; `shared/types.ts` mirrors
  them (export `z.infer` types from `schemas.ts` only on the server; web uses the handwritten
  mirrors in `shared/types.ts` — keep them identical).
- Every route validates input with zod; respond `400` with the issue summary.
- Secrets never leave the server (API key masked in GET /settings, IMAP password never returned).
- Filenames sanitized: `[^A-Za-z0-9._-]` → `_`, max 80 chars.
- Dates stored ISO 8601 UTC; displayed local.
- No `console.log` spam; a small `log(level, msg, meta?)` helper.
- Windows host: use `path.join`, never hardcode `/`. The PATH for child shells may not include
  Node; agents should invoke `"C:\Program Files\nodejs\npm.cmd"` / `node.exe` by full path if
  `npm` is not found.
