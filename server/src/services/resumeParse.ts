import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { MAX_UPLOAD_BYTES } from "../../../shared/types.js";
import { badRequest } from "../http.js";

export const ALLOWED_RESUME_TYPES = new Set([
  "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain", "application/octet-stream",
]);

export async function extractResumeText(filename: string, mime: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  const bytes = await fs.readFile(filename);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw badRequest("Resume exceeds 5 MB");
  let text: string;
  if (ext === ".txt" || mime === "text/plain") text = bytes.toString("utf8");
  else if (ext === ".docx" || mime.includes("wordprocessingml")) {
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  } else if (ext === ".pdf" || mime === "application/pdf") {
    const pdf = await import("pdf-parse");
    const parser = new pdf.PDFParse({ data: bytes });
    try {
      text = (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
    if (!text.trim()) throw badRequest("Could not extract text from this PDF");
  } else throw badRequest("Supported resume formats are PDF, DOCX, and TXT");
  const cleaned = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (cleaned.length < 20) throw badRequest("Resume contains too little readable text");
  return cleaned.slice(0, 200_000);
}
