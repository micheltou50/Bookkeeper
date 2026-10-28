// Bookkeeper Inbox API — the one door the scheduled Inbox runs use to change
// anything: Outlook drafts and the Inbox rows. Reading stays on the connectors;
// every write comes here, authenticated with a key, limited to these
// operations, and read back before it is reported.
//
// Why it exists (28 Oct 2026): the Microsoft 365 connector can only draft in
// the signed-in mailbox, strips every style and image (so the real signature
// cannot be carried) and cannot attach files; and the runs were writing to the
// database through SELECTs that call functions, which sidestepped the
// connector's confirmation gate rather than going through an explicitly
// authorised path. This function uses the app's own Microsoft connection (the
// one that sends invoices) and the service role, so a run never needs to write
// SQL and never touches Graph directly.
//
// What it will never do: send. Nothing here calls Graph's sending operation,
// and scripts/inbox-api-test.mjs asserts that against the source on every
// run. Drafts are created in Drafts, verified, and left for Michel.
//
// Operations (POST JSON {op, …}, Authorization: Bearer <key>):
//   ping          — who the key is, which mailboxes can be drafted in
//   message_read  — a message's raw HTML and attachment list (for checks)
//   drafts_find   — drafts already in a conversation (duplicate check)
//   draft         — create a reply / reply-all / new draft with the signature
//                   and OneDrive attachments, then read it back and verify;
//                   a draft that fails its checks is deleted and reported
//   draft_read    — read a draft back (the same checks)
//   draft_delete  — delete a draft (refused for anything that is not a draft)
//   run_open, run_items, run_done, run_close, run_qa, quote_draft
//                 — the Inbox writes, through the restricted bk_* functions
//
// Keys: sha256 hashes in bk_inbox_api_keys (migration 0033); the key itself
// sits in Supabase Vault as 'inbox_api_key', issued by bk_inbox_api_key_issue().

import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { encryptToken, decryptToken } from "./lib/token-crypto.mjs";
import { signatureAttachments } from "./lib/signature.mjs";
import { checkOutgoingHtml, composeNewPart, injectAbove, verifyDraftBody, fileAttachmentsOf, textOf } from "./lib/inbox-draft.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

// The mailboxes a draft may be created in, and nothing else. info@ is the
// signed-in account; the other two are shared mailboxes it has full access to.
// Drafting in a shared mailbox needs the delegated scope Mail.ReadWrite.Shared
// on the connection (granted when Outlook is reconnected in Bookkeeper).
const MAILBOXES = {
  info: { address: "info@mworxgroup.com.au", shared: false },
  accounts: { address: "accounts@mworxgroup.com.au", shared: true },
  energy: { address: "energy@mworxgroup.com.au", shared: true },
};
const SHARED_SCOPE = "Mail.ReadWrite.Shared";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;     // per file; Netlify's 10 s wall clock is the real limit
const SMALL_ATTACHMENT_BYTES = 3 * 1024 * 1024;   // Graph: above this an upload session is required
const UPLOAD_CHUNK = 12 * 327680;                 // multiples of 320 KiB, as Graph requires
const MAX_BODY_BYTES = 200 * 1024;

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY
);

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const fail = (status, error, detail, extra) => json({ ok: false, error, ...(detail ? { detail } : {}), ...(extra || {}) }, status);

class GraphError extends Error {
  constructor(status, body, where) { super(`Graph ${status} at ${where}`); this.status = status; this.body = body; this.where = where; }
}

async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- auth

async function authenticate(req) {
  const h = req.headers.get("authorization") || "";
  const key = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!key || key.length < 32 || key.length > 256) return null;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const { data, error } = await supabase.from("bk_inbox_api_keys").select("id,user_id,label").eq("key_hash", hash).is("revoked_at", null).maybeSingle();
  if (error || !data) return null;
  supabase.from("bk_inbox_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).then(() => {}, () => {});
  return data;
}

// --------------------------------------------------------------- token

// The app's Outlook connection for the user (the one that sends invoices).
// Refreshed with the scopes it was granted, never more: a refresh that asked
// for a scope the user has not consented to would fail and take invoice
// sending down with it.
async function loadConnection(userId) {
  const base = () => supabase.from("bk_email_connections").select("*").eq("user_id", userId).eq("provider", "outlook");
  let { data } = await base().eq("business_id", "mworx").maybeSingle();
  if (!data) {
    const { data: any } = await base().order("updated_at", { ascending: false }).limit(1);
    data = any?.[0] || null;
  }
  return data;
}

async function refreshAccessToken(conn, refreshTok) {
  const granted = String(conn.scopes || "").split(/\s+/).filter(Boolean);
  const scope = Array.from(new Set(["offline_access", ...granted])).join(" ");
  const resp = await fetchWithTimeout("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshTok, grant_type: "refresh_token", scope }),
  });
  if (!resp.ok) {
    let detail = ""; try { detail = JSON.stringify(await resp.json()); } catch {}
    console.error("inbox-api: token refresh failed", resp.status, detail);
    return null;
  }
  const tokens = await resp.json();
  await supabase.from("bk_email_connections").update({
    access_token: encryptToken(tokens.access_token),
    refresh_token: encryptToken(tokens.refresh_token || refreshTok),
    expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    scopes: tokens.scope || conn.scopes,
    updated_at: new Date().toISOString(),
  }).eq("id", conn.id);
  return tokens.access_token;
}

async function graphSession(userId) {
  const conn = await loadConnection(userId);
  if (!conn) return { error: "no_outlook_connection", detail: "No Outlook connection in Bookkeeper for this user. Connect one in Settings → Email Sending." };
  let access, refresh;
  try { access = decryptToken(conn.access_token); refresh = conn.refresh_token ? decryptToken(conn.refresh_token) : null; }
  catch { return { error: "reconnect_outlook", detail: "The stored Outlook tokens cannot be read; reconnect Outlook in Bookkeeper." }; }
  if (!access || new Date(conn.expires_at).getTime() < Date.now() + 60 * 1000) {
    access = refresh ? await refreshAccessToken(conn, refresh) : null;
    if (!access) return { error: "reconnect_outlook", detail: "The Outlook token could not be refreshed; reconnect Outlook in Bookkeeper." };
  }
  const session = { conn, access, refresh, sharedOk: String(conn.scopes || "").split(/\s+/).includes(SHARED_SCOPE) };
  session.call = async (method, url, { body, headers, raw } = {}) => {
    const run = (token) => fetchWithTimeout(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...(headers || {}) },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    let r = await run(session.access);
    if (r.status === 401 && session.refresh) {
      const t = await refreshAccessToken(session.conn, session.refresh);
      if (t) { session.access = t; r = await run(t); }
    }
    if (r.status === 204) return null;
    const text = await r.text();
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!r.ok) throw new GraphError(r.status, parsed, `${method} ${url.replace(GRAPH, "")}`);
    return parsed;
  };
  return session;
}

// ------------------------------------------------------------- helpers

function mailboxOf(name) {
  const key = String(name || "").toLowerCase().trim();
  const found = MAILBOXES[key] || Object.entries(MAILBOXES).find(([, m]) => m.address === key)?.[1];
  if (!found) return null;
  return { key: Object.keys(MAILBOXES).find((k) => MAILBOXES[k] === found), ...found, base: found.shared ? `${GRAPH}/users/${encodeURIComponent(found.address)}` : `${GRAPH}/me` };
}

const addr = (r) => (r?.emailAddress?.address || "").toLowerCase();
const recipients = (list) => (list || []).map((r) => ({ name: r.emailAddress?.name || "", address: r.emailAddress?.address || "" }));
const idOk = (s) => typeof s === "string" && s.length > 0 && s.length <= 1024 && /^[A-Za-z0-9+/=_\-%.!]+$/.test(s);
const emailOk = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const odataQuote = (s) => String(s).replace(/'/g, "''");

const MESSAGE_SELECT = "id,subject,isDraft,conversationId,from,sender,toRecipients,ccRecipients,webLink,hasAttachments,parentFolderId,createdDateTime,receivedDateTime";

async function readDraft(session, box, draftId) {
  const batch = await session.call("POST", `${GRAPH}/$batch`, { body: { requests: [
    { id: "m", method: "GET", url: `${box.base.replace(GRAPH, "")}/messages/${draftId}?$select=${MESSAGE_SELECT},body` },
    { id: "a", method: "GET", url: `${box.base.replace(GRAPH, "")}/messages/${draftId}/attachments?$select=id,name,size,isInline,contentId,contentType` },
  ] } });
  const res = Object.fromEntries((batch?.responses || []).map((r) => [r.id, r]));
  if (!res.m || res.m.status >= 400) throw new GraphError(res.m?.status || 500, res.m?.body, "read draft");
  const msg = res.m.body;
  const atts = res.a && res.a.status < 400 ? (res.a.body?.value || []) : [];
  const verify = verifyDraftBody(msg.body?.content || "", atts);
  return { msg, atts, verify };
}

function describe(box, msg, atts, verify, original) {
  const files = fileAttachmentsOf(atts);
  return {
    draft: {
      id: msg.id, web_link: msg.webLink, mailbox: box.key, from: box.address, subject: msg.subject,
      to: recipients(msg.toRecipients), cc: recipients(msg.ccRecipients),
      conversation_id: msg.conversationId, is_draft: !!msg.isDraft, created: msg.createdDateTime,
    },
    attachments: files,
    signature: { present_once: verify.checks.signature_once, logo: verify.checks.logo_attached && verify.checks.logo_referenced, line: verify.checks.line_attached && verify.checks.line_referenced },
    checks: {
      ...verify.checks,
      is_draft: !!msg.isDraft,
      same_conversation: original ? msg.conversationId === original.conversationId : true,
    },
  };
}

// --------------------------------------------------------- attachments

async function downloadDriveItem(session, driveId, itemId) {
  const meta = await session.call("GET", `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=id,name,size,file,webUrl,parentReference`);
  if (!meta?.file) throw new GraphError(400, null, "attachment is not a file");
  if (meta.size > MAX_ATTACHMENT_BYTES) throw new GraphError(413, { name: meta.name, size: meta.size }, "attachment too large");
  const r = await fetchWithTimeout(`${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`, {
    headers: { Authorization: `Bearer ${session.access}` }, redirect: "manual",
  });
  let bytes;
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
    const dl = await fetchWithTimeout(r.headers.get("location"), {}, 20000);
    if (!dl.ok) throw new GraphError(dl.status, null, "download");
    bytes = Buffer.from(await dl.arrayBuffer());
  } else if (r.ok) {
    bytes = Buffer.from(await r.arrayBuffer());
  } else {
    throw new GraphError(r.status, null, "download");
  }
  return { name: meta.name, size: bytes.length, webUrl: meta.webUrl, bytes };
}

async function attachFile(session, box, draftId, file) {
  if (file.size <= SMALL_ATTACHMENT_BYTES) {
    await session.call("POST", `${box.base}/messages/${draftId}/attachments`, { body: {
      "@odata.type": "#microsoft.graph.fileAttachment", name: file.name, contentBytes: file.bytes.toString("base64"),
    } });
    return;
  }
  const sess = await session.call("POST", `${box.base}/messages/${draftId}/attachments/createUploadSession`, { body: {
    AttachmentItem: { attachmentType: "file", name: file.name, size: file.size },
  } });
  const uploadUrl = sess?.uploadUrl;
  if (!uploadUrl) throw new GraphError(502, sess, "createUploadSession");
  for (let start = 0; start < file.size; start += UPLOAD_CHUNK) {
    const end = Math.min(start + UPLOAD_CHUNK, file.size) - 1;
    const chunk = file.bytes.subarray(start, end + 1);
    const r = await fetchWithTimeout(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(chunk.length), "Content-Range": `bytes ${start}-${end}/${file.size}` },
      body: chunk,
    }, 20000);
    if (!r.ok && r.status !== 201 && r.status !== 200) {
      let detail = ""; try { detail = await r.text(); } catch {}
      throw new GraphError(r.status, detail, "upload chunk");
    }
  }
}

// ----------------------------------------------------------------- ops

async function opPing(auth) {
  const s = await graphSession(auth.user_id);
  if (s.error) return fail(401, s.error, s.detail);
  const me = await s.call("GET", `${GRAPH}/me?$select=displayName,mail,userPrincipalName`);
  return json({
    ok: true, key: auth.label, user: me.mail || me.userPrincipalName, scopes: s.conn.scopes,
    mailboxes: Object.fromEntries(Object.entries(MAILBOXES).map(([k, m]) => [k, { address: m.address, drafts: m.shared ? s.sharedOk : true, needs: m.shared && !s.sharedOk ? `reconnect Outlook in Bookkeeper to grant ${SHARED_SCOPE}` : null }])),
    never_sends: true,
  });
}

async function opMessageRead(auth, p) {
  const box = mailboxOf(p.mailbox || "info");
  if (!box) return fail(400, "bad_mailbox", "mailbox must be info, accounts or energy");
  if (!idOk(p.message_id)) return fail(400, "bad_message_id");
  const s = await graphSession(auth.user_id);
  if (s.error) return fail(401, s.error, s.detail);
  if (box.shared && !s.sharedOk) return fail(403, "shared_mailbox_scope_missing", `Reconnect Outlook in Bookkeeper to grant ${SHARED_SCOPE}`);
  const msg = await s.call("GET", `${box.base}/messages/${p.message_id}?$select=${MESSAGE_SELECT},body`);
  const atts = await s.call("GET", `${box.base}/messages/${p.message_id}/attachments?$select=id,name,size,isInline,contentId,contentType`);
  const body = String(msg.body?.content || "");
  return json({ ok: true, message: { id: msg.id, subject: msg.subject, is_draft: msg.isDraft, conversation_id: msg.conversationId, from: recipients([msg.from])[0], to: recipients(msg.toRecipients), cc: recipients(msg.ccRecipients), received: msg.receivedDateTime, web_link: msg.webLink }, body_html: body.slice(0, MAX_BODY_BYTES), body_truncated: body.length > MAX_BODY_BYTES, attachments: (atts?.value || []).map((a) => ({ id: a.id, name: a.name, size: a.size, inline: !!a.isInline, content_id: a.contentId || null, content_type: a.contentType })) });
}

async function findDrafts(s, box, { conversationId, subject }) {
  const filter = conversationId ? `conversationId eq '${odataQuote(conversationId)}'` : `subject eq '${odataQuote(subject)}'`;
  const r = await s.call("GET", `${box.base}/mailFolders/drafts/messages?$filter=${encodeURIComponent(filter)}&$select=id,subject,webLink,createdDateTime,toRecipients,conversationId&$top=25`);
  return (r?.value || []).map((m) => ({ id: m.id, subject: m.subject, web_link: m.webLink, created: m.createdDateTime, to: recipients(m.toRecipients) }));
}

async function opDraftsFind(auth, p) {
  const box = mailboxOf(p.mailbox || "info");
  if (!box) return fail(400, "bad_mailbox");
  if (!p.conversation_id && !p.subject) return fail(400, "bad_request", "conversation_id or subject required");
  const s = await graphSession(auth.user_id);
  if (s.error) return fail(401, s.error, s.detail);
  if (box.shared && !s.sharedOk) return fail(403, "shared_mailbox_scope_missing", `Reconnect Outlook in Bookkeeper to grant ${SHARED_SCOPE}`);
  const drafts = await findDrafts(s, box, { conversationId: p.conversation_id, subject: p.subject });
  return json({ ok: true, mailbox: box.key, drafts });
}

async function opDraft(auth, p) {
  const box = mailboxOf(p.mailbox || "info");
  if (!box) return fail(400, "bad_mailbox", "mailbox must be info, accounts or energy");
  const mode = ["reply", "reply_all", "new"].includes(p.mode) ? p.mode : null;
  if (!mode) return fail(400, "bad_mode", "mode must be reply, reply_all or new");
  if (mode !== "new" && !idOk(p.message_id)) return fail(400, "bad_message_id", "message_id of the email being answered is required");
  if (mode === "new") {
    if (!Array.isArray(p.to) || !p.to.length || !p.to.every(emailOk)) return fail(400, "bad_recipients", "to must be a list of email addresses");
    if (p.cc && (!Array.isArray(p.cc) || !p.cc.every(emailOk))) return fail(400, "bad_recipients", "cc must be a list of email addresses");
    if (typeof p.subject !== "string" || !p.subject.trim() || p.subject.length > 255) return fail(400, "bad_subject");
  }
  const wanted = Array.isArray(p.attachments) ? p.attachments : [];
  if (wanted.length > MAX_ATTACHMENTS) return fail(400, "too_many_attachments", `at most ${MAX_ATTACHMENTS} files`);
  for (const a of wanted) if (!a || !idOk(a.drive_id) || !idOk(a.item_id)) return fail(400, "bad_attachment", "each attachment needs drive_id and item_id");
  const check = checkOutgoingHtml(p.html, { attachmentCount: wanted.length });
  if (!check.ok) return fail(400, "html_not_ready", check.problems.join("; "), { problems: check.problems });

  const s = await graphSession(auth.user_id);
  if (s.error) return fail(401, s.error, s.detail);
  if (box.shared && !s.sharedOk) return fail(403, "shared_mailbox_scope_missing", `Drafting in ${box.address} needs ${SHARED_SCOPE}: reconnect Outlook in Bookkeeper (Settings → Email Sending) to grant it.`);

  let original = null;
  try {
    if (mode !== "new") {
      original = await s.call("GET", `${box.base}/messages/${p.message_id}?$select=${MESSAGE_SELECT}`);
      if (original.isDraft) return fail(400, "cannot_reply_to_draft", "message_id points at a draft, not a received email");
    }
    // One draft per thread: unless told to allow it, refuse when the
    // conversation already has one in this mailbox's Drafts.
    const existing = await findDrafts(s, box, original ? { conversationId: original.conversationId } : { subject: p.subject.trim() });
    if (existing.length && !p.allow_existing) return fail(409, "draft_exists", "a draft already exists for this conversation in this mailbox", { existing });
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return fail(404, "message_not_found", `no message ${p.message_id} in ${box.address}`);
    throw e;
  }

  // Files first, so a missing or oversized document stops us before a draft exists.
  const files = [];
  for (const a of wanted) {
    try { files.push(await downloadDriveItem(s, a.drive_id, a.item_id)); }
    catch (e) {
      if (e instanceof GraphError && e.status === 404) return fail(404, "attachment_not_found", `OneDrive item ${a.item_id} was not found`);
      if (e instanceof GraphError && e.status === 413) return fail(413, "attachment_too_large", `${e.body?.name} is ${e.body?.size} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`);
      if (e instanceof GraphError && e.status === 400) return fail(400, "attachment_not_a_file", `OneDrive item ${a.item_id} is a folder`);
      throw e;
    }
  }

  // Create the draft: Graph builds a reply with the quoted history and the
  // right recipients; a new message is built here.
  let draft;
  if (mode === "new") {
    draft = await s.call("POST", `${box.base}/messages`, { body: {
      subject: p.subject.trim(),
      toRecipients: p.to.map((e) => ({ emailAddress: { address: e } })),
      ccRecipients: (p.cc || []).map((e) => ({ emailAddress: { address: e } })),
      body: { contentType: "HTML", content: composeNewPart(p.html) },
    } });
  } else {
    draft = await s.call("POST", `${box.base}/messages/${p.message_id}/${mode === "reply_all" ? "createReplyAll" : "createReply"}`, { body: {} });
  }
  const draftId = draft.id;
  const basePath = box.base.replace(GRAPH, "");

  try {
    // Body (for replies: our part above the quoted history) and the two
    // signature images, in one round trip.
    // Chained with dependsOn so Graph runs them in order on the one message.
    const requests = [];
    if (mode !== "new") requests.push({ id: "body", method: "PATCH", url: `${basePath}/messages/${draftId}`, headers: { "Content-Type": "application/json" }, body: { body: { contentType: "HTML", content: injectAbove(draft.body?.content || "", composeNewPart(p.html)) } } });
    signatureAttachments().forEach((att, i) => requests.push({ id: `sig${i}`, method: "POST", url: `${basePath}/messages/${draftId}/attachments`, headers: { "Content-Type": "application/json" }, body: att, ...(requests.length ? { dependsOn: [requests[requests.length - 1].id] } : {}) }));
    const batch = await s.call("POST", `${GRAPH}/$batch`, { body: { requests } });
    const bad = (batch?.responses || []).find((r) => r.status >= 400);
    if (bad) throw new GraphError(bad.status, bad.body, `batch ${bad.id}`);

    for (const f of files) await attachFile(s, box, draftId, f);

    // Read it back: this is what gets reported, not what was intended.
    const { msg, atts, verify } = await readDraft(s, box, draftId);
    const out = describe(box, msg, atts, verify, original);
    const got = fileAttachmentsOf(atts);
    const missing = files.filter((f) => !got.some((g) => g.name === f.name && Number(g.size) === f.size)).map((f) => f.name);
    out.checks.attachments_ok = missing.length === 0;
    out.checks.attachments_missing = missing;
    const ok = Object.entries(out.checks).every(([k, v]) => k === "attachments_missing" || v === true);
    if (!ok) {
      await s.call("DELETE", `${box.base}/messages/${draftId}`).catch(() => {});
      return json({ ok: false, error: "draft_failed_checks", detail: "the saved draft did not pass its checks and has been deleted", deleted: true, ...out }, 502);
    }
    return json({ ok: true, ...out, note: box.shared ? "Saved in the shared mailbox's Drafts; sending it as that mailbox needs Send As on it." : null });
  } catch (e) {
    // Never leave a half-built draft behind.
    await s.call("DELETE", `${box.base}/messages/${draftId}`).catch(() => {});
    throw e;
  }
}

async function opDraftRead(auth, p) {
  const box = mailboxOf(p.mailbox || "info");
  if (!box) return fail(400, "bad_mailbox");
  if (!idOk(p.draft_id)) return fail(400, "bad_draft_id");
  const s = await graphSession(auth.user_id);
  if (s.error) return fail(401, s.error, s.detail);
  if (box.shared && !s.sharedOk) return fail(403, "shared_mailbox_scope_missing", `Reconnect Outlook in Bookkeeper to grant ${SHARED_SCOPE}`);
  try {
    const { msg, atts, verify } = await readDraft(s, box, p.draft_id);
    const out = describe(box, msg, atts, verify, null);
    return json({ ok: Object.values(out.checks).every((v) => v === true), ...out });
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return fail(404, "draft_not_found");
    throw e;
  }
}

async function opDraftDelete(auth, p) {
  const box = mailboxOf(p.mailbox || "info");
  if (!box) return fail(400, "bad_mailbox");
  if (!idOk(p.draft_id)) return fail(400, "bad_draft_id");
  const s = await graphSession(auth.user_id);
  if (s.error) return fail(401, s.error, s.detail);
  if (box.shared && !s.sharedOk) return fail(403, "shared_mailbox_scope_missing");
  let msg;
  try { msg = await s.call("GET", `${box.base}/messages/${p.draft_id}?$select=id,isDraft,subject`); }
  catch (e) { if (e instanceof GraphError && e.status === 404) return json({ ok: true, deleted: false, detail: "already gone" }); throw e; }
  if (!msg.isDraft) return fail(400, "not_a_draft", "only drafts can be deleted here");
  await s.call("DELETE", `${box.base}/messages/${p.draft_id}`);
  return json({ ok: true, deleted: true, subject: msg.subject });
}

// ------------------------------------------------------ inbox writes

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

async function ownsRun(userId, runId) {
  const { data } = await supabase.from("bk_inbox_runs").select("id").eq("id", runId).eq("user_id", userId).maybeSingle();
  return !!data;
}
async function ownsItem(userId, itemId) {
  const { data } = await supabase.from("bk_inbox_items").select("id").eq("id", itemId).eq("user_id", userId).maybeSingle();
  return !!data;
}
const uuidOk = (s) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function opRunOpen(auth, p) {
  if (!["morning", "closeoff", "manual"].includes(p.run_type)) return fail(400, "bad_run_type");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.sydney_date || ""))) return fail(400, "bad_date", "sydney_date must be yyyy-mm-dd");
  const run_id = await rpc("bk_inbox_open_run", { p_user_id: auth.user_id, p_run_type: p.run_type, p_sydney_date: p.sydney_date });
  return json({ ok: true, run_id });
}

async function opRunItems(auth, p) {
  if (!Array.isArray(p.items) || !p.items.length) return fail(400, "bad_items", "items must be a non-empty array");
  if (p.items.length > 200) return fail(400, "bad_items", "at most 200 items per call");
  const items = p.items.map((it) => { const { user_id, business_id, ...rest } = it || {}; return rest; });
  const result = await rpc("bk_inbox_write_items", { p_user_id: auth.user_id, p_items: items });
  return json({ ok: !!result?.ok, result });
}

async function opRunDone(auth, p) {
  if (!uuidOk(p.item_id)) return fail(400, "bad_item_id");
  if (!(await ownsItem(auth.user_id, p.item_id))) return fail(404, "item_not_found");
  const result = await rpc("bk_inbox_mark_done", { p_item_id: p.item_id, p_note: typeof p.note === "string" ? p.note.slice(0, 500) : null });
  return json({ ok: !!result?.ok, result });
}

async function opRunClose(auth, p) {
  if (!uuidOk(p.run_id)) return fail(400, "bad_run_id");
  if (!(await ownsRun(auth.user_id, p.run_id))) return fail(404, "run_not_found");
  if (!["ok", "partial", "error"].includes(p.status)) return fail(400, "bad_status");
  const result = await rpc("bk_inbox_close_run", { p_run_id: p.run_id, p_status: p.status, p_summary: typeof p.summary === "string" ? p.summary.slice(0, 4000) : null, p_counts: p.counts && typeof p.counts === "object" ? p.counts : {}, p_error: typeof p.error === "string" ? p.error.slice(0, 2000) : null });
  return json({ ok: !!result?.ok, result });
}

async function opRunQa(auth, p) {
  if (!uuidOk(p.run_id)) return fail(400, "bad_run_id");
  if (!(await ownsRun(auth.user_id, p.run_id))) return fail(404, "run_not_found");
  if (!Array.isArray(p.qa)) return fail(400, "bad_qa", "qa must be an array");
  const result = await rpc("bk_inbox_run_qa", { p_run_id: p.run_id, p_qa: p.qa });
  return json({ ok: !!result?.ok, result });
}

async function opQuoteDraft(auth, p) {
  if (!uuidOk(p.item_id)) return fail(400, "bad_item_id");
  if (!(await ownsItem(auth.user_id, p.item_id))) return fail(404, "item_not_found");
  const result = await rpc("bk_draft_quote_from_proposal", {
    p_item_id: p.item_id,
    p_application_type: typeof p.application_type === "string" ? p.application_type : null,
    p_works: typeof p.works === "string" ? p.works.slice(0, 500) : null,
    p_amount: typeof p.amount === "number" && isFinite(p.amount) ? p.amount : null,
    p_template_id: uuidOk(p.template_id) ? p.template_id : null,
    p_client_company: typeof p.client_company === "string" ? p.client_company.slice(0, 200) : null,
  });
  return json({ ok: !!result?.ok, result });
}

const OPS = {
  ping: opPing, message_read: opMessageRead, drafts_find: opDraftsFind,
  draft: opDraft, draft_read: opDraftRead, draft_delete: opDraftDelete,
  run_open: opRunOpen, run_items: opRunItems, run_done: opRunDone, run_close: opRunClose, run_qa: opRunQa, quote_draft: opQuoteDraft,
};

export default async (req) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed", "POST a JSON body with an op");
  const auth = await authenticate(req);
  if (!auth) return fail(401, "unauthorized");
  let p;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return fail(413, "body_too_large");
    p = JSON.parse(text || "{}");
  } catch { return fail(400, "bad_json"); }
  const op = OPS[p?.op];
  if (!op) return fail(400, "unknown_op", `op must be one of ${Object.keys(OPS).join(", ")}`);
  try {
    return await op(auth, p);
  } catch (e) {
    if (e instanceof GraphError) {
      console.error("inbox-api graph error", p.op, e.where, e.status, typeof e.body === "string" ? e.body.slice(0, 500) : JSON.stringify(e.body || "").slice(0, 500));
      const status = e.status === 404 ? 404 : e.status === 403 ? 403 : 502;
      return fail(status, "graph_error", `${e.where} returned ${e.status}`, { graph: typeof e.body === "object" ? e.body?.error : String(e.body || "").slice(0, 300) });
    }
    console.error("inbox-api error", p.op, e?.message || e);
    return fail(500, "internal_error", String(e?.message || e).slice(0, 300));
  }
};
