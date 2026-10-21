/**
 * ApplyPilot shared types (SPEC §3–§5).
 *
 * Imported by the server as `../../shared/types.js` (NodeNext) and by the web app as
 * `../../shared/types`. These are handwritten mirrors of the Zod schemas in
 * `server/src/agents/schemas.ts`; keep them identical.
 */

// ---------------------------------------------------------------------------
// Enumerations / unions
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
  "new",
  "parsed",
  "qualified",
  "skipped",
  "kit_ready",
  "applied",
  "parked",
  "blocked",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_SOURCES = ["manual", "url", "email", "bulk"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export const REMOTE_TYPES = ["remote", "hybrid", "onsite", "unknown"] as const;
export type RemoteType = (typeof REMOTE_TYPES)[number];

export const LOCATION_MODES = ["remote", "hybrid", "onsite", "any"] as const;
export type LocationMode = (typeof LOCATION_MODES)[number];

export const ATS_VENDORS = [
  "greenhouse",
  "lever",
  "workday",
  "ashby",
  "workable",
  "icims",
  "smartrecruiters",
  "bamboohr",
  "linkedin",
  "indeed",
  "other",
  "unknown",
] as const;
export type AtsVendor = (typeof ATS_VENDORS)[number];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const MOCK_MODES = ["auto", "on", "off"] as const;
export type MockMode = (typeof MOCK_MODES)[number];

export const APPLICATION_ROUTES = ["ats", "site", "manual", "assist"] as const;
export type ApplicationRoute = (typeof APPLICATION_ROUTES)[number];

export const BLOCK_REASONS = ["captcha", "identity", "lever", "login", "payment", "other"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export const KIT_STATUSES = ["draft", "approved"] as const;
export type KitStatus = (typeof KIT_STATUSES)[number];

export const ASSIST_STATUSES = [
  "starting",
  "filling",
  "ready_for_review",
  "submitted",
  "failed",
  "closed",
] as const;
export type AssistStatus = (typeof ASSIST_STATUSES)[number];

export const PAY_PERIODS = ["year", "month", "hour", "day", "unknown"] as const;
export type PayPeriod = (typeof PAY_PERIODS)[number];

export const AGENT_NAMES = [
  "ResumeAnalyst",
  "ExperienceBankBuilder",
  "JobParser",
  "Qualifier",
  "ResumeSelector",
  "ResumeTailor",
  "HonestyChecker",
  "AnswerWriter",
  "IntakeSuggester",
  "FormMapper",
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** What GET /settings returns. Secrets are masked / reduced to booleans. */
export interface Settings {
  /** `sk-ant-…last4` or empty string when no key is saved. */
  anthropicApiKeyMasked: string;
  /** True when a key is saved in Settings OR present in the environment. */
  hasApiKey: boolean;
  /** Where the active key comes from. */
  apiKeySource: "settings" | "env" | "none";
  model: string;
  effort: Effort;
  autoSubmit: boolean;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  /** The IMAP password itself is never returned. */
  imapPasswordSet: boolean;
  imapFolder: string;
  dailyTarget: number;
  mockMode: MockMode;
  /** Resolved: true when agents will run in mock mode right now. */
  mockActive: boolean;
  /** Absolute path of the data folder (shown in Settings). */
  dataDir: string;
  /** Whether Playwright's Chromium is installed. */
  browserInstalled: boolean;
}

/** Body of PUT /settings. Every field optional; secrets are write-only. */
export interface SettingsUpdate {
  anthropicApiKey?: string;
  model?: string;
  effort?: Effort;
  autoSubmit?: boolean;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;
  imapFolder?: string;
  dailyTarget?: number;
  mockMode?: MockMode;
}

export interface TestKeyResult {
  ok: boolean;
  model: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Profile: standing facts, rules, stories
// ---------------------------------------------------------------------------

export interface EducationEntry {
  school: string;
  degree: string;
  field: string;
  year: string;
}

export interface EeoAnswers {
  gender: string;
  race: string;
  veteranStatus: string;
  disabilityStatus: string;
}

export interface ScreenerAnswers {
  /** Answer to "do you need accommodations?" */
  accommodations: string;
  /** Answer to "do you have startup experience?" */
  startupExperience: string;
  /** Years of experience per skill, e.g. { "HubSpot": 4 }. */
  yearsBySkill: Record<string, number>;
  /** OK to receive SMS from recruiters? */
  smsOk: boolean;
}

export interface StandingFacts {
  fullName: string;
  email: string;
  phone: string;
  address: string;
  timeZone: string;
  /** Verbatim answer to the work-authorization question. */
  workAuthorization: string;
  /** Verbatim answer to the sponsorship question. */
  sponsorshipAnswer: string;
  requiresSponsorship: boolean;
  targetTitles: string[];
  locationMode: LocationMode;
  /** Regions/states/countries the user will work in (when not fully remote). */
  regions: string[];
  /** Hard minimum annual base pay; null = none stated. */
  payFloor: number | null;
  desiredPay: number | null;
  payCurrency: string;
  /** Verbatim answer to "soonest start date". */
  soonestStart: string;
  /** Verbatim answer to "how did you hear about this job". */
  howDidYouHear: string;
  linkedinUrl: string;
  portfolioUrl: string;
  eeo: EeoAnswers;
  screeners: ScreenerAnswers;
  education: EducationEntry[];
  summary: string;
}

export interface SalaryRules {
  /** Below this annual figure the job is skipped when pay is stated. */
  floor: number | null;
  desired: number | null;
  currency: string;
  /** How to answer "desired salary": a range, a single number, or decline politely. */
  answerStyle: "range" | "single" | "decline";
  negotiable: boolean;
}

export interface CustomRule {
  text: string;
  createdAt: string;
}

export interface Rules {
  /** Role families to never apply to (matched as regex/substring against titles). */
  roleExclusions: string[];
  /** Exact-ish title fragments that disqualify a posting. */
  blacklistTitles: string[];
  excludedCompanies: string[];
  /** Email senders / sites to ignore during sweeps. */
  excludedSenders: string[];
  /** Playbook rule: never touch the user's own job-board filters. */
  neverTouchFiltersNote: string;
  salary: SalaryRules;
  customRules: CustomRule[];
}

export const STORY_KEYS = [
  "outside_work",
  "planning_to_execution",
  "pipeline_built",
  "team_built",
  "case_study",
  "why_company",
] as const;
export type StoryKey = (typeof STORY_KEYS)[number];

export interface Story {
  id?: number;
  key: string;
  title: string;
  body: string;
  approved: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface StoryUpdate {
  title: string;
  body: string;
  approved: boolean;
}

/** Output of IntakeSuggester; the user must confirm before it is saved. */
export type IntakeSuggestion = Partial<StandingFacts>;

// ---------------------------------------------------------------------------
// Resumes & experience bank
// ---------------------------------------------------------------------------

export interface ResumeContact {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: string[];
}

export interface ResumeExperience {
  company: string;
  title: string;
  start: string;
  end: string;
  location: string;
  bullets: string[];
}

export interface ResumeEducation {
  school: string;
  degree: string;
  field: string;
  year: string;
}

export interface ResumeProject {
  name: string;
  description: string;
  bullets: string[];
}

/** Structured resume produced by ResumeAnalyst and edited by ResumeTailor. */
export interface ResumeDocument {
  contact: ResumeContact;
  summary: string;
  experience: ResumeExperience[];
  education: ResumeEducation[];
  skills: string[];
  certifications: string[];
  projects: ResumeProject[];
}

export interface ResumeSummary {
  id: number;
  label: string;
  originalName: string;
  mime: string;
  isBase: boolean;
  analyzed: boolean;
  skills: string[];
  skillsCount: number;
  textLength: number;
  uploadedAt: string;
}

export interface Resume extends ResumeSummary {
  filename: string;
  text: string;
  parsed: ResumeDocument | null;
}

export interface ResumeUpdate {
  label?: string;
  is_base?: boolean;
}

export interface BankBullet {
  text: string;
  sourceResumeIds: number[];
  /** True when the bullet contains a number / percentage / currency figure. */
  quantified: boolean;
}

export interface BankRole {
  company: string;
  title: string;
  start: string;
  end: string;
  location: string;
  bullets: BankBullet[];
  sourceResumeIds: number[];
}

export interface BankSkillEvidence {
  resumeId: number;
  /** The bullet (or section text) that proves the skill. */
  bullet: string;
}

export interface BankSkill {
  name: string;
  evidence: BankSkillEvidence[];
}

export interface ExperienceBank {
  roles: BankRole[];
  skills: BankSkill[];
  education: ResumeEducation[];
  certifications: string[];
  /** Quantified bullets, best first. */
  strongestResults: BankBullet[];
  builtFromResumeIds: number[];
  builtAt: string;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobPosting {
  title: string;
  company: string;
  location: string;
  remoteType: RemoteType;
  payMin?: number;
  payMax?: number;
  payCurrency?: string;
  payPeriod?: PayPeriod;
  employmentType: string;
  seniority: string;
  requiredSkills: string[];
  niceToHaveSkills: string[];
  responsibilities: string[];
  /** ATS keywords, 15–40. */
  keywords: string[];
  yearsExperience?: number;
  atsVendor: AtsVendor;
  postingId?: string;
  applyUrl?: string;
  screeningQuestions: string[];
}

export interface JobSummary {
  id: number;
  source: JobSource;
  url: string | null;
  title: string;
  company: string;
  location: string;
  remoteType: RemoteType;
  payMin: number | null;
  payMax: number | null;
  payCurrency: string | null;
  atsVendor: AtsVendor;
  postingId: string | null;
  board: string | null;
  status: JobStatus;
  statusReason: string | null;
  fitScore: number | null;
  foundAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Job extends JobSummary {
  descriptionText: string;
  parsed: JobPosting | null;
  qualification: Qualification | null;
  dedupeKey: string;
}

export interface JobCreateInput {
  url?: string;
  text?: string;
  title?: string;
  company?: string;
  board?: string;
}

export interface JobListQuery {
  status?: JobStatus | "";
  q?: string;
  limit?: number;
  offset?: number;
}

export interface JobListResponse {
  items: JobSummary[];
  total: number;
}

export interface JobDetail {
  job: Job;
  kit: ApplicationKit | null;
  application: Application | null;
  blocked: BlockedItem[];
  parked: ParkedItem[];
}

export interface Qualification {
  qualifies: boolean;
  fitScore: number;
  reasons: string[];
  /** Hard rule violations: location, pay floor, exclusion, blacklist. */
  blockers: string[];
  /** Missing required skills. */
  gaps: string[];
  matchedSkills: string[];
}

export interface ResumeRanking {
  resumeId: number;
  score: number;
  strengths: string[];
  weaknesses: string[];
}

export interface ResumeSelection {
  rankings: ResumeRanking[];
  selectedResumeId: number;
  rationale: string;
}

export const TAILOR_CHANGE_TYPES = [
  "added_keyword",
  "reordered",
  "rephrased",
  "added_bullet_from_bank",
] as const;
export type TailorChangeType = (typeof TAILOR_CHANGE_TYPES)[number];

export interface TailorChange {
  type: TailorChangeType;
  detail: string;
  /** Where the fact came from (resume id / bank role / base bullet). */
  source: string;
}

export interface KeywordCoverage {
  covered: string[];
  missing: string[];
  coveragePct: number;
}

export interface TailorResult {
  document: ResumeDocument;
  changes: TailorChange[];
  keywordCoverage: KeywordCoverage;
}

export interface HonestyClaim {
  text: string;
  section: string;
  supported: boolean;
  source?: string;
}

export interface HonestyReport {
  claims: HonestyClaim[];
  unsupportedCount: number;
  verdict: "pass" | "fail";
}

/** `facts`, `rule`, `bank`, or `story:<key>`. */
export type AnswerSource = "facts" | "bank" | "rule" | `story:${string}`;

export interface ScreeningAnswer {
  question: string;
  answer: string;
  source: AnswerSource;
  needsHuman: boolean;
  humanReason?: string;
}

export interface AnswerResult {
  answers: ScreeningAnswer[];
  coverLetter: string;
}

export interface ApplicationKit {
  id: number;
  jobId: number;
  selectedResumeId: number | null;
  selection: ResumeSelection | null;
  tailored: ResumeDocument | null;
  honesty: HonestyReport | null;
  keywords: KeywordCoverage | null;
  answers: ScreeningAnswer[];
  coverLetter: string;
  pdfPath: string | null;
  docxPath: string | null;
  status: KitStatus;
  createdAt: string;
  updatedAt: string;
}

/** Body of PUT /jobs/:id/kit. */
export interface KitUpdate {
  tailored?: ResumeDocument;
  answers?: ScreeningAnswer[];
  coverLetter?: string;
}

export interface Application {
  id: number;
  jobId: number;
  company: string;
  title: string;
  postingId: string | null;
  route: ApplicationRoute;
  resumeFile: string | null;
  submittedAt: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarkAppliedInput {
  route: ApplicationRoute;
  notes?: string;
}

export interface BlockedItem {
  id: number;
  jobId: number;
  reason: BlockReason;
  actionText: string;
  link: string | null;
  resumeFile: string | null;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  /** Joined from jobs for display. */
  company?: string;
  title?: string;
}

export interface BlockInput {
  reason: BlockReason;
  action_text: string;
  link?: string;
}

export interface ParkedItem {
  id: number;
  jobId: number;
  reason: string;
  retryPlan: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  company?: string;
  title?: string;
}

export interface ParkInput {
  reason: string;
  retry_plan?: string;
}

export interface BulkAddResult {
  created: Job[];
  duplicates: string[];
  failed: { url: string; error: string }[];
}

export interface RunStatus {
  running: boolean;
  done: number;
  total: number;
  current: { jobId: number; title: string; company: string } | null;
  errors: { jobId: number; error: string }[];
}

export interface RunAllInput {
  statuses?: JobStatus[];
}

/** Result of services/jobFetch.ts (SPEC §10). */
export interface JobFetchResult {
  text: string;
  title?: string;
  company?: string;
  location?: string;
  atsVendor: AtsVendor;
  postingId?: string;
  applyUrl: string;
  /** Length of the raw HTML. */
  raw: number;
  needsManualPaste?: boolean;
}

// ---------------------------------------------------------------------------
// Email alerts
// ---------------------------------------------------------------------------

export interface EmailTestResult {
  ok: boolean;
  message: string;
  mailboxCount?: number;
}

export interface EmailSweepInput {
  sinceDays?: number;
}

export interface EmailSweepResult {
  emailsScanned: number;
  urlsFound: number;
  jobsCreated: Job[];
  duplicates: number;
  /** URLs that could not be fetched/created. */
  failed: { url: string; error: string }[];
}

// ---------------------------------------------------------------------------
// Apply assist
// ---------------------------------------------------------------------------

export const FORM_FIELD_TYPES = [
  "text",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "textarea",
  "select",
  "file",
  "radio",
  "checkbox",
  "password",
  "hidden",
  "other",
] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormField {
  /** Stable id assigned by applyAssist (e.g. `f12`). */
  id: string;
  name: string;
  domId: string;
  label: string;
  type: FormFieldType;
  options: string[];
  required: boolean;
  placeholder: string;
}

export const FORM_ACTIONS = [
  "fill",
  "select",
  "check",
  "upload_resume",
  "upload_cover",
  "skip",
  "needs_human",
] as const;
export type FormAction = (typeof FORM_ACTIONS)[number];

export interface FormMapping {
  fieldId: string;
  action: FormAction;
  value?: string;
  reason?: string;
}

export interface FormMapResult {
  mappings: FormMapping[];
}

export interface AssistLogEntry {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface AssistSession {
  id: number;
  jobId: number;
  status: AssistStatus;
  fields: FormField[];
  mappings: FormMapping[];
  log: AssistLogEntry[];
  screenshotPath: string | null;
  /** URL the web app can load the screenshot from, when one exists. */
  screenshotUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistStatusResponse {
  browserInstalled: boolean;
  active: AssistSession | null;
}

export interface AssistSubmitInput {
  confirm?: boolean;
}

// ---------------------------------------------------------------------------
// Logs, reports, dashboard
// ---------------------------------------------------------------------------

export interface AgentRun {
  id: number;
  agent: string;
  jobId: number | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
  mock: boolean;
  createdAt: string;
}

export interface LedgerResponse {
  items: Application[];
  total: number;
}

export interface DailyReport {
  date: string;
  submitted: number;
  total: number;
  /** "X today and Y total" */
  line: string;
}

export interface WeeklyReportWeek {
  weekStart: string;
  submitted: number;
  interviews: number;
}

export interface WeeklyReport {
  weeks: WeeklyReportWeek[];
}

export interface DashboardData {
  today: number;
  total: number;
  byStatus: Record<JobStatus, number>;
  blockedCount: number;
  parkedCount: number;
  resumesCount: number;
  bankBuilt: boolean;
  mockActive: boolean;
  tokensToday: number;
  recentRuns: AgentRun[];
}

export interface ApiErrorBody {
  error: string;
}

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "high";
export const DEFAULT_DAILY_TARGET = 70;
export const MAX_RESUMES = 10;
export const RECOMMENDED_MIN_RESUMES = 5;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const DEFAULT_STANDING_FACTS: StandingFacts = {
  fullName: "",
  email: "",
  phone: "",
  address: "",
  timeZone: "America/New_York",
  workAuthorization: "Yes, I am authorized to work in the United States for any employer.",
  sponsorshipAnswer: "No, I will not now or in the future require sponsorship.",
  requiresSponsorship: false,
  targetTitles: [],
  locationMode: "remote",
  regions: [],
  payFloor: null,
  desiredPay: null,
  payCurrency: "USD",
  soonestStart: "Two weeks from offer acceptance.",
  howDidYouHear: "Job board / online search.",
  linkedinUrl: "",
  portfolioUrl: "",
  eeo: {
    gender: "Decline to self-identify",
    race: "Decline to self-identify",
    veteranStatus: "I am not a protected veteran",
    disabilityStatus: "I do not want to answer",
  },
  screeners: {
    accommodations: "No accommodations needed.",
    startupExperience: "",
    yearsBySkill: {},
    smsOk: true,
  },
  education: [],
  summary: "",
};

export const DEFAULT_RULES: Rules = {
  roleExclusions: [],
  blacklistTitles: [],
  excludedCompanies: [],
  excludedSenders: [],
  neverTouchFiltersNote:
    "Never change the job-alert filters or saved searches on any job board. Only read what they send.",
  salary: {
    floor: null,
    desired: null,
    currency: "USD",
    answerStyle: "range",
    negotiable: true,
  },
  customRules: [],
};

/** The six playbook story templates; the user edits and approves each one. */
export const DEFAULT_STORIES: Story[] = [
  {
    key: "outside_work",
    title: "Something I do outside of work",
    approved: false,
    body:
      "Outside of work I [hobby or pursuit, e.g. coach a youth soccer team / run a small " +
      "newsletter / restore vintage bikes]. I started it because [why it matters to you]. " +
      "It keeps me [quality the hobby builds, e.g. patient, curious, disciplined], which shows " +
      "up at work when [concrete example of that quality on the job].",
  },
  {
    key: "planning_to_execution",
    title: "Taking a project from planning to execution",
    approved: false,
    body:
      "At [Company] I owned [project] from the first planning conversation through launch. " +
      "The goal was [measurable goal]. I started by [how you scoped it: stakeholders, " +
      "requirements, timeline], then [how you ran it: milestones, tooling, who did what]. " +
      "When [the obstacle that came up], I [what you changed]. We shipped [when] and the " +
      "result was [quantified outcome].",
  },
  {
    key: "pipeline_built",
    title: "A pipeline or system I built",
    approved: false,
    body:
      "At [Company] the [process] was [the painful before state: manual, slow, error-prone]. " +
      "I built [the pipeline/system: tools, integrations, automation] so that [what it does " +
      "end to end]. It took [timeframe] and involved [teams/tools]. Afterwards " +
      "[quantified improvement: time saved, volume handled, error rate], and it is still " +
      "running today / became the standard for [scope].",
  },
  {
    key: "team_built",
    title: "A team I built or grew",
    approved: false,
    body:
      "At [Company] I [hired / assembled / grew] a team of [N] [roles] to [mission]. I " +
      "[how you hired or chose people, how you onboarded them, how you set expectations]. " +
      "The hardest part was [the challenge] and I handled it by [what you did]. Within " +
      "[timeframe] the team delivered [quantified outcome] and [retention/promotion/" +
      "what happened to the people].",
  },
  {
    key: "case_study",
    title: "Case study: a result I am proudest of",
    approved: false,
    body:
      "Situation: [Company, team, the problem in one sentence]. Task: I was responsible for " +
      "[your charge]. Action: I [the 2–4 specific things you did, including tools and " +
      "decisions]. Result: [the quantified outcome: revenue, pipeline, conversion, cost, time]. " +
      "What I learned: [one honest lesson].",
  },
  {
    key: "why_company",
    title: "Why this company (template)",
    approved: false,
    body:
      "I am drawn to [Company] because [one specific thing about the product, customers, or " +
      "mission that genuinely interests you]. In my work at [Previous Company] I " +
      "[the closest thing you did to what this role needs], and I want to bring that to a " +
      "team that [what the posting says the team is doing]. Specifically, [one sentence tying " +
      "a requirement in the posting to a result on your resume].",
  },
];

/** The playbook's standard screening questions, always answered in every kit. */
export const STANDARD_QUESTIONS: readonly string[] = [
  "What is your desired salary?",
  "What is your minimum acceptable salary?",
  "Are you legally authorized to work in the country where this job is located?",
  "Will you now or in the future require sponsorship for employment visa status?",
  "What is the soonest date you could start?",
  "How did you hear about this job?",
  "Why do you want to work at this company?",
];

/** Empty byStatus map helper so UI code never has to guard keys. */
export function emptyStatusCounts(): Record<JobStatus, number> {
  const out = {} as Record<JobStatus, number>;
  for (const s of JOB_STATUSES) out[s] = 0;
  return out;
}
