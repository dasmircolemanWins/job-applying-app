import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { readSettingOrDefault } from "../config.js";
import { badRequest } from "../http.js";

export interface EmailSweepData {
  scanned: number;
  urls: string[];
}

function mailboxConfig() {
  const host = readSettingOrDefault("imap_host").trim();
  const user = readSettingOrDefault("imap_user").trim();
  const password = readSettingOrDefault("imap_password");
  const port = Number(readSettingOrDefault("imap_port")) || 993;
  const folder = readSettingOrDefault("imap_folder").trim() || "INBOX";
  const missing = [
    !host && "IMAP host",
    !user && "IMAP username",
    !password && "IMAP password",
  ].filter(Boolean);
  if (missing.length) throw badRequest(`Configure ${missing.join(", ")} in Settings before using email alerts.`);
  return { host, user, password, port, folder };
}

function messageSearchText(message: { from?: { text?: string } | null; subject?: string | null; text?: string | null; html?: string | false | null; date?: Date | null }): string {
  const html = typeof message.html === "string" ? message.html.replace(/<[^>]*>/g, " ") : "";
  return [message.from?.text, message.subject, message.text, html].filter(Boolean).join("\n");
}

function extractJobUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const candidate = match[0].replace(/[.,;!?]+$/, "");
    try {
      const url = new URL(candidate);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      const host = url.hostname.toLowerCase();
      if (/unsubscribe|optout|preferences|mailchimp|sendgrid|tracking|click\.|utm_/i.test(candidate)) continue;
      if (!/(job|career|apply|greenhouse|lever|workday|ashby|icims|smartrecruiters|linkedin|indeed)/i.test(candidate + host)) continue;
      urls.push(url.toString());
    } catch {
      // Ignore malformed links in alert messages.
    }
  }
  return [...new Set(urls)];
}

async function withMailbox<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const config = mailboxConfig();
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  try {
    await client.connect();
    return await fn(client);
  } catch {
    throw badRequest("Could not connect to the configured IMAP mailbox. Check the host, port, username, password, and TLS settings.");
  } finally {
    try { await client.logout(); } catch { /* connection may already have closed */ }
  }
}

export async function testMailbox(): Promise<{ ok: true; message: string; mailboxCount: number }> {
  return withMailbox(async client => {
    const lock = await client.getMailboxLock(readSettingOrDefault("imap_folder").trim() || "INBOX");
    try {
      const mailbox = client.mailbox;
      const count = typeof mailbox === "object" && mailbox !== null && "exists" in mailbox
        ? Number((mailbox as { exists: number }).exists) : 0;
      return { ok: true, message: "Connected to the mailbox.", mailboxCount: Number.isFinite(count) ? count : 0 };
    } finally {
      lock.release();
    }
  });
}

export async function sweepMailbox(sinceDays: number): Promise<EmailSweepData> {
  return withMailbox(async client => {
    const folder = readSettingOrDefault("imap_folder").trim() || "INBOX";
    const lock = await client.getMailboxLock(folder);
    try {
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      const urls: string[] = [];
      const searchResult = await client.search({ since }, { uid: true });
      const ids = Array.isArray(searchResult) ? searchResult : [];
      const limitedIds = ids.slice(-500);
      let count = 0;
      for await (const message of client.fetch(limitedIds, { source: true, envelope: true, uid: true }, { uid: true })) {
        if (!message.source) continue;
        const parsed = await simpleParser(message.source);
        urls.push(...extractJobUrls(messageSearchText(parsed)));
        count++;
      }
      return { scanned: count, urls: [...new Set(urls)] };
    } finally {
      lock.release();
    }
  });
}
