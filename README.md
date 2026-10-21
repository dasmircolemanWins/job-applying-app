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
