import { z } from "zod";
import { PAY_PERIODS } from "../../../shared/types.js";

const resumeExperienceSchema = z.object({
  company: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  location: z.string(),
  bullets: z.array(z.string()),
}).strict();

const resumeEducationSchema = z.object({
  school: z.string(),
  degree: z.string(),
  field: z.string(),
  year: z.string(),
}).strict();

const resumeProjectSchema = z.object({
  name: z.string(),
  description: z.string(),
  bullets: z.array(z.string()),
}).strict();

export const ResumeDocumentSchema = z.object({
  contact: z.object({
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    location: z.string(),
    links: z.array(z.string()),
  }).strict(),
  summary: z.string(),
  experience: z.array(resumeExperienceSchema),
  education: z.array(resumeEducationSchema),
  skills: z.array(z.string()),
  certifications: z.array(z.string()),
  projects: z.array(resumeProjectSchema),
}).strict();

export const JobPostingSchema = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string(),
  remoteType: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  payMin: z.number().nonnegative().optional(),
  payMax: z.number().nonnegative().optional(),
  payCurrency: z.string().optional(),
  payPeriod: z.enum(PAY_PERIODS).optional(),
  employmentType: z.string(),
  seniority: z.string(),
  requiredSkills: z.array(z.string()),
  niceToHaveSkills: z.array(z.string()),
  responsibilities: z.array(z.string()),
  keywords: z.array(z.string()),
  yearsExperience: z.number().nonnegative().optional(),
  atsVendor: z.enum([
    "greenhouse", "lever", "workday", "ashby", "workable", "icims",
    "smartrecruiters", "bamboohr", "linkedin", "indeed", "other", "unknown",
  ]),
  postingId: z.string().optional(),
  applyUrl: z.string().optional(),
  screeningQuestions: z.array(z.string()),
}).strict();

export const QualificationSchema = z.object({
  qualifies: z.boolean(),
  fitScore: z.number().min(0).max(100),
  reasons: z.array(z.string()),
  blockers: z.array(z.string()),
  gaps: z.array(z.string()),
  matchedSkills: z.array(z.string()),
}).strict();

export const ResumeSelectionSchema = z.object({
  rankings: z.array(z.object({
    resumeId: z.number().int().positive(),
    score: z.number().min(0).max(100),
    strengths: z.array(z.string()),
    weaknesses: z.array(z.string()),
  }).strict()),
  selectedResumeId: z.number().int().positive(),
  rationale: z.string(),
}).strict();
