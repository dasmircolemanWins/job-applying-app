import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { ResumeDocument } from "../../../shared/types.js";
import { TAILORED_DIR, sanitizeFilename } from "../paths.js";

export interface RenderedResume {
  pdfPath: string;
  docxPath: string;
}

function resumeParagraphs(resume: ResumeDocument): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const addHeading = (text: string) => paragraphs.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 100 } }));
  const addText = (text: string) => { if (text.trim()) paragraphs.push(new Paragraph({ children: [new TextRun(text.trim())], spacing: { after: 70 } })); };
  const addBullet = (text: string) => { if (text.trim()) paragraphs.push(new Paragraph({ text: text.trim(), bullet: { level: 0 }, spacing: { after: 60 } })); };

  if (resume.contact.name) paragraphs.push(new Paragraph({ text: resume.contact.name, heading: HeadingLevel.TITLE }));
  const contact = [resume.contact.email, resume.contact.phone, resume.contact.location, ...resume.contact.links].filter(Boolean).join(" | ");
  addText(contact);
  if (resume.summary) { addHeading("Summary"); addText(resume.summary); }
  if (resume.experience.length) {
    addHeading("Experience");
    for (const role of resume.experience) {
      addText([role.title, role.company].filter(Boolean).join(" — "));
      addText([role.start, role.end, role.location].filter(Boolean).join(" | "));
      role.bullets.forEach(addBullet);
    }
  }
  if (resume.skills.length) { addHeading("Skills"); addText(resume.skills.join(" · ")); }
  if (resume.education.length) {
    addHeading("Education");
    for (const entry of resume.education) addText([entry.degree, entry.field, entry.school, entry.year].filter(Boolean).join(" — "));
  }
  if (resume.certifications.length) { addHeading("Certifications"); resume.certifications.forEach(addBullet); }
  if (resume.projects.length) {
    addHeading("Projects");
    for (const project of resume.projects) {
      addText(project.name);
      addText(project.description);
      project.bullets.forEach(addBullet);
    }
  }
  return paragraphs;
}

function writePdf(file: string, resume: ResumeDocument): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 54, bottom: 54, left: 56, right: 56 }, bufferPages: true });
    const output = fs.open(file, "w").then(handle => handle.createWriteStream());
    void output.then(stream => {
      stream.on("error", reject);
      stream.on("finish", resolve);
      doc.pipe(stream);
      const heading = (text: string) => { doc.moveDown(0.65).font("Helvetica-Bold").fontSize(13).fillColor("#17243b").text(text); doc.moveDown(0.2).font("Helvetica").fontSize(10).fillColor("#111111"); };
      const text = (value: string) => { if (value.trim()) doc.font("Helvetica").fontSize(10).fillColor("#111111").text(value.trim(), { lineGap: 2 }); };
      const bullets = (values: string[]) => values.forEach(value => { if (value.trim()) doc.font("Helvetica").fontSize(10).text(`•  ${value.trim()}`, { indent: 10, lineGap: 2 }); });
      if (resume.contact.name) doc.font("Helvetica-Bold").fontSize(20).fillColor("#17243b").text(resume.contact.name);
      const contact = [resume.contact.email, resume.contact.phone, resume.contact.location, ...resume.contact.links].filter(Boolean).join(" | ");
      if (contact) { doc.moveDown(0.25).font("Helvetica").fontSize(9).fillColor("#526175").text(contact); }
      doc.font("Helvetica").fontSize(10).fillColor("#111111");
      if (resume.summary) { heading("Summary"); text(resume.summary); }
      if (resume.experience.length) {
        heading("Experience");
        for (const role of resume.experience) {
          doc.font("Helvetica-Bold").fontSize(10).text([role.title, role.company].filter(Boolean).join(" — "));
          const dates = [role.start, role.end, role.location].filter(Boolean).join(" | ");
          if (dates) doc.font("Helvetica-Oblique").fontSize(9).fillColor("#526175").text(dates).fillColor("#111111");
          bullets(role.bullets);
        }
      }
      if (resume.skills.length) { heading("Skills"); text(resume.skills.join(" · ")); }
      if (resume.education.length) {
        heading("Education");
        for (const entry of resume.education) text([entry.degree, entry.field, entry.school, entry.year].filter(Boolean).join(" — "));
      }
      if (resume.certifications.length) { heading("Certifications"); bullets(resume.certifications); }
      if (resume.projects.length) {
        heading("Projects");
        for (const project of resume.projects) { doc.font("Helvetica-Bold").fontSize(10).text(project.name); text(project.description); bullets(project.bullets); }
      }
      doc.end();
    }).catch(reject);
  });
}

export async function renderResume(jobId: number, company: string, title: string, resume: ResumeDocument): Promise<RenderedResume> {
  await fs.mkdir(TAILORED_DIR, { recursive: true });
  const base = sanitizeFilename(`${company}-${title}-${new Date().toISOString().slice(0, 10)}-${jobId}`);
  const pdfPath = path.join(TAILORED_DIR, `${base}.pdf`);
  const docxPath = path.join(TAILORED_DIR, `${base}.docx`);
  const docx = new Document({ sections: [{ properties: {}, children: resumeParagraphs(resume) }] });
  const content = await Packer.toBuffer(docx);
  await Promise.all([fs.writeFile(docxPath, content), writePdf(pdfPath, resume)]);
  return { pdfPath, docxPath };
}
