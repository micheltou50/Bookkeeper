import { createClient } from "@supabase/supabase-js";
import { encryptToken, decryptToken } from "./lib/token-crypto.mjs";

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY
);

const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

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
      scope: "offline_access User.Read Mail.Send Mail.ReadWrite Files.ReadWrite",
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

function fmtAUD(n) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

const DEFAULT_INVOICE_TEMPLATE = `<p>Hi {contact_name},</p><p>Please find attached invoice {number} for {amount}.</p>{due_date_line}{payment_details}<p>Kind regards,<br>{signature}</p>`;

const DEFAULT_QUOTE_TEMPLATE = `<p>Hi {contact_name},</p><p>Please find attached quote {number} for {amount}.</p><p>This quote is valid until {due_date}.</p><p>Kind regards,<br>{signature}</p>`;

const HTML_VARS = new Set(["payment_details", "signature", "due_date_line"]);

function renderTemplate(template, vars) {
  const isHtml = /<[a-z][\s\S]*>/i.test(template);
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    const safe = HTML_VARS.has(k) ? (v || "") : escapeHtml(v || "");
    out = out.replaceAll(`{${k}}`, safe);
  }
  if (!isHtml) {
    out = out.split(/\n\n+/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
  }
  return out;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const authHeader = req.headers.get("authorization");
  const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const { invoice_id, draft } = body;
  if (!invoice_id || !authToken) {
    return new Response(JSON.stringify({ error: "invoice_id and Authorization header required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const userClient = createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  );
  const { data: { user } } = await userClient.auth.getUser(authToken);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const { data: inv } = await supabase.from("bk_invoices").select("*").eq("id", invoice_id).single();
  if (!inv || inv.user_id !== user.id) {
    return new Response(JSON.stringify({ error: "Invoice not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  if (!inv.contact_email) {
    return new Response(JSON.stringify({ error: "Invoice has no contact email" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const { data: conn } = await supabase.from("bk_email_connections")
    .select("*")
    .eq("user_id", user.id)
    .eq("business_id", inv.business_id)
    .eq("provider", "outlook")
    .single();

  if (!conn) {
    return new Response(JSON.stringify({ error: "No Outlook connection found" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  let accessToken, refreshToken;
  try {
    accessToken = decryptToken(conn.access_token);
    refreshToken = conn.refresh_token ? decryptToken(conn.refresh_token) : null;
  } catch {
    return new Response(JSON.stringify({ error: "Outlook connection needs to be reconnected" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  if (new Date(conn.expires_at) < new Date()) {
    accessToken = await refreshAccessToken(conn.id, refreshToken);
    if (!accessToken) {
      return new Response(JSON.stringify({ error: "Token refresh failed — reconnect Outlook" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
  }

  const { data: profile } = await supabase.from("bk_profiles").select("*").eq("user_id", user.id).eq("business_id", inv.business_id).single();
  const bName = profile?.name || "Our company";
  const docType = inv.type === "quote" ? "Quote" : "Invoice";

  // The invoice PDF is required — never send/draft an invoice email without it.
  let pdfAttachment = null;
  if (!inv.pdf_path) {
    return new Response(JSON.stringify({ error: "Invoice PDF has not been generated yet. Please try again." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const { data: pdfData, error: pdfErr } = await supabase.storage.from("invoices").download(inv.pdf_path);
  if (pdfErr || !pdfData) {
    console.error("PDF download failed:", pdfErr?.message);
    return new Response(JSON.stringify({ error: "Could not load the invoice PDF. Please regenerate it and try again." }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const buf = Buffer.from(await pdfData.arrayBuffer());
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    console.warn(`PDF too large for inline attachment (${buf.length} bytes)`);
    return new Response(JSON.stringify({ error: "The invoice PDF is too large to attach (over 3 MB). Please simplify the invoice or send it manually." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  pdfAttachment = {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: `${docType}-${inv.number || "draft"}.pdf`,
    contentType: "application/pdf",
    contentBytes: buf.toString("base64"),
  };

  const accountName = profile?.account_name || profile?.name || bName;
  const fmtDate = (d) => new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });

  const paymentDetailsHtml = profile?.bsb
    ? `<p><strong>Payment details:</strong><br>${profile.bank_name ? `Bank: ${escapeHtml(profile.bank_name)}<br>` : ""}Account: ${escapeHtml(accountName)}<br>BSB: ${escapeHtml(profile.bsb)}<br>Account #: ${escapeHtml(profile.account_number)}<br>Reference: ${escapeHtml(inv.number)}</p>`
    : "";

  const dueDateLine = inv.due_date
    ? (inv.type === "quote"
        ? `<p>This quote is valid until <strong>${fmtDate(inv.due_date)}</strong>.</p>`
        : `<p>Payment is due by <strong>${fmtDate(inv.due_date)}</strong>.</p>`)
    : "";

  const signatureHtml = profile?.email_signature
    ? profile.email_signature.replace(/\n/g, "<br>")
    : `<strong>${escapeHtml(bName)}</strong>${profile?.abn ? `<br>ABN: ${escapeHtml(profile.abn)}` : ""}${profile?.address ? `<br>${escapeHtml(profile.address)}` : ""}${profile?.email ? `<br>${escapeHtml(profile.email)}` : ""}${profile?.phone ? ` · ${escapeHtml(profile.phone)}` : ""}`;

  const templateVars = {
    contact_name: inv.contact_name || "there",
    number: inv.number || "",
    amount: fmtAUD(inv.total || 0),
    due_date: inv.due_date ? fmtDate(inv.due_date) : "",
    due_date_line: dueDateLine,
    payment_details: paymentDetailsHtml,
    business_name: bName,
    signature: signatureHtml,
  };

  const customTemplate = inv.type === "quote" ? profile?.email_template_quote : profile?.email_template_invoice;
  const template = customTemplate?.trim() || (inv.type === "quote" ? DEFAULT_QUOTE_TEMPLATE : DEFAULT_INVOICE_TEMPLATE);

  const subject = `${docType} ${inv.number} from ${bName}`;
  const rawBody = renderTemplate(template, templateVars);
  const htmlBody = `<div style="font-family: 'Century Gothic', CenturyGothic, AppleGothic, sans-serif; font-size: 11pt;">${rawBody}</div>`;

  const message = {
    subject,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: [{ emailAddress: { address: inv.contact_email, name: inv.contact_name || "" } }],
  };
  if (pdfAttachment) message.attachments = [pdfAttachment];

  const doGraph = async (token, url, payload) => {
    return fetchWithTimeout(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload,
    });
  };

  if (draft) {
    const draftPayload = JSON.stringify(message);
    let draftResp = await doGraph(accessToken, "https://graph.microsoft.com/v1.0/me/messages", draftPayload);

    if (draftResp.status === 401 && refreshToken) {
      const newToken = await refreshAccessToken(conn.id, refreshToken);
      if (newToken) {
        accessToken = newToken;
        draftResp = await doGraph(accessToken, "https://graph.microsoft.com/v1.0/me/messages", draftPayload);
      }
    }

    if (!draftResp.ok) {
      let graphError = "";
      try { const errBody = await draftResp.json(); graphError = JSON.stringify(errBody); } catch {}
      console.error("Graph draft creation failed:", draftResp.status, graphError);
      return new Response(JSON.stringify({ error: "Could not create the Outlook draft. Please reconnect Outlook in Settings and try again." }), { status: 502, headers: { "Content-Type": "application/json" } });
    }

    const created = await draftResp.json();
    return new Response(JSON.stringify({ success: true, draft: true, webLink: created.webLink, messageId: created.id }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const mailPayload = JSON.stringify({ message, saveToSentItems: true });
  let sendResp = await doGraph(accessToken, "https://graph.microsoft.com/v1.0/me/sendMail", mailPayload);

  if (sendResp.status === 401 && refreshToken) {
    console.log("Access token rejected, refreshing...");
    const newToken = await refreshAccessToken(conn.id, refreshToken);
    if (newToken) {
      accessToken = newToken;
      sendResp = await doGraph(accessToken, "https://graph.microsoft.com/v1.0/me/sendMail", mailPayload);
    }
  }

  if (!sendResp.ok) {
    let graphError = "";
    try { const errBody = await sendResp.json(); graphError = JSON.stringify(errBody); } catch {}
    console.error("Graph sendMail failed:", sendResp.status, graphError);
    return new Response(JSON.stringify({ error: "Could not send the email via Outlook. Please reconnect Outlook in Settings and try again." }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  await supabase.from("bk_invoices").update({
    status: inv.status === "draft" ? "sent" : inv.status,
    sent_at: new Date().toISOString(),
  }).eq("id", invoice_id);

  return new Response(JSON.stringify({ success: true, sent_to: inv.contact_email }), { status: 200, headers: { "Content-Type": "application/json" } });
};
