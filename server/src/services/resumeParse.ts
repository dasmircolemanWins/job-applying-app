import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { MAX_UPLOAD_BYTES } from "../../../shared/types.js";
import { badRequest, HttpError } from "../http.js";

export const ALLOWED_RESUME_TYPES = new Set([
  "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain", "application/octet-stream",
]);

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

interface XmlNode {
  nodeType: number;
  nodeValue: string | null;
  namespaceURI: string | null;
  localName: string | null;
  childNodes: { length: number; item(index: number): XmlNode | null };
}

export async function extractDocxText(bytes: Buffer): Promise<string> {
  let documentXml: string;
  try {
    const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const document = archive.file("word/document.xml");
    if (!document) throw badRequest("DOCX file is missing its document body");
    documentXml = await document.async("string");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw badRequest("Could not read this DOCX file");
  }

  const parserErrors: string[] = [];
  const xml = new DOMParser({
    errorHandler: (level: string, message: unknown) => {
      if (level !== "warning") parserErrors.push(String(message));
    },
  }).parseFromString(documentXml, "application/xml");
  const paragraphs = xml.getElementsByTagNameNS(WORD_NAMESPACE, "p");
  if (parserErrors.length || paragraphs.length === 0) throw badRequest("DOCX document XML is invalid or empty");

  const readParagraph = (node: XmlNode): string => {
    if (node.nodeType === 3) return node.nodeValue ?? "";
    if (node.nodeType !== 1) return "";
    if (node.namespaceURI === WORD_NAMESPACE) {
      if (node.localName === "tab") return "\t";
      if (node.localName === "br" || node.localName === "cr") return "\n";
    }
    let text = "";
    for (let index = 0; index < node.childNodes.length; index += 1) {
      const child = node.childNodes.item(index);
      if (child) text += readParagraph(child);
    }
    return text;
  };

  return Array.from(paragraphs, readParagraph).join("\n");
}

export async function extractResumeText(filename: string, mime: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  const bytes = await fs.readFile(filename);
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw badRequest("Resume exceeds 5 MB");
  let text: string;
  if (ext === ".txt" || mime === "text/plain") text = bytes.toString("utf8");
  else if (ext === ".docx" || mime.includes("wordprocessingml")) text = await extractDocxText(bytes);
  else if (ext === ".pdf" || mime === "application/pdf") {
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
