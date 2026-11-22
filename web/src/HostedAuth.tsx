import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { hostedAuthConfigured, supabase } from "./auth";
import { api, downloadAccountExport } from "./api";
import "./hosted-auth.css";

export default function HostedAuth({ children }: { children?: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");

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
      const { data, error: authError } = mode === "signup"
        ? await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: new URL("/", window.location.origin).toString() },
        })
        : await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;
      if (mode === "signup" && !data.session) {
        setMessage("Account created. Check your email and confirm your address before signing in.");
      } else {
        setSession(data.session);
      }
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

  async function exportAccount() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await downloadAccountExport();
      setMessage("Your account export has been downloaded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account export failed.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (deletePhrase !== "DELETE") return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.deleteAccount();
      setDeleteOpen(false);
      setDeletePhrase("");
      setSession(null);
      const { error: signOutError } = supabase
        ? await supabase.auth.signOut({ scope: "local" })
        : { error: null };
      if (signOutError) {
        setError("Your account was deleted, but this device could not clear its saved session. Refresh this page.");
      } else {
        setMessage("Your account and hosted data have been permanently deleted.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account deletion failed.");
    } finally {
      setBusy(false);
    }
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
    if (children) {
      return (
        <>
          {children}
          <details className="hosted-account-menu">
            <summary>{session.user.email ?? "Account"}</summary>
            {error && <p className="hosted-error" role="alert">{error}</p>}
            {message && <p className="hosted-message" role="status">{message}</p>}
            <button type="button" className="hosted-account-action" disabled={busy} onClick={() => void exportAccount()}>
              {busy ? "Please wait…" : "Export account data"}
            </button>
            <button type="button" className="hosted-account-action" disabled={busy} onClick={() => {
              setDeletePhrase("");
              setError("");
              setDeleteOpen(true);
            }}>
              Delete account
            </button>
            <button type="button" className="hosted-account-action" disabled={busy} onClick={() => void signOut()}>
              Sign out
            </button>
          </details>
          {deleteOpen && <DeleteAccountDialog
            busy={busy}
            phrase={deletePhrase}
            error={error}
            onPhraseChange={setDeletePhrase}
            onCancel={() => { setDeleteOpen(false); setDeletePhrase(""); setError(""); }}
            onConfirm={() => void deleteAccount()}
          />}
        </>
      );
    }

    return <HostedShell>
      <div className="hosted-eyebrow">Signed in</div>
      <h1>Hosted workspace</h1>
      <p>Authentication is active for <strong>{session.user.email ?? "your account"}</strong>.</p>
      <div className="hosted-warning">
        <strong>Hosted workflow availability</strong>
        <p>The Master AI Brain, profile, rules, resume analysis, manual job parsing and qualification, tailored application kits, screening answers, and account export/deletion are available. External web research, automated job processing, mailbox integration, and API-key testing are not yet available.</p>
        <p>Account deletion requires a server-only Supabase admin key. Your local SQLite data is never exposed to hosted accounts.</p>
      </div>
      {error && <p className="hosted-error" role="alert">{error}</p>}
      {message && <p className="hosted-message" role="status">{message}</p>}
      <button className="hosted-button" type="button" disabled={busy} onClick={() => void exportAccount()}>
        {busy ? "Please wait…" : "Export account data"}
      </button>
      <button className="hosted-button" type="button" disabled={busy} onClick={() => setDeleteOpen(true)}>
        Permanently delete account
      </button>
      <button className="hosted-button" type="button" disabled={busy} onClick={() => void signOut()}>Sign out</button>
      {deleteOpen && <DeleteAccountDialog
        busy={busy}
        phrase={deletePhrase}
        error={error}
        onPhraseChange={setDeletePhrase}
        onCancel={() => { setDeleteOpen(false); setDeletePhrase(""); setError(""); }}
        onConfirm={() => void deleteAccount()}
      />}
    </HostedShell>;
  }

  return <HostedShell>
    <div className="hosted-eyebrow">ApplyPilot secure account</div>
    <h1>Sign in</h1>
    <p>{mode === "signup" ? "Create a private workspace. Verify your email before signing in." : "Sign in to your private ApplyPilot workspace."}</p>
    <form className="hosted-form" onSubmit={(event) => void submit(event)}>
      <label>Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>Password
        <input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} required />
      </label>
      {error && <p className="hosted-error" role="alert">{error}</p>}
      {message && <p className="hosted-message" role="status">{message}</p>}
      <button className="hosted-button" type="submit" disabled={busy}>
        {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
      </button>
    </form>
    <button className="hosted-link" type="button" onClick={() => {
      setMode(mode === "signin" ? "signup" : "signin");
      setError("");
      setMessage("");
    }}>
      {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
    </button>
    <p className="hosted-note">Email verification is required. Each account gets a private, user-isolated workspace.</p>
  </HostedShell>;
}

function DeleteAccountDialog({
  busy, phrase, error, onPhraseChange, onCancel, onConfirm,
}: {
  busy: boolean;
  phrase: string;
  error: string;
  onPhraseChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return <div className="delete-account-backdrop">
    <section className="delete-account-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-account-title">
      <div className="hosted-eyebrow">Permanent action</div>
      <h2 id="delete-account-title">Delete your account?</h2>
      <p>This permanently removes your hosted profile, resumes, job history, private files, and sign-in identity. This cannot be undone.</p>
      <label className="delete-account-confirm">Type <strong>DELETE</strong> to confirm
        <input autoFocus value={phrase} onChange={(event) => onPhraseChange(event.target.value)} />
      </label>
      {error && <p className="hosted-error" role="alert">{error}</p>}
      <div className="delete-account-actions">
        <button className="hosted-cancel-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="hosted-danger-button" type="button" disabled={busy || phrase !== "DELETE"} onClick={onConfirm}>
          {busy ? "Deleting…" : "Permanently delete"}
        </button>
      </div>
    </section>
  </div>;
}

function HostedShell({ children }: { children: ReactNode }) {
  return <main className="hosted-shell">
    <section className="hosted-card">
      <a className="hosted-brand" href="/">Apply<span>Pilot</span></a>
      {children}
    </section>
  </main>;
}
