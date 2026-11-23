import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { hostedAuthConfigured, INVALID_SESSION_EVENT, isPasswordRecoveryRedirect, supabase } from "./auth";
import { api, downloadAccountExport } from "./api";
import "./hosted-auth.css";

export default function HostedAuth({ children }: { children?: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [recoveryMode, setRecoveryMode] = useState(isPasswordRecoveryRedirect);
  const [recoveryComplete, setRecoveryComplete] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePhrase, setDeletePhrase] = useState("");

  useEffect(() => {
    if (!supabase) {
      setChecking(false);
      return;
    }
    const client = supabase;
    let active = true;
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      setSession(data.session);
      if (sessionError) setError(sessionError.message);
      setChecking(false);
    });
    const { data: { subscription } } = client.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
      if (event === "SIGNED_OUT") {
        setRecoveryMode(false);
        setRecoveryComplete(false);
      }
    });
    const handleInvalidSession = () => {
      setError("Your saved session is no longer valid. Sign in again to continue.");
      setMessage("");
      setSession(null);
      void client.auth.signOut({ scope: "local" }).then(({ error: signOutError }) => {
        if (signOutError) {
          setError("Your session is no longer valid. Refresh this page, then sign in again.");
        }
      });
    };
    window.addEventListener(INVALID_SESSION_EVENT, handleInvalidSession);
    return () => {
      active = false;
      subscription.unsubscribe();
      window.removeEventListener(INVALID_SESSION_EVENT, handleInvalidSession);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const firstName = String(form.get("firstName") ?? "").trim();
    const lastName = String(form.get("lastName") ?? "").trim();
    const birthdate = String(form.get("birthdate") ?? "");
    const address = String(form.get("address") ?? "").trim();
    const city = String(form.get("city") ?? "").trim();
    const state = String(form.get("state") ?? "").trim();
    const zipCode = String(form.get("zipCode") ?? "").trim();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "forgot") {
        const redirectTo = new URL("/", window.location.origin);
        redirectTo.searchParams.set("type", "recovery");
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: redirectTo.toString(),
        });
        if (authError) throw authError;
        setMessage("If an account exists for that email, we'll send a password reset link.");
        return;
      }
      const { data, error: authError } = mode === "signup"
        ? await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: new URL("/", window.location.origin).toString(),
            data: {
              first_name: firstName,
              last_name: lastName,
              birthdate,
              address,
              city,
              state,
              zip_code: zipCode,
            },
          },
        })
        : await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;
      if (mode === "signup" && !data.session) {
        setMessage("Your account is ready. Check your email to confirm your address before signing in.");
      } else {
        setSession(data.session);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      setMessage("");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { error: authError } = await supabase.auth.updateUser({ password });
      if (authError) throw authError;
      setRecoveryMode(false);
      setRecoveryComplete(true);
      window.history.replaceState(null, document.title, "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Password reset failed. Request a new reset link and try again.");
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

  if (recoveryMode && !session) {
    return <HostedShell>
      <div className="hosted-eyebrow">Account recovery</div>
      <h1>Reset link unavailable</h1>
      <p>This reset link may have expired or already been used. Request a new link to continue.</p>
      <button className="hosted-button" type="button" onClick={() => {
        setRecoveryMode(false);
        setMode("forgot");
        setError("");
        window.history.replaceState(null, document.title, "/");
      }}>Request a new reset link</button>
    </HostedShell>;
  }

  if (recoveryComplete) {
    return <HostedShell>
      <div className="hosted-eyebrow">Account recovery</div>
      <h1>Password updated</h1>
      <p className="hosted-message" role="status">Your password has been changed successfully.</p>
      <button className="hosted-button" type="button" onClick={() => setRecoveryComplete(false)}>Continue to ApplyPilot</button>
    </HostedShell>;
  }

  if (recoveryMode) {
    return <HostedShell>
      <div className="hosted-eyebrow">Account recovery</div>
      <h1>Choose a new password</h1>
      <p>Use a new password with at least 8 characters. If this reset link has expired, request another from the sign-in page.</p>
      <form className="hosted-form" onSubmit={(event) => void updatePassword(event)}>
        <label>New password
          <input name="password" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
        </label>
        <label>Confirm new password
          <input name="confirmPassword" type="password" autoComplete="new-password" minLength={8} maxLength={128} required />
        </label>
        {error && <p className="hosted-error" role="alert">{error}</p>}
        {message && <p className="hosted-message" role="status">{message}</p>}
        <button className="hosted-button" type="submit" disabled={busy}>
          {busy ? "Updating password…" : "Update password"}
        </button>
      </form>
    </HostedShell>;
  }

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
        <p>The Master AI Brain, public posting research, free Arbeitnow search, JSearch/Adzuna discovery, user-triggered processing into reviewable application drafts, optional read-only mailbox job-alert scans, API-key testing, and account export/deletion are available.</p>
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
    <h1>{mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Welcome back"}</h1>
    <p>{mode === "signup" ? "Set up your private ApplyPilot workspace." : mode === "forgot" ? "Enter the email address for your account and we’ll send a reset link." : "Sign in to your private ApplyPilot workspace."}</p>
    <form className="hosted-form" onSubmit={(event) => void submit(event)}>
      {mode === "signup" && <>
        <fieldset className="hosted-fieldset">
          <legend>Personal information</legend>
          <div className="hosted-form-grid">
            <label>First name
              <input name="firstName" type="text" autoComplete="given-name" maxLength={100} required />
            </label>
            <label>Last name
              <input name="lastName" type="text" autoComplete="family-name" maxLength={100} required />
            </label>
            <label className="hosted-span-two">Birthdate
              <input name="birthdate" type="date" autoComplete="bday" max={new Date().toISOString().slice(0, 10)} required />
            </label>
          </div>
        </fieldset>
        <fieldset className="hosted-fieldset">
          <legend>Home address</legend>
          <div className="hosted-form-grid">
            <label className="hosted-span-two">Street address
              <input name="address" type="text" autoComplete="street-address" maxLength={200} required />
            </label>
            <label>City
              <input name="city" type="text" autoComplete="address-level2" maxLength={100} required />
            </label>
            <label>State
              <input name="state" type="text" autoComplete="address-level1" maxLength={100} required />
            </label>
            <label className="hosted-span-two">ZIP / postal code
              <input name="zipCode" type="text" autoComplete="postal-code" maxLength={20} required />
            </label>
          </div>
        </fieldset>
      </>}
      <label>Email
        <input name="email" type="email" autoComplete="email" maxLength={254} required />
      </label>
      {mode !== "forgot" && <label>Password
        <input name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={8} maxLength={128} required />
      </label>}
      {error && <p className="hosted-error" role="alert">{error}</p>}
      {message && <p className="hosted-message" role="status">{message}</p>}
      <button className="hosted-button" type="submit" disabled={busy}>
        {busy ? "Please wait…" : mode === "signup" ? "Create your account" : mode === "forgot" ? "Send reset link" : "Sign in"}
      </button>
    </form>
    {mode === "signin" && <button className="hosted-link" type="button" onClick={() => {
      setMode("forgot");
      setError("");
      setMessage("");
    }}>Forgot password?</button>}
    {mode !== "forgot" && <button className="hosted-link" type="button" onClick={() => {
      setMode(mode === "signup" ? "signin" : "signup");
      setError("");
      setMessage("");
    }}>
      {mode === "signup" ? "Already have an account? Sign in" : "New to ApplyPilot? Create your account"}
    </button>}
    {mode === "forgot" && <button className="hosted-link" type="button" onClick={() => {
      setMode("signin");
      setError("");
      setMessage("");
    }}>Back to sign in</button>}
    <p className="hosted-note">{mode === "signup"
      ? "We store your account details securely with your private account. Email verification is required before sign-in."
      : mode === "forgot"
        ? "For your privacy, the same confirmation is shown whether or not an account uses that email."
      : "Each account gets a private, user-isolated workspace."}</p>
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
