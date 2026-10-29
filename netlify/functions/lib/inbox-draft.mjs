// How a run's text becomes an Outlook draft body, and how a saved draft is
// checked afterwards. Pure functions (no network), so scripts/inbox-api-test.mjs
// exercises them offline; inbox-api.mjs is the only other caller.

import { signatureHtml, signatureAttachments, SIGNATURE_PHONE, LOGO_CID, LINE_CID } from "./signature.mjs";
const [LOGO_NAME, LINE_NAME] = signatureAttachments().map((a) => a.name);

export const MAX_HTML_CHARS = 20000;

// His compose font in Outlook, so the new text sits in the same face as the
// mail he writes himself.
const BODY_FONT = "font-family:&quot;Century Gothic&quot;,sans-serif;font-size:12pt;color:rgb(0,0,0)";

export const textOf = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * What is wrong with the text a run wants to send, if anything. The run only
 * supplies paragraphs; everything that would make the draft unsafe or not ready
 * to send is refused here rather than fixed quietly.
 */
export function checkOutgoingHtml(html, { attachmentCount = 0 } = {}) {
  const problems = [];
  const s = typeof html === "string" ? html : "";
  const text = textOf(s);
  if (!text) problems.push("html is empty");
  if (s.length > MAX_HTML_CHARS) problems.push(`html is over ${MAX_HTML_CHARS} characters`);
  for (const tag of ["<script", "<style", "<img", "<iframe", "<object", "<embed", "<form", "<link", "<meta", "<base"]) {
    if (s.toLowerCase().includes(tag)) problems.push(`html may not contain ${tag}`);
  }
  if (/javascript:/i.test(s)) problems.push("html may not contain javascript: links");
  if (/\bon[a-z]+\s*=/i.test(s)) problems.push("html may not contain inline event handlers");
  if (/cid:/i.test(s)) problems.push("html may not reference cid: images; the signature adds its own");
  if (/[\[\]]/.test(text)) problems.push("the text still has a [placeholder] in square brackets");
  if (/\bregards\b/i.test(text) && /michael t\b/i.test(text)) problems.push("the text carries its own sign-off; leave the signature to the template");
  if (attachmentCount === 0 && /\battach(ed|ment|ments|ing)?\b/i.test(text)) problems.push("the text mentions an attachment but no file is being attached");
  return { ok: problems.length === 0, problems };
}

/** The run's paragraphs in his font, followed by the signature. */
export function composeNewPart(html) {
  return `<div style="${BODY_FONT}">${html}</div>${signatureHtml()}`;
}

/**
 * Put the new part at the top of the body Graph built for a reply (which holds
 * the quoted history): just inside <body>, else before everything.
 */
export function injectAbove(existingBody, newPart) {
  const body = String(existingBody || "");
  const m = body.match(/<body[^>]*>/i);
  if (m) {
    const at = m.index + m[0].length;
    return body.slice(0, at) + newPart + body.slice(at);
  }
  return newPart + body;
}

/** The part of a saved body above the quoted history (Outlook's reply header). */
export function newPartOf(body) {
  const s = String(body || "");
  const marks = [s.indexOf('id="divRplyFwdMsg"'), s.indexOf("divRplyFwdMsg"), s.search(/<hr[\s>]/i)].filter((i) => i >= 0);
  if (!marks.length) return s;
  return s.slice(0, Math.min(...marks));
}

const count = (s, needle) => s.split(needle).length - 1;

/**
 * What a saved draft's body shows: the signature exactly once in the new part,
 * both images referenced, no placeholders. `attachments` is Graph's list for
 * the draft; the inline images must be there too, or Outlook shows broken boxes.
 */
export function verifyDraftBody(body, attachments = []) {
  const top = newPartOf(body);
  const topText = textOf(top);
  const inline = (attachments || []).filter((a) => a && a.isInline);
  // Graph's attachment listing cannot $select contentId (it lives on the
  // fileAttachment subtype, and the collection is typed as attachment), so an
  // inline image is recognised by its content id when the caller has it, else
  // by the name the signature gives it.
  const has = (cid, name) => inline.some((a) => String(a.contentId || "") === cid || a.name === name);
  const checks = {
    signature_once: count(top, SIGNATURE_PHONE) === 1,
    logo_referenced: top.includes(`cid:${LOGO_CID}`),
    line_referenced: top.includes(`cid:${LINE_CID}`),
    logo_attached: has(LOGO_CID, LOGO_NAME),
    line_attached: has(LINE_CID, LINE_NAME),
    no_placeholders: !/[\[\]]/.test(topText),
    has_text: topText.length > 0,
  };
  return { ok: Object.values(checks).every(Boolean), checks, signature_count: count(top, SIGNATURE_PHONE), new_part_chars: top.length };
}

/** The non-inline files on a draft, as {name, size, id}. */
export const fileAttachmentsOf = (attachments = []) =>
  (attachments || []).filter((a) => a && !a.isInline).map((a) => ({ id: a.id, name: a.name, size: a.size, contentType: a.contentType }));
