import fs from "node:fs";
import path from "node:path";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { ZodError } from "zod";
import { DATA_DIR, IS_PRODUCTION, PORT, SCREENSHOTS_DIR, WEB_DIST_DIR, ensureDirs } from "./config.js";
import { initDb } from "./db.js";
import { HttpError, zodIssueSummary } from "./http.js";
import { errorMessage, logger } from "./log.js";
import { router as settingsRouter } from "./routes/settings.js";
import { router as profileRouter } from "./routes/profile.js";
import { router as resumesRouter } from "./routes/resumes.js";
import { router as jobsRouter } from "./routes/jobs.js";
import { router as emailRouter } from "./routes/email.js";
import { router as assistRouter } from "./routes/assist.js";
import { router as logsRouter } from "./routes/logs.js";

ensureDirs();
initDb();

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

// Every router declares its own full sub-paths (e.g. /settings, /profile, /rules,
// /jobs/:id/kit) and is mounted at /api so owners can add sibling resources freely.
app.use("/api", settingsRouter);
app.use("/api", profileRouter);
app.use("/api", resumesRouter);
app.use("/api", jobsRouter);
app.use("/api", emailRouter);
app.use("/api", assistRouter);
app.use("/api", logsRouter);

// Screenshots taken by apply-assist are served read-only for the UI.
app.use("/api/screenshots", express.static(SCREENSHOTS_DIR, { fallthrough: true, index: false }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, dataDir: DATA_DIR, production: IS_PRODUCTION });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Built web app (production): static assets + SPA fallback for client-side routes.
const webDistExists = fs.existsSync(path.join(WEB_DIST_DIR, "index.html"));
if (webDistExists) {
  app.use(express.static(WEB_DIST_DIR, { index: "index.html" }));
  app.get("/{*splat}", (_req: Request, res: Response) => {
    res.sendFile(path.join(WEB_DIST_DIR, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res
      .type("text/plain")
      .send("ApplyPilot API is running. Start the web app with `npm run dev` or build it with `npm run build`.");
  });
}

interface MulterLikeError extends Error {
  code?: string;
}

const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid request: " + zodIssueSummary(err) });
    return;
  }
  if (err instanceof SyntaxError && "status" in err && (err as { status?: number }).status === 400) {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }
  if (err instanceof Error && err.name === "MulterError") {
    const code = (err as MulterLikeError).code ?? "UPLOAD_ERROR";
    res.status(400).json({ error: `Upload rejected (${code}): ${err.message}` });
    return;
  }
  const message = errorMessage(err);
  logger.error("unhandled error", { error: message, stack: err instanceof Error ? err.stack : undefined });
  res.status(500).json({ error: message || "Internal server error" });
};
app.use(errorHandler);

app.listen(PORT, () => {
  logger.info(`ApplyPilot server listening on http://localhost:${PORT}`, {
    production: IS_PRODUCTION,
    webDist: webDistExists,
  });
});
