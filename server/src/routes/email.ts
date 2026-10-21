import { Router } from "express";
import { z } from "zod";
import { asyncHandler, validate } from "../http.js";
import { createJobFromUrl } from "./jobs.js";
import { sweepMailbox, testMailbox } from "../services/emailAlerts.js";

export const router = Router();

router.post("/email/test", asyncHandler(async (_req, res) => {
  res.json(await testMailbox());
}));

router.post("/email/sweep", asyncHandler(async (req, res) => {
  const body = validate(req.body ?? {}, z.object({ sinceDays: z.number().int().min(1).max(365).default(7) }).strict());
  const mailbox = await sweepMailbox(body.sinceDays);
  const jobsCreated = [];
  const duplicates: string[] = [];
  const failed: { url: string; error: string }[] = [];
  for (const url of mailbox.urls) {
    try {
      jobsCreated.push(await createJobFromUrl(url, "email"));
    } catch (error) {
      if (error instanceof Error && /matching job already exists/i.test(error.message)) duplicates.push(url);
      else failed.push({ url, error: error instanceof Error ? error.message : "Unable to add job from email URL" });
    }
  }
  res.json({
    emailsScanned: mailbox.scanned,
    urlsFound: mailbox.urls.length,
    jobsCreated,
    duplicates: duplicates.length,
    failed,
  });
}));
