// Linked documents in email: finding the download links in an HTML body,
// telling a real document link from a website / signature / tracking link,
// and fetching a file safely — https only, named services or a plain document
// URL, never an internal address, redirects re-checked hop by hop, a size cap,
// and the first bytes checked so an HTML error or sign-in page is never filed
// as a document. Pure where it can be (scripts/inbox-api-test.mjs runs it
// offline with a fake fetch); inbox-api.mjs is the only other caller.
//
// Nothing here opens, runs or renders a file: bytes are moved from the source
// to OneDrive and looked at only for their first few bytes.

import dns from "node:dns/promises";
import net from "node:net";

export const MAX_REDIRECTS = 5;
export const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;   // refuse anything bigger up front
export const CHUNK_BYTES = 8 * 327680;                   // 2.5 MiB: a Graph upload chunk (multiple of 320 KiB)
export const DOC_EXT = /\.(pdf|docx?|dotx?|xlsx?|xlsm|csv|pptx?|dwg|dxf|dwf|dwfx|rvt|rfa|ifc|skp|pln|zip|7z|rar|png|jpe?g|jfif|gif|tiff?|heic|bmp|webp|svg|txt|rtf|msg|eml|kmz|kml)$/i;

// Services whose links we know how to download from without a browser.
const SERVICE_HOSTS = [
  { service: "icloud_maildrop", hosts: ["www.icloud.com", "icloud.com"], cdn: [/\.icloud-content\.com$/] },
  { service: "dropbox", hosts: ["www.dropbox.com", "dropbox.com", "dl.dropboxusercontent.com"], cdn: [/\.dropboxusercontent\.com$/, /^dl\.dropbox\.com$/] },
  { service: "google_drive", hosts: ["drive.google.com", "docs.google.com", "drive.usercontent.google.com"], cdn: [/\.googleusercontent\.com$/, /^drive\.usercontent\.google\.com$/] },
  { service: "onedrive", hosts: ["1drv.ms", "onedrive.live.com"], cdn: [/\.sharepoint\.com$/, /\.files\.1drv\.com$/, /\.1drv\.com$/, /^onedrive\.live\.com$/, /\.storage\.live\.com$/] },
  { service: "sharepoint", hosts: [], cdn: [/\.sharepoint\.com$/] },
  { service: "wetransfer", hosts: ["we.tl", "wetransfer.com", "www.wetransfer.com"], cdn: [/\.wetransfer\.com$/] },
];
// Links that are never documents: social, maps, calendars, unsubscribe and
// tracking hosts, and Mworx's own site.
const IGNORE_HOSTS = [/(^|\.)facebook\.com$/, /(^|\.)instagram\.com$/, /(^|\.)linkedin\.com$/, /(^|\.)twitter\.com$/, /(^|\.)x\.com$/, /(^|\.)youtube\.com$/, /(^|\.)tiktok\.com$/, /(^|\.)pinterest\.com$/, /(^|\.)google\.com$/, /(^|\.)apple\.com$/, /(^|\.)microsoft\.com$/, /(^|\.)mworxgroup\.com\.au$/, /(^|\.)w3\.org$/, /(^|\.)aka\.ms$/, /(^|\.)list-manage\.com$/, /(^|\.)mailchimp\.com$/, /(^|\.)sendgrid\.net$/, /(^|\.)hubspot\.com$/, /(^|\.)safelinks\.protection\.outlook\.com$/];
const PORTAL_HINTS = /portal|login|sign ?in|download|view (the )?(document|file|plan|drawing)|open (the )?(document|file)|shared (a )?(file|folder)|attachment|transfer/i;

export const sanitizeFilename = (name) => String(name || "")
  .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^\.+/, "").replace(/\s+/g, " ").trim().slice(0, 180) || "file";

/** `<a href>` links in an HTML body, with their visible text, deduplicated. */
export function extractLinks(html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push({ href, text: decodeEntities(m[4].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200) });
  }
  return out;
}

export function decodeEntities(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** Outlook's Safe Links wrapper (safelinks.protection.outlook.com/?url=...) unwrapped. */
export function unwrapSafeLink(href) {
  try {
    const u = new URL(href);
    if (/\.safelinks\.protection\.outlook\.com$/i.test(u.hostname) && u.searchParams.get("url")) return u.searchParams.get("url");
  } catch { /* not a URL */ }
  return href;
}

/**
 * iCloud Mail Drop: https://www.icloud.com/attachment/?u=<encoded CDN url with
 * ${f} and ${uk} placeholders>&uk=<key>&f=<filename>&sz=<bytes>. The CDN url
 * carries the expiry (e=<epoch>). The direct url is private — it goes into the
 * encrypted transfer token, never into a response.
 */
export function icloudMailDrop(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!/^(www\.)?icloud\.com$/i.test(u.hostname) || !u.pathname.startsWith("/attachment")) return null;
  const raw = u.searchParams.get("u"), uk = u.searchParams.get("uk"), f = u.searchParams.get("f"), sz = u.searchParams.get("sz");
  if (!raw || !uk || !f) return { service: "icloud_maildrop", kind: "portal", note: "Mail Drop link without a direct address — open it in a browser" };
  const direct = raw.replace(/\$\{f\}/g, encodeURIComponent(f)).replace(/\$\{uk\}/g, encodeURIComponent(uk));
  let expires = null;
  try { const e = new URL(direct).searchParams.get("e"); if (e && /^\d+$/.test(e)) expires = new Date(Number(e) * 1000).toISOString(); } catch { /* ignore */ }
  const expired = expires ? new Date(expires).getTime() < Date.now() : false;
  return { service: "icloud_maildrop", kind: expired ? "expired" : "download", filename: sanitizeFilename(f), size: sz && /^\d+$/.test(sz) ? Number(sz) : null, expires, direct_url: direct };
}

function serviceOf(hostname) {
  const h = hostname.toLowerCase();
  for (const s of SERVICE_HOSTS) if (s.hosts.includes(h) || s.cdn.some((re) => re.test(h))) return s.service;
  return null;
}

/**
 * What a link is: a document we can fetch ("download"), a page that needs a
 * browser, a sign-in or a decision ("portal"), or nothing to do with documents
 * ("ignored"). Never returns the private direct url for Mail Drop in `href`.
 */
export function classifyLink(rawHref, text = "") {
  const href = unwrapSafeLink(rawHref);
  let u;
  try { u = new URL(href); } catch { return { href: rawHref, kind: "ignored", reason: "not a URL" }; }
  if (u.protocol === "mailto:" || u.protocol === "tel:" || u.protocol === "sms:") return { href, kind: "ignored", reason: u.protocol.slice(0, -1) };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { href, kind: "ignored", reason: `${u.protocol} link` };
  const host = u.hostname.toLowerCase();
  const icloud = icloudMailDrop(href);
  if (icloud) return { href, text, ...icloud };
  const service = serviceOf(host);
  const base = { href, text, service };
  if (service === "dropbox") {
    if (/\/(s|sh|scl\/fi|scl\/fo)\//.test(u.pathname)) { const d = new URL(href); d.searchParams.set("dl", "1"); return { ...base, kind: "download", filename: guessFilename(u, text), direct_url: d.toString(), note: "Dropbox shared link fetched with dl=1" }; }
    return { ...base, kind: "portal", note: "Dropbox page, not a shared file link" };
  }
  if (service === "google_drive") {
    const id = (u.pathname.match(/\/file\/d\/([^/]+)/) || [])[1] || u.searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return { ...base, kind: "download", filename: guessFilename(u, text), direct_url: `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download`, note: "Google Drive file; only files shared with anyone-with-the-link download without sign-in" };
    return { ...base, kind: "portal", note: "Google Docs / Drive folder — needs a browser" };
  }
  if (service === "onedrive" || service === "sharepoint") return { ...base, kind: "portal", note: "OneDrive / SharePoint share link — fetch through Graph (shares) with Michel's connection; a link that needs sign-in stays a task" , share: true };
  if (service === "wetransfer") return { ...base, kind: "portal", note: "WeTransfer needs its web page to start the download" };
  if (IGNORE_HOSTS.some((re) => re.test(host))) return { ...base, kind: "ignored", reason: "website / social / tracking link" };
  if (u.protocol !== "https:") return { ...base, kind: "portal", reason: "http link; only https is fetched", note: "Open it in a browser if it matters" };
  const pathname = decodeURIComponent(u.pathname);
  if (DOC_EXT.test(pathname)) return { ...base, kind: "download", filename: sanitizeFilename(pathname.split("/").pop()), direct_url: href, service: "direct" };
  if (PORTAL_HINTS.test(text) || PORTAL_HINTS.test(pathname)) return { ...base, kind: "portal", note: "looks like a document page or portal — needs a browser, a login or a decision" };
  return { ...base, kind: "ignored", reason: "website link" };
}

function guessFilename(u, text) {
  const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
  if (DOC_EXT.test(last)) return sanitizeFilename(last);
  if (DOC_EXT.test(text || "")) return sanitizeFilename(text);
  return null;
}

/** Attachments on a message, classified: a document, an inline image, or signature noise. */
export function classifyAttachment(a) {
  const name = a.name || "";
  const small = (a.size || 0) < 50 * 1024;
  const image = /^image\//i.test(a.contentType || "") || /\.(png|jpe?g|gif|bmp|webp)$/i.test(name);
  if (a.isInline && image && small) return { ...pick(a), kind: "image", note: "inline image under 50 KB — signature / logo noise unless the email is about it" };
  if (a.isInline && image) return { ...pick(a), kind: "image", note: "inline image (a photo or a preview embedded in the body)" };
  if (/\.(ics|vcf)$/i.test(name)) return { ...pick(a), kind: "ignored", reason: "calendar / contact card" };
  return { ...pick(a), kind: "attachment", note: a.isInline ? "inline file" : "file attachment (the Power Automate flow also saves it to staging)" };
}
const pick = (a) => ({ id: a.id, name: a.name, size: a.size, content_type: a.contentType, inline: !!a.isInline, content_id: a.contentId || null });

// ------------------------------------------------------------- network safety

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" ) return true;
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    if (/^fe[89ab]/.test(l) || /^f[cd]/.test(l) || l.startsWith("ff")) return true;
    return false;
  }
  return true; // not an address at all
}

/** Refuses anything that is not a public https host: literal IPs, local names, private resolutions. */
export async function assertPublicUrl(url, lookup = (h) => dns.lookup(h, { all: true })) {
  let u;
  try { u = new URL(url); } catch { throw new LinkError("bad_url", "not a URL"); }
  if (u.protocol !== "https:") throw new LinkError("not_https", `${u.protocol} is not fetched`);
  if (u.username || u.password) throw new LinkError("bad_url", "credentials in the URL");
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host)) throw new LinkError("bad_host", "IP address literal");
  if (!host.includes(".") || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host) || host === "localhost") throw new LinkError("bad_host", `internal name ${host}`);
  if (/\.(netlify\.app|netlify\.com|supabase\.co|supabase\.in)$/.test(host) || host === "169.254.169.254") throw new LinkError("bad_host", `${host} is not a document host`);
  let addrs;
  try { addrs = await lookup(host); } catch { throw new LinkError("dns_failed", `${host} does not resolve`); }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === "string" ? a : a.address));
  if (!list.length) throw new LinkError("dns_failed", `${host} does not resolve`);
  const bad = list.find((ip) => isPrivateIp(ip));
  if (bad) throw new LinkError("private_address", `${host} resolves to a non-public address`);
  return { url: u.toString(), host };
}

export class LinkError extends Error {
  constructor(code, detail, extra) { super(detail || code); this.code = code; this.detail = detail; this.extra = extra; }
}

// --------------------------------------------------------------- the bytes

const HTML_START = /^\s*(<!doctype\s+html|<html|<head|<body|<script|<\?xml[^>]*>\s*<!doctype html)/i;

/** What the first bytes say the file is. An HTML page is never a document. */
export function sniffType(bytes, filename = "") {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const head = b.subarray(0, 512);
  const text = head.toString("latin1");
  const hex = head.subarray(0, 8).toString("hex");
  let type = null;
  if (text.startsWith("%PDF")) type = "pdf";
  else if (hex.startsWith("504b0304") || hex.startsWith("504b0506") || hex.startsWith("504b0708")) type = /\.(docx|xlsx|pptx|dotx|xlsm)$/i.test(filename) ? "ooxml" : "zip";
  else if (hex.startsWith("89504e470d0a1a0a")) type = "png";
  else if (hex.startsWith("ffd8ff")) type = "jpeg";
  else if (text.startsWith("GIF8")) type = "gif";
  else if (hex.startsWith("49492a00") || hex.startsWith("4d4d002a")) type = "tiff";
  else if (hex.startsWith("d0cf11e0a1b11ae1")) type = "ole";          // .doc .xls .msg
  else if (text.startsWith("{\\rtf")) type = "rtf";
  else if (/^AC10\d\d/.test(text)) type = "dwg";
  else if (/^\s*0\r?\n\s*SECTION/.test(text)) type = "dxf";
  else if (hex.startsWith("377abcaf271c")) type = "7z";
  else if (text.startsWith("Rar!")) type = "rar";
  else if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") type = "webp";
  else if (/^\s*<svg|^\s*<\?xml[^>]*>\s*<svg/i.test(text)) type = "svg";
  else if (hex.slice(8, 16) === "66747970") type = "heic_or_mp4";
  const html = HTML_START.test(text) || (/<title>|<meta |<div|<form/i.test(text) && !type);
  const textLike = !type && !html && /^[\x09\x0a\x0d\x20-\x7e\x80-\xff]*$/.test(text);
  return { type: type || (html ? "html" : textLike ? "text" : "unknown"), html, ok: !!type || (textLike && /\.(txt|csv|dxf|eml|kml)$/i.test(filename)) };
}

export function parseContentRange(h) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(h || "");
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? null : Number(m[3]) };
}

/**
 * Fetch one byte range of a document, following at most MAX_REDIRECTS redirects
 * and checking every hop (https, public host, size cap). Returns the bytes, the
 * total size when the server says it, the content type and the final URL.
 * The server must honour Range (206) past the first chunk; a 200 answer is
 * accepted only at offset 0 and only up to the cap.
 */
export async function fetchRange(url, { offset = 0, length = CHUNK_BYTES, fetchImpl = fetch, lookup, timeoutMs = 8000 } = {}) {
  let current = url;
  const hops = [];
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const checked = await assertPublicUrl(current, lookup);
    hops.push(checked.host);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let r;
    try {
      r = await fetchImpl(checked.url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { Range: `bytes=${offset}-${offset + length - 1}`, "User-Agent": "Mworx-Bookkeeper-Inbox/1.0 (document filing)", Accept: "*/*" } });
    } finally { clearTimeout(t); }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) throw new LinkError("bad_redirect", `redirect ${r.status} without a location`);
      try { r.body?.cancel?.(); } catch { /* ignore */ }
      current = new URL(loc, checked.url).toString();
      if (i === MAX_REDIRECTS) throw new LinkError("too_many_redirects", `more than ${MAX_REDIRECTS} redirects`);
      continue;
    }
    if (r.status === 401 || r.status === 403) throw new LinkError("access_denied", `the server answered ${r.status} — sign-in or permission needed`, { hops });
    if (r.status === 404 || r.status === 410) throw new LinkError("gone", `the server answered ${r.status} — the link has expired or was removed`, { hops });
    if (r.status === 416) throw new LinkError("bad_range", "range not satisfiable", { hops });
    if (!r.ok) throw new LinkError("fetch_failed", `the server answered ${r.status}`, { hops });
    const contentType = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const range = r.status === 206 ? parseContentRange(r.headers.get("content-range")) : null;
    if (r.status === 200 && offset > 0) throw new LinkError("no_range_support", "the server ignores byte ranges; the file cannot be fetched in parts", { hops });
    const declared = r.status === 206 ? range?.total ?? null : (r.headers.get("content-length") ? Number(r.headers.get("content-length")) : null);
    if (declared != null && declared > MAX_DOWNLOAD_BYTES) { try { r.body?.cancel?.(); } catch { /* ignore */ } throw new LinkError("too_large", `${declared} bytes is over the ${MAX_DOWNLOAD_BYTES} byte limit`, { hops }); }
    // Read at most `length` bytes even when the server sends the whole file.
    const bytes = await readUpTo(r, length);
    const disposition = r.headers.get("content-disposition") || "";
    const dispName = (/filename\*=UTF-8''([^;]+)/i.exec(disposition) || [])[1] ? decodeURIComponent((/filename\*=UTF-8''([^;]+)/i.exec(disposition) || [])[1]) : (/filename="?([^";]+)"?/i.exec(disposition) || [])[1] || null;
    return { bytes, total: declared, partial: r.status === 206, contentType, finalUrl: checked.url, hops, filename: dispName ? sanitizeFilename(dispName) : null, complete: r.status === 200 && declared != null && bytes.length >= declared };
  }
  throw new LinkError("too_many_redirects", `more than ${MAX_REDIRECTS} redirects`);
}

async function readUpTo(r, limit) {
  if (!r.body || typeof r.body.getReader !== "function") {
    const all = Buffer.from(await r.arrayBuffer());
    return all.subarray(0, limit);
  }
  const reader = r.body.getReader();
  const parts = [];
  let got = 0;
  while (got < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    parts.push(chunk.subarray(0, limit - got));
    got += Math.min(chunk.length, limit - got);
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return Buffer.concat(parts);
}

/** "yyMMdd_" from a Sydney date, as Michel's filing names use. */
export function sydneyDatePrefix(iso) {
  const d = iso ? new Date(iso) : new Date();
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "2-digit", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}${get("month")}${get("day")}_`;
}

/** The filing name: keep the original name, add the yyMMdd_ prefix once. */
export function filingName(original, receivedIso) {
  const clean = sanitizeFilename(original);
  return /^\d{6}_/.test(clean) ? clean : sydneyDatePrefix(receivedIso) + clean;
}
