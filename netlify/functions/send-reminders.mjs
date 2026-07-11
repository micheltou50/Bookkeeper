import { createClient } from "@supabase/supabase-js";
import { wrapCors } from './lib/cors.mjs';

// Resolve ALL configuration from environment at request time. No hardcoded
// secret/URL fallbacks: committing those values can trip Netlify secret
// scanning / sensitive-variable policies, and a frozen module-load value would
// also cache a null client during debugging.
function getEnvConfig() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
    supabaseServiceKey:
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SERVICE_ROLE_KEY,
    resendApiKey: process.env.RESEND_API_KEY,
    reminderFromEmail: process.env.REMINDER_FROM_EMAIL || "noreply@mworxgroup.com.au",
    // BCC a fixed monitoring inbox on every reminder so a copy of exactly what
    // was sent (and to whom) lands somewhere reviewable. Override in Netlify, or
    // set REMINDER_BCC_EMAIL="" to disable.
    reminderBccEmail: process.env.REMINDER_BCC_EMAIL ?? "info@mworxgroup.com.au",
    // When STRIPE_SECRET_KEY is set, reminder emails gain a "Pay by card" button.
    stripeSecretKey: process.env.STRIPE_SECRET_KEY,
    surchargePct: Number(process.env.STRIPE_SURCHARGE_PCT ?? "1.7") || 0,
  };
}

// Module-scoped handles, (re)assigned at the start of each request by
// resolveRuntime() so the helper functions below can use them without
// threading parameters through every call.
let supabase = null;
let RESEND_API_KEY = null;
let REMINDER_FROM_EMAIL = "noreply@mworxgroup.com.au";
let REMINDER_BCC_EMAIL = "info@mworxgroup.com.au";
let PAY_ENABLED = false;   // true when STRIPE_SECRET_KEY is configured
let SURCHARGE_PCT = 1.7;   // card surcharge %, for the "Pay by card" note

function resolveRuntime() {
  const cfg = getEnvConfig();
  RESEND_API_KEY = cfg.resendApiKey;
  REMINDER_FROM_EMAIL = cfg.reminderFromEmail;
  REMINDER_BCC_EMAIL = cfg.reminderBccEmail;
  PAY_ENABLED = !!cfg.stripeSecretKey;
  SURCHARGE_PCT = cfg.surchargePct;
  if (cfg.supabaseUrl && cfg.supabaseServiceKey) {
    try {
      supabase = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey);
    } catch (e) {
      console.error("Failed to create Supabase client:", e.message);
      supabase = null;
    }
  } else {
    supabase = null;
  }
  return cfg;
}

const THRESHOLDS = [1, 7, 14, 30];
const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || "Australia/Sydney";
// Absolute base for pay links embedded in emails (the recipient's browser has
// no API_BASE). Netlify sets URL in production; fall back to the known domain.
const PAY_BASE = process.env.URL || "https://bkeeper.netlify.app";
const STALE_SENDING_MS = 30 * 60 * 1000; // a "sending" claim older than this is retryable

function fmtAUD(n) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

// Escape user-controlled values before injecting them into email HTML so a
// stray "<", "&", or quote in a name/address can't break rendering or markup.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// First word of a name, for friendly greetings ("Hi John,").
function firstName(n) {
  return String(n ?? "").trim().split(/\s+/)[0] || "";
}

// --- Business-local date logic (item 4) ---------------------------------------
// Use the business timezone, not UTC, so reminders fire on the right calendar
// day around midnight. en-CA formats as YYYY-MM-DD.
function businessTodayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: BUSINESS_TZ });
}

function daysOverdueFor(dueDate) {
  const today = businessTodayStr();
  const a = new Date(today + "T00:00:00Z").getTime();
  const b = new Date(String(dueDate).slice(0, 10) + "T00:00:00Z").getTime();
  return Math.round((a - b) / 86400000);
}

// The highest threshold that has been reached (item 5): if a cron day was
// missed, the next run still sends the highest unsent threshold <= daysOverdue.
function applicableThreshold(daysOverdue) {
  let best = null;
  for (const t of THRESHOLDS) if (t <= daysOverdue) best = t;
  return best;
}

// --- Email sending (Resend) ---------------------------------------------------

async function fetchWithTimeout(url, options, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Send via Resend. Returns { ok: true } or { ok: false, detail } — never throws.
async function sendViaResend({ to, toName, subject, html, fromName }) {
  if (!RESEND_API_KEY) return { ok: false, detail: "RESEND_API_KEY not set" };
  try {
    const resp = await fetchWithTimeout("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName || "Accounts"} <${REMINDER_FROM_EMAIL}>`,
        to: [to],
        // Blind-copy the monitoring inbox so there's always a reviewable record
        // of the exact email + recipient. Skip it when the recipient IS the BCC
        // address (avoids a pointless duplicate), or when BCC is disabled ("").
        ...(REMINDER_BCC_EMAIL && REMINDER_BCC_EMAIL.toLowerCase() !== String(to).toLowerCase()
          ? { bcc: [REMINDER_BCC_EMAIL] }
          : {}),
        subject,
        html,
      }),
    });
    if (resp.ok) return { ok: true };
    let detail = `Resend ${resp.status}`;
    try { detail = `Resend ${resp.status}: ${JSON.stringify(await resp.json())}`.slice(0, 500); } catch { /* keep status */ }
    return { ok: false, detail };
  } catch (e) {
    return { ok: false, detail: `Resend error: ${e.message}` };
  }
}

// Logos live in a PRIVATE Supabase bucket, so profile.logo_url (a /object/public/
// URL) 403s when an email client tries to load it — the logo shows as broken. Mint
// a long-lived signed URL the email client can actually fetch. Returns null on
// failure so buildReminderHTML cleanly falls back to the text logo.
async function resolveLogoUrl(logoUrl) {
  if (!logoUrl) return null;
  const m = String(logoUrl).match(/\/storage\/v1\/object\/(?:public\/|sign\/)?([^/?]+)\/([^?]+)/);
  if (!m) return logoUrl; // already a plain external URL
  const [, bucket, path] = m;
  try {
    const { data } = await supabase.storage.from(bucket).createSignedUrl(decodeURIComponent(path), 60 * 60 * 24 * 365);
    return data?.signedUrl || null;
  } catch {
    return null;
  }
}

function buildReminderHTML(inv, profile, daysOverdue) {
  const bName = profile.name || "Our company";
  const docType = inv.type === "quote" ? "Quote" : "Invoice";
  const accent = profile.business_id === "mworx" ? "#0d9488" : "#0f766e";
  const total = fmtAUD(inv.total || 0);

  const logoHTML = profile.logo_url
    ? `<img src="${esc(profile.logo_url)}" alt="${esc(bName)}" style="height:44px;border-radius:6px" />`
    : `<div style="background:#1a1a2e;color:#fff;padding:10px 20px;border-radius:6px;font-size:16px;font-weight:800;display:inline-block">${esc(bName)}</div>`;

  const bankHTML = (profile.bsb || profile.account_number) ? `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px 24px;margin:24px 0">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:12px">Payment Details</div>
      <table style="font-size:14px;color:#334155;line-height:1.8">
        ${profile.bank_name ? `<tr><td style="color:#64748b;padding-right:16px">Bank</td><td style="font-weight:600">${esc(profile.bank_name)}</td></tr>` : ""}
        <tr><td style="color:#64748b;padding-right:16px">Account Name</td><td style="font-weight:600">${esc(profile.account_name || profile.name || bName)}</td></tr>
        ${profile.bsb ? `<tr><td style="color:#64748b;padding-right:16px">BSB</td><td style="font-weight:600">${esc(profile.bsb)}</td></tr>` : ""}
        ${profile.account_number ? `<tr><td style="color:#64748b;padding-right:16px">Account Number</td><td style="font-weight:600">${esc(profile.account_number)}</td></tr>` : ""}
        <tr><td style="color:#64748b;padding-right:16px">Reference</td><td style="font-weight:600">${esc(inv.number)}</td></tr>
      </table>
    </div>` : "";

  // Card-payment button — only for real invoices when Stripe is configured and
  // the invoice has a pay token. The customer is charged the total plus a
  // surcharge (disclosed here and itemised at checkout).
  const payHTML = (PAY_ENABLED && inv.type !== "quote" && inv.pay_token) ? `
    <div style="text-align:center;margin:24px 0">
      <a href="${PAY_BASE}/.netlify/functions/pay-invoice?invoice=${esc(inv.id)}&t=${esc(inv.pay_token)}" style="display:inline-block;background:${accent};color:#fff;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;text-decoration:none">Pay ${total} by card</a>
      <div style="font-size:11px;color:#94a3b8;margin-top:8px">${SURCHARGE_PCT > 0 ? `A ${SURCHARGE_PCT}% card surcharge applies at checkout. ` : ""}Prefer bank transfer? Use the details below.</div>
    </div>` : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px">
    <div style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">

      <div style="background:${accent};height:4px"></div>

      <div style="padding:32px 36px 24px">
        ${logoHTML}
      </div>

      <div style="padding:0 36px 32px">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b">Payment Reminder</h1>
        <p style="margin:0 0 24px;font-size:14px;color:#64748b">${docType} ${esc(inv.number)} ${daysOverdue > 0 ? `is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue` : "— payment reminder"}</p>

        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:20px 24px;margin-bottom:24px">
          <table style="width:100%;font-size:14px">
            <tr>
              <td style="color:#64748b;padding-bottom:8px">${docType} Number</td>
              <td style="text-align:right;font-weight:600;color:#1e293b;padding-bottom:8px">${esc(inv.number)}</td>
            </tr>
            <tr>
              <td style="color:#64748b;padding-bottom:8px">Due Date</td>
              <td style="text-align:right;font-weight:600;color:#ef4444;padding-bottom:8px">${fmtDate(inv.due_date)}</td>
            </tr>
            <tr>
              <td style="color:#64748b">Amount Due</td>
              <td style="text-align:right;font-size:20px;font-weight:800;color:#1e293b">${total}</td>
            </tr>
          </table>
        </div>

        <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 4px">
          Hi ${esc(firstName(inv.contact_name) || "there")},
        </p>
        <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 24px">
          This is a friendly reminder that ${docType.toLowerCase()} <strong>${esc(inv.number)}</strong> for <strong>${total}</strong> ${daysOverdue > 0 ? `was due on <strong>${fmtDate(inv.due_date)}</strong> (${daysOverdue} day${daysOverdue === 1 ? "" : "s"} ago)` : `is due on <strong>${fmtDate(inv.due_date)}</strong>`}. We'd appreciate prompt payment at your earliest convenience.
        </p>

        ${payHTML}
        ${bankHTML}

        <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 4px">
          If you've already made payment, please disregard this reminder.
        </p>
        <p style="font-size:14px;color:#334155;line-height:1.7;margin:24px 0 0">
          Kind regards,<br>
          <strong>${esc(bName)}</strong>${profile.abn ? `<br>ABN: ${esc(profile.abn)}` : ""}${profile.address ? `<br>${esc(profile.address)}` : ""}${profile.email ? `<br>${esc(profile.email)}` : ""}${profile.phone ? ` · ${esc(profile.phone)}` : ""}
        </p>
      </div>

      <div style="background:#f8fafc;padding:20px 36px;border-top:1px solid #e2e8f0;text-align:center">
        <p style="margin:0;font-size:11px;color:#94a3b8">
          ${esc(bName)}${profile.abn ? ` · ABN ${esc(profile.abn)}` : ""}${profile.email ? ` · ${esc(profile.email)}` : ""}${profile.phone ? ` · ${esc(profile.phone)}` : ""}
        </p>
      </div>

    </div>

    <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px">
      This is an automated reminder from ${esc(bName)}.
    </p>
  </div>
</body>
</html>`;
}

// Upsert a reminder-log row keyed by (invoice_id, threshold). created_at is
// refreshed on every claim so staleness is measured from the last attempt.
async function writeLog(inv, threshold, status, detail) {
  await supabase.from("bk_reminder_log").upsert(
    {
      invoice_id: inv.id,
      threshold,
      sent_to: inv.contact_email,
      status,
      detail: detail ? String(detail).slice(0, 500) : null,
      created_at: new Date().toISOString(),
    },
    { onConflict: "invoice_id,threshold" }
  );
}

// Atomically claim the right to send. Returns the row id on success, or null if
// another concurrent run already holds the claim.
// - New (no prior row): INSERT. The unique (invoice_id, threshold) constraint
//   means only one concurrent writer wins; the loser's insert errors -> null.
// - Retry (failed/stale row): compare-and-swap UPDATE guarded on the exact
//   status + created_at we observed, so only one writer flips it to "sending".
async function claimLog(inv, threshold, logRow) {
  if (!logRow) {
    const { data, error } = await supabase
      .from("bk_reminder_log")
      .insert({ invoice_id: inv.id, threshold, sent_to: inv.contact_email, status: "sending", created_at: new Date().toISOString() })
      .select("id")
      .single();
    return error || !data ? null : data.id;
  }
  const { data, error } = await supabase
    .from("bk_reminder_log")
    .update({ status: "sending", sent_to: inv.contact_email, created_at: new Date().toISOString() })
    .eq("id", logRow.id)
    .eq("status", logRow.status)
    .eq("created_at", logRow.created_at)
    .select("id")
    .single();
  return error || !data ? null : data.id;
}

async function setLogStatus(id, status, detail) {
  await supabase.from("bk_reminder_log")
    .update({ status, detail: detail ? String(detail).slice(0, 500) : null })
    .eq("id", id);
}

// Classify what would/should happen for one invoice at its applicable threshold.
// Returns { threshold, disposition } where disposition is one of:
// skipped_not_due | already_sent | in_progress | will_send | failed_retryable
function classify(inv, daysOverdue, logRow) {
  const threshold = applicableThreshold(daysOverdue);
  if (!threshold) return { threshold: null, disposition: "skipped_not_due" };
  if (!logRow) return { threshold, disposition: "will_send" };
  if (logRow.status === "sent") return { threshold, disposition: "already_sent" };
  if (logRow.status === "sending") {
    const stale = Date.now() - new Date(logRow.created_at).getTime() > STALE_SENDING_MS;
    return { threshold, disposition: stale ? "failed_retryable" : "in_progress" };
  }
  // status === "failed" (or anything else) -> retry
  return { threshold, disposition: "failed_retryable" };
}

// dryRun: classify everything, send nothing.
// userId/businessId: when provided (manual run) the query is scoped to that
// user + business. The scheduled cron run passes neither and stays global.
export async function runReminders({ dryRun, userId = null, businessId = null }) {
  const todayStr = businessTodayStr();

  let query = supabase
    .from("bk_invoices")
    .select("*")
    .in("status", ["sent", "overdue"])
    .not("due_date", "is", null)
    .not("contact_email", "is", null)
    .lt("due_date", todayStr);
  if (userId) query = query.eq("user_id", userId);
  if (businessId) query = query.eq("business_id", businessId);

  const { data: invoices, error } = await query;
  if (error) {
    console.error("DB error:", error.message);
    return { ok: false, status: 500, message: "DB error" };
  }

  const { data: profiles } = await supabase.from("bk_profiles").select("*");
  const profileMap = {};
  for (const p of profiles || []) {
    // Swap the (private, unfetchable) logo URL for a signed one the email can load.
    if (!dryRun && p.logo_url) p.logo_url = await resolveLogoUrl(p.logo_url);
    profileMap[`${p.user_id}|${p.business_id}`] = p;
  }

  const canResend = !!RESEND_API_KEY;

  let sent = 0, skipped = 0, failed = 0;
  const preview = [];

  for (const inv of invoices || []) {
    if (inv.type === "quote") continue; // quotes don't get payment reminders

    const daysOverdue = daysOverdueFor(inv.due_date);
    const profile = profileMap[`${inv.user_id}|${inv.business_id}`] || {};

    // What threshold applies, and has it already been handled?
    const probe = applicableThreshold(daysOverdue);
    let logRow = null;
    if (probe) {
      const { data } = await supabase
        .from("bk_reminder_log")
        .select("*")
        .eq("invoice_id", inv.id)
        .eq("threshold", probe)
        .maybeSingle();
      logRow = data;
    }
    const { threshold, disposition } = classify(inv, daysOverdue, logRow);

    // Reminders send via Resend only.
    let status = disposition;
    const wouldSend = disposition === "will_send" || disposition === "failed_retryable";
    if (wouldSend && !canResend) status = "no_email_sender";

    if (dryRun) {
      preview.push({
        invoice: inv.number,
        to: inv.contact_email,
        daysOverdue,
        threshold,
        status,
        sendableVia: canResend ? `Resend (${REMINDER_FROM_EMAIL})` : null,
      });
      continue;
    }

    // ---- real send ----
    if (disposition === "skipped_not_due" || disposition === "already_sent" || disposition === "in_progress") {
      skipped++;
      continue;
    }
    if (!canResend) {
      failed++;
      await writeLog(inv, threshold, "failed", "Email sending not configured — set RESEND_API_KEY in Netlify");
      continue;
    }

    // Atomically claim before sending. If null, another run beat us to it.
    const claimId = await claimLog(inv, threshold, logRow);
    if (!claimId) { skipped++; continue; }

    const html = buildReminderHTML(inv, profile, daysOverdue);
    const subject = `Reminder: ${inv.type === "quote" ? "Quote" : "Invoice"} ${inv.number} from ${profile.name || "Our company"} — ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`;

    const res = await sendViaResend({ to: inv.contact_email, toName: inv.contact_name, subject, html, fromName: profile.name });

    if (res.ok) {
      sent++;
      await setLogStatus(claimId, "sent", "via resend");
    } else {
      failed++;
      console.error(`Failed to send ${inv.number} to ${inv.contact_email}:`, res.detail);
      await setLogStatus(claimId, "failed", res.detail);
    }
  }

  return { ok: true, status: 200, sent, skipped, failed, dryRun: !!dryRun, preview };
}

// On-demand send of a reminder for a SINGLE invoice (the "Send Reminder" button in
// the app). Bypasses the threshold/dedup logic of the scheduled run — it always
// sends. Scoped to the requesting user.
async function sendOneReminder({ invoiceId, userId }) {
  const { data: inv, error } = await supabase.from("bk_invoices").select("*").eq("id", invoiceId).eq("user_id", userId).maybeSingle();
  if (error || !inv) return { ok: false, status: 404, message: "Invoice not found" };
  if (inv.type === "quote") return { ok: false, status: 400, message: "Quotes don't get payment reminders" };
  if (!inv.contact_email) return { ok: false, status: 400, message: "This invoice has no contact email" };
  if (!RESEND_API_KEY) return { ok: false, status: 500, message: "Email sending not configured (RESEND_API_KEY missing in Netlify)." };

  const { data: profile } = await supabase.from("bk_profiles").select("*").eq("user_id", inv.user_id).eq("business_id", inv.business_id).maybeSingle();
  const prof = profile || {};
  if (prof.logo_url) prof.logo_url = await resolveLogoUrl(prof.logo_url);

  const daysOverdue = inv.due_date ? daysOverdueFor(inv.due_date) : 0;
  const html = buildReminderHTML(inv, prof, daysOverdue);
  const overdueLabel = daysOverdue > 0 ? ` — ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue` : "";
  const subject = `Reminder: Invoice ${inv.number} from ${prof.name || "Our company"}${overdueLabel}`;

  const res = await sendViaResend({ to: inv.contact_email, toName: inv.contact_name, subject, html, fromName: prof.name });
  if (!res.ok) return { ok: false, status: 502, message: res.detail || "Send failed" };
  await writeLog(inv, 0, "sent", "manual send"); // threshold 0 = manual, on-demand
  return { ok: true, status: 200, sent_to: inv.contact_email };
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Safe runtime env diagnostic. Exposes only booleans, value LENGTHS, total env
// count, Netlify system vars, and matching env-var NAMES — never any values.
// ENV_SMOKE_TEST is a non-sensitive var you add in Netlify: if it's visible but
// the SUPABASE_*/RESEND_* vars aren't, Netlify is withholding sensitive vars
// (untrusted-deploy policy), not a code bug. If even ENV_SMOKE_TEST is missing,
// it's the wrong deploy/scope/context.
function buildEnvDiagnostic() {
  const allKeys = Object.keys(process.env);
  return {
    totalEnvCount: allKeys.length,
    netlifySystemVars: {
      NETLIFY: !!process.env.NETLIFY,
      AWS_REGION: !!process.env.AWS_REGION,
      LAMBDA_TASK_ROOT: !!process.env.LAMBDA_TASK_ROOT,
    },
    has_ENV_SMOKE_TEST: !!process.env.ENV_SMOKE_TEST,
    lengths: {
      SUPABASE_SERVICE_KEY: (process.env.SUPABASE_SERVICE_KEY || "").length,
      SUPABASE_SERVICE_ROLE_KEY: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").length,
      SERVICE_ROLE_KEY: (process.env.SERVICE_ROLE_KEY || "").length,
      SUPABASE_URL: (process.env.SUPABASE_URL || "").length,
      VITE_SUPABASE_URL: (process.env.VITE_SUPABASE_URL || "").length,
      SUPABASE_ANON_KEY: (process.env.SUPABASE_ANON_KEY || "").length,
      VITE_SUPABASE_ANON_KEY: (process.env.VITE_SUPABASE_ANON_KEY || "").length,
      RESEND_API_KEY: (process.env.RESEND_API_KEY || "").length,
      ANTHROPIC_API_KEY: (process.env.ANTHROPIC_API_KEY || "").length,
      ENV_SMOKE_TEST: (process.env.ENV_SMOKE_TEST || "").length,
    },
    matchingNames: allKeys
      .filter((k) => /SUPABASE|SERVICE|RESEND|ENV_SMOKE|ANTHROPIC/i.test(k))
      .sort(),
  };
}

const handler = async (req) => {
  // Wrap everything: an unhandled throw returns an empty body, which Netlify
  // surfaces as "error decoding lambda response: unexpected end of JSON input".
  // Catching it guarantees a JSON response with the real cause.
  let isManual = false;
  try {
    // Resolve env config at request time (not module load).
    const cfg = resolveRuntime();

    const authHeader = req.headers?.get?.("authorization");
    const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    let dryRun = false;
    let businessId = null;
    try {
      const url = new URL(req.url);
      dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";
      businessId = url.searchParams.get("business_id") || null;
    } catch {
      // No parseable URL on some scheduled invocations — treat as cron run.
    }

    isManual = !!authToken || dryRun;

    let userId = null;
    if (isManual) {
      // Any authenticated app user may trigger/preview, but only for their own
      // user + active business (scoping happens in runReminders).
      if (!authToken) return json({ error: "Unauthorized" }, 401);
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        const diagnostic = buildEnvDiagnostic();
        console.error("send-reminders config diagnostic:", JSON.stringify(diagnostic));
        return json({ error: "Server not configured: Supabase URL/anon key missing in Netlify environment variables", diagnostic }, 500);
      }
      const userClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      const { data: { user }, error: authErr } = await userClient.auth.getUser(authToken);
      if (authErr || !user) return json({ error: "Unauthorized" }, 401);
      userId = user.id;
    }

    if (!supabase) {
      const diagnostic = buildEnvDiagnostic();
      console.error("send-reminders config diagnostic:", JSON.stringify(diagnostic));
      return isManual
        ? json({ error: "Server not configured: no Supabase service key found at runtime.", diagnostic }, 500)
        : new Response("Not configured", { status: 200 });
    }
    if (!dryRun && !RESEND_API_KEY) {
      console.log("Missing RESEND_API_KEY");
      return isManual ? json({ error: "Email sending not configured (RESEND_API_KEY missing in Netlify). Dry run still works." }, 500) : new Response("Not configured", { status: 200 });
    }

    // Single-invoice on-demand send: the app's "Send Reminder" button POSTs an
    // invoice_id in the body. Always sends that one invoice, bypassing thresholds.
    let invoiceId = null;
    try { const body = await req.json(); invoiceId = body?.invoice_id || null; } catch { /* no body = batch run */ }
    if (invoiceId) {
      if (!isManual || !userId) return json({ error: "Unauthorized" }, 401);
      const one = await sendOneReminder({ invoiceId, userId });
      return one.ok ? json({ ok: true, sent_to: one.sent_to }) : json({ error: one.message }, one.status);
    }

    // Manual run: scope to this user + their active business.
    // Cron run: global (userId/businessId stay null).
    const result = await runReminders({ dryRun, userId, businessId: isManual ? businessId : null });
    if (!result.ok) {
      return isManual ? json({ error: result.message }, result.status) : new Response(result.message, { status: result.status });
    }

    if (isManual) return json(result);
    return new Response(`Sent ${result.sent} reminders (skipped ${result.skipped}, failed ${result.failed})`, { status: 200 });
  } catch (err) {
    console.error("send-reminders fatal error:", err);
    const msg = `${err?.name || "Error"}: ${err?.message || String(err)}`;
    return isManual ? json({ error: msg }, 500) : new Response(msg, { status: 500 });
  }
};

export default wrapCors(handler);

export const config = {
  schedule: "@daily",
};
