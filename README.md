# ApplyPilot

ApplyPilot is a local-first job-application workspace. It organizes job postings,
compares them with your resumes and preferences, and prepares application materials
for your review. It is a productivity tool, not a promise of a particular number
of applications, interviews, or job offers. Your data is stored in the local
`data/` directory.

## Requirements

- Node.js 24 or newer
- npm 10 or newer

## Run locally

1. Open a terminal in the project directory.
2. Install dependencies:

   ```powershell
   npm install
   ```

3. Start the development servers:

   ```powershell
   npm run dev
   ```

4. Open the web address printed by Vite (normally `http://localhost:5173`).

The API listens on `http://localhost:4310`. In the absence of an Anthropic API
key, agents use deterministic mock mode so you can explore the workflow without
making model calls. To enable live agents, either add a key in Settings or copy
`.env.example` to `.env` and set `ANTHROPIC_API_KEY`. Keep `.env` private; it is
excluded from Git. Live model calls currently power resume analysis, job parsing,
and resume selection. Qualification, tailoring, and answer writing remain
deterministic and use local rules and verified source data.

## First-time setup

1. Add at least one resume; five to ten resumes are recommended for better
   comparisons. PDF, DOCX, and text files are supported, up to 5 MB each.
2. Analyze resumes and build the experience bank.
3. Review and complete your standing facts, job preferences, and application
   stories. Confirm suggested profile details before using them.
4. Add job postings and review each qualification result and application kit
   before proceeding.

## Safe application workflow

ApplyPilot prepares tailored materials from information in your resumes,
standing facts, and approved stories. Review the honesty report and every
generated answer; unsupported statements should not be used. Sensitive
identity questions require your own response.

Application assistance currently uses a manual handoff: open the employer's
page yourself, complete the form, and record the application after you submit
it. This build does not fill or submit application forms. ApplyPilot does not
solve CAPTCHAs, bypass paywalls, or ask you to weaken account security. Respect
each job site's terms.

## Local data

The SQLite database, uploaded resumes, generated documents, browser profile,
and screenshots are stored under `data/`. This directory is excluded from Git.
Back it up privately if you want to preserve your local application history.
Do not share your database or browser profile; they may contain personal
information or authenticated sessions.

## iPhone and App Store

The web app includes an iPhone Home Screen manifest and icons. After the website
is deployed over HTTPS, open it in Safari and choose **Share → Add to Home
Screen** for an installable web-app preview.

A Capacitor iOS project is included for native packaging. On a Mac with Xcode
installed, run:

```sh
npm install
npm run mobile:sync
npm run mobile:open:ios
```

Before `mobile:sync`, set the hosted public values in the Mac terminal so the
native bundle calls the deployed API instead of trying to reach its local
WebView:

```sh
export VITE_API_BASE_URL=https://<your-render-host>
export VITE_SUPABASE_URL=https://<your-project>.supabase.co
export VITE_SUPABASE_ANON_KEY=<your-public-anon-key>
npm run mobile:sync
```

Set the final bundle identifier in `capacitor.config.ts` and Xcode, then configure
Apple signing and App Store Connect on the Mac. This Windows workspace cannot
sign or upload an iOS release. The native project is packaging scaffolding: do
not distribute it until the hosted API URL, authenticated multi-user backend,
privacy policy, and account-deletion flow are configured and tested.

## Render deployment preview

`render.yaml` describes one Render web service for the website and API. To
create it:

1. Create a Supabase project. Turn off public user sign-ups in the Supabase Auth
   settings; sign-up is intentionally unavailable in this build.
2. In Render, choose **New + → Blueprint** and connect this GitHub repository.
3. Enter the Supabase project URL and public anon key when Render requests the
   four `SUPABASE_*` and `VITE_SUPABASE_*` values. These are named separately
   because Vite embeds its `VITE_` values during the web build.
4. After Render assigns a URL, add it as the Supabase Auth site URL and allowed
   redirect URL.

Use only the Supabase public anon key in the web build. Never put a Supabase
service-role key in Render's web-build variables or the iOS app.

Add the Render HTTPS URL to Supabase Auth's allowed site and redirect URLs.
The provided CORS allowlist includes Capacitor's iOS origins; if you use a
custom web domain, add that exact HTTPS origin to `CORS_ALLOWED_ORIGINS` in
Render. Render's free service may sleep when idle.

This is currently a **secure deployment preview, not a usable hosted
workspace**: Supabase Auth can be configured, but production APIs deliberately
return `503` because PostgreSQL per-user repositories, private Storage policies,
and account export/deletion are not implemented. No migration or import of local
resumes/history occurs. Do not advertise this preview as a functioning
multi-user app or submit it to the App Store until those release gates are
complete.

## Development checks

```powershell
npm run typecheck
npm test
npm run build
```

The Playwright browser used for apply assistance is optional. Install Chromium
when needed with:

```powershell
npx playwright install chromium
```
