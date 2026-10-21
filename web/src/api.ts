import type {
  AgentRun, Application, ApplicationKit, AssistSession, AssistStatusResponse, BlockedItem,
  BulkAddResult, DashboardData, DailyReport, ExperienceBank, IntakeSuggestion, Job, JobCreateInput,
  JobDetail, JobListResponse, JobStatus, KitUpdate, LedgerResponse, ParkedItem, ParkInput,
  Resume, ResumeSummary, ResumeUpdate, RunStatus, ScreeningAnswer, Settings, SettingsUpdate, StandingFacts,
  Rules, Story, StoryUpdate, TestKeyResult, WeeklyReport,
} from "../../shared/types";
import { getAccessToken } from "./auth";

function apiRoot(): string {
  const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim();
  if (!configuredBase) return "/api";

  let url: URL;
  try {
    url = new URL(configuredBase);
  } catch {
    throw new Error("VITE_API_BASE_URL must be an absolute HTTP(S) URL.");
  }
  const localHttp = import.meta.env.DEV &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("VITE_API_BASE_URL must use HTTPS (HTTP is allowed only for local development).");
  }
  const basePath = url.pathname.replace(/\/+$/, "");
  if (basePath.endsWith("/api")) return `${url.origin}${basePath}`;
  return `${url.origin}${basePath}/api`;
}

const API_ROOT = apiRoot();

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const accessToken = await getAccessToken();
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, { ...init, headers });
  } catch {
    throw new Error("Could not reach ApplyPilot. Check that the local server is running.");
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status message when the server response is not JSON.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (method: string, value?: unknown): RequestInit => ({
  method,
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
const idPath = (id: number) => `/${id}`;

export const api = {
  dashboard: () => request<DashboardData>("/dashboard"),
  report: () => request<DailyReport>("/reports/today"),
  weekly: () => request<WeeklyReport>("/reports/weekly"),
  recordInterview: (jobId: number) => request<{ ok: boolean }>("/reports/interview", json("POST", { jobId })),
  settings: () => request<Settings>("/settings"),
  updateSettings: (value: SettingsUpdate) => request<Settings>("/settings", json("PUT", value)),
  testKey: () => request<TestKeyResult>("/settings/test-key", json("POST")),
  profile: () => request<StandingFacts>("/profile"),
  saveProfile: (value: StandingFacts) => request<StandingFacts>("/profile", json("PUT", value)),
  rules: () => request<Rules>("/rules"),
  saveRules: (value: Rules) => request<Rules>("/rules", json("PUT", value)),
  stories: () => request<Story[]>("/stories"),
  saveStory: (key: string, value: StoryUpdate) =>
    request<Story>(`/stories/${encodeURIComponent(key)}`, json("PUT", value)),
  suggest: (resumeIds?: number[]) =>
    request<IntakeSuggestion>("/intake/suggest", json("POST", { resumeIds })),
  resumes: () => request<ResumeSummary[]>("/resumes"),
  resume: (id: number) => request<Resume>(`/resumes${idPath(id)}`),
  upload: (files: File[]) => {
    const data = new FormData();
    files.forEach((file) => data.append("files[]", file));
    return request<ResumeSummary[]>("/resumes", { method: "POST", body: data });
  },
  updateResume: (id: number, value: ResumeUpdate) =>
    request<ResumeSummary>(`/resumes${idPath(id)}`, json("PATCH", value)),
  deleteResume: (id: number) => request<void>(`/resumes${idPath(id)}`, { method: "DELETE" }),
  analyzeResume: (id: number) => request(`/resumes${idPath(id)}/analyze`, json("POST")),
  analyzeAll: () => request<{ analyzed: number }>("/resumes/analyze-all", json("POST")),
  buildBank: () => request<ExperienceBank>("/experience-bank/build", json("POST")),
  bank: () => request<ExperienceBank | null>("/experience-bank"),
  jobs: (query = "") => request<JobListResponse>(`/jobs${query}`),
  addJob: (value: JobCreateInput) => request<Job>("/jobs", json("POST", value)),
  bulkJobs: (urls: string[]) => request<BulkAddResult>("/jobs/bulk", json("POST", { urls })),
  deleteJob: (id: number) => request<void>(`/jobs${idPath(id)}`, { method: "DELETE" }),
  job: (id: number) => request<JobDetail>(`/jobs${idPath(id)}`),
  parseJob: (id: number) => request<Job>(`/jobs${idPath(id)}/parse`, json("POST")),
  qualifyJob: (id: number) => request<Job>(`/jobs${idPath(id)}/qualify`, json("POST")),
  buildKit: (id: number) => request<ApplicationKit>(`/jobs${idPath(id)}/build-kit`, json("POST")),
  runJob: (id: number) => request<JobDetail>(`/jobs${idPath(id)}/run`, json("POST")),
  runAll: (statuses?: JobStatus[]) => request<{ started: number }>("/jobs/run-all", json("POST", { statuses })),
  runStatus: () => request<RunStatus>("/jobs/run-status"),
  saveKit: (id: number, value: KitUpdate) => request<ApplicationKit>(`/jobs${idPath(id)}/kit`, json("PUT", value)),
  approveKit: (id: number) => request<ApplicationKit>(`/jobs${idPath(id)}/kit/approve`, json("POST")),
  questions: (id: number, questions: string[]) =>
    request<ScreeningAnswer[]>(`/jobs${idPath(id)}/questions`, json("POST", { questions })),
  markApplied: (id: number, route: string, notes?: string) =>
    request<Application>(`/jobs${idPath(id)}/mark-applied`, json("POST", { route, notes })),
  parkJob: (id: number, reason: string, retry_plan?: string) =>
    request<ParkedItem>(`/jobs${idPath(id)}/park`, json("POST", { reason, retry_plan } satisfies ParkInput)),
  blockJob: (id: number, reason: string, action_text: string, link?: string) =>
    request(`/jobs${idPath(id)}/block`, json("POST", { reason, action_text, link })),
  assistStatus: () => request<AssistStatusResponse>("/assist/status"),
  assist: (id: number) => request<AssistSession | null>(`/assist${idPath(id)}`),
  startAssist: (id: number) => request<AssistSession>(`/assist${idPath(id)}/start`, json("POST")),
  submitAssist: (id: number) => request<AssistSession>(`/assist${idPath(id)}/submit`, json("POST", { confirm: true })),
  closeAssist: (id: number) => request<AssistSession>(`/assist${idPath(id)}/close`, json("POST")),
  ledger: () => request<LedgerResponse>("/ledger"),
  blocked: () => request<BlockedItem[]>("/blocked"),
  resolveBlocked: (id: number) => request<void>(`/blocked${idPath(id)}/resolve`, json("POST")),
  parked: () => request<ParkedItem[]>("/parked"),
  resolveParked: (id: number) => request<void>(`/parked${idPath(id)}/resolve`, json("POST")),
  runs: () => request<AgentRun[]>("/agent-runs"),
  emailTest: () => request<{ ok: boolean; message: string; mailboxCount?: number }>("/email/test", json("POST")),
  emailSweep: (sinceDays = 7) =>
    request<{ emailsScanned: number; urlsFound: number; jobsCreated: Job[]; duplicates: number }>("/email/sweep", json("POST", { sinceDays })),
};

export async function download(path: string, filename: string): Promise<void> {
  const headers = new Headers();
  const accessToken = await getAccessToken();
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${API_ROOT}${path}`, { headers });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const downloadKitPdf = (id: number, filename: string) =>
  download(`/jobs/${id}/kit/pdf`, filename);
export const downloadKitDocx = (id: number, filename: string) =>
  download(`/jobs/${id}/kit/docx`, filename);
