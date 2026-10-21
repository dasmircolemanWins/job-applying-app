import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { Router, type Request } from "express";
import { z } from "zod";
import { MAX_RESUMES, MAX_UPLOAD_BYTES } from "../../../shared/types.js";
import { all, get, nowIso, run } from "../db.js";
import { badRequest, asyncHandler, conflict, idParam, notFound, validate } from "../http.js";
import { UPLOADS_DIR, sanitizeFilename } from "../paths.js";
import { ALLOWED_RESUME_TYPES, extractResumeText } from "../services/resumeParse.js";
import { analyzeResume, buildBank } from "../services/agents.js";
import { dbBank, dbResume } from "../services/core.js";

export const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_RESUMES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_RESUME_TYPES.has(file.mimetype) || file.mimetype === "application/octet-stream") {
      cb(badRequest("Only PDF, DOCX, and TXT files are accepted"));
      return;
    }
    const ext = path.extname(file.originalname).toLowerCase();
    const valid = (ext === ".pdf" && file.mimetype === "application/pdf")
      || (ext === ".docx" && file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      || (ext === ".txt" && file.mimetype === "text/plain");
    if (valid) cb(null, true);
    else cb(badRequest("File extension and content type must match PDF, DOCX, or TXT"));
  },
}).fields([{ name: "files[]", maxCount: MAX_RESUMES }, { name: "files", maxCount: MAX_RESUMES }]);

function fileList(req: Request): Express.Multer.File[] {
  if (Array.isArray(req.files)) return req.files;
  const fields = req.files as Record<string, Express.Multer.File[]> | undefined;
  return fields ? Object.values(fields).flat() : [];
}
function assertSignature(file: Express.Multer.File): void {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf" && file.buffer.subarray(0, 5).toString() !== "%PDF-") throw badRequest(`Invalid PDF file: ${file.originalname}`);
  if (ext === ".docx" && file.buffer.subarray(0, 2).toString() !== "PK") throw badRequest(`Invalid DOCX file: ${file.originalname}`);
  if (ext === ".txt" && file.buffer.includes(0)) throw badRequest(`Invalid text file: ${file.originalname}`);
}
function rowResume(id: number, full = false) {
  const row = get<Record<string, unknown>>("SELECT * FROM resumes WHERE id=?", id);
  if (!row) throw notFound("Resume not found");
  return dbResume(row, full);
}
function invalidateBank() {
  run("DELETE FROM experience_bank");
}

router.get("/resumes", (_req, res) => {
  const rows = all<Record<string, unknown>>("SELECT * FROM resumes ORDER BY uploaded_at,id");
  res.json(rows.map(r => dbResume(r)));
});

router.post("/resumes", upload, asyncHandler(async (req, res) => {
  const files = fileList(req);
  if (!files.length) throw badRequest("Select at least one resume file in files[]");
  const count = get<{ count: number }>("SELECT COUNT(*) AS count FROM resumes")?.count ?? 0;
  if (count + files.length > MAX_RESUMES) throw conflict(`At most ${MAX_RESUMES} resumes can be stored`);
  const added: number[] = [];
  try {
    for (const file of files) {
      assertSignature(file);
      const ext = path.extname(file.originalname).toLowerCase();
      const filename = `${randomUUID()}${ext}`;
      const fullPath = path.join(UPLOADS_DIR, filename);
      await fs.writeFile(fullPath, file.buffer, { flag: "wx" });
      try {
        const text = await extractResumeText(fullPath, file.mimetype);
        const currentCount = get<{ count: number }>("SELECT COUNT(*) AS count FROM resumes")?.count ?? 0;
        if (currentCount >= MAX_RESUMES) throw conflict(`At most ${MAX_RESUMES} resumes can be stored`);
        const ts = nowIso();
        const result = run(
          "INSERT INTO resumes(filename,original_name,mime,text,label,is_base,parsed_json,skills_json,uploaded_at,created_at,updated_at) VALUES(?,?,?,?,?,0,NULL,'[]',?,?,?)",
          filename, path.basename(file.originalname), file.mimetype, text, path.basename(file.originalname, ext), ts, ts, ts,
        );
        added.push(result.lastInsertRowid);
      } catch (error) {
        await fs.unlink(fullPath).catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    for (const id of added) {
      const row = get<{ filename: string }>("SELECT filename FROM resumes WHERE id=?", id);
      if (row) await fs.unlink(path.join(UPLOADS_DIR, row.filename)).catch(() => undefined);
      run("DELETE FROM resumes WHERE id=?", id);
    }
    throw error;
  }
  invalidateBank();
  res.status(201).json(added.map(id => rowResume(id)));
}));

router.get("/resumes/:id", (req, res) => res.json(rowResume(idParam(req.params.id), true)));
router.patch("/resumes/:id", asyncHandler((req, res) => {
  const id = idParam(req.params.id);
  const body = validate(req.body, z.object({ label: z.string().trim().max(200).optional(), is_base: z.boolean().optional() }).strict());
  const old = get<Record<string, unknown>>("SELECT * FROM resumes WHERE id=?", id);
  if (!old) throw notFound("Resume not found");
  const ts = nowIso();
  if (body.is_base === true) run("UPDATE resumes SET is_base=0,updated_at=?", ts);
  run("UPDATE resumes SET label=COALESCE(?,label),is_base=COALESCE(?,is_base),updated_at=? WHERE id=?",
    body.label ?? null, body.is_base === undefined ? null : body.is_base ? 1 : 0, ts, id);
  res.json(rowResume(id));
}));
router.delete("/resumes/:id", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  const row = get<{ filename: string }>("SELECT filename FROM resumes WHERE id=?", id);
  if (!row) throw notFound("Resume not found");
  run("DELETE FROM resumes WHERE id=?", id);
  await fs.unlink(path.join(UPLOADS_DIR, row.filename)).catch(() => undefined);
  invalidateBank();
  res.status(204).end();
}));

router.post("/resumes/:id/analyze", asyncHandler(async (req, res) => {
  const id = idParam(req.params.id);
  const row = get<{ text: string }>("SELECT text FROM resumes WHERE id=?", id);
  if (!row) throw notFound("Resume not found");
  const parsed = await analyzeResume(row.text);
  run("UPDATE resumes SET parsed_json=?,skills_json=?,updated_at=? WHERE id=?", JSON.stringify(parsed), JSON.stringify(parsed.skills), nowIso(), id);
  invalidateBank();
  res.json(parsed);
}));
router.post("/resumes/analyze-all", asyncHandler(async (_req, res) => {
  const rows = all<{ id: number; text: string }>("SELECT id,text FROM resumes WHERE parsed_json IS NULL ORDER BY id");
  for (const row of rows) {
    const parsed = await analyzeResume(row.text);
    run("UPDATE resumes SET parsed_json=?,skills_json=?,updated_at=? WHERE id=?", JSON.stringify(parsed), JSON.stringify(parsed.skills), nowIso(), row.id);
  }
  if (rows.length) invalidateBank();
  res.json({ analyzed: rows.length });
}));

router.get("/experience-bank", (_req, res) => res.json(dbBank()));
router.post("/experience-bank/build", asyncHandler(async (_req, res) => {
  const rows = all<{ id: number; text: string; parsed_json: string | null }>("SELECT id,text,parsed_json FROM resumes ORDER BY id");
  if (!rows.length) throw badRequest("Upload at least one resume before building the experience bank");
  const docs = [];
  for (const row of rows) {
    const doc = row.parsed_json ? JSON.parse(row.parsed_json) : await analyzeResume(row.text);
    if (!row.parsed_json) run("UPDATE resumes SET parsed_json=?,skills_json=?,updated_at=? WHERE id=?", JSON.stringify(doc), JSON.stringify(doc.skills), nowIso(), row.id);
    docs.push({ resumeId: row.id, doc });
  }
  const bank = buildBank(docs);
  const ts = nowIso();
  run(`INSERT INTO experience_bank(id,bank_json,built_from_json,built_at,created_at,updated_at) VALUES(1,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET bank_json=excluded.bank_json,built_from_json=excluded.built_from_json,built_at=excluded.built_at,updated_at=excluded.updated_at`,
    JSON.stringify(bank), JSON.stringify(docs.map(x => x.resumeId)), ts, ts, ts);
  res.json(bank);
}));
