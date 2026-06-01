import { createClient } from "@supabase/supabase-js";

// The project URL is public (it's already in src/supabaseClient.js), so it's
// safe to hard-code as a fallback. Only the keys are secret.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://yzndkdlzgegrcotfeqlp.supabase.co";
// The anon key is PUBLIC by design (it's already shipped in the browser bundle),
// so hard-coding it as a fallback is safe and means the manual reminder trigger
// works without an extra Netlify env var. Only the service key stays secret.
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6bmRrZGx6Z2VncmNvdGZlcWxwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3MzY2NzgsImV4cCI6MjA5NDMxMjY3OH0.GOWxurft8r0NlQv9phY4MRFcYM8iGdy4fWdphLxc72s";

// Build the client defensively. createClient throws "supabaseKey is required"
// if the key is missing — and because this runs at module load (before the
// handler's try/catch), that throw would surface as an empty lambda response
// ("unexpected end of JSON input") instead of a readable error. Returning null
// lets the handler report a clean "not configured" message instead.
function makeServiceClient() {
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !key) return null;
  try {
    return createClient(SUPABASE_URL, key);
  } catch (e) {
    console.error("Failed to create Supabase client:", e.message);
    return null;
  }
}

const supabase = makeServiceClient();

const THRESHOLDS = [1, 7, 14, 30];
const BUSINESS_TZ = process.env.BUSINESS_TIMEZONE || "Australia/Sydney";
const STALE_SENDING_MS = 30 * 60 * 1000; // a "sending" claim older than this is retryable

// Reminders send via Resend (avoids the Microsoft 365 outbound IP-reputation
// bounces). Requires RESEND_API_KEY and the domain verified in Resend.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REMINDER_FROM_EMAIL = process.env.REMINDER_FROM_EMAIL || "noreply@mworxgroup.com.au";

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
        <p style="margin:0 0 24px;font-size:14px;color:#64748b">${docType} ${esc(inv.number)} is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue</p>

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
          Hi ${esc(inv.contact_name || "there")},
        </p>
        <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 24px">
          This is a friendly reminder that ${docType.toLowerCase()} <strong>${esc(inv.number)}</strong> for <strong>${total}</strong> was due on <strong>${fmtDate(inv.due_date)}</strong> (${daysOverdue} day${daysOverdue === 1 ? "" : "s"} ago). We'd appreciate prompt payment at your earliest convenience.
        </p>

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
  for (const p of profiles || []) profileMap[`${p.user_id}|${p.business_id}`] = p;

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

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

export default async (req) => {
  // Wrap everything: an unhandled throw returns an empty body, which Netlify
  // surfaces as "error decoding lambda response: unexpected end of JSON input".
  // Catching it guarantees a JSON response with the real cause.
  let isManual = false;
  try {
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
      if (!SUPABASE_ANON_KEY) {
        return json({ error: "Server not configured: VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY) is missing in Netlify environment variables" }, 500);
      }
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data: { user }, error: authErr } = await userClient.auth.getUser(authToken);
      if (authErr || !user) return json({ error: "Unauthorized" }, 401);
      userId = user.id;
    }

    if (!supabase) {
      return isManual ? json({ error: "Server not configured: no Supabase service key found. Set SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) in Netlify and redeploy. Make sure its Scope includes Functions." }, 500) : new Response("Not configured", { status: 200 });
    }
    if (!dryRun && !RESEND_API_KEY) {
      console.log("Missing RESEND_API_KEY");
      return isManual ? json({ error: "Email sending not configured (RESEND_API_KEY missing in Netlify). Dry run still works." }, 500) : new Response("Not configured", { status: 200 });
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

export const config = {
  schedule: "@daily",
};
