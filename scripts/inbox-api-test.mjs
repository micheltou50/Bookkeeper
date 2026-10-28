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

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const test = (name, fn) => {
  try { const r = fn(); if (r && typeof r.then === "function") return r.then(() => results.push([name, "pass"]), (e) => results.push([name, "FAIL", String(e?.message || e)])); results.push([name, "pass"]); }
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
    assert(!verifyDraftBody(composeNewPart("<p>Hi [day]</p>"), atts).checks.no_placeholders, "placeholder");
    eq(fileAttachmentsOf([...atts, { id: "1", name: "plan.pdf", size: 10, isInline: false }]).map((f) => f.name), ["plan.pdf"]);
  });
  test("the function has no path that sends mail", () => {
    const src = fs.readFileSync(path.join(here, "../netlify/functions/inbox-api.mjs"), "utf8");
    for (const s of ["/send", "sendMail", "microsoft.graph.send", "/reply\"", "/forward"]) assert(!src.includes(s), `source contains ${s}`);
    assert(src.includes("never_sends: true"), "ping reports never_sends");
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

if (process.argv.includes("--offline")) { offline(); finish(); }
else { offline(); await online(); }
