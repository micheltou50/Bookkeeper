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

  const { data: rows, error } = await supabase.from("bk_app_data").select("user_id, data");
  if (error) {
    console.error("DB error:", error.message);
    return new Response("DB error", { status: 500 });
  }

  const now = new Date();
  let sent = 0;

  for (const row of rows || []) {
    const d = row.data;
    if (!d?.invoices || !d?.profiles) continue;

    for (const bizKey of Object.keys(d.invoices)) {
      const profile = d.profiles[bizKey] || {};
      const invoiceList = d.invoices[bizKey] || [];

      for (const inv of invoiceList) {
        if (inv.status !== "sent" && inv.status !== "overdue") continue;
        if (!inv.dueDate || !inv.contactEmail) continue;

        const due = new Date(inv.dueDate);
        const daysOverdue = Math.floor((now - due) / 86400000);

        if (daysOverdue < 1) continue;
        if (daysOverdue !== 1 && daysOverdue !== 7 && daysOverdue !== 14 && daysOverdue !== 30) continue;

        const bName = profile.name || "Our company";
        const docType = inv.type === "quote" ? "Quote" : "Invoice";
        const bankDetails = profile.bsb
          ? `\n\nBank details:\nAccount: ${profile.bankName || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.accountNumber}\nReference: ${inv.number}`
          : "";

        const subject = `Reminder: ${docType} ${inv.number} from ${bName} — ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`;
        const body = `Hi ${inv.contact || ""},\n\nThis is a friendly reminder that ${docType.toLowerCase()} ${inv.number} for $${Number(inv.total || 0).toLocaleString("en-AU", { minimumFractionDigits: 2 })} was due on ${inv.dueDate} (${daysOverdue} day${daysOverdue === 1 ? "" : "s"} ago).${bankDetails}\n\nPlease let us know if you have any questions.\n\nKind regards,\n${bName}`;

        try {
          const resp = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: FROM_EMAIL, to: inv.contactEmail, subject, text: body }),
          });
          if (resp.ok) sent++;
          else console.error(`Failed to send to ${inv.contactEmail}:`, await resp.text());
        } catch (err) {
          console.error(`Email error for ${inv.number}:`, err.message);
        }
      }
    }
  }

  return new Response(`Sent ${sent} reminders`, { status: 200 });
};

export const config = {
  schedule: "@daily",
};
