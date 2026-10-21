import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Link, NavLink, Route, Routes, useLocation, useNavigate, useParams,
} from "react-router-dom";
import {
  DEFAULT_RULES, DEFAULT_STANDING_FACTS, DEFAULT_STORIES, JOB_STATUSES, MAX_RESUMES,
  RECOMMENDED_MIN_RESUMES, STORY_KEYS,
} from "../../shared/types";
import type {
  AgentRun, ApplicationKit, AssistSession, BlockedItem, DashboardData, ExperienceBank, JobDetail,
  ParkedItem, ResumeDocument, ResumeSummary, Rules, Settings, SettingsUpdate,
  StandingFacts, Story,
} from "../../shared/types";
import { api, downloadKitDocx, downloadKitPdf } from "./api";

type ToastMessage = { id: number; message: string; kind: "success" | "error" | "info" };
const NAV = [
  { to: "/", label: "Overview", icon: "◈", end: true },
  { to: "/resumes", label: "Resumes", icon: "▤" },
  { to: "/profile", label: "Profile & rules", icon: "◎" },
  { to: "/jobs", label: "Jobs", icon: "⌕" },
  { to: "/logs", label: "Activity & logs", icon: "≋" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export default function App() {
  const location = useLocation();
  const [report, setReport] = useState<{ line: string } | null>(null);
  const [mock, setMock] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const notify = useCallback((message: string, kind: ToastMessage["kind"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, kind }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4200);
  }, []);
  useEffect(() => {
    api.report().then(setReport).catch(() => setReport({ line: "Your daily report will appear here" }));
  }, [location.pathname]);
  useEffect(() => {
    api.settings().then((value) => setMock(value.mockActive)).catch(() => undefined);
  }, []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/"><span className="brand-mark">A</span><span>Apply<span className="accent">Pilot</span><small>YOUR JOB SEARCH, IN CONTROL</small></span></Link>
        <div className="nav-label">WORKSPACE</div>
        <nav className="nav-list">
          {NAV.map((item) => <NavLink key={item.to} end={item.end} to={item.to} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}><span className="nav-icon">{item.icon}</span>{item.label}</NavLink>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card"><span className="privacy-icon">⌑</span><strong>Local by design</strong><p>Your profile, resumes, and application data stay on this machine.</p></div>
          <div className="user-chip"><div className="avatar">AP</div><div><strong>Personal workspace</strong><span>Local instance</span></div><span className="online-dot" /></div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-sep">/</span><strong>{NAV.find((item) => item.to === window.location.pathname)?.label ?? "ApplyPilot"}</strong></div>
          <div className="topbar-actions"><span className="daily-line"><span className="daily-dot" />{report?.line ?? "Loading daily report…"}</span>{mock && <span className="badge badge-amber">✦ Mock mode</span>}<Link className="avatar top-avatar" to="/settings">AP</Link></div>
        </header>
        <div className="page-content">
          <Routes>
            <Route path="/" element={<Dashboard notify={notify} />} />
            <Route path="/resumes" element={<ResumesPage notify={notify} />} />
            <Route path="/profile" element={<ProfilePage notify={notify} />} />
            <Route path="/jobs" element={<JobsPage notify={notify} />} />
            <Route path="/jobs/:id" element={<JobPage notify={notify} />} />
            <Route path="/apply/:id" element={<ApplyPage notify={notify} />} />
            <Route path="/logs" element={<LogsPage notify={notify} />} />
            <Route path="/settings" element={<SettingsPage notify={notify} />} />
            <Route path="*" element={<EmptyState title="Page not found" detail="The page you requested does not exist." action={<Link className="button button-primary" to="/">Back to overview</Link>} />} />
          </Routes>
        </div>
      </main>
      <div className="toast-stack" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.kind}`}><span>{toast.kind === "success" ? "✓" : toast.kind === "error" ? "!" : "•"}</span>{toast.message}<button aria-label="Dismiss notification" onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}>×</button></div>)}</div>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}
function Panel({ title, subtitle, action, children, className = "" }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}><div className="panel-body">{(title || action) && <div className="panel-heading"><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action}</div>}{children}</div></section>;
}
function Button({ children, onClick, variant = "secondary", disabled = false, type = "button", className = "" }: { children: ReactNode; onClick?: () => void; variant?: "primary" | "secondary" | "quiet" | "danger"; disabled?: boolean; type?: "button" | "submit"; className?: string }) {
  return <button type={type} className={`button button-${variant} ${className}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Loading() { return <div className="loading-state"><span className="spinner" />Loading your workspace…</div>; }
function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="error-state"><span className="error-mark">!</span><div><strong>We couldn’t load this data</strong><p>{message}</p>{retry && <Button onClick={retry}>Try again</Button>}</div></div>;
}
function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">✳</div><h3>{title}</h3><p>{detail}</p>{action}</div>;
}
function StatusPill({ value }: { value: string }) {
  const tone = ["qualified", "kit_ready", "applied", "approved", "ready_for_review", "pass"].includes(value) ? "green" :
    ["skipped", "blocked", "failed", "fail"].includes(value) ? "red" :
      ["parked", "new", "starting", "filling"].includes(value) ? "amber" : "blue";
  return <span className={`status-pill status-${tone}`}><i />{value.replaceAll("_", " ")}</span>;
}
function useAction(notify: (message: string, kind?: ToastMessage["kind"]) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async <T,>(operation: () => Promise<T>, success: string, after?: (value: T) => void) => {
    setBusy(true); setError("");
    try { const value = await operation(); after?.(value); notify(success); return value; }
    catch (cause) { const message = cause instanceof Error ? cause.message : "Something went wrong"; setError(message); notify(message, "error"); return undefined; }
    finally { setBusy(false); }
  }, [notify]);
  return { busy, error, run, setError };
}

function Dashboard({ notify }: { notify: (message: string, kind?: ToastMessage["kind"]) => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [report, setReport] = useState<{ line: string; submitted: number; total: number } | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ running: boolean; done: number; total: number; current: string; errors: { jobId: number; error: string }[] } | null>(null);
  const action = useAction(notify);
  const load = useCallback(() => {
    setLoading(true); setError("");
    Promise.all([api.dashboard(), api.report(), api.settings()]).then(([dashboard, daily, settings]) => {
      setData(dashboard);
      setReport(daily);
      setHasApiKey(settings.hasApiKey);
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  const runAll = async () => {
    const started = await action.run(() => api.runAll(["new"]), "Job processing started");
    if (!started) return;
    setProgress({ running: true, done: 0, total: started.started, current: "", errors: [] });
    const timer = window.setInterval(() => api.runStatus().then((status) => {
      setProgress({
        running: status.running,
        done: status.done,
        total: status.total,
        current: status.current ? `${status.current.company} · ${status.current.title}` : "",
        errors: status.errors,
      });
      if (!status.running) {
        window.clearInterval(timer);
        notify(status.errors.length
          ? `Finished processing ${status.done} jobs; ${status.errors.length} need attention`
          : `Finished processing ${status.done} jobs`);
        load();
      }
    }).catch((cause: unknown) => {
      window.clearInterval(timer);
      setProgress((current) => current ? { ...current, running: false } : current);
      notify(cause instanceof Error ? cause.message : "Could not read job queue progress", "error");
    }), 1600);
  };
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} retry={load} />;
  if (!data) return null;
  const stats = [
    { label: "Applications today", value: report?.submitted ?? data.today, suffix: `of ${data.today || 0} today`, icon: "↗", color: "green" },
    { label: "All-time applications", value: data.total, suffix: "in your ledger", icon: "▤", color: "blue" },
    { label: "Kits ready", value: data.byStatus.kit_ready ?? 0, suffix: "ready for review", icon: "✧", color: "purple" },
    { label: "Needs attention", value: data.blockedCount + data.parkedCount, suffix: `${data.blockedCount} blocked · ${data.parkedCount} parked`, icon: "◷", color: "amber" },
  ];
  const statuses = Object.entries(data.byStatus).filter(([, count]) => count > 0);
  const totalStatus = Math.max(1, statuses.reduce((sum, [, count]) => sum + count, 0));
  const checklist = [
    ["API key configured", hasApiKey, "/settings"], ["Resume uploaded", data.resumesCount > 0, "/resumes"],
    ["Experience bank built", data.bankBuilt, "/resumes"], ["Profile completed", false, "/profile"],
    ["Rules reviewed", false, "/profile"], ["Stories approved", false, "/profile"],
  ];
  return <>
    <PageHeading eyebrow={new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }).toUpperCase()} title="Good morning" description="Your application workspace at a glance." action={<Button variant="primary" onClick={runAll} disabled={action.busy}>✦ {action.busy ? "Starting…" : "Run all new jobs"}</Button>} />
    {progress && <div className="progress-card"><div><strong>{progress.running ? "Working through your queue" : "Queue complete"}</strong><span>{progress.current || `${progress.done} of ${progress.total} jobs processed`}</span>{progress.errors.length > 0 && <small className="progress-errors">{progress.errors.length} jobs need attention</small>}</div><div className="progress-track"><i style={{ width: `${progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 0}%` }} /></div><span>{progress.done}/{progress.total}</span></div>}
    <div className="stats-grid">{stats.map((stat) => <div className="stat-card" key={stat.label}><div className={`stat-icon stat-${stat.color}`}>{stat.icon}</div><span className="stat-label">{stat.label}</span><strong className="stat-value">{stat.value}</strong><span className="stat-caption">{stat.suffix}</span></div>)}</div>
    <div className="dashboard-grid">
      <Panel title="Application pipeline" subtitle="Jobs by current status" action={<Link className="text-link" to="/jobs">View jobs <span>↗</span></Link>}>
        {statuses.length ? <><div className="pipeline-bar">{statuses.map(([status, count]) => <i key={status} title={`${status.replaceAll("_", " ")}: ${count}`} className={`bar-${status}`} style={{ width: `${(count / totalStatus) * 100}%` }} />)}</div><div className="pipeline-legend">{statuses.map(([status, count]) => <div key={status}><span className={`legend-dot bar-${status}`} />{status.replaceAll("_", " ")}<strong>{count}</strong></div>)}</div></> : <EmptyState title="No jobs in your pipeline" detail="Add a role that looks promising to get started." action={<Link className="button button-primary" to="/jobs">Add your first job</Link>} />}
      </Panel>
      <Panel title="Setup checklist" subtitle="A few steps to make ApplyPilot yours">
        <div className="checklist">{checklist.map(([label, done, to]) => <Link key={label as string} to={to as string} className={`check-row${done ? " check-done" : ""}`}><span>{done ? "✓" : "○"}</span>{label as string}<span className="check-arrow">↗</span></Link>)}</div>
      </Panel>
      <Panel title="Recent agent runs" subtitle={`${data.tokensToday.toLocaleString()} tokens used today`} className="wide-panel" action={<Link className="text-link" to="/logs">All activity ↗</Link>}>
        {data.recentRuns.length ? <RunTable runs={data.recentRuns.slice(0, 6)} /> : <EmptyState title="No agent activity yet" detail="When you process a job, each step will be recorded here." />}
      </Panel>
      <Panel title="Weekly momentum" subtitle="Applications submitted each week">
        <WeeklyChart />
      </Panel>
    </div>
  </>;
}
function WeeklyChart() {
  const [weeks, setWeeks] = useState<{ weekStart: string; submitted: number; interviews: number }[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api.weekly().then((value) => setWeeks(value.weeks)).catch((e: Error) => setError(e.message)); }, []);
  if (error) return <p className="muted">Weekly report unavailable: {error}</p>;
  if (!weeks) return <div className="mini-loading"><span className="spinner" />Loading report…</div>;
  if (!weeks.length) return <EmptyState title="Your progress starts here" detail="Weekly trends appear after your first application." />;
  const maximum = Math.max(1, ...weeks.map((week) => week.submitted));
  return <div className="chart">{weeks.slice(-6).map((week) => <div className="chart-col" key={week.weekStart} title={`${week.submitted} applications, ${week.interviews} interviews`}><div className="chart-bars"><i style={{ height: `${(week.submitted / maximum) * 100}%` }} /><b style={{ height: `${(week.interviews / maximum) * 100}%` }} /></div><span>{new Date(`${week.weekStart}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>)}</div>;
}
function RunTable({ runs }: { runs: AgentRun[] }) {
  return <div className="compact-list">{runs.map((run) => <div className="compact-row" key={run.id}><div className="agent-avatar">{run.agent.slice(0, 1)}</div><div className="compact-main"><strong>{run.agent}</strong><span>{run.jobId ? `Job #${run.jobId}` : "Workspace"} · {run.model}</span></div><StatusPill value={run.mock ? "mock" : run.ok ? "complete" : "failed"} /><span className="row-time">{run.durationMs < 1000 ? `${run.durationMs} ms` : `${(run.durationMs / 1000).toFixed(1)} s`}</span></div>)}</div>;
}

function ResumesPage({ notify }: { notify: (message: string, kind?: ToastMessage["kind"]) => void }) {
  const [resumes, setResumes] = useState<ResumeSummary[] | null>(null);
  const [bank, setBank] = useState<ExperienceBank | null>(null);
  const [bankLoaded, setBankLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const load = useCallback(() => {
    setError("");
    Promise.all([api.resumes(), api.bank()]).then(([items, value]) => { setResumes(items); setBank(value); setBankLoaded(true); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const doAction = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true); setError("");
    try { await fn(); notify(message); load(); }
    catch (e) { const msg = e instanceof Error ? e.message : "Action failed"; setError(msg); notify(msg, "error"); }
    finally { setBusy(false); }
  };
  const upload = (files: FileList | File[]) => {
    const selected = Array.from(files);
    const invalid = selected.filter((file) => !/\.(pdf|docx|txt)$/i.test(file.name) || file.size > 5 * 1024 * 1024);
    if (invalid.length) {
      notify(`These files were not uploaded (choose PDF, DOCX, or TXT files up to 5 MB): ${invalid.map((file) => file.name).join(", ")}`, "error");
      return;
    }
    if (!selected.length) { notify("Choose at least one resume file.", "error"); return; }
    void doAction(() => api.upload(selected), `${selected.length} resume${selected.length === 1 ? "" : "s"} uploaded`);
  };
  if (!resumes && error) return <><PageHeading title="Resumes" /><ErrorState message={error} retry={load} /></>;
  if (!resumes) return <Loading />;
  return <>
    <PageHeading eyebrow="YOUR EXPERIENCE" title="Resume library" description="Build a truthful, flexible experience bank from the resumes you’ve actually written." action={<Button variant="primary" disabled={busy} onClick={() => document.getElementById("resume-files")?.click()}>＋ Upload resumes</Button>} />
    <input id="resume-files" type="file" accept=".pdf,.docx,.txt" multiple hidden onChange={(event) => { if (event.currentTarget.files) upload(event.currentTarget.files); event.currentTarget.value = ""; }} />
    {error && <div className="inline-error">{error}</div>}
    <div className="resume-summary-row"><div className="summary-chip"><strong>{resumes.length} / {MAX_RESUMES}</strong><span>resumes stored</span></div><div className="summary-chip"><strong>{resumes.filter((resume) => resume.analyzed).length}</strong><span>analyzed</span></div><div className="summary-chip"><strong>{resumes.filter((resume) => resume.isBase).length ? "Set" : "Not set"}</strong><span>base resume</span></div><div className="summary-hint">{resumes.length < RECOMMENDED_MIN_RESUMES ? `Add ${RECOMMENDED_MIN_RESUMES - resumes.length} more to reach the recommended 5–10 versions.` : "Great coverage. Keep your versions current."}</div></div>
    <Panel title="Your resumes" subtitle="PDF, DOCX, or plain text · max 5 MB each" action={<div className="button-group"><Button disabled={!resumes.length || busy} onClick={() => doAction(() => api.analyzeAll(), "Resume analysis complete")}>✧ Analyze all</Button><Button variant="primary" disabled={!resumes.length || busy} onClick={() => doAction(() => api.buildBank(), "Experience bank built")}>◈ Build experience bank</Button></div>}>
      <div className={`upload-drop${drag ? " drag-active" : ""}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}>
        <div className="upload-icon">↑</div><div><strong>Drop resumes here, or <button className="inline-button" onClick={() => document.getElementById("resume-files")?.click()}>browse files</button></strong><span>{resumes.length} of 10 resumes used · supports PDF, DOCX, TXT</span></div><span className="drop-limit">5 MB max</span>
      </div>
      {resumes.length ? <div className="table-scroll"><table><thead><tr><th>RESUME</th><th>SKILLS</th><th>ANALYSIS</th><th>ROLE</th><th className="align-right">ACTIONS</th></tr></thead><tbody>{resumes.map((resume) => <tr key={resume.id}><td><div className="resume-name"><span className="file-icon">▤</span><span><strong>{resume.label || resume.originalName}</strong><small>{resume.originalName} · {new Date(resume.uploadedAt).toLocaleDateString()}</small></span></div></td><td>{resume.skillsCount || resume.skills.length} skills</td><td><StatusPill value={resume.analyzed ? "analyzed" : "not analyzed"} /></td><td>{resume.isBase ? <span className="badge badge-green">★ Base resume</span> : <Button variant="quiet" disabled={busy} onClick={() => doAction(() => api.updateResume(resume.id, { is_base: true }), "Base resume updated")}>Set as base</Button>}</td><td className="align-right"><div className="row-actions"><Button variant="quiet" disabled={busy} onClick={() => doAction(() => api.updateResume(resume.id, { label: window.prompt("Resume label", resume.label) ?? resume.label }), "Resume label updated")}>Rename</Button><Button variant="quiet" disabled={busy} onClick={() => doAction(() => api.analyzeResume(resume.id), "Resume analyzed")}>{resume.analyzed ? "Re-analyze" : "Analyze"}</Button><Button variant="quiet" disabled={busy} onClick={() => { if (window.confirm(`Delete ${resume.originalName}?`)) void doAction(() => api.deleteResume(resume.id), "Resume deleted"); }}>Delete</Button></div></td></tr>)}</tbody></table></div> : <EmptyState title="Start with your first resume" detail="Upload one or more versions to create your private experience library." />}
    </Panel>
    <Panel title="Experience bank" subtitle="A grounded knowledge base compiled from analyzed resumes" action={<Button variant="quiet" onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse" : "View details"} ↓</Button>}>
      {!bankLoaded ? <div className="mini-loading"><span className="spinner" />Checking experience bank…</div> : bank ? <><div className="bank-overview"><div><strong>{bank.roles.length}</strong><span>career roles</span></div><div><strong>{bank.skills.length}</strong><span>skills with evidence</span></div><div><strong>{bank.strongestResults.length}</strong><span>measurable results</span></div><div className="bank-build-date">Last built<br /><strong>{new Date(bank.builtAt).toLocaleDateString()}</strong></div></div>{expanded && <div className="bank-detail"><h3>Core skills</h3><div className="skill-chips">{bank.skills.slice(0, 24).map((skill) => <span className="chip" key={skill.name}>{skill.name}<small>{skill.evidence.length}</small></span>)}</div><h3>Strongest results</h3>{bank.strongestResults.slice(0, 5).map((result, i) => <p className="evidence-line" key={`${i}-${result.text}`}>↗ {result.text}</p>)}</div>}</> : <EmptyState title="No experience bank yet" detail="Analyze your resumes, then build a consolidated bank with source evidence." />}</Panel>
  </>;
}

function ProfilePage({ notify }: { notify: (message: string, kind?: ToastMessage["kind"]) => void }) {
  const [tab, setTab] = useState<"facts" | "rules" | "stories">("facts");
  const [facts, setFacts] = useState<StandingFacts>(DEFAULT_STANDING_FACTS);
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [stories, setStories] = useState<Story[]>(DEFAULT_STORIES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [suggestion, setSuggestion] = useState<Partial<StandingFacts> | null>(null);
  const action = useAction(notify);
  const load = useCallback(() => {
    setLoading(true); setError("");
    Promise.all([api.profile(), api.rules(), api.stories()]).then(([profile, valueRules, valueStories]) => {
      setFacts(profile); setRules(valueRules); setStories(valueStories);
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  const saveFacts = (e: FormEvent) => { e.preventDefault(); void action.run(() => api.saveProfile(facts), "Profile saved"); };
  const saveRules = (e: FormEvent) => { e.preventDefault(); void action.run(async () => { await Promise.all([api.saveRules(rules), api.saveProfile(facts)]); }, "Rules and location preference saved"); };
  const update = <K extends keyof StandingFacts>(key: K, value: StandingFacts[K]) => setFacts((current) => ({ ...current, [key]: value }));
  const suggest = async () => {
    const value = await action.run(() => api.suggest(), "Draft suggestions ready");
    if (value) setSuggestion(value);
  };
  if (loading) return <Loading />;
  if (error) return <><PageHeading title="Profile & rules" /><ErrorState message={error} retry={load} /></>;
  return <>
    <PageHeading eyebrow="YOUR PLAYBOOK" title="Profile & rules" description="Keep your application answers accurate, consistent, and always yours to approve." action={<Button disabled={action.busy} onClick={suggest}>✧ Suggest from resumes</Button>} />
    {action.error && <div className="inline-error">{action.error}</div>}
    {suggestion && <Panel title="Suggested profile draft" subtitle="Review these inferred details carefully. Nothing is saved until you choose to save it." action={<Button variant="quiet" onClick={() => setSuggestion(null)}>Dismiss</Button>}><pre className="suggestion-preview">{JSON.stringify(suggestion, null, 2)}</pre><Button variant="primary" onClick={() => { setFacts((current) => ({ ...current, ...suggestion })); setSuggestion(null); notify("Draft copied into your profile. Review and save it."); }}>Use these suggestions</Button></Panel>}
    <div className="tabs" role="tablist"><button className={tab === "facts" ? "tab active" : "tab"} onClick={() => setTab("facts")}>Standing facts</button><button className={tab === "rules" ? "tab active" : "tab"} onClick={() => setTab("rules")}>Application rules</button><button className={tab === "stories" ? "tab active" : "tab"} onClick={() => setTab("stories")}>Story library <span>{stories.filter((story) => story.approved).length}/{STORY_KEYS.length}</span></button></div>
    {tab === "facts" && <form onSubmit={saveFacts}><Panel title="Personal details" subtitle="These facts may be used in application forms. Keep them current."><div className="form-grid"><Field label="Full name"><input value={facts.fullName} onChange={(e) => update("fullName", e.target.value)} /></Field><Field label="Email"><input type="email" value={facts.email} onChange={(e) => update("email", e.target.value)} /></Field><Field label="Phone"><input value={facts.phone} onChange={(e) => update("phone", e.target.value)} /></Field><Field label="Time zone"><input value={facts.timeZone} onChange={(e) => update("timeZone", e.target.value)} /></Field><Field label="Address" className="col-span-2"><input value={facts.address} onChange={(e) => update("address", e.target.value)} /></Field><Field label="LinkedIn URL"><input value={facts.linkedinUrl} onChange={(e) => update("linkedinUrl", e.target.value)} /></Field><Field label="Portfolio URL"><input value={facts.portfolioUrl} onChange={(e) => update("portfolioUrl", e.target.value)} /></Field><Field label="Target titles" hint="Comma separated"><input value={facts.targetTitles.join(", ")} onChange={(e) => update("targetTitles", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} /></Field><Field label="Location preference"><select value={facts.locationMode} onChange={(e) => update("locationMode", e.target.value as StandingFacts["locationMode"])}>{["remote", "hybrid", "onsite", "any"].map((v) => <option key={v}>{v}</option>)}</select></Field><Field label="Regions" hint="Comma separated"><input value={facts.regions.join(", ")} onChange={(e) => update("regions", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} /></Field><Field label="Pay floor (annual)"><input type="number" min="0" value={facts.payFloor ?? ""} onChange={(e) => update("payFloor", e.target.value ? Number(e.target.value) : null)} /></Field><Field label="Desired pay (annual)"><input type="number" min="0" value={facts.desiredPay ?? ""} onChange={(e) => update("desiredPay", e.target.value ? Number(e.target.value) : null)} /></Field><Field label="Work authorization" className="col-span-2"><input value={facts.workAuthorization} onChange={(e) => update("workAuthorization", e.target.value)} /></Field><Field label="Sponsorship answer" className="col-span-2"><input value={facts.sponsorshipAnswer} onChange={(e) => update("sponsorshipAnswer", e.target.value)} /></Field><Field label="Soonest start"><input value={facts.soonestStart} onChange={(e) => update("soonestStart", e.target.value)} /></Field><Field label="How did you hear?"><input value={facts.howDidYouHear} onChange={(e) => update("howDidYouHear", e.target.value)} /></Field><Field label="Professional summary" className="col-span-2"><textarea rows={4} value={facts.summary} onChange={(e) => update("summary", e.target.value)} /></Field></div></Panel><Panel title="Voluntary & screening answers" subtitle="Sensitive questions are yours to answer; nothing is inferred or silently submitted."><div className="form-grid"><Field label="Accommodations"><input value={facts.screeners.accommodations} onChange={(e) => update("screeners", { ...facts.screeners, accommodations: e.target.value })} /></Field><Field label="Startup experience"><input value={facts.screeners.startupExperience} onChange={(e) => update("screeners", { ...facts.screeners, startupExperience: e.target.value })} /></Field><Field label="Gender"><input value={facts.eeo.gender} onChange={(e) => update("eeo", { ...facts.eeo, gender: e.target.value })} /></Field><Field label="Race / ethnicity"><input value={facts.eeo.race} onChange={(e) => update("eeo", { ...facts.eeo, race: e.target.value })} /></Field><Field label="Veteran status"><input value={facts.eeo.veteranStatus} onChange={(e) => update("eeo", { ...facts.eeo, veteranStatus: e.target.value })} /></Field><Field label="Disability status"><input value={facts.eeo.disabilityStatus} onChange={(e) => update("eeo", { ...facts.eeo, disabilityStatus: e.target.value })} /></Field><Field label="Requires sponsorship?"><select value={facts.requiresSponsorship === null ? "" : String(facts.requiresSponsorship)} onChange={(e) => update("requiresSponsorship", e.target.value === "" ? null : e.target.value === "true")}><option value="">Not answered</option><option value="true">Yes</option><option value="false">No</option></select></Field><label className="toggle-line"><input type="checkbox" checked={facts.screeners.smsOk} onChange={(e) => update("screeners", { ...facts.screeners, smsOk: e.target.checked })} />OK to receive recruiter texts</label></div><div className="panel-footer"><Button type="submit" variant="primary" disabled={action.busy}>Save standing facts</Button></div></Panel></form>}
    {tab === "rules" && <form onSubmit={saveRules}><Panel title="Hard boundaries" subtitle="These rules help filter roles before you invest time."><div className="form-grid"><Field label="Location mode"><select value={facts.locationMode} onChange={(e) => update("locationMode", e.target.value as StandingFacts["locationMode"])}>{["remote", "hybrid", "onsite", "any"].map((v) => <option key={v}>{v}</option>)}</select></Field><Field label="Minimum annual salary"><input type="number" value={rules.salary.floor ?? ""} onChange={(e) => setRules({ ...rules, salary: { ...rules.salary, floor: e.target.value ? Number(e.target.value) : null } })} /></Field><Field label="Excluded role families" hint="Comma separated"><input value={rules.roleExclusions.join(", ")} onChange={(e) => setRules({ ...rules, roleExclusions: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></Field><Field label="Blacklisted title terms" hint="Comma separated"><input value={rules.blacklistTitles.join(", ")} onChange={(e) => setRules({ ...rules, blacklistTitles: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></Field><Field label="Excluded companies" hint="Comma separated"><input value={rules.excludedCompanies.join(", ")} onChange={(e) => setRules({ ...rules, excludedCompanies: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></Field><Field label="Excluded senders / sites" hint="Comma separated"><input value={rules.excludedSenders.join(", ")} onChange={(e) => setRules({ ...rules, excludedSenders: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })} /></Field><Field label="Salary answer style"><select value={rules.salary.answerStyle} onChange={(e) => setRules({ ...rules, salary: { ...rules.salary, answerStyle: e.target.value as Rules["salary"]["answerStyle"] } })}><option value="range">Range</option><option value="single">Single figure</option><option value="decline">Decline politely</option></select></Field><label className="toggle-line"><input type="checkbox" checked={rules.salary.negotiable} onChange={(e) => setRules({ ...rules, salary: { ...rules.salary, negotiable: e.target.checked } })} />Salary is negotiable</label><Field label="Never-touch-filters reminder" className="col-span-2"><textarea rows={3} value={rules.neverTouchFiltersNote} onChange={(e) => setRules({ ...rules, neverTouchFiltersNote: e.target.value })} /></Field></div></Panel><Panel title="Custom standing rules" subtitle="Add personal guidelines to keep each application true to you."><TagEditor values={rules.customRules.map((rule) => rule.text)} onChange={(values) => setRules({ ...rules, customRules: values.map((text) => ({ text, createdAt: new Date().toISOString() })) })} placeholder="e.g. Never claim people-management experience unless it's in my resume" /><div className="panel-footer"><Button type="submit" variant="primary" disabled={action.busy}>Save rules</Button></div></Panel></form>}
    {tab === "stories" && <div className="story-grid">{STORY_KEYS.map((key) => { const story = stories.find((item) => item.key === key) ?? DEFAULT_STORIES.find((item) => item.key === key)!; return <StoryCard key={key} story={story} disabled={action.busy} save={(value) => action.run(() => api.saveStory(key, value), "Story saved", (saved) => setStories((current) => [...current.filter((item) => item.key !== key), saved]))} />; })}</div>}
  </>;
}

function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span>{label}{hint && <small>{hint}</small>}</span>{children}</label>;
}
function TagEditor({ values, onChange, placeholder }: { values: string[]; onChange: (values: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const add = () => { const trimmed = draft.trim(); if (trimmed && !values.includes(trimmed)) onChange([...values, trimmed]); setDraft(""); };
  return <><div className="tag-list">{values.map((value, index) => <span className="editable-tag" key={`${value}-${index}`}>{value}<button onClick={() => onChange(values.filter((_, i) => i !== index))} aria-label={`Remove ${value}`}>×</button></span>)}</div><div className="inline-add"><input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} placeholder={placeholder} /><Button onClick={add}>＋ Add rule</Button></div></>;
}
function StoryCard({ story, disabled, save }: { story: Story; disabled: boolean; save: (value: { title: string; body: string; approved: boolean }) => void }) {
  const [title, setTitle] = useState(story.title);
  const [body, setBody] = useState(story.body);
  const [approved, setApproved] = useState(story.approved);
  useEffect(() => { setTitle(story.title); setBody(story.body); setApproved(story.approved); }, [story]);
  return <Panel className="story-card" title={title} subtitle={story.key.replaceAll("_", " ")}><div className="story-editor"><Field label="Story title"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field><Field label="Your story"><textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></Field><label className="toggle-line"><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />I reviewed and approve this story</label><Button variant="primary" disabled={disabled} onClick={() => save({ title, body, approved })}>Save story</Button></div></Panel>;
}

function JobsPage({ notify }: { notify: (message: string, kind?: ToastMessage["kind"]) => void }) {
  const [items, setItems] = useState<JobDetail["job"][] | null>(null);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [bulk, setBulk] = useState("");
  const [addMode, setAddMode] = useState<"url" | "paste" | "bulk">("url");
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [emailResult, setEmailResult] = useState("");
  const navigate = useNavigate();
  const load = useCallback(() => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ limit: "100" });
    if (status) params.set("status", status);
    if (query) params.set("q", query);
    api.jobs(`?${params}`).then((value) => { setItems(value.items as JobDetail["job"][]); setTotal(value.total); setSelected([]); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [status, query]);
  useEffect(load, [load]);
  const act = async <T,>(fn: () => Promise<T>, success: string): Promise<T | undefined> => {
    setBusy(true); setError("");
    try { const value = await fn(); notify(success); load(); return value; }
    catch (e) { const message = e instanceof Error ? e.message : "Action failed"; setError(message); notify(message, "error"); return undefined; }
    finally { setBusy(false); }
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (addMode === "bulk") {
      const urls = bulk.split(/\s+/).map((value) => value.trim()).filter(Boolean);
      if (!urls.length) return;
      const result = await act(() => api.bulkJobs(urls), "Bulk job import complete");
      if (result) setBulk("");
    } else {
      const payload = addMode === "url" ? { url: url.trim() } : { text: paste.trim() };
      if (!Object.values(payload)[0]) return;
      const job = await act(() => api.addJob(payload), "Job added to your pipeline");
      if (job) { setUrl(""); setPaste(""); }
    }
  };
  if (loading && !items) return <><PageHeading title="Job pipeline" /><Loading /></>;
  if (error && !items) return <><PageHeading title="Job pipeline" /><ErrorState message={error} retry={load} /></>;
  const jobs = items ?? [];
  const emailSweep = async () => {
    const result = await act(() => api.emailSweep(), "Email alert sweep finished");
    if (result) setEmailResult(`Scanned ${result.emailsScanned} emails · found ${result.urlsFound} links · added ${result.jobsCreated.length} jobs · ${result.duplicates} duplicates`);
  };
  const runSelected = async () => {
    if (!selected.length) return;
    setBusy(true); setError("");
    let completed = 0;
    try {
      for (const id of selected) {
        await api.runJob(id);
        completed += 1;
      }
      notify(`Processed ${completed} selected job${completed === 1 ? "" : "s"}`);
      load();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not process selected jobs";
      setError(`${message} (${completed} of ${selected.length} completed)`);
      notify(message, "error");
      load();
    } finally { setBusy(false); }
  };
  return <>
    <PageHeading eyebrow="DISCOVER & QUALIFY" title="Job pipeline" description={`${total} roles tracked. Keep your shortlist focused on opportunities that fit.`} action={<Button onClick={emailSweep} disabled={busy}>✉ Sweep email alerts</Button>} />
    {error && <div className="inline-error">{error}<button onClick={() => setError("")}>×</button></div>}
    {emailResult && <div className="inline-success">{emailResult}<button onClick={() => setEmailResult("")}>×</button></div>}
    <Panel title="Add a job" subtitle="Save a posting to review it with your own application rules.">
      <div className="tabs compact-tabs"><button className={addMode === "url" ? "tab active" : "tab"} onClick={() => setAddMode("url")}>Posting URL</button><button className={addMode === "paste" ? "tab active" : "tab"} onClick={() => setAddMode("paste")}>Paste description</button><button className={addMode === "bulk" ? "tab active" : "tab"} onClick={() => setAddMode("bulk")}>Bulk URLs</button></div>
      <form className="add-job-form" onSubmit={add}>
        {addMode === "url" && <input aria-label="Job posting URL" type="url" required placeholder="Paste the job posting URL…" value={url} onChange={(e) => setUrl(e.target.value)} />}
        {addMode === "paste" && <textarea aria-label="Job description" required rows={3} placeholder="Paste the full job description…" value={paste} onChange={(e) => setPaste(e.target.value)} />}
        {addMode === "bulk" && <textarea aria-label="Job URLs" required rows={3} placeholder={"Paste one job URL per line…"} value={bulk} onChange={(e) => setBulk(e.target.value)} />}
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Adding…" : addMode === "bulk" ? "Import URLs" : "＋ Add job"}</Button>
      </form>
    </Panel>
    <Panel title="Your shortlist" subtitle="Filter, qualify, and prepare an application kit when you’re ready." action={<div className="button-group"><span className="muted">{selected.length} selected</span><Button variant="primary" disabled={!selected.length || busy} onClick={runSelected}>✦ Run selected</Button></div>}>
      <div className="filters-row"><div className="search-box"><span>⌕</span><input placeholder="Search company or title…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} /><button onClick={load}>Search</button></div><select aria-label="Filter by job status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{JOB_STATUSES.map((value) => <option value={value} key={value}>{value.replaceAll("_", " ")}</option>)}</select><Button onClick={load}>↻ Refresh</Button></div>
      {loading && <div className="mini-loading"><span className="spinner" />Updating jobs…</div>}
      {jobs.length ? <div className="table-scroll"><table><thead><tr><th><input aria-label="Select all jobs" type="checkbox" checked={jobs.length > 0 && selected.length === jobs.length} onChange={(e) => setSelected(e.target.checked ? jobs.map((job) => job.id) : [])} /></th><th>ROLE</th><th>LOCATION</th><th>FIT</th><th>STATUS</th><th>FOUND</th><th className="align-right">ACTIONS</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id}><td><input aria-label={`Select ${job.title}`} type="checkbox" checked={selected.includes(job.id)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, job.id] : current.filter((id) => id !== job.id))} /></td><td><Link className="job-cell" to={`/jobs/${job.id}`}><strong>{job.title || "Untitled role"}</strong><span>{job.company || "Company not identified"}{job.board ? ` · ${job.board}` : ""}</span></Link></td><td>{job.location || "—"}</td><td>{job.fitScore == null ? "—" : <span className={`fit-score ${job.fitScore >= 75 ? "fit-high" : "fit-medium"}`}>{job.fitScore}%</span>}</td><td><StatusPill value={job.status} /></td><td>{new Date(job.foundAt).toLocaleDateString()}</td><td className="align-right"><div className="row-actions"><Button variant="quiet" disabled={busy} onClick={() => void act(() => api.runJob(job.id), `Job ${job.id} processed`)}>Run</Button><Button variant="quiet" onClick={() => navigate(`/jobs/${job.id}`)}>Open</Button><Button variant="quiet" disabled={busy} onClick={() => { if (window.confirm(`Delete ${job.title || "this job"}?`)) void act(() => api.deleteJob(job.id), "Job removed"); }}>Delete</Button></div></td></tr>)}</tbody></table></div> : !loading && <EmptyState title="No matching jobs" detail="Add a job posting, paste a description, or run an email alert sweep." /> }
    </Panel>
  </>;
}

function JobPage({ notify }: { notify: (message: string, kind?: ToastMessage["kind"]) => void }) {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState("");
  const [coverLetter, setCoverLetter] = useState("");
  const [answersText, setAnswersText] = useState("");
  const [reason, setReason] = useState("");
  const [blockReason, setBlockReason] = useState("other");
  const [route, setRoute] = useState("manual");
  const load = useCallback(() => {
    setLoading(true); setError("");
    api.job(id).then((value) => { setDetail(value); setSummary(value.kit?.tailored?.summary ?? ""); setCoverLetter(value.kit?.coverLetter ?? ""); setAnswersText(JSON.stringify(value.kit?.answers ?? [], null, 2)); }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);
  useEffect(load, [load]);
  const act = async <T,>(fn: () => Promise<T>, message: string, after?: (value: T) => void) => {
    setBusy(true); setError("");
    try { const value = await fn(); notify(message); after?.(value); load(); return value; }
    catch (e) { const msg = e instanceof Error ? e.message : "Action failed"; setError(msg); notify(msg, "error"); }
    finally { setBusy(false); }
  };
  if (loading) return <Loading />;
  if (error && !detail) return <ErrorState message={error} retry={load} />;
  if (!detail) return null;
  const job = detail.job;
  const kit = detail.kit;
  const parsed = job.parsed;
  const saveEdits = () => {
    let answers;
    try { answers = JSON.parse(answersText) as ApplicationKit["answers"]; }
    catch { setError("Screening answers must be valid JSON. Check the answer list before saving."); return; }
    void act(() => api.saveKit(id, { tailored: kit?.tailored ? { ...kit.tailored, summary } : undefined, coverLetter, answers }), "Application kit saved");
  };
  const downloadFile = (kind: "pdf" | "docx") => void act(() => kind === "pdf"
    ? downloadKitPdf(id, `${job.company || "resume"}-${job.title || "application"}.pdf`)
    : downloadKitDocx(id, `${job.company || "resume"}-${job.title || "application"}.docx`), `${kind.toUpperCase()} download started`);
  return <>
    <div className="back-link"><Link to="/jobs">← Back to jobs</Link><span>Job #{id}</span></div>
    <PageHeading eyebrow={`${job.company || "COMPANY"} · ${job.location || "LOCATION"}`} title={job.title || "Untitled position"} description={job.url || "Manually added job posting"} action={<StatusPill value={job.status} />} />
    {error && <div className="inline-error">{error}<button onClick={() => setError("")}>×</button></div>}
    <div className="detail-layout">
      <div className="detail-main">
        <Panel title="Role overview" subtitle="Posting details and requirements">
          {parsed ? <><div className="fact-grid"><div><span>Remote type</span><strong>{parsed.remoteType}</strong></div><div><span>Seniority</span><strong>{parsed.seniority || "—"}</strong></div><div><span>Employment</span><strong>{parsed.employmentType || "—"}</strong></div><div><span>Pay range</span><strong>{parsed.payMin ? `${parsed.payCurrency ?? "USD"} ${parsed.payMin.toLocaleString()}${parsed.payMax ? `–${parsed.payMax.toLocaleString()}` : ""}` : "Not listed"}</strong></div></div><h3>Required skills</h3><div className="skill-chips">{parsed.requiredSkills.map((skill) => <span key={skill} className="chip">{skill}</span>)}</div><h3>Responsibilities</h3><ul className="bullet-list">{parsed.responsibilities.map((item, i) => <li key={i}>{item}</li>)}</ul><details className="description-details"><summary>Full job description</summary><p>{job.descriptionText}</p></details></> : <><p className="muted">This role has not been parsed yet.</p><pre className="job-description">{job.descriptionText}</pre></>}
        </Panel>
        {job.qualification && <Panel title="Qualification" subtitle="Fit against your profile and hard rules"><div className="qual-score"><strong>{job.qualification.fitScore}<small>/100</small></strong><div><StatusPill value={job.qualification.qualifies ? "qualified" : "skipped"} /><span>Fit score</span></div></div>{job.qualification.blockers.length > 0 && <div className="warning-box"><strong>Hard rule blockers</strong>{job.qualification.blockers.map((item, i) => <div key={i}>× {item}</div>)}</div>}<div className="two-lists"><div><h3>Why it fits</h3>{job.qualification.reasons.map((item, i) => <p className="evidence-line" key={i}>✓ {item}</p>)}</div><div><h3>Skill gaps</h3>{job.qualification.gaps.map((item, i) => <p className="evidence-line muted" key={i}>○ {item}</p>)}</div></div></Panel>}
        {kit && <Panel title="Application kit" subtitle="Review every detail. Nothing is submitted from this screen." action={<StatusPill value={kit.status} />}>
          {kit.selection && <div className="selection-card"><div><span>Selected resume</span><strong>Resume #{kit.selection.selectedResumeId}</strong><small>{kit.selection.rationale}</small></div><div className="ranking-list">{kit.selection.rankings.map((ranking) => <span key={ranking.resumeId}>#{ranking.resumeId} <b>{ranking.score}%</b></span>)}</div></div>}
          {kit.keywords && <><h3>Keyword coverage · {kit.keywords.coveragePct}%</h3><div className="skill-chips">{kit.keywords.covered.map((word) => <span className="chip chip-success" key={word}>✓ {word}</span>)}{kit.keywords.missing.map((word) => <span className="chip chip-muted" key={word}>○ {word}</span>)}</div></>}
          {kit.honesty && <div className={`honesty-card${kit.honesty.unsupportedCount ? " honesty-warning" : ""}`}><strong>{kit.honesty.unsupportedCount ? "Review unsupported claims" : "Honesty check passed"}</strong><span>{kit.honesty.unsupportedCount} unsupported claims · {kit.honesty.claims.length} claims reviewed</span>{kit.honesty.claims.map((claim, i) => <p className={!claim.supported ? "claim-unsupported" : ""} key={i}>{claim.supported ? "✓" : "!"} {claim.text}<small>{claim.source || claim.section}</small></p>)}</div>}
          {kit.tailored && <><Field label="Tailored resume summary" hint="Edit only to reflect your real experience"><textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>{kit.tailored.experience.map((experience, index) => <div className="experience-edit" key={`${experience.company}-${index}`}><h3>{experience.title} · {experience.company}</h3><textarea aria-label={`${experience.company} bullets`} rows={Math.max(3, experience.bullets.length)} value={experience.bullets.join("\n")} onChange={(e) => { if (!kit.tailored) return; const updated: ResumeDocument = { ...kit.tailored, experience: kit.tailored.experience.map((item, i) => i === index ? { ...item, bullets: e.target.value.split("\n") } : item) }; setDetail({ ...detail, kit: { ...kit, tailored: updated } }); }} /></div>)}</>}
          <div className="form-grid"><Field label="Cover letter"><textarea rows={7} value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} /></Field><Field label="Screening answers (JSON)" hint="Edit carefully; mark uncertain answers for human review"><textarea className="code-input" rows={7} value={answersText} onChange={(e) => setAnswersText(e.target.value)} /></Field></div>
          <div className="button-group kit-actions"><Button disabled={busy} onClick={saveEdits}>Save edits</Button><Button disabled={busy} onClick={() => downloadFile("pdf")}>↓ Download PDF</Button><Button disabled={busy} onClick={() => downloadFile("docx")}>↓ Download DOCX</Button><Button variant="primary" disabled={busy || kit.status === "approved"} onClick={() => void act(() => api.approveKit(id), "Kit approved")}>✓ Approve kit</Button></div>
        </Panel>}
        {kit?.answers.some((answer) => answer.needsHuman) && <div className="warning-box"><strong>Human review needed</strong>{kit.answers.filter((answer) => answer.needsHuman).map((answer, i) => <p key={i}>{answer.question}: {answer.humanReason}</p>)}</div>}
      </div>
      <aside className="detail-side">
        <Panel title="Next steps"><div className="action-stack"><Button variant="primary" disabled={busy} onClick={() => void act(() => api.runJob(id), "Job processing complete")}>✦ Process job</Button><Button disabled={busy || !kit} onClick={() => void act(() => api.approveKit(id), "Kit approved")}>✓ Approve kit</Button><Button disabled={busy || !kit} onClick={() => navigate(`/apply/${id}`)}>◉ Apply with assist</Button><hr /><Field label="Application route"><select value={route} onChange={(e) => setRoute(e.target.value)}>{["manual", "ats", "site", "assist"].map((value) => <option key={value}>{value}</option>)}</select></Field><Button disabled={busy} onClick={() => { if (window.confirm("Confirm that you genuinely submitted this application? This records it in your ledger.")) void act(() => api.markApplied(id, route), "Application recorded in your ledger"); }}>✓ Mark genuinely applied</Button><hr /><Field label="Park reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Revisit after portfolio update" /></Field><Button disabled={busy || !reason.trim()} onClick={() => void act(() => api.parkJob(id, reason), "Job parked")}>◷ Park job</Button><Field label="Blocked reason"><select value={blockReason} onChange={(e) => setBlockReason(e.target.value)}>{["captcha", "identity", "lever", "login", "payment", "other"].map((value) => <option key={value}>{value}</option>)}</select></Field><Button disabled={busy} onClick={() => { const instruction = window.prompt("What action is needed from you? (For example, solve a CAPTCHA manually.)"); if (instruction) void act(() => api.blockJob(id, blockReason, instruction, job.url ?? undefined), "Job marked as blocked"); }}>⚑ Mark blocked</Button></div></Panel>
        <Panel title="Pipeline status"><div className="pipeline-details"><div><span>Status</span><StatusPill value={job.status} /></div><div><span>Fit score</span><strong>{job.fitScore == null ? "Not scored" : `${job.fitScore}%`}</strong></div><div><span>ATS</span><strong>{job.atsVendor}</strong></div><div><span>Source</span><strong>{job.source}</strong></div></div>{job.statusReason && <p className="muted status-reason">{job.statusReason}</p>}</Panel>
      </aside>
    </div>
  </>;
}

function ApplyPage({ notify }: { notify: (message: string, kind?: ToastMessage["kind"]) => void }) {
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const [session, setSession] = useState<AssistSession | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const load = useCallback(() => {
    setLoading(true); setError("");
    Promise.all([api.assistStatus(), api.assist(id), api.job(id)]).then(([, value, job]) => {
      setSession(value);
      setDetail(job);
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<AssistSession>, success: string) => {
    setBusy(true); setError("");
    try { setSession(await fn()); notify(success); }
    catch (e) { const message = e instanceof Error ? e.message : "Apply assist failed"; setError(message); notify(message, "error"); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!session || !["starting", "filling"].includes(session.status)) return;
    const timer = window.setInterval(() => api.assist(id).then(setSession).catch(() => undefined), 1800);
    return () => window.clearInterval(timer);
  }, [id, session?.status]);
  if (loading) return <Loading />;
  if (error && !session) return <ErrorState message={error} retry={load} />;
  if (!detail) return <Loading />;
  return <>
    <div className="back-link"><Link to={`/jobs/${id}`}>← Back to job</Link><span>APPLICATION ASSIST</span></div>
    <PageHeading eyebrow={`JOB #${id}`} title="Human-guided application" description="Open the employer’s page yourself and record your application only after you submit it there." action={session && <StatusPill value={session.status} />} />
    {error && <div className="inline-error">{error}<button onClick={() => setError("")}>×</button></div>}
    {!session && <Panel title="Manual application handoff" subtitle="Open the employer’s application page yourself. ApplyPilot will keep your review and submission record here, without interacting with the site."><div className="human-review-callout"><span>◉</span><div><strong>You stay in control</strong><p>No form is filled or submitted by ApplyPilot. You sign in, complete the application, and solve any CAPTCHA yourself.</p></div></div><div className="button-group"><Button variant="primary" disabled={busy} onClick={() => void act(() => api.startAssist(id), "Manual review session started")}>Start review session</Button>{detail.job.url && <a className="button button-secondary" href={detail.job.url} target="_blank" rel="noreferrer">Open job application ↗</a>}</div></Panel>}
    {session && <div className="assist-grid">
      <Panel title="Review timeline" subtitle="Manual application progress"><div className="timeline">{["ready_for_review", "submitted"].map((status, index) => { const isCurrent = status === session.status; const reached = session.status === "submitted" || isCurrent; return <div className={`timeline-row${reached ? " reached" : ""}${isCurrent ? " current" : ""}`} key={status}><span>{reached ? "✓" : index + 1}</span><div><strong>{status.replaceAll("_", " ")}</strong><small>{index === 0 ? "Complete and submit the application on the employer’s site, then confirm below." : "Recorded after your confirmation."}</small></div></div>; })}</div></Panel>
      <Panel title="Application materials" subtitle="Review your approved kit, then use the job site directly."><div className="button-group">{detail.kit?.pdfPath && <Button onClick={() => { void downloadKitPdf(id, `${detail.job.company || "resume"}-${detail.job.title || "application"}.pdf`).catch((cause: unknown) => { const message = cause instanceof Error ? cause.message : "Could not download resume"; setError(message); notify(message, "error"); }); }}>↓ Download approved resume</Button>}{detail.job.url && <a className="button button-secondary" href={detail.job.url} target="_blank" rel="noreferrer">Open job application ↗</a>}</div>{!detail.kit && <EmptyState title="No application kit" detail="Return to the job to process and approve its materials before applying." />}</Panel>
      <Panel title="Activity log" subtitle={`${session.log.length} events`}><div className="activity-log">{session.log.map((item, index) => <div key={`${item.at}-${index}`} className={`log-line log-${item.level}`}><time>{new Date(item.at).toLocaleTimeString()}</time><span>{item.message}</span></div>)}</div></Panel>
    </div>}
    {session && <Panel className="submit-panel"><div className="human-review-callout"><span>✓</span><div><strong>Confirm your manual submission</strong><p>Only confirm after you have submitted on the employer’s site. ApplyPilot cannot submit the form.</p></div></div><div className="button-group"><Button disabled={busy} onClick={() => void act(() => api.closeAssist(id), "Review session closed")}>Close review</Button><Button variant="primary" disabled={busy || session.status !== "ready_for_review"} onClick={() => { if (window.confirm("Confirm that you already submitted this application on the employer’s website? ApplyPilot will only record your confirmation.")) void act(() => api.submitAssist(id), "Your submission was recorded"); }}>{session.status === "submitted" ? "Submission recorded" : "I submitted on the job site"}</Button>{session.status === "submitted" && <Button onClick={() => navigate("/logs")}>View ledger</Button>}</div></Panel>}
  </>;
}

function LogsPage({ notify }: { notify: (message: string, kind?: ToastMessage["kind"]) => void }) {
  const [tab, setTab] = useState<"ledger" | "blocked" | "parked" | "runs">("ledger");
  const [ledger, setLedger] = useState<Awaited<ReturnType<typeof api.ledger>> | null>(null);
  const [blocked, setBlocked] = useState<BlockedItem[] | null>(null);
  const [parked, setParked] = useState<ParkedItem[] | null>(null);
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const load = useCallback(() => {
    setLoading(true); setError("");
    Promise.all([api.ledger(), api.blocked(), api.parked(), api.runs()]).then(([valueLedger, valueBlocked, valueParked, valueRuns]) => {
      setLedger(valueLedger); setBlocked(valueBlocked); setParked(valueParked); setRuns(valueRuns);
    }).catch((e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  const resolve = async (type: "blocked" | "parked", id: number) => {
    setBusyId(id);
    try { if (type === "blocked") await api.resolveBlocked(id); else await api.resolveParked(id); notify("Item resolved"); load(); }
    catch (e) { notify(e instanceof Error ? e.message : "Could not resolve item", "error"); }
    finally { setBusyId(null); }
  };
  if (loading) return <><PageHeading title="Activity & logs" /><Loading /></>;
  if (error && !ledger) return <><PageHeading title="Activity & logs" /><ErrorState message={error} retry={load} /></>;
  return <>
    <PageHeading eyebrow="YOUR AUDIT TRAIL" title="Activity & logs" description="A transparent record of applications, blocks, pauses, and agent work." action={<Button onClick={load}>↻ Refresh</Button>} />
    {error && <div className="inline-error">{error}</div>}
    <div className="tabs"><button className={tab === "ledger" ? "tab active" : "tab"} onClick={() => setTab("ledger")}>Application ledger <span>{ledger?.total ?? 0}</span></button><button className={tab === "blocked" ? "tab active" : "tab"} onClick={() => setTab("blocked")}>Blocked <span>{blocked?.length ?? 0}</span></button><button className={tab === "parked" ? "tab active" : "tab"} onClick={() => setTab("parked")}>Parked <span>{parked?.length ?? 0}</span></button><button className={tab === "runs" ? "tab active" : "tab"} onClick={() => setTab("runs")}>Agent runs <span>{runs?.length ?? 0}</span></button></div>
    <Panel title={tab === "ledger" ? "Genuine applications" : tab === "blocked" ? "Blocked for human action" : tab === "parked" ? "Parked for later" : "Agent run history"} subtitle={tab === "ledger" ? "Only confirmed submissions belong in this ledger." : "Entries are retained until you resolve them."}>
      {tab === "ledger" && <>{ledger?.items.length ? <div className="table-scroll"><table><thead><tr><th>COMPANY</th><th>ROLE</th><th>ROUTE</th><th>SUBMITTED</th><th>NOTES</th></tr></thead><tbody>{ledger.items.map((item) => <tr key={item.id}><td><Link to={`/jobs/${item.jobId}`} className="text-link">{item.company}</Link></td><td>{item.title}</td><td><StatusPill value={item.route} /></td><td>{new Date(item.submittedAt).toLocaleDateString()}</td><td>{item.notes || "—"}</td></tr>)}</tbody></table></div> : <EmptyState title="Your ledger is empty" detail="Confirmed applications will be added here. A prepared kit is not a submitted application." />}</>}
      {tab === "blocked" && <QueueList items={blocked ?? []} kind="blocked" busyId={busyId} onResolve={(id) => resolve("blocked", id)} />}
      {tab === "parked" && <QueueList items={parked ?? []} kind="parked" busyId={busyId} onResolve={(id) => resolve("parked", id)} />}
      {tab === "runs" && (runs?.length ? <RunTable runs={runs} /> : <EmptyState title="No agent runs recorded" detail="Run a job to start an auditable activity history." />)}
    </Panel>
  </>;
}
function QueueList({ items, kind, busyId, onResolve }: { items: (BlockedItem | ParkedItem)[]; kind: "blocked" | "parked"; busyId: number | null; onResolve: (id: number) => void }) {
  if (!items.length) return <EmptyState title={`No ${kind} items`} detail="Items needing attention will show up here." />;
  return <div className="compact-list">{items.map((item) => <div className="queue-row" key={item.id}><div className={`queue-symbol ${kind}`}>{kind === "blocked" ? "⚑" : "◷"}</div><div className="compact-main"><strong>{item.title || `Job #${item.jobId}`} · {item.company || "Unknown company"}</strong><span>{kind === "blocked" ? `${(item as BlockedItem).reason}: ${(item as BlockedItem).actionText}` : `${(item as ParkedItem).reason}${(item as ParkedItem).retryPlan ? ` · ${ (item as ParkedItem).retryPlan}` : ""}`}</span></div><Link className="button button-quiet" to={`/jobs/${item.jobId}`}>Open job</Link><Button disabled={busyId === item.id} onClick={() => onResolve(item.id)}>Resolve</Button></div>)}</div>;
}

function SettingsPage({ notify }: { notify: (message: string, kind?: ToastMessage["kind"]) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [testResult, setTestResult] = useState("");
  const action = useAction(notify);
  const load = useCallback(() => { setLoading(true); setError(""); api.settings().then(setSettings).catch((e: Error) => setError(e.message)).finally(() => setLoading(false)); }, []);
  useEffect(load, [load]);
  if (loading) return <><PageHeading title="Settings" /><Loading /></>;
  if (error && !settings) return <><PageHeading title="Settings" /><ErrorState message={error} retry={load} /></>;
  if (!settings) return null;
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings((current) => current ? { ...current, [key]: value } : current);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const payload: SettingsUpdate = {
      model: settings.model, effort: settings.effort, autoSubmit: settings.autoSubmit, imapHost: settings.imapHost,
      imapPort: settings.imapPort, imapUser: settings.imapUser, imapFolder: settings.imapFolder,
      dailyTarget: settings.dailyTarget, mockMode: settings.mockMode,
    };
    if (apiKey.trim()) payload.anthropicApiKey = apiKey.trim();
    if (imapPassword) payload.imapPassword = imapPassword;
    void action.run(() => api.updateSettings(payload), "Settings saved", (saved) => { setSettings(saved); setApiKey(""); setImapPassword(""); });
  };
  const testKey = async () => { const result = await action.run(() => api.testKey(), "API key test finished"); if (result) setTestResult(result.message); };
  const testEmail = async () => { const result = await action.run(() => api.emailTest(), "Mailbox test finished"); if (result) setTestResult(result.message); };
  return <>
    <PageHeading eyebrow="PREFERENCES & CONNECTIONS" title="Settings" description="Tune your local environment and control how your data is handled." />
    {action.error && <div className="inline-error">{action.error}</div>}{testResult && <div className="inline-success">{testResult}<button onClick={() => setTestResult("")}>×</button></div>}
    <form onSubmit={save}>
      <Panel title="AI connection" subtitle="Credentials are write-only and are never displayed in full.">
        <div className="form-grid"><Field label="Anthropic API key" hint={settings.hasApiKey ? `Saved: ${settings.anthropicApiKeyMasked || "configured"} · source: ${settings.apiKeySource}` : "No key configured"} className="col-span-2"><input type="password" autoComplete="new-password" placeholder={settings.hasApiKey ? "Enter a new key to replace the saved key" : "sk-ant-…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></Field><Field label="Model"><input value={settings.model} onChange={(e) => update("model", e.target.value)} /></Field><Field label="Reasoning effort"><select value={settings.effort} onChange={(e) => update("effort", e.target.value as Settings["effort"])}>{["low", "medium", "high", "max"].map((value) => <option key={value}>{value}</option>)}</select></Field><Field label="Mock mode"><select value={settings.mockMode} onChange={(e) => update("mockMode", e.target.value as Settings["mockMode"])}><option value="auto">Auto</option><option value="on">Always on</option><option value="off">Always live</option></select></Field><Field label="Daily target"><input type="number" min="1" value={settings.dailyTarget} onChange={(e) => update("dailyTarget", Number(e.target.value))} /></Field></div><div className="panel-footer"><Button disabled={action.busy} onClick={testKey}>Test API key</Button><Button variant="primary" type="submit" disabled={action.busy}>Save settings</Button></div><div className="info-line"><span>✦</span>{settings.mockActive ? "Mock mode is active. No model API calls are made; the local deterministic workflow is available." : "Live mode is active. AI agent requests use your configured API key."}</div></Panel>
      <Panel title="Submission safeguards" subtitle="ApplyPilot prepares applications but leaves the decision and submission to you."><div className="safety-box"><strong>Human review stays in the loop</strong><p>This build does not fill or submit application forms. Open the job site yourself and complete the application there. ApplyPilot never solves CAPTCHAs, bypasses sign-in, or asks you to lower account security.</p><label className="toggle-line"><input type="checkbox" checked={settings.autoSubmit} onChange={(e) => update("autoSubmit", e.target.checked)} />Auto-submit preference (reserved; not used in this build)</label><small>All submissions require your manual action on the employer’s site and your confirmation in ApplyPilot.</small></div></Panel>
      <Panel title="Email job alerts" subtitle="IMAP connects using TLS. Use an app password; never lower your email account security."><div className="form-grid"><Field label="IMAP host"><input value={settings.imapHost} onChange={(e) => update("imapHost", e.target.value)} placeholder="imap.gmail.com" /></Field><Field label="TLS port"><input type="number" value={settings.imapPort} onChange={(e) => update("imapPort", Number(e.target.value))} /></Field><Field label="Username"><input value={settings.imapUser} onChange={(e) => update("imapUser", e.target.value)} /></Field><Field label="App password" hint={settings.imapPasswordSet ? "A password is already saved" : "Write-only credential"}><input type="password" autoComplete="new-password" value={imapPassword} onChange={(e) => setImapPassword(e.target.value)} placeholder={settings.imapPasswordSet ? "Enter a new password to replace" : "App password"} /></Field><Field label="Folder"><input value={settings.imapFolder} onChange={(e) => update("imapFolder", e.target.value)} /></Field></div><div className="panel-footer"><Button disabled={action.busy} onClick={testEmail}>Test mailbox</Button><span className="muted">For Gmail, create an App Password with 2-Step Verification enabled.</span></div></Panel>
      <Panel title="Browser & data" subtitle="Form automation is not enabled in this build; applying is manual."><div className="settings-list"><div><span>Chromium available</span><StatusPill value={settings.browserInstalled ? "installed" : "not installed"} /></div><div><span>Local data folder</span><code className="path-code">{settings.dataDir || "Not reported"}</code></div><div><span>Current agent mode</span><StatusPill value={settings.mockActive ? "mock active" : "live"} /></div></div></Panel>
    </form>
  </>;
}
