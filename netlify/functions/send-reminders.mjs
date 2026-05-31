import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.REMINDER_FROM_EMAIL || "noreply@mworxgroup.com.au";

function fmtAUD(n) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
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

export default async () => {
  if (!RESEND_API_KEY || !supabase) {
    console.log("Missing RESEND_API_KEY or Supabase config");
    return new Response("Not configured", { status: 200 });
  }

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
    return new Response("DB error", { status: 500 });
  }

  const { data: profiles } = await supabase.from("bk_profiles").select("*");
  const profileMap = {};
  for (const p of profiles || []) profileMap[`${p.user_id}|${p.business_id}`] = p;

  let sent = 0;

  for (const inv of invoices || []) {
    if (inv.type === "quote") continue; // quotes don't get payment reminders
    const daysOverdue = Math.floor((now - new Date(inv.due_date)) / 86400000);
    if (daysOverdue < 1) continue;
    if (daysOverdue !== 1 && daysOverdue !== 7 && daysOverdue !== 14 && daysOverdue !== 30) continue;

    const profile = profileMap[`${inv.user_id}|${inv.business_id}`] || {};
    const bName = profile.name || "Our company";
    const docType = inv.type === "quote" ? "Quote" : "Invoice";

    const subject = `Reminder: ${docType} ${inv.number} from ${bName} — ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`;
    const html = buildReminderHTML(inv, profile, daysOverdue);
    const sig = profile.email_signature || `${bName}${profile.abn ? `\nABN: ${profile.abn}` : ""}${profile.address ? `\n${profile.address}` : ""}${profile.email ? `\n${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}`;
    const text = `Hi ${inv.contact_name || "there"},\n\nThis is a friendly reminder that ${docType.toLowerCase()} ${inv.number} for ${fmtAUD(inv.total || 0)} was due on ${fmtDate(inv.due_date)} (${daysOverdue} day${daysOverdue === 1 ? "" : "s"} ago).${profile.bsb ? `\n\nBank details:\n${profile.bank_name ? `Bank: ${profile.bank_name}\n` : ""}Account: ${profile.account_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}` : ""}\n\nKind regards,\n${sig}`;

    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `${bName} <${FROM_EMAIL}>`, to: inv.contact_email, subject, html, text }),
      });
      if (resp.ok) sent++;
      else console.error(`Failed to send to ${inv.contact_email}:`, await resp.text());
    } catch (err) {
      console.error(`Email error for ${inv.number}:`, err.message);
    }
  }

  return new Response(`Sent ${sent} reminders`, { status: 200 });
};

export const config = {
  schedule: "@daily",
};
