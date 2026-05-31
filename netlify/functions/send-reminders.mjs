import { createClient } from "@supabase/supabase-js";
import { encryptToken, decryptToken } from "./lib/token-crypto.mjs";

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

// The project URL is public (it's already in src/supabaseClient.js), so it's
// safe to hard-code as a fallback. Only the keys are secret.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "https://yzndkdlzgegrcotfeqlp.supabase.co";
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

// Build the client defensively. createClient throws "supabaseKey is required"
// if the key is missing — and because this runs at module load (before the
// handler's try/catch), that throw would surface as an empty lambda response
// ("unexpected end of JSON input") instead of a readable error. Returning null
// lets the handler report a clean "not configured" message instead.
function makeServiceClient() {
  const key = process.env.SUPABASE_SERVICE_KEY;
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

function fmtAUD(n) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

// --- Outlook / Microsoft Graph sending (mirrors send-invoice-outlook.mjs) ---

async function refreshAccessToken(connectionId, decryptedRefreshToken) {
  if (!decryptedRefreshToken) return null;
  const resp = await fetchWithTimeout("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: decryptedRefreshToken,
      grant_type: "refresh_token",
      scope: "offline_access User.Read Mail.Send Mail.ReadWrite",
    }),
  });
  if (!resp.ok) {
    console.error("Token refresh failed:", resp.status);
    return null;
  }
  const tokens = await resp.json();
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
  await supabase.from("bk_email_connections").update({
    access_token: encryptToken(tokens.access_token),
    refresh_token: encryptToken(tokens.refresh_token || decryptedRefreshToken),
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }).eq("id", connectionId);
  return tokens.access_token;
}

// fetch with a hard timeout so a hung Microsoft call can't run out the
// function's wall-clock limit (which would yield an empty lambda response).
async function fetchWithTimeout(url, options, ms = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

const graphSend = (token, message) => fetchWithTimeout("https://graph.microsoft.com/v1.0/me/sendMail", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ message, saveToSentItems: true }),
});

// Returns { ok: true } or { ok: false, detail } — never throws.
async function sendViaOutlook(conn, message) {
  let accessToken, refreshToken;
  try {
    accessToken = decryptToken(conn.access_token);
    refreshToken = conn.refresh_token ? decryptToken(conn.refresh_token) : null;
  } catch {
    return { ok: false, detail: "Outlook connection invalid — reconnect needed" };
  }

  // Proactively refresh if the stored access token has expired.
  if (new Date(conn.expires_at) < new Date()) {
    const refreshed = await refreshAccessToken(conn.id, refreshToken);
    if (!refreshed) return { ok: false, detail: "Token refresh failed — reconnect Outlook in Settings" };
    accessToken = refreshed;
  }

  let resp = await graphSend(accessToken, message);
  if (resp.status === 401 && refreshToken) {
    const newToken = await refreshAccessToken(conn.id, refreshToken);
    if (newToken) resp = await graphSend(newToken, message);
  }

  if (resp.ok) return { ok: true };
  let detail = `Graph error ${resp.status}`;
  try { detail = `Graph ${resp.status}: ${JSON.stringify(await resp.json())}`.slice(0, 500); } catch { /* keep status */ }
  return { ok: false, detail };
}

function buildReminderHTML(inv, profile, daysOverdue) {
  const bName = profile.name || "Our company";
  const docType = inv.type === "quote" ? "Quote" : "Invoice";
  const accent = profile.business_id === "mworx" ? "#0d9488" : "#0f766e";
  const total = fmtAUD(inv.total || 0);

  const logoHTML = profile.logo_url
    ? `<img src="${profile.logo_url}" alt="${bName}" style="height:44px;border-radius:6px" />`
    : `<div style="background:#1a1a2e;color:#fff;padding:10px 20px;border-radius:6px;font-size:16px;font-weight:800;display:inline-block">${bName}</div>`;

  const bankHTML = (profile.bsb || profile.account_number) ? `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px 24px;margin:24px 0">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:12px">Payment Details</div>
      <table style="font-size:14px;color:#334155;line-height:1.8">
        ${profile.bank_name ? `<tr><td style="color:#64748b;padding-right:16px">Bank</td><td style="font-weight:600">${profile.bank_name}</td></tr>` : ""}
        <tr><td style="color:#64748b;padding-right:16px">Account Name</td><td style="font-weight:600">${profile.account_name || profile.name || bName}</td></tr>
        ${profile.bsb ? `<tr><td style="color:#64748b;padding-right:16px">BSB</td><td style="font-weight:600">${profile.bsb}</td></tr>` : ""}
        ${profile.account_number ? `<tr><td style="color:#64748b;padding-right:16px">Account Number</td><td style="font-weight:600">${profile.account_number}</td></tr>` : ""}
        <tr><td style="color:#64748b;padding-right:16px">Reference</td><td style="font-weight:600">${inv.number}</td></tr>
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
        <p style="margin:0 0 24px;font-size:14px;color:#64748b">${docType} ${inv.number} is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue</p>

        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:20px 24px;margin-bottom:24px">
          <table style="width:100%;font-size:14px">
            <tr>
              <td style="color:#64748b;padding-bottom:8px">${docType} Number</td>
              <td style="text-align:right;font-weight:600;color:#1e293b;padding-bottom:8px">${inv.number}</td>
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
          Hi ${inv.contact_name || "there"},
        </p>
        <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 24px">
          This is a friendly reminder that ${docType.toLowerCase()} <strong>${inv.number}</strong> for <strong>${total}</strong> was due on <strong>${fmtDate(inv.due_date)}</strong> (${daysOverdue} day${daysOverdue === 1 ? "" : "s"} ago). We'd appreciate prompt payment at your earliest convenience.
        </p>

        ${bankHTML}

        <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 4px">
          If you've already made payment, please disregard this reminder.
        </p>
        <p style="font-size:14px;color:#334155;line-height:1.7;margin:24px 0 0">
          Kind regards,<br>
          <strong>${bName}</strong>${profile.abn ? `<br>ABN: ${profile.abn}` : ""}${profile.address ? `<br>${profile.address}` : ""}${profile.email ? `<br>${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}
        </p>
      </div>

      <div style="background:#f8fafc;padding:20px 36px;border-top:1px solid #e2e8f0;text-align:center">
        <p style="margin:0;font-size:11px;color:#94a3b8">
          ${bName}${profile.abn ? ` · ABN ${profile.abn}` : ""}${profile.email ? ` · ${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}
        </p>
      </div>

    </div>

    <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px">
      This is an automated reminder from ${bName}.
    </p>
  </div>
</body>
</html>`;
}

export async function runReminders({ dryRun }) {
  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];

  const { data: invoices, error } = await supabase
    .from("bk_invoices")
    .select("*")
    .in("status", ["sent", "overdue"])
    .not("due_date", "is", null)
    .not("contact_email", "is", null)
    .lt("due_date", todayStr);

  if (error) {
    console.error("DB error:", error.message);
    return { ok: false, status: 500, message: "DB error" };
  }

  const { data: profiles } = await supabase.from("bk_profiles").select("*");
  const profileMap = {};
  for (const p of profiles || []) profileMap[`${p.user_id}|${p.business_id}`] = p;

  // Outlook connection per user+business — reminders send from this mailbox.
  const { data: conns } = await supabase.from("bk_email_connections").select("*").eq("provider", "outlook");
  const connMap = {};
  for (const c of conns || []) connMap[`${c.user_id}|${c.business_id}`] = c;

  let sent = 0, skipped = 0, failed = 0;
  const preview = [];

  for (const inv of invoices || []) {
    if (inv.type === "quote") continue; // quotes don't get payment reminders
    const daysOverdue = Math.floor((now - new Date(inv.due_date)) / 86400000);
    if (!THRESHOLDS.includes(daysOverdue)) continue;

    const profile = profileMap[`${inv.user_id}|${inv.business_id}`] || {};
    const bName = profile.name || "Our company";
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    const subject = `Reminder: ${docType} ${inv.number} from ${bName} — ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`;
    const conn = connMap[`${inv.user_id}|${inv.business_id}`];

    if (dryRun) {
      preview.push({ invoice: inv.number, to: inv.contact_email, daysOverdue, subject, sendableVia: conn ? `Outlook (${conn.email})` : "NO OUTLOOK CONNECTION" });
      continue;
    }

    // Idempotency: claim this (invoice, threshold) before sending. A duplicate
    // claim fails on the unique constraint, so the reminder is never sent twice.
    const { data: claim, error: claimErr } = await supabase
      .from("bk_reminder_log")
      .insert({ invoice_id: inv.id, threshold: daysOverdue, sent_to: inv.contact_email, status: "sending" })
      .select("id")
      .single();
    if (claimErr || !claim) {
      skipped++; // already sent for this threshold (or claim failed) — do not re-send
      continue;
    }

    if (!conn) {
      failed++;
      await supabase.from("bk_reminder_log").update({ status: "failed", detail: "No Outlook connection for this business — connect Outlook in Settings" }).eq("id", claim.id);
      continue;
    }

    const html = buildReminderHTML(inv, profile, daysOverdue);
    const message = {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: inv.contact_email, name: inv.contact_name || "" } }],
    };

    const res = await sendViaOutlook(conn, message);
    if (res.ok) {
      sent++;
      await supabase.from("bk_reminder_log").update({ status: "sent" }).eq("id", claim.id);
    } else {
      failed++;
      console.error(`Failed to send ${inv.number} to ${inv.contact_email}:`, res.detail);
      await supabase.from("bk_reminder_log").update({ status: "failed", detail: String(res.detail).slice(0, 500) }).eq("id", claim.id);
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
    // A manual invocation comes from the app carrying a Supabase auth token
    // and/or a dryRun query param. The scheduled (@daily) cron run has neither
    // and proceeds without auth.
    const authHeader = req.headers?.get?.("authorization");
    const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    let dryRun = false;
    try {
      const url = new URL(req.url);
      dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";
    } catch {
      // No parseable URL on some scheduled invocations — treat as cron run.
    }

    isManual = !!authToken || dryRun;

    if (isManual) {
      // Any authenticated app user may trigger or preview reminders.
      if (!authToken) return json({ error: "Unauthorized" }, 401);
      if (!SUPABASE_ANON_KEY) {
        return json({ error: "Server not configured: VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY) is missing in Netlify environment variables" }, 500);
      }
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data: { user }, error: authErr } = await userClient.auth.getUser(authToken);
      if (authErr || !user) return json({ error: "Unauthorized" }, 401);
    }

    // Config requirements: Supabase service key always; Microsoft creds only for
    // a real send (dry runs send nothing, so they work without them).
    if (!supabase) {
      return isManual ? json({ error: "Server not configured: SUPABASE_SERVICE_KEY is missing in Netlify environment variables" }, 500) : new Response("Not configured", { status: 200 });
    }
    if (!dryRun && (!CLIENT_ID || !CLIENT_SECRET)) {
      console.log("Missing Microsoft OAuth credentials");
      return isManual ? json({ error: "Outlook sending not configured (Microsoft credentials missing in Netlify). Dry run still works." }, 500) : new Response("Not configured", { status: 200 });
    }

    const result = await runReminders({ dryRun });
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
