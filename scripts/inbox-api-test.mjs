#!/usr/bin/env node
// Tests for the Inbox API (netlify/functions/inbox-api.mjs).
//
//   node scripts/inbox-api-test.mjs --offline
//     The pure parts, with no network: signature template, body composition,
//     the checks a draft must pass, and the promise that the function has no
//     code path that sends mail.
//
//   INBOX_API_URL=https://…/.netlify/functions/inbox-api INBOX_API_KEY=… \
//   TEST_MESSAGE_ID=<an info@ message id> [TEST_DRIVE_ID=… TEST_ITEM_ID=…] \
//   [KEEP=1] node scripts/inbox-api-test.mjs
//     Against a deploy: ping, a reply draft in info@ with the signature (and a
//     OneDrive attachment when given), the read-back, duplicate prevention,
//     the error paths, the shared-mailbox gate, and clean-up of what it made
//     (KEEP=1 leaves the drafts in Outlook for a visual check). Nothing is sent.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signatureHtml, signatureAttachments, signatureHtmlForPreview, SIGNATURE_PHONE, LOGO_CID, LINE_CID } from "../netlify/functions/lib/signature.mjs";
import { checkOutgoingHtml, composeNewPart, injectAbove, newPartOf, verifyDraftBody, fileAttachmentsOf } from "../netlify/functions/lib/inbox-draft.mjs";
import { extractLinks, classifyLink, classifyAttachment, icloudMailDrop, unwrapSafeLink, isPrivateIp, assertPublicUrl, sniffType, tailCheck, fetchRange, parseContentRange, sanitizeFilename, filingName, sydneyDatePrefix, LinkError, MAX_DOWNLOAD_BYTES, QuickXorHash, quickXorHashOf } from "../netlify/functions/lib/inbox-links.mjs";
import crypto from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const pending = [];
const test = (name, fn) => {
  try { const r = fn(); if (r && typeof r.then === "function") { const pr = r.then(() => results.push([name, "pass"]), (e) => results.push([name, "FAIL", String(e?.message || e)])); pending.push(pr); return pr; } results.push([name, "pass"]); }
  catch (e) { results.push([name, "FAIL", String(e?.message || e)]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || "not equal"}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

function offline() {
  test("signature template carries name, phone, site link, disclaimer, both images", () => {
    const h = signatureHtml();
    for (const s of ["Michael T.", SIGNATURE_PHONE, 'href="https://www.mworxgroup.com.au/"', "Disclaimer:", `cid:${LOGO_CID}`, `cid:${LINE_CID}`, "rgb(45,184,125)"]) assert(h.includes(s), `missing ${s}`);
    assert((h.match(/<table/g) || []).length === 2, "two tables (block and contact)");
  });
  test("signature attachments are two inline PNGs with the cids the HTML uses", () => {
    const a = signatureAttachments();
    eq(a.map((x) => [x.name, x.isInline, x.contentId, x.contentType]), [["mworx-logo.png", true, LOGO_CID, "image/png"], ["mworx-line.png", true, LINE_CID, "image/png"]]);
    assert(Buffer.from(a[0].contentBytes, "base64").subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "logo is a PNG");
    assert(Buffer.from(a[1].contentBytes, "base64").length < 1000, "line image is tiny");
  });
  test("outgoing text: good paragraphs pass", () => {
    eq(checkOutgoingHtml("<p>Hi Seda,</p><p>Thanks for sending everything through.</p>").ok, true);
  });
  test("outgoing text: placeholders, sign-offs, images, scripts, attachment claims are refused", () => {
    const bad = (html, opts) => { const r = checkOutgoingHtml(html, opts); assert(!r.ok, `should fail: ${html}`); return r.problems.join(" | "); };
    assert(bad("<p>We'll have it by [day].</p>").includes("placeholder"));
    assert(bad("<p>Thanks.</p><p>Regards,<br>Michael T.</p>").includes("sign-off"));
    assert(bad('<p>Hi</p><img src="x">').includes("<img"));
    assert(bad("<p>Hi</p><script>1</script>").includes("<script"));
    assert(bad("<p>Please find attached the fee proposal.</p>").includes("attachment"));
    assert(checkOutgoingHtml("<p>Please find attached the fee proposal.</p>", { attachmentCount: 1 }).ok, "allowed when a file is attached");
    assert(bad("").includes("empty"));
    assert(bad("<p>x</p>".repeat(5000)).includes("over"));
  });
  test("composition: new part sits above the quoted history, signature once", () => {
    const quoted = '<html><head></head><body><div id="divRplyFwdMsg"><b>From:</b> Seda</div><div>old text</div></body></html>';
    const body = injectAbove(quoted, composeNewPart("<p>Hi Seda,</p><p>Thanks.</p>"));
    assert(body.indexOf("Hi Seda") < body.indexOf("divRplyFwdMsg"), "new text first");
    const top = newPartOf(body);
    assert(top.includes(SIGNATURE_PHONE) && !top.includes("old text"), "new part ends before the history");
    const v = verifyDraftBody(body, signatureAttachments().map((a) => ({ isInline: true, contentId: a.contentId })));
    eq(v.ok, true, JSON.stringify(v.checks));
    eq(v.signature_count, 1);
  });
  test("verification: a second signature, a missing image or a placeholder fails", () => {
    const atts = signatureAttachments().map((a) => ({ isInline: true, contentId: a.contentId }));
    const twice = composeNewPart("<p>Hi</p>") + signatureHtml();
    assert(!verifyDraftBody(twice, atts).checks.signature_once, "two signatures");
    assert(!verifyDraftBody(composeNewPart("<p>Hi</p>"), [atts[0]]).checks.line_attached, "line image not attached");
    // Graph's listing gives no contentId: the inline images are recognised by name.
    const byName = verifyDraftBody(composeNewPart("<p>Hi</p>"), signatureAttachments().map((a) => ({ isInline: true, name: a.name })));
    assert(byName.checks.logo_attached && byName.checks.line_attached, "inline images recognised by name");
    assert(!verifyDraftBody(composeNewPart("<p>Hi</p>"), [{ isInline: false, name: "mworx-logo.png" }]).checks.logo_attached, "a non-inline file is not the logo");
    assert(!verifyDraftBody(composeNewPart("<p>Hi [day]</p>"), atts).checks.no_placeholders, "placeholder");
    eq(fileAttachmentsOf([...atts, { id: "1", name: "plan.pdf", size: 10, isInline: false }]).map((f) => f.name), ["plan.pdf"]);
  });
  test("the function has no path that sends mail, and never writes a message's read flag", () => {
    const src = fs.readFileSync(path.join(here, "../netlify/functions/inbox-api.mjs"), "utf8");
    assert(!/\$select=[^"`]*contentId/.test(src), "attachment listings must not $select contentId (Graph rejects it on the attachment collection)");
    for (const s of ["/send", "sendMail", "microsoft.graph.send", "/reply\"", "/forward"]) assert(!src.includes(s), `source contains ${s}`);
    assert(src.includes("never_sends: true"), "ping reports never_sends");
    // isRead is only ever read ($select) and reported; no object literal or
    // JSON body carries it as a key, in either direction.
    assert(!/isRead\s*:/.test(src) && !/"isRead"\s*:/.test(src), "source writes isRead somewhere");
    assert(!/PATCH[^\n]*messages\/\$\{enc\((messageId|p\.message_id)\)\}`/.test(src), "source patches a received message");
  });
  test("QuickXorHash: empty vector, chunked with state round-trips equals one-shot, order-sensitive", () => {
    eq(quickXorHashOf(Buffer.alloc(0)), "AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    const buf = crypto.randomBytes(700001);
    const one = quickXorHashOf(buf);
    let h = new QuickXorHash(); let off = 0;
    while (off < buf.length) { const n = Math.min(327680 + (off % 13), buf.length - off); h = new QuickXorHash(JSON.parse(JSON.stringify(h.state()))).update(buf.subarray(off, off + n)); off += n; }
    eq(h.digest(), one, "chunked != one-shot");
    assert(quickXorHashOf(Buffer.from("ab")) !== quickXorHashOf(Buffer.from("ba")), "order matters");
    assert(quickXorHashOf(Buffer.from("a")) !== quickXorHashOf(Buffer.from("a\0")), "length matters");
    eq(quickXorHashOf(Buffer.from("a")).length, 28, "20 bytes in base64");
  });
  test("end of file: PDF %%EOF, ZIP central directory, PNG IEND, JPEG EOI; a truncated file fails", () => {
    eq(tailCheck("pdf", Buffer.from("...startxref\n1234\n%%EOF\n"), 1000).ok, true);
    eq(tailCheck("pdf", Buffer.from("...startxref\n1234\n%%EO"), 1000).ok, false);
    // A one-entry ZIP end record: signature, disk fields, 1 entry, directory of 46 bytes at offset 100, in a 168-byte file.
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46, 12); eocd.writeUInt32LE(100, 16);
    const zipOk = tailCheck("zip", Buffer.concat([Buffer.alloc(146), eocd]), 168); eq(zipOk.ok, true); eq(zipOk.entries, 1);
    eq(tailCheck("zip", Buffer.concat([Buffer.alloc(146), eocd]), 120).ok, false, "directory past the end of a shorter file");
    eq(tailCheck("zip", Buffer.alloc(100), 100).ok, false, "no end record");
    eq(tailCheck("png", Buffer.from("00000000" + "49454e44ae426082", "hex"), 12).ok, true);
    eq(tailCheck("jpeg", Buffer.from([0x00, 0xff, 0xd9]), 3).ok, true);
    eq(tailCheck("dwg", Buffer.alloc(10), 10).ok, null, "no check for other types");
  });

  // --- linked documents (the lib is pure; network parts take a fake fetch) ---
  // The shape of Seda's email (28 Oct): iCloud Mail Drop links whose u= carries
  // the CDN address with ${f} / ${uk} placeholders. Invented keys and names.
  const cdn = "https://cvws.icloud-content.com/B/AbCdEf/${f}?o=AtEst&v=1&x=3&a=XYZ&e=1795735013&k=${uk}&fl=&r=abc&ckc=com.apple.largeattachment&ckz=mail&p=99&s=sig";
  const maildrop = (f, sz) => `https://www.icloud.com/attachment/?u=${encodeURIComponent(cdn)}&uk=KEY123&f=${encodeURIComponent(f)}&sz=${sz}`;
  const sedaBody = `<html><body><p>Hi Michael,</p><p>Please find the documents:</p>
    <a href="${maildrop("Site Plan.pdf", 1200345)}">Site Plan.pdf</a><br>
    <a href="${maildrop("Images.zip", 18874368)}">Download full resolution images</a><br>
    <a href="https://www.dropbox.com/scl/fi/abc123/Floor%20Plan.dwg?rlkey=zzz&dl=0">Floor Plan.dwg</a>
    <a href="https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing">Council letter</a>
    <a href="https://we.tl/t-AbCdEf1234">WeTransfer</a>
    <a href="https://mycouncil.nsw.gov.au/documents/DA-2026-123/Notice.pdf">Notice of determination</a>
    <a href="https://portal.planning.nsw.gov.au/da/12345">View on the Planning Portal</a>
    <a href="https://www.facebook.com/skinclinic">Facebook</a> <a href="mailto:seda@example.test">email me</a>
    <a href="https://aus01.safelinks.protection.outlook.com/?url=${encodeURIComponent("https://files.example.test/Survey.pdf")}&data=05">Survey (safe link)</a>
    <a href="http://plain.example.test/old.pdf">old link</a>
    <a href="https://www.example-studio.com.au/">Our website</a>
    <img src="cid:image001.png@01D"></body></html>`;
  test("links: anchors are found once each, with their text", () => {
    const links = extractLinks(sedaBody);
    eq(links.length, 12);
    eq(links[1].text, "Download full resolution images");
  });
  test("links: iCloud Mail Drop → filename, size, expiry, direct url rebuilt from the placeholders; the href stays the public one", () => {
    const c = classifyLink(maildrop("Site Plan.pdf", 1200345), "Site Plan.pdf");
    eq(c.kind, "download"); eq(c.service, "icloud_maildrop"); eq(c.filename, "Site Plan.pdf"); eq(c.size, 1200345);
    assert(c.expires && c.expires.startsWith("2026-11-2"), "expiry from e=" + c.expires);
    assert(c.direct_url.startsWith("https://cvws.icloud-content.com/B/AbCdEf/Site%20Plan.pdf?") && c.direct_url.includes("k=KEY123"), "direct url rebuilt");
    assert(!c.direct_url.includes("${"), "no placeholders left");
    assert(c.href.startsWith("https://www.icloud.com/attachment/"), "href is the public page");
    const expired = icloudMailDrop(maildrop("x.pdf", 1).replace("e%3D1795735013", "e%3D1600000000"));
    eq(expired.kind, "expired");
  });
  test("links: Dropbox and Google Drive become direct downloads; WeTransfer, OneDrive share, portals need a browser; social, mailto, http, websites are ignored", () => {
    const by = Object.fromEntries(extractLinks(sedaBody).map((l) => [l.text, classifyLink(l.href, l.text)]));
    eq(by["Floor Plan.dwg"].kind, "download"); assert(by["Floor Plan.dwg"].direct_url.includes("dl=1"), "dropbox dl=1"); eq(by["Floor Plan.dwg"].filename, "Floor Plan.dwg");
    eq(by["Council letter"].kind, "download"); assert(by["Council letter"].direct_url.startsWith("https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQrStUv"), "drive direct");
    eq(by["WeTransfer"].kind, "portal");
    eq(by["Notice of determination"].kind, "download"); eq(by["Notice of determination"].service, "direct"); eq(by["Notice of determination"].filename, "Notice.pdf");
    eq(by["View on the Planning Portal"].kind, "portal");
    eq(by["Facebook"].kind, "ignored"); eq(by["email me"].kind, "ignored"); eq(by["Our website"].kind, "ignored");
    eq(by["old link"].kind, "portal", "http is not fetched");
    eq(by["Survey (safe link)"].href, "https://files.example.test/Survey.pdf"); eq(by["Survey (safe link)"].kind, "download");
    eq(classifyLink("https://1drv.ms/b/s!AbC").kind, "portal"); eq(classifyLink("https://contoso.sharepoint.com/:b:/g/x").kind, "portal");
    eq(unwrapSafeLink("https://x.test/a"), "https://x.test/a");
  });
  test("attachments: signature images are noise, inline photos are images, files are attachments", () => {
    eq(classifyAttachment({ id: "1", name: "image001.png", size: 4000, isInline: true, contentType: "image/png" }).kind, "image");
    assert(classifyAttachment({ id: "1", name: "image001.png", size: 4000, isInline: true, contentType: "image/png" }).note.includes("signature"));
    eq(classifyAttachment({ id: "2", name: "IMG_2041.jpeg", size: 2400000, isInline: true, contentType: "image/jpeg" }).kind, "image");
    eq(classifyAttachment({ id: "3", name: "Survey Plan.pdf", size: 240000, isInline: false, contentType: "application/pdf" }).kind, "attachment");
    eq(classifyAttachment({ id: "4", name: "invite.ics", size: 2000, isInline: false, contentType: "text/calendar" }).kind, "ignored");
  });
  test("safety: private addresses, IP literals, internal names, http and our own hosts are refused; a public host passes", async () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) assert(isPrivateIp(ip), `${ip} should be private`);
    for (const ip of ["8.8.8.8", "17.253.1.1", "2606:4700::1111"]) assert(!isPrivateIp(ip), `${ip} should be public`);
    const refuse = async (url, lookup, code) => { try { await assertPublicUrl(url, lookup); throw new Error("should refuse " + url); } catch (e) { assert(e instanceof LinkError && e.code === code, `${url}: ${e.code || e.message} (wanted ${code})`); } };
    const pub = async () => [{ address: "17.253.1.1" }];
    await refuse("http://files.example.test/a.pdf", pub, "not_https");
    await refuse("https://10.0.0.5/a.pdf", pub, "bad_host");
    await refuse("https://[::1]/a.pdf", pub, "bad_host");
    await refuse("https://intranet.local/a.pdf", pub, "bad_host");
    await refuse("https://bkeeper.netlify.app/.netlify/functions/inbox-api", pub, "bad_host");
    await refuse("https://yzndkdlzgegrcotfeqlp.supabase.co/rest/v1/bk_invoices", pub, "bad_host");
    await refuse("https://user:pw@files.example.test/a.pdf", pub, "bad_url");
    await refuse("https://evil.example.test/a.pdf", async () => [{ address: "192.168.0.10" }], "private_address");
    await refuse("https://evil.example.test/a.pdf", async () => [{ address: "8.8.8.8" }, { address: "10.1.1.1" }], "private_address");
    await refuse("https://nowhere.example.test/a.pdf", async () => { throw new Error("ENOTFOUND"); }, "dns_failed");
    eq((await assertPublicUrl("https://files.example.test/a.pdf", pub)).host, "files.example.test");
  });
  test("sniff: PDF, ZIP, PNG, JPEG, DWG, DOCX are documents; an HTML page never is", () => {
    eq(sniffType(Buffer.from("%PDF-1.7\n%âãÏÓ"), "a.pdf").type, "pdf");
    eq(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), "Images.zip").type, "zip");
    eq(sniffType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), "Plans.docx").type, "ooxml");
    eq(sniffType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "x.png").type, "png");
    eq(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "x.jpg").type, "jpeg");
    eq(sniffType(Buffer.from("AC1032xxxx"), "x.dwg").type, "dwg");
    const html = sniffType(Buffer.from("<!DOCTYPE html><html><head><title>Sign in</title></head>"), "Notice.pdf");
    eq(html.type, "html"); eq(html.html, true); eq(html.ok, false);
    const html2 = sniffType(Buffer.from("\n\n<html lang=en><body>Download expired</body></html>"), "x.pdf");
    eq(html2.html, true);
    eq(sniffType(Buffer.from("0\r\nSECTION\r\n2\r\nHEADER"), "x.dxf").type, "dxf");
  });
  test("fetch: redirects are followed hop by hop with every host checked, ranges honoured, sizes read, HTML refused by the caller", async () => {
    const calls = [];
    const mk = (status, headers, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => Buffer.from(body || ""), body: null });
    const fetchImpl = async (url, opts) => {
      calls.push([url, opts.headers.Range]);
      if (url.startsWith("https://www.icloud.com/")) return mk(302, { location: "https://cvws.icloud-content.com/B/x/Site%20Plan.pdf?e=1" });
      if (url.startsWith("https://cvws.icloud-content.com/")) return mk(206, { "content-range": "bytes 0-9/1200345", "content-type": "application/pdf", "content-disposition": "attachment; filename=\"Site Plan.pdf\"" }, "%PDF-1.7\n%x");
      if (url.startsWith("https://loop.example.test/")) return mk(302, { location: "https://loop.example.test/again" });
      if (url.startsWith("https://inside.example.test/")) return mk(302, { location: "https://169.254.169.254/latest/meta-data" });
      if (url.startsWith("https://gone.example.test/")) return mk(404, {});
      if (url.startsWith("https://login.example.test/")) return mk(401, {});
      if (url.startsWith("https://big.example.test/")) return mk(206, { "content-range": `bytes 0-9/${MAX_DOWNLOAD_BYTES + 1}` }, "0123456789");
      if (url.startsWith("https://norange.example.test/")) return mk(200, { "content-length": "20", "content-type": "application/octet-stream" }, "01234567890123456789");
      return mk(500, {});
    };
    const lookup = async (h) => (h === "www.icloud.com" || h === "cvws.icloud-content.com" || /example\.test$/.test(h)) ? [{ address: "17.253.1.1" }] : (() => { throw new Error("ENOTFOUND"); })();
    const r = await fetchRange("https://www.icloud.com/attachment/x", { offset: 0, length: 10, fetchImpl, lookup });
    eq(r.total, 1200345); eq(r.partial, true); eq(r.contentType, "application/pdf"); eq(r.filename, "Site Plan.pdf"); eq(r.hops, ["www.icloud.com", "cvws.icloud-content.com"]); eq(r.bytes.toString().slice(0, 4), "%PDF");
    eq(calls[0][1], "bytes=0-9");
    const err = async (url, code, opts = {}) => { try { await fetchRange(url, { fetchImpl, lookup, ...opts }); throw new Error("should fail " + url); } catch (e) { assert(e instanceof LinkError && e.code === code, `${url}: ${e.code || e.message} (wanted ${code})`); } };
    await err("https://loop.example.test/a", "too_many_redirects");
    await err("https://inside.example.test/a", "bad_host");
    await err("https://gone.example.test/a.pdf", "gone");
    await err("https://login.example.test/a.pdf", "access_denied");
    await err("https://big.example.test/a.zip", "too_large");
    await err("https://norange.example.test/a.pdf", "no_range_support", { offset: 10, length: 10 });
    const whole = await fetchRange("https://norange.example.test/a.pdf", { offset: 0, length: 10, fetchImpl, lookup });
    eq(whole.bytes.length, 10); eq(whole.total, 20); eq(whole.complete, false);
    eq(parseContentRange("bytes 100-199/5000"), { start: 100, end: 199, total: 5000 });
  });
  test("names: Michel's yyMMdd_ prefix from the Sydney received date, kept when present, unsafe characters removed", () => {
    eq(sydneyDatePrefix("2026-10-27T14:30:00Z"), "261028_", "after midnight Sydney");
    eq(sydneyDatePrefix("2026-10-27T12:30:00Z"), "261027_", "still the 27th in Sydney");
    eq(filingName("Site Plan.pdf", "2026-10-27T14:30:00Z"), "261028_Site Plan.pdf");
    eq(filingName("261026_Survey.pdf", "2026-10-27T14:30:00Z"), "261026_Survey.pdf");
    eq(sanitizeFilename("../../etc/passwd"), "..-..-etc-passwd".replace(/^\.+/, ""));
    eq(sanitizeFilename("Plan: rev <A>?.pdf"), "Plan- rev -A--.pdf");
  });
  const previewPath = path.join(here, "../netlify/functions/lib/assets/signature-preview.html");
  fs.writeFileSync(previewPath, `<!doctype html><html><head><meta charset="utf-8"><title>Signature preview</title></head><body style="margin:24px;background:#fff">` +
    `<div style="font-family:'Century Gothic',sans-serif;font-size:12pt;color:#000"><p>Hi Seda,</p><p>Thanks for sending everything through for 12 Cobbler Crescent, Minchinbury.</p></div>` +
    signatureHtmlForPreview() + `</body></html>`);
  results.push(["preview written", previewPath]);
}

async function online() {
  const url = process.env.INBOX_API_URL;
  const key = process.env.INBOX_API_KEY;
  const messageId = process.env.TEST_MESSAGE_ID;
  if (!url || !key) { console.log("Set INBOX_API_URL and INBOX_API_KEY for the online tests (or pass --offline)."); return finish(); }
  const call = async (body, auth = key) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, ...(j || {}) };
  };
  const made = [];

  await test("auth: no key → 401; wrong key → 401; GET → 405", async () => {
    eq((await call({ op: "ping" }, null)).status, 401);
    eq((await call({ op: "ping" }, "x".repeat(64))).status, 401);
    const r = await fetch(url, { method: "GET" }); eq(r.status, 405);
  });
  let ping;
  await test("ping: connection and mailbox map", async () => {
    ping = await call({ op: "ping" });
    assert(ping.ok, JSON.stringify(ping));
    assert(ping.never_sends === true);
    assert(ping.mailboxes.info.drafts === true, "info@ can draft");
    console.log("  user:", ping.user, "| scopes:", ping.scopes, "| accounts@:", ping.mailboxes.accounts.drafts, "| energy@:", ping.mailboxes.energy.drafts);
  });
  await test("errors: unknown op, bad mailbox, bad mode, placeholder text, attachment claim", async () => {
    eq((await call({ op: "nope" })).error, "unknown_op");
    eq((await call({ op: "draft", mailbox: "sales", mode: "reply", message_id: "x", html: "<p>hi</p>" })).error, "bad_mailbox");
    eq((await call({ op: "draft", mailbox: "info", mode: "forward", message_id: "x", html: "<p>hi</p>" })).error, "bad_mode");
    eq((await call({ op: "draft", mailbox: "info", mode: "reply", message_id: "AAMk", html: "<p>by [day]</p>" })).error, "html_not_ready");
    eq((await call({ op: "draft", mailbox: "info", mode: "reply", message_id: "AAMk", html: "<p>please find attached</p>" })).error, "html_not_ready");
    eq((await call({ op: "draft", mailbox: "info", mode: "reply", message_id: "AAMkDoesNotExist", html: "<p>Hi</p>" })).error, "message_not_found");
  });
  if (!messageId) { results.push(["draft tests", "skipped (no TEST_MESSAGE_ID)"]); return finish(); }

  let first;
  await test("draft: reply in info@ with the signature, read back", async () => {
    const atts = process.env.TEST_DRIVE_ID && process.env.TEST_ITEM_ID ? [{ drive_id: process.env.TEST_DRIVE_ID, item_id: process.env.TEST_ITEM_ID }] : [];
    const html = atts.length ? "<p>Hi,</p><p>This is a test draft made by the Inbox API. The document is attached. Please do not send it.</p>" : "<p>Hi,</p><p>This is a test draft made by the Inbox API. Please do not send it.</p>";
    first = await call({ op: "draft", mailbox: "info", mode: "reply", message_id: messageId, html, attachments: atts, allow_existing: true });
    assert(first.ok, JSON.stringify(first));
    made.push(first.draft.id);
    assert(first.checks.is_draft && first.checks.signature_once && first.checks.logo_attached && first.checks.line_attached && first.checks.same_conversation, JSON.stringify(first.checks));
    if (atts.length) { eq(first.checks.attachments_ok, true, JSON.stringify(first.attachments)); console.log("  attached:", first.attachments.map((a) => `${a.name} (${a.size} bytes)`).join(", ")); }
    console.log("  draft:", first.draft.web_link, "| to:", first.draft.to.map((t) => t.address).join(", "));
  });
  await test("read-back op agrees", async () => {
    const r = await call({ op: "draft_read", mailbox: "info", draft_id: first.draft.id });
    assert(r.ok, JSON.stringify(r));
  });
  await test("duplicate prevention: a second draft for the same conversation is refused", async () => {
    const r = await call({ op: "draft", mailbox: "info", mode: "reply", message_id: messageId, html: "<p>Hi again.</p>" });
    eq(r.status, 409); eq(r.error, "draft_exists"); assert(r.existing.some((d) => d.id === first.draft.id), "lists the existing draft");
  });
  await test("drafts_find lists it", async () => {
    const r = await call({ op: "drafts_find", mailbox: "info", conversation_id: first.draft.conversation_id });
    assert(r.drafts.some((d) => d.id === first.draft.id));
  });
  await test("shared mailbox: gated on the scope", async () => {
    const r = await call({ op: "draft", mailbox: "energy", mode: "new", to: ["info@mworxgroup.com.au"], subject: "Inbox API test (do not send)", html: "<p>Test.</p>" });
    if (ping.mailboxes.energy.drafts) { assert(r.ok, JSON.stringify(r)); made.push(["energy", r.draft.id]); console.log("  energy@ draft:", r.draft.web_link); }
    else { eq(r.status, 403); eq(r.error, "shared_mailbox_scope_missing"); }
  });
  await test("draft_delete refuses a non-draft", async () => {
    const r = await call({ op: "draft_delete", mailbox: "info", draft_id: messageId });
    eq(r.error, "not_a_draft");
  });
  if (process.env.KEEP) { results.push(["clean-up", `kept ${made.length} test draft(s) for a visual check`]); return finish(); }
  await test("clean-up: delete what this run made", async () => {
    for (const m of made) {
      const [mailbox, id] = Array.isArray(m) ? m : ["info", m];
      const r = await call({ op: "draft_delete", mailbox, draft_id: id });
      assert(r.ok && r.deleted, JSON.stringify(r));
    }
  });
  finish();
}

function finish() {
  const failed = results.filter((r) => r[1] === "FAIL");
  for (const r of results) console.log(`${r[1] === "FAIL" ? "✗" : "✓"} ${r[0]}${r[2] ? ` — ${r[2]}` : ""}`);
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv.includes("--offline")) { offline(); await Promise.all(pending); finish(); }
else { offline(); await Promise.all(pending); await online(); }
