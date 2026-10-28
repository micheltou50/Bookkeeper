#!/usr/bin/env node
// Live verification of the Inbox API against Microsoft Graph, run from a
// machine that can reach the deploy (the Claude environment needs the deploy's
// host allowed). Everything it does is read-only on mail except unsent test
// drafts, and it files only what it is told to (Seda's linked documents into
// the 12 Cobbler Crescent job folder; test-email attachments into _Skipped).
//
//   INBOX_API_URL=https://deploy-preview-29--bkeeper.netlify.app/.netlify/functions/inbox-api
//   INBOX_API_KEY_FILE=/path/to/key          (the key is never printed)
//   TEST_DRIVE_ID=…  TEST_FOLDER_ID=…         (destination for the linked documents)
//   TEST_PDF_NAME=…  TEST_DUP_NAME=…           (which PDF to file, which one the folder already holds)
//   TEST_ZIP_NAME=…  TEST_ZIP_FOLDER_ID=…      (the large ZIP, and a test folder for its copy)
//   TEST_LINKS_MESSAGE_ID=…                   (Seda's email, info@)
//   TEST_UNREAD_INFO=… TEST_UNREAD_ACCOUNTS=… TEST_UNREAD_ENERGY=…   (unread test emails)
//   TEST_SKIPPED_FOLDER_ID=…                  (where a test email's attachment is filed)
//   STAGE=scan|pdf|zip|unread|drafts|all      (default all)   KEEP=1 keeps the drafts
//   node scripts/inbox-api-live.mjs
import fs from "node:fs";

const url = process.env.INBOX_API_URL;
const key = process.env.INBOX_API_KEY || (process.env.INBOX_API_KEY_FILE ? fs.readFileSync(process.env.INBOX_API_KEY_FILE, "utf8").trim() : "");
if (!url || !key) { console.error("INBOX_API_URL and INBOX_API_KEY_FILE (or INBOX_API_KEY) are required"); process.exit(2); }
const stage = process.env.STAGE || "all";
const want = (s) => stage === "all" || stage === s;
const log = (...a) => console.log(...a);
const results = [];
const record = (name, ok, info) => { results.push([name, ok ? "pass" : "FAIL", info]); log(`${ok ? "✓" : "✗"} ${name}${info ? " — " + (typeof info === "string" ? info : JSON.stringify(info)) : ""}`); return ok; };
const call = async (body) => {
  const started = Date.now();
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, ms: Date.now() - started, ...(j || {}) };
};
// Private things never reach the console: transfer tokens, upload or download addresses.
const show = (o) => JSON.stringify(o, (k, v) => (["transfer", "upload_url", "direct_url", "downloadUrl"].includes(k) ? "<hidden>" : v)).slice(0, 900);

const drive = process.env.TEST_DRIVE_ID, folder = process.env.TEST_FOLDER_ID;
const unread = { info: process.env.TEST_UNREAD_INFO, accounts: process.env.TEST_UNREAD_ACCOUNTS, energy: process.env.TEST_UNREAD_ENERGY };
const readStates = async (label) => {
  const out = {};
  for (const [mailbox, id] of Object.entries(unread)) {
    if (!id) continue;
    const r = await call({ op: "read_state", mailbox, message_id: id });
    out[mailbox] = r.ok ? r.is_read : `error ${r.error}`;
  }
  log(`  read state ${label}:`, JSON.stringify(out));
  return out;
};

const ping = await call({ op: "ping" });
record("ping", ping.ok && ping.never_sends === true, { user: ping.user, mailboxes: ping.mailboxes && Object.fromEntries(Object.entries(ping.mailboxes).map(([k, v]) => [k, v.drafts])) });
if (!ping.ok) { finish(); process.exit(1); }

const before = await readStates("at start");

let scan = null;
if (want("scan") || want("pdf") || want("zip")) {
  const id = process.env.TEST_LINKS_MESSAGE_ID;
  if (!id) record("links_scan", false, "TEST_LINKS_MESSAGE_ID not set");
  else {
    scan = await call({ op: "links_scan", mailbox: "info", message_id: id });
    record("links_scan: Seda's email inventoried", scan.ok, { downloads: scan.downloads?.length, images: scan.images?.length, attachments: scan.attachments?.length, portals: scan.portals?.length, ignored: scan.ignored, read_state: scan.read_state });
    if (scan.ok) for (const d of scan.downloads) log(`   - ${d.filename} | ${d.size} bytes | expires ${d.expires} | ${d.service} | file as ${d.filing_name}`);
    record("links_scan leaves isRead as found", !!scan.read_state?.unchanged, scan.read_state);
  }
}

const byName = (name) => scan?.downloads?.find((d) => d.filename === name);
const pickPdf = () => (process.env.TEST_PDF_NAME ? byName(process.env.TEST_PDF_NAME) : scan?.downloads?.filter((d) => /\.pdf$/i.test(d.filename || "") && d.size).sort((a, b) => a.size - b.size)[0]);
const pickZip = () => (process.env.TEST_ZIP_NAME ? byName(process.env.TEST_ZIP_NAME) : scan?.downloads?.filter((d) => /\.zip$/i.test(d.filename || "") && d.size).sort((a, b) => b.size - a.size)[0]);
const zipFolder = process.env.TEST_ZIP_FOLDER_ID || folder;

async function fetchAll(d, opts = {}) {
  // Runs links_fetch until done, the way a scheduled run would.
  const into = opts.folder || folder;
  let r = await call({ op: "links_fetch", href: d.href, text: d.text, drive_id: drive, folder_id: into, mailbox: "info", message_id: process.env.TEST_LINKS_MESSAGE_ID });
  const calls = [{ status: r.status, ms: r.ms, done: r.done, progress: r.progress, error: r.error }];
  let hops = 0;
  while (r.ok && r.done === false && hops++ < 200) {
    if (opts.interruptAt != null && r.progress?.offset >= opts.interruptAt && !opts._interrupted) { opts._interrupted = true; return { r, calls, interrupted: true }; }
    r = await call({ op: "links_fetch", transfer: r.transfer, drive_id: drive, folder_id: into });
    calls.push({ status: r.status, ms: r.ms, done: r.done, progress: r.progress, error: r.error });
  }
  return { r, calls };
}

if (want("pdf") && scan?.ok) {
  const d = pickPdf();
  if (!d || !drive || !folder) record("pdf: prerequisites", false, "no PDF in the scan, or TEST_DRIVE_ID / TEST_FOLDER_ID not set");
  else {
    log(`  smallest PDF: ${d.filename} (${d.size} bytes)`);
    const { r, calls } = await fetchAll(d);
    record("pdf: fetched and filed in one go", r.ok && r.done && r.filed, { calls: calls.length, name: r.name, size: r.size, type: r.type, checks: r.checks, hash_from_graph: r.item?.graph_hash, hash_computed: r.quick_xor_hash, source: r.source, read_state: r.read_state, error: r.error, detail: r.detail });
    if (r.ok && r.item?.id) {
      const v = await call({ op: "file_verify", drive_id: drive, item_id: r.item.id, expect_size: d.size, expect_hash: r.quick_xor_hash, folder_id: folder });
      record("pdf: file_verify — size, OneDrive hash, %PDF head, %%EOF tail, content hash recomputed", v.ok, { checks: v.checks, type: v.type, end_of_file: v.end_of_file, path: v.item?.path, web_url: v.item?.web_url });
      const again = await fetchAll(d);
      record("pdf: second run is a duplicate, nothing uploaded", again.r.ok && again.r.duplicate === true && again.r.filed === false, { existing: again.r.existing?.name, note: again.r.note });
    }
  }
  const dup = process.env.TEST_DUP_NAME ? byName(process.env.TEST_DUP_NAME) : null;
  if (dup) {
    const r = await call({ op: "links_fetch", href: dup.href, text: dup.text, drive_id: drive, folder_id: folder, mailbox: "info", message_id: process.env.TEST_LINKS_MESSAGE_ID });
    record("pdf: a file Michel filed by hand (same name without the date prefix, same size) is a duplicate, nothing uploaded", r.ok && r.duplicate === true && r.filed === false, { existing: r.existing?.name, existing_size: r.existing?.size, link_size: dup.size, read_state: r.read_state, error: r.error });
  }
}

if (want("zip") && scan?.ok) {
  const d = pickZip();
  if (!d || !drive || !folder) record("zip: prerequisites", false, "no ZIP in the scan, or TEST_DRIVE_ID / TEST_FOLDER_ID not set");
  else {
    log(`  largest ZIP: ${d.filename} (${d.size} bytes)`);
    // 1. Start, stop after the first part, then resume from the token: the way
    //    a run resumes after a 10 s invocation ends.
    const first = await fetchAll(d, { interruptAt: 1, folder: zipFolder });
    record("zip: first call moved a part and handed back a transfer", first.r.ok && first.r.done === false && !!first.r.transfer && first.r.progress?.offset > 0, { progress: first.r.progress, ms: first.calls[0].ms });
    // 2. Failure recovery: a corrupted token is refused; a cancelled transfer discards the partial upload.
    const bad = await call({ op: "links_fetch", transfer: (first.r.transfer || "").slice(0, -12) + "AAAAAAAAAAAA", drive_id: drive, folder_id: zipFolder });
    record("zip: a tampered transfer token is refused", bad.ok === false && bad.error === "bad_transfer", { error: bad.error });
    const cancelled = await call({ op: "links_fetch", transfer: first.r.transfer, drive_id: drive, folder_id: zipFolder, cancel: true });
    record("zip: cancel discards the partial upload", cancelled.ok && cancelled.cancelled === true, { progress: cancelled.progress });
    const afterCancel = await call({ op: "links_fetch", transfer: first.r.transfer, drive_id: drive, folder_id: zipFolder });
    record("zip: resuming a cancelled transfer is refused (session gone)", afterCancel.ok === false && ["upload_session_lost", "upload_out_of_step", "graph_error"].includes(afterCancel.error), { error: afterCancel.error, status: afterCancel.status });
    // 3. The real transfer: start again, resume until done.
    const full = await fetchAll(d, { folder: zipFolder });
    record("zip: fetched in parts and filed", full.r.ok && full.r.done && full.r.filed, { calls: full.calls.length, per_call_ms: full.calls.map((c) => c.ms), name: full.r.name, size: full.r.size, checks: full.r.checks, hash_from_graph: full.r.item?.graph_hash, hash_computed: full.r.quick_xor_hash, read_state: full.r.read_state, error: full.r.error, detail: full.r.detail });
    if (full.r.ok && full.r.item?.id) {
      const v = await call({ op: "file_verify", drive_id: drive, item_id: full.r.item.id, expect_size: d.size, expect_hash: full.r.quick_xor_hash, folder_id: zipFolder });
      record("zip: file_verify — size, OneDrive hash, PK head, central directory at the end", v.ok, { checks: v.checks, type: v.type, end_of_file: v.end_of_file, path: v.item?.path });
      const again = await fetchAll(d, { folder: zipFolder });
      record("zip: second run is a duplicate", again.r.ok && again.r.duplicate === true, { existing: again.r.existing?.name });
    }
  }
}

const made = [];
if (want("drafts") || want("unread")) {
  for (const [mailbox, id] of Object.entries(unread)) {
    if (!id) continue;
    const mr = await call({ op: "message_read", mailbox, message_id: id });
    record(`${mailbox}: message_read leaves isRead as found`, mr.ok && mr.read_state?.unchanged, { is_read: mr.message?.is_read, attachments: mr.attachments?.length, read_state: mr.read_state, error: mr.error });
    const sc = await call({ op: "links_scan", mailbox, message_id: id });
    record(`${mailbox}: links_scan leaves isRead as found`, sc.ok && sc.read_state?.unchanged, { downloads: sc.downloads?.length, attachments: sc.attachments?.length, read_state: sc.read_state, error: sc.error });
    const att = sc.attachments?.[0];
    if (att && drive && process.env.TEST_SKIPPED_FOLDER_ID) {
      const af = await call({ op: "attachment_fetch", mailbox, message_id: id, attachment_id: att.id, drive_id: drive, folder_id: process.env.TEST_SKIPPED_FOLDER_ID });
      record(`${mailbox}: attachment_fetch files the test attachment into _Skipped and leaves isRead as found`, af.ok && af.filed && af.read_state?.unchanged, { name: af.name, size: af.size, checks: af.checks, read_state: af.read_state, error: af.error, detail: af.detail });
    }
    if (want("drafts")) {
      const dr = await call({ op: "draft", mailbox, mode: "reply", message_id: id, html: "<p>Hi,</p><p>This is an unsent test draft made by the Inbox API to check the signature and the read state. Please do not send it.</p>", allow_existing: true });
      record(`${mailbox}: reply draft with the full signature, same conversation, isRead as found`, dr.ok && dr.checks?.is_draft && dr.checks?.signature_once && dr.checks?.logo_attached && dr.checks?.line_attached && dr.checks?.same_conversation && dr.read_state?.unchanged, { mailbox: dr.draft?.mailbox, from: dr.draft?.from, subject: dr.draft?.subject, to: dr.draft?.to, checks: dr.checks, read_state: dr.read_state, web_link: dr.draft?.web_link, error: dr.error, detail: dr.detail, graph: dr.graph });
      if (dr.ok) made.push([mailbox, dr.draft.id]);
    }
  }
}

const after = await readStates("at end");
record("every unread test email is still unread at the end", Object.entries(before).every(([k, v]) => v === false && after[k] === false), { before, after });

if (made.length && !process.env.KEEP) {
  for (const [mailbox, id] of made) { const r = await call({ op: "draft_delete", mailbox, draft_id: id }); record(`${mailbox}: test draft deleted`, r.ok && r.deleted, r.subject); }
} else if (made.length) log(`  kept ${made.length} test draft(s) in Drafts for a look in Outlook`);

finish();
function finish() {
  const failed = results.filter((r) => r[1] === "FAIL");
  log(`${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
}
