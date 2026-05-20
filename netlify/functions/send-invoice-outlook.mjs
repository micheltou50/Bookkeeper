import { createClient } from "@supabase/supabase-js";
import { encryptToken, decryptToken } from "./lib/token-crypto.mjs";

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

async function refreshAccessToken(connectionId, decryptedRefreshToken) {
  if (!decryptedRefreshToken) return null;

  const resp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: decryptedRefreshToken,
      grant_type: "refresh_token",
      scope: "offline_access User.Read Mail.Send",
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

  const { invoice_id } = body;
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

  let pdfAttachment = null;
  if (inv.pdf_path) {
    const { data: pdfData } = await supabase.storage.from("invoices").download(inv.pdf_path);
    if (pdfData) {
      const buf = Buffer.from(await pdfData.arrayBuffer());
      if (buf.length <= MAX_ATTACHMENT_BYTES) {
        pdfAttachment = {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: `${docType}-${inv.number || "draft"}.pdf`,
          contentType: "application/pdf",
          contentBytes: buf.toString("base64"),
        };
      } else {
        console.warn(`PDF too large for inline attachment (${buf.length} bytes), sending without attachment`);
      }
    }
  }

  const accountName = profile?.account_name || profile?.name || bName;

  const subject = `${docType} ${inv.number} from ${bName}`;
  const htmlBody = `<p>Hi ${inv.contact_name || "there"},</p>
<p>Please find attached ${docType.toLowerCase()} <strong>${inv.number}</strong> for <strong>${fmtAUD(inv.total || 0)}</strong>.</p>
${inv.due_date ? `<p>Payment is due by <strong>${new Date(inv.due_date).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" })}</strong>.</p>` : ""}
${profile?.bsb ? `<p><strong>Payment details:</strong><br>${profile.bank_name ? `Bank: ${profile.bank_name}<br>` : ""}Account: ${accountName}<br>BSB: ${profile.bsb}<br>Account #: ${profile.account_number}<br>Reference: ${inv.number}</p>` : ""}
<p>Kind regards,<br><strong>${bName}</strong></p>`;

  const message = {
    subject,
    body: { contentType: "HTML", content: htmlBody },
    toRecipients: [{ emailAddress: { address: inv.contact_email, name: inv.contact_name || "" } }],
  };
  if (pdfAttachment) message.attachments = [pdfAttachment];

  const sendResp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!sendResp.ok) {
    console.error("Graph sendMail failed:", sendResp.status);
    return new Response(JSON.stringify({ error: "Failed to send email via Outlook" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  await supabase.from("bk_invoices").update({
    status: inv.status === "draft" ? "sent" : inv.status,
    sent_at: new Date().toISOString(),
  }).eq("id", invoice_id);

  return new Response(JSON.stringify({ success: true, sent_to: inv.contact_email }), { status: 200, headers: { "Content-Type": "application/json" } });
};
