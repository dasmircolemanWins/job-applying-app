import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { hostedAuthConfigured, supabase } from "./auth";
import "./hosted-auth.css";

export default function HostedAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!supabase) {
      setChecking(false);
      return;
    }
    let active = true;
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      setSession(data.session);
      if (sessionError) setError(sessionError.message);
      setChecking(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;
      setSession(data.session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error: authError } = await supabase.auth.signOut();
    if (authError) setError(authError.message);
    setSession(null);
  }

  if (!hostedAuthConfigured) {
    return <HostedShell>
      <h1>Hosted authentication is not configured</h1>
      <p>Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to public Supabase project values, then rebuild the web app.</p>
      <p className="hosted-note">The hosted API remains closed. The service-role key must never be added to the web app.</p>
    </HostedShell>;
  }

  if (checking) return <HostedShell><p>Checking your session…</p></HostedShell>;

  if (session) {
    return <HostedShell>
      <div className="hosted-eyebrow">Signed in</div>
      <h1>Workspace unavailable</h1>
      <p>Authentication is active for <strong>{session.user.email ?? "your account"}</strong>.</p>
      <div className="hosted-warning">
        <strong>Hosted workspace is not enabled.</strong>
        <p>Production API routes remain disabled until per-user PostgreSQL access and private Supabase Storage policies are implemented and verified. No local SQLite data is available to this deployment.</p>
        <p>Account data export and in-app account deletion are not implemented. Do not use this deployment as a production multi-user service.</p>
      </div>
      {error && <p className="hosted-error" role="alert">{error}</p>}
      <button className="hosted-button" type="button" onClick={() => void signOut()}>Sign out</button>
    </HostedShell>;
  }

  return <HostedShell>
    <div className="hosted-eyebrow">ApplyPilot secure account</div>
    <h1>Sign in</h1>
    <p>Account creation is disabled until a user-isolated workspace and account deletion flow are ready.</p>
    <form className="hosted-form" onSubmit={(event) => void submit(event)}>
      <label>Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>Password
        <input name="password" type="password" autoComplete="current-password" minLength={8} required />
      </label>
      {error && <p className="hosted-error" role="alert">{error}</p>}
      {message && <p className="hosted-message" role="status">{message}</p>}
      <button className="hosted-button" type="submit" disabled={busy}>
        {busy ? "Please wait…" : "Sign in"}
      </button>
    </form>
    <p className="hosted-note">Sign-up is not available in ApplyPilot. Also disable new-user sign-ups in the Supabase Auth project settings: the public anon key can otherwise be used to call Supabase Auth directly, outside this app.</p>
  </HostedShell>;
}

function HostedShell({ children }: { children: ReactNode }) {
  return <main className="hosted-shell">
    <section className="hosted-card">
      <a className="hosted-brand" href="/">Apply<span>Pilot</span></a>
      {children}
    </section>
  </main>;
}
