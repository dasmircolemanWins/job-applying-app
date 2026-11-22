import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readSettingOrDefault } from "../config.js";
import { badRequest } from "../http.js";

export interface EmailSweepData {
  scanned: number;
  urls: string[];
}

export interface MailboxConfig {
  host: string;
  user: string;
  password: string;
  port: number;
  folder: string;
}

function mailboxConfig(config?: Partial<MailboxConfig>): MailboxConfig {
  const host = (config?.host ?? readSettingOrDefault("imap_host")).trim();
  const user = (config?.user ?? readSettingOrDefault("imap_user")).trim();
  const password = config?.password ?? readSettingOrDefault("imap_password");
  const port = config?.port ?? (Number(readSettingOrDefault("imap_port")) || 993);
  const folder = (config?.folder ?? readSettingOrDefault("imap_folder")).trim() || "INBOX";
  const missing = [
    !host && "IMAP host",
    !user && "IMAP username",
    !password && "IMAP password",
  ].filter(Boolean);
  if (missing.length) throw badRequest(`Configure ${missing.join(", ")} in Settings before using email alerts.`);
  return { host, user, password, port, folder };
}

function privateAddress(address: string): boolean {
  const value = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
      || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168 || a! >= 224;
  }
  if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd")
    || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
}

async function assertPublicMailboxHost(host: string): Promise<void> {
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || isIP(host)) {
    throw badRequest("IMAP host must be a public DNS hostname.");
  }
  const addresses = await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
    throw badRequest("IMAP host must resolve only to public IP addresses.");
  }
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

async function withMailbox<T>(fn: (client: ImapFlow) => Promise<T>, suppliedConfig?: Partial<MailboxConfig>): Promise<T> {
  const config = mailboxConfig(suppliedConfig);
  await assertPublicMailboxHost(config.host);
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

export async function testMailbox(config?: Partial<MailboxConfig>): Promise<{ ok: true; message: string; mailboxCount: number }> {
  return withMailbox(async client => {
    const lock = await client.getMailboxLock(mailboxConfig(config).folder);
    try {
      const mailbox = client.mailbox;
      const count = typeof mailbox === "object" && mailbox !== null && "exists" in mailbox
        ? Number((mailbox as { exists: number }).exists) : 0;
      return { ok: true, message: "Connected to the mailbox.", mailboxCount: Number.isFinite(count) ? count : 0 };
    } finally {
      lock.release();
    }
  }, config);
}

export async function sweepMailbox(sinceDays: number, config?: Partial<MailboxConfig>): Promise<EmailSweepData> {
  return withMailbox(async client => {
    const folder = mailboxConfig(config).folder;
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
      return { scanned: count, urls: [...new Set(urls)].slice(0, 100) };
    } finally {
      lock.release();
    }
  }, config);
}
