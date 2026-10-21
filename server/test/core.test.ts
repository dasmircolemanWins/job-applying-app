import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import JSZip from "jszip";
import { DEFAULT_RULES, DEFAULT_STANDING_FACTS, type ResumeDocument } from "../../shared/types.js";
import { extractDocxText } from "../src/services/resumeParse.js";

const dbPath = path.join(os.tmpdir(), `applypilot-test-${process.pid}-${Date.now()}.db`);
process.env.APPLYPILOT_DB = dbPath;
const previousApiKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const [{ checkHonestyGate }, { fetchJobText }, { db }, agents, config, { ResumeDocumentSchema, JobPostingSchema }] = await Promise.all([
  import("../src/services/pipeline.js"),
  import("../src/services/jobFetch.js"),
  import("../src/db.js"),
  import("../src/services/agents.js"),
  import("../src/config.js"),
  import("../src/agents/schemas.js"),
]);

const source: ResumeDocument = {
  contact: { name: "Jordan Example", email: "jordan@example.test", phone: "", location: "", links: [] },
  summary: "Customer success leader.",
  experience: [{
    company: "Example Co",
    title: "Customer Success Manager",
    start: "2022",
    end: "2025",
    location: "Remote",
    bullets: ["Improved retention by 20%."],
  }],
  education: [],
  skills: ["Customer success", "Salesforce"],
  certifications: [],
  projects: [],
};

test("honesty gate passes an unchanged resume", () => {
  const report = checkHonestyGate(source, source, 1);
  assert.equal(report.verdict, "pass");
  assert.equal(report.unsupportedCount, 0);
});

test("honesty gate rejects unsupported claims and altered standing facts", () => {
  const invented: ResumeDocument = {
    ...source,
    summary: "Award-winning customer success leader.",
    experience: source.experience.map((role) => ({
      ...role,
      bullets: [...role.bullets, "Generated $10 million in revenue."],
    })),
    skills: [...source.skills, "Machine learning"],
  };

  const report = checkHonestyGate(invented, source, 2);
  assert.equal(report.verdict, "fail");
  assert.ok(report.unsupportedCount >= 3);
});

test("mock resume analysis extracts roles and skills from labeled sections", async () => {
  config.writeSetting("mock_mode", "auto");
  config.writeSetting("anthropic_api_key", "");
  assert.equal(config.resolveApiKey(), null);
  assert.equal(config.isMockActive(), true);
  const previousRuns = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM agent_runs WHERE agent='ResumeAnalyst' AND mock=1",
  ).get()?.count ?? 0);
  const parsed = await agents.analyzeResume(`Taylor Jordan
taylor@example.test

SUMMARY
Customer success leader with SaaS experience.

EXPERIENCE
Senior Analyst | Acme Inc.
Jan 2022 - Present
- Improved renewal rate by 20%.

EDUCATION
Example University

SKILLS
SQL, Python, Salesforce`);

  assert.equal(parsed.contact.name, "Taylor Jordan");
  assert.equal(parsed.contact.email, "taylor@example.test");
  assert.equal(parsed.experience[0]?.company, "Acme Inc.");
  assert.equal(parsed.experience[0]?.title, "Senior Analyst");
  assert.deepEqual(parsed.experience[0]?.bullets, ["Improved renewal rate by 20%."]);
  assert.deepEqual(parsed.skills, ["SQL", "Python", "Salesforce"]);
  assert.equal(ResumeDocumentSchema.safeParse(parsed).success, true);
  const currentRuns = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM agent_runs WHERE agent='ResumeAnalyst' AND mock=1",
  ).get()?.count ?? 0);
  assert.equal(currentRuns, previousRuns + 1, "mock ResumeAnalyst should log exactly once");
});

test("DOCX text extraction reads paragraph, tab, and line-break content", async () => {
  const archive = new JSZip();
  archive.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>Customer Success</w:t></w:r></w:p>
        <w:p><w:r><w:t>Skills:</w:t><w:tab/><w:t>Salesforce</w:t><w:br/><w:t>Onboarding</w:t></w:r></w:p>
      </w:body>
    </w:document>`);

  const bytes = await archive.generateAsync({ type: "nodebuffer" });
  assert.equal(await extractDocxText(bytes), "Customer Success\nSkills:\tSalesforce\nOnboarding");
});

test("mock job parsing extracts an ATS posting ID for duplicate protection", async () => {
  assert.equal(config.resolveApiKey(), null);
  assert.equal(config.isMockActive(), true);
  const previousRuns = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM agent_runs WHERE agent='JobParser' AND mock=1",
  ).get()?.count ?? 0);
  const parsed = await agents.parseJob(
    "Senior Analyst role. Location: Remote. Required: SQL and Python. Salary: $100,000 - $120,000.",
    "https://jobs.lever.co/acme/12345678-1234-1234-1234-123456789abc",
    { company: "Acme Inc." },
  );

  assert.equal(parsed.atsVendor, "lever");
  assert.equal(parsed.postingId, "12345678-1234-1234-1234-123456789abc");
  assert.equal(parsed.payMin, 100000);
  assert.equal(JobPostingSchema.safeParse(parsed).success, true);
  assert.equal(JobPostingSchema.safeParse({ ...parsed, payPeriod: "unknown" }).success, true);
  assert.equal(JobPostingSchema.safeParse({ ...parsed, payPeriod: "week" }).success, false);
  const currentRuns = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM agent_runs WHERE agent='JobParser' AND mock=1",
  ).get()?.count ?? 0);
  assert.equal(currentRuns, previousRuns + 1, "mock JobParser should log exactly once");
});

test("mock job parsing keeps listed required skills separate from posting noise", async () => {
  const parsed = await agents.parseJob(
    "Customer Success Manager\nCompany: Smoke Test Co\nLocation: Remote\nRequired skills: Salesforce, customer success, onboarding\nSalary: $100,000 - $120,000",
    "",
    { title: "Customer Success Manager", company: "Smoke Test Co" },
  );

  assert.deepEqual(parsed.requiredSkills, ["Salesforce", "customer success", "onboarding"]);
  assert.deepEqual(parsed.keywords, ["Salesforce", "customer success", "onboarding"]);
  assert.equal(JobPostingSchema.safeParse(parsed).success, true);
});

test("mock resume selection ranks only supplied resumes without model credentials", async () => {
  assert.equal(config.resolveApiKey(), null);
  assert.equal(config.isMockActive(), true);
  const previousRuns = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM agent_runs WHERE agent='ResumeSelector' AND mock=1",
  ).get()?.count ?? 0);
  const job = {
    title: "Customer Success Manager",
    company: "Example Co",
    location: "Remote",
    remoteType: "remote" as const,
    employmentType: "",
    seniority: "",
    requiredSkills: ["Salesforce"],
    niceToHaveSkills: [],
    responsibilities: [],
    keywords: ["Salesforce", "Customer success"],
    atsVendor: "unknown" as const,
    screeningQuestions: [],
  };
  const selection = await agents.selectResume(job, [
    { id: 10, label: "General", doc: { ...source, skills: ["Excel"] } },
    { id: 11, label: "Customer Success", doc: source },
  ], 5);

  assert.equal(selection.selectedResumeId, 11);
  assert.deepEqual(selection.rankings.map(item => item.resumeId), [11, 10]);
  assert.equal(new Set(selection.rankings.map(item => item.resumeId)).size, 2);
  const currentRuns = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM agent_runs WHERE agent='ResumeSelector' AND mock=1",
  ).get()?.count ?? 0);
  assert.equal(currentRuns, previousRuns + 1, "mock ResumeSelector should log exactly once");
});

test("resume tailoring reorders existing skills without adding unsupported claims", () => {
  const original: ResumeDocument = {
    ...source,
    skills: ["Customer success", "Salesforce"],
    experience: [{
      ...source.experience[0]!,
      bullets: ["Led onboarding.", "Improved retention by 20%."],
    }],
  };
  const result = agents.tailorResume({
    title: "Customer Success Manager",
    company: "Example Co",
    location: "Remote",
    remoteType: "remote",
    employmentType: "",
    seniority: "",
    requiredSkills: ["Salesforce"],
    niceToHaveSkills: [],
    responsibilities: [],
    keywords: ["retention"],
    atsVendor: "unknown",
    screeningQuestions: [],
  }, original, 3);

  assert.deepEqual(result.document.experience[0]?.bullets, ["Improved retention by 20%.", "Led onboarding."]);
  assert.deepEqual([...result.document.skills].sort(), [...original.skills].sort());
  assert.equal(result.document.skills[0], "Salesforce");
  assert.equal(result.document.experience[0]?.company, original.experience[0]?.company);
  assert.equal(result.keywordCoverage.coveragePct, 100);
});

test("screening answers use approved stories and enforce the pay floor", () => {
  const facts = {
    ...DEFAULT_STANDING_FACTS,
    fullName: "Jordan Example",
    desiredPay: 110000,
    payFloor: 100000,
    payCurrency: "USD",
  };
  const stories = [{
    key: "pipeline_built",
    title: "A system I built",
    body: "I built a documented system using my verified experience.",
    approved: true,
  }];
  const result = agents.makeAnswers(
    ["What pipeline have you built?", "What is your minimum acceptable salary?", "What is your Social Security number?"],
    facts,
    stories,
    {
      ...{
        title: "Analyst",
        company: "Example Co",
        location: "Remote",
        remoteType: "remote" as const,
        employmentType: "",
        seniority: "",
        requiredSkills: [],
        niceToHaveSkills: [],
        responsibilities: [],
        keywords: [],
        atsVendor: "unknown" as const,
        screeningQuestions: [],
      },
      payMin: 90000,
      payCurrency: "USD",
    },
    4,
    DEFAULT_RULES,
  );

  assert.equal(result.answers[0]?.answer, stories[0]?.body);
  assert.equal(result.answers[0]?.source, "story:pipeline_built");
  assert.equal(result.answers[1]?.answer, "USD 100000");
  assert.equal(result.answers[2]?.needsHuman, true);
  assert.equal(result.answers[2]?.answer, "");
});

test("job fetch rejects loopback and private-network URLs", async () => {
  await assert.rejects(fetchJobText("http://127.0.0.1:4310/private"), /public host/);
  await assert.rejects(fetchJobText("http://192.168.1.1/jobs/1"), /public host/);
});

test("new profiles do not assume work authorization or sponsorship answers", () => {
  assert.equal(DEFAULT_STANDING_FACTS.workAuthorization, "");
  assert.equal(DEFAULT_STANDING_FACTS.sponsorshipAnswer, "");
  assert.equal(DEFAULT_STANDING_FACTS.requiresSponsorship, null);
  assert.equal(DEFAULT_STANDING_FACTS.locationMode, "any");
});

after(async () => {
  db.close();
  await Promise.all(
    [`${dbPath}-wal`, `${dbPath}-shm`, dbPath].map((file) =>
      fs.rm(file, { force: true }),
    ),
  );
  if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousApiKey;
});
