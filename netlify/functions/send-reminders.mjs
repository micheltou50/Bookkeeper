import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.REMINDER_FROM_EMAIL || "noreply@mworxgroup.com.au";

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

  const profileKeys = [...new Set((invoices || []).map((i) => `${i.user_id}|${i.business_id}`))];
  const { data: profiles } = await supabase.from("bk_profiles").select("*");
  const profileMap = {};
  for (const p of profiles || []) profileMap[`${p.user_id}|${p.business_id}`] = p;

  let sent = 0;

  for (const inv of invoices || []) {
    const daysOverdue = Math.floor((now - new Date(inv.due_date)) / 86400000);
    if (daysOverdue < 1) continue;
    if (daysOverdue !== 1 && daysOverdue !== 7 && daysOverdue !== 14 && daysOverdue !== 30) continue;

    const profile = profileMap[`${inv.user_id}|${inv.business_id}`] || {};
    const bName = profile.name || "Our company";
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    const bankDetails = profile.bsb
      ? `\n\nBank details:\nAccount: ${profile.bank_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}`
      : "";

    const subject = `Reminder: ${docType} ${inv.number} from ${bName} — ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`;
    const body = `Hi ${inv.contact_name || ""},\n\nThis is a friendly reminder that ${docType.toLowerCase()} ${inv.number} for $${Number(inv.total || 0).toLocaleString("en-AU", { minimumFractionDigits: 2 })} was due on ${inv.due_date} (${daysOverdue} day${daysOverdue === 1 ? "" : "s"} ago).${bankDetails}\n\nPlease let us know if you have any questions.\n\nKind regards,\n${bName}`;

    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM_EMAIL, to: inv.contact_email, subject, text: body }),
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
