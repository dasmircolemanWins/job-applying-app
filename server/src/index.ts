import fs from "node:fs";
import path from "node:path";
import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { ZodError } from "zod";
import { DATA_DIR, SCREENSHOTS_DIR, WEB_DIST_DIR, ensureDirs } from "./paths.js";
import { createApiCorsMiddleware, createSupabaseAuthMiddleware, productionDataUnavailable } from "./auth.js";
import { HttpError, zodIssueSummary } from "./http.js";
import { errorMessage, logger } from "./log.js";

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 4310;

export const app = express();
app.disable("x-powered-by");

app.use("/api", createApiCorsMiddleware());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ...(IS_PRODUCTION ? {} : { dataDir: DATA_DIR }),
    production: IS_PRODUCTION,
    dataApi: IS_PRODUCTION ? "disabled" : "local-only",
  });
});

if (IS_PRODUCTION) {
  // SQLite is still a shared local store. Do not even load its routes or open its database in production.
  app.use("/api", createSupabaseAuthMiddleware());
  const { createAccountRouter } = await import("./routes/account.js");
  app.use("/api", createAccountRouter());
  app.use("/api", productionDataUnavailable());
} else {
  ensureDirs();
  app.use(express.json({ limit: "10mb" }));
  const [
    { router: settingsRouter },
    { router: profileRouter },
    { router: resumesRouter },
    { router: jobsRouter },
    { router: emailRouter },
    { router: assistRouter },
    { router: logsRouter },
  ] = await Promise.all([
    import("./routes/settings.js"),
    import("./routes/profile.js"),
    import("./routes/resumes.js"),
    import("./routes/jobs.js"),
    import("./routes/email.js"),
    import("./routes/assist.js"),
    import("./routes/logs.js"),
  ]);

  // Local development retains the original SQLite-backed API behavior.
  app.use("/api", settingsRouter);
  app.use("/api", profileRouter);
  app.use("/api", resumesRouter);
  app.use("/api", jobsRouter);
  app.use("/api", emailRouter);
  app.use("/api", assistRouter);
  app.use("/api", logsRouter);
  app.use("/api/screenshots", express.static(SCREENSHOTS_DIR, { fallthrough: true, index: false }));
}

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

app.listen(PORT, IS_PRODUCTION ? "0.0.0.0" : "127.0.0.1", () => {
  logger.info(`ApplyPilot server listening on http://localhost:${PORT}`, {
    production: IS_PRODUCTION,
    webDist: webDistExists,
  });
});
