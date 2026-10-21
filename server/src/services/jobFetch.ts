import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as cheerio from "cheerio";
import { badRequest } from "../http.js";

const MAX_HTML_BYTES = 2 * 1024 * 1024;

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254
    || a === 172 && b! >= 16 && b! <= 31 || a === 192 && b === 168
    || a! >= 224;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  if (isIP(normalized) === 4) return isPrivateIPv4(normalized);
  if (normalized.startsWith("::ffff:")) return isPrivateIPv4(normalized.slice(7));
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || normalized.startsWith("fe8")
    || normalized.startsWith("fe9") || normalized.startsWith("fea")
    || normalized.startsWith("feb");
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw badRequest("Job URL must be a public HTTP(S) URL");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw badRequest("Job URL must use a public hostname");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw badRequest("Job URL must resolve to a public host");
}

async function readLimited(response: Response): Promise<string> {
  const statedLength = Number(response.headers.get("content-length") ?? 0);
  if (statedLength > MAX_HTML_BYTES) throw badRequest("Job page is too large to fetch");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_HTML_BYTES) {
      await reader.cancel();
      throw badRequest("Job page is too large to fetch");
    }
    chunks.push(part.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function fetchJobText(rawUrl: string): Promise<string> {
  let url = new URL(rawUrl);
  for (let redirects = 0; redirects <= 4; redirects++) {
    await assertPublicUrl(url);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": "ApplyPilot-local/1.0", accept: "text/html,text/plain" },
      });
    } catch {
      throw badRequest("Could not fetch the job URL");
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 4) throw badRequest("Job page redirected too many times");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw badRequest(`Job page returned HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!/(text\/html|text\/plain)/i.test(type)) throw badRequest("Job URL did not return HTML or plain text");
    const body = await readLimited(response);
    const $ = cheerio.load(body);
    $("script,style,noscript,svg,header,footer,nav,form").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    if (text.length < 20) throw badRequest("Could not extract readable text from the job page");
    return text.slice(0, 200_000);
  }
  throw badRequest("Unable to fetch the job URL");
}
