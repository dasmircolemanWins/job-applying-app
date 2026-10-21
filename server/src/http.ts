import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { z } from "zod";

/** Throw from a route to produce a `{error}` JSON response with the given status. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (msg: string): HttpError => new HttpError(400, msg);
export const notFound = (msg = "Not found"): HttpError => new HttpError(404, msg);
export const conflict = (msg: string): HttpError => new HttpError(409, msg);

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;

/**
 * Wraps an async route so rejections reach the central error handler.
 * Express 5 does this natively, but the wrapper keeps handlers uniform and
 * guards against a response already having been sent.
 */
export function asyncHandler(fn: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err: unknown) => {
      if (res.headersSent) return;
      next(err);
    });
  };
}

/** Summarise Zod issues as a single readable line: `field: message; other: message`. */
export function zodIssueSummary(err: z.ZodError): string {
  return err.issues
    .map((i) => {
      const path = i.path.map((p) => String(p)).join(".");
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join("; ");
}

/** Validate a body/query/params object; throws HttpError(400) with the issue summary. */
export function validate<T>(body: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(400, "Invalid request: " + zodIssueSummary(result.error));
  }
  return result.data;
}

/** Parse a positive integer route param (e.g. `/jobs/:id`), else 400. */
export function idParam(raw: string | string[] | undefined, name = "id"): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}
