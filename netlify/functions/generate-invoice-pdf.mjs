import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function fmtAUD(n) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

async function fetchLogoBase64(logoUrl) {
  if (!logoUrl) return null;
  try {
    const resp = await fetch(logoUrl);
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get("content-type") || "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function buildInvoiceHTML(inv, items, profile, logoDataUrl) {
  const accent = profile.business_id === "mworx" ? "#0d9488" : "#0f766e";
  const docType = inv.type === "quote" ? "QUOTE" : "INVOICE";
  const isQuote = inv.type === "quote";
  const bName = profile.name || "Company";
  const tagline = profile.business_id === "mworx" ? "Design · Consultancy · Project Management" : "";

  const logoHTML = logoDataUrl
    ? `<img src="${logoDataUrl}" style="max-height:70px;max-width:200px;object-fit:contain;display:block" />`
    : `<div style="font-size:24px;font-weight:800;color:#1e293b;letter-spacing:-0.02em">${bName}</div>`;

  const itemRows = (items || []).map((item) => {
    const amount = (Number(item.qty) || 0) * (Number(item.rate) || 0);
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#1e293b;vertical-align:top">
        <div style="font-weight:600">${item.description || ""}</div>
        ${item.note ? `<div style="font-size:10px;color:#6b7280;margin-top:2px">${item.note}</div>` : ""}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:center;vertical-align:top">${Number(item.qty) || 1}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums">${fmtAUD(item.rate || 0)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;font-weight:600;color:#1e293b;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums">${fmtAUD(amount)}</td>
    </tr>`;
  }).join("");

  const subtotal = (items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);

  const accountName = profile.name || bName;

  const paymentSection = !isQuote ? `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px 20px;margin-top:24px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:10px">How to Pay</div>
      <table style="font-size:11px;color:#374151;line-height:1.8;border-collapse:collapse">
        <tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Account Name</td><td style="font-weight:600">${accountName}</td></tr>
        ${profile.bank_name ? `<tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Bank</td><td style="font-weight:600">${profile.bank_name}</td></tr>` : ""}
        ${profile.bsb ? `<tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">BSB</td><td style="font-weight:600">${profile.bsb}</td></tr>` : ""}
        ${profile.account_number ? `<tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Account Number</td><td style="font-weight:600">${profile.account_number}</td></tr>` : ""}
        <tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Reference</td><td style="font-weight:600">${inv.number || ""}</td></tr>
      </table>
    </div>` : `
    <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:6px;padding:14px 20px;margin-top:24px">
      <div style="font-size:11px;color:#0f766e;line-height:1.6">This quote is valid for 30 days from the date of issue. Payment details will be provided upon acceptance.</div>
    </div>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #fff; color: #1e293b; -webkit-print-color-adjust: exact; }
  .page { width: 210mm; min-height: 297mm; padding: 40px 44px 64px; position: relative; }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
    <div>
      ${logoHTML}
      <div style="margin-top:10px">
        ${profile.abn ? `<div style="font-size:10px;color:#475569;font-weight:600;margin-bottom:3px">ABN ${profile.abn}</div>` : ""}
        <div style="font-size:10px;color:#6b7280;line-height:1.6">
          ${profile.address ? `${profile.address}<br>` : ""}${profile.email || ""}${profile.phone ? ` · ${profile.phone}` : ""}
        </div>
      </div>
    </div>
    <div style="text-align:right">
      <div style="font-size:32px;font-weight:700;color:#1e293b;letter-spacing:0.04em;text-transform:uppercase">${docType}</div>
      <div style="font-size:14px;font-weight:700;color:#374151;margin-top:4px">${inv.number || ""}</div>
    </div>
  </div>

  <div style="height:2px;background:${accent};margin-bottom:24px"></div>

  <!-- Bill To / Dates row -->
  <div style="display:flex;justify-content:space-between;margin-bottom:28px">
    <div style="flex:1">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin-bottom:6px">${isQuote ? "Quote For" : "Bill To"}</div>
      <div style="font-size:12px;color:#1e293b;line-height:1.7">
        <strong>${inv.contact_name || ""}</strong>
        ${inv.contact_company ? `<br>${inv.contact_company}` : ""}
        ${inv.contact_abn ? `<br><span style="font-size:10px;color:#6b7280">ABN ${inv.contact_abn}</span>` : ""}
        ${inv.contact_address ? `<br><span style="color:#6b7280;font-size:11px">${inv.contact_address}</span>` : ""}
        ${inv.contact_email ? `<br><span style="color:#6b7280;font-size:11px">${inv.contact_email}</span>` : ""}
        ${inv.contact_phone ? `<br><span style="color:#6b7280;font-size:11px">${inv.contact_phone}</span>` : ""}
      </div>
    </div>
    <div style="text-align:right;min-width:180px">
      <table style="font-size:11px;margin-left:auto;border-collapse:collapse">
        <tr><td style="color:#94a3b8;padding:3px 14px 3px 0;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">${isQuote ? "Quote Date" : "Invoice Date"}</td><td style="color:#1e293b;font-weight:500;padding:3px 0">${fmtDate(inv.date)}</td></tr>
        ${inv.due_date ? `<tr><td style="color:#94a3b8;padding:3px 14px 3px 0;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">${isQuote ? "Valid Until" : "Due Date"}</td><td style="color:#1e293b;font-weight:500;padding:3px 0">${fmtDate(inv.due_date)}</td></tr>` : ""}
        ${inv.job ? `<tr><td style="color:#94a3b8;padding:3px 14px 3px 0;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Job / Ref</td><td style="color:#1e293b;font-weight:500;padding:3px 0">${inv.job}</td></tr>` : ""}
      </table>
    </div>
  </div>

  <!-- Line items table -->
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
    <thead>
      <tr style="background:#f8fafc">
        <th style="text-align:left;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b">Description</th>
        <th style="text-align:center;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:50px">Qty</th>
        <th style="text-align:right;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:90px">Rate</th>
        <th style="text-align:right;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:100px">Amount</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <!-- Totals -->
  <div style="display:flex;justify-content:flex-end">
    <div style="width:240px">
      <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums"><span>Subtotal</span><span>${fmtAUD(subtotal)}</span></div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:11px;color:#94a3b8;font-variant-numeric:tabular-nums"><span>GST</span><span>$0.00</span></div>
      <div style="display:flex;justify-content:space-between;padding:10px 0 4px;margin-top:4px;border-top:2px solid #1e293b">
        <span style="font-size:14px;font-weight:700;color:#1e293b">Total AUD</span>
        <span style="font-size:16px;font-weight:800;color:${accent};font-variant-numeric:tabular-nums">${fmtAUD(subtotal)}</span>
      </div>
      <div style="font-size:10px;color:#6b7280;text-align:right;margin-top:2px">Not registered for GST. No GST has been charged.</div>
    </div>
  </div>

  <!-- Payment / Quote notice -->
  ${paymentSection}

  <!-- Notes -->
  ${inv.notes ? `<div style="font-size:10px;color:#6b7280;line-height:1.6;margin-top:20px;padding-top:10px;border-top:1px solid #e5e7eb">${inv.notes}</div>` : ""}

  <!-- Footer -->
  <div style="position:absolute;bottom:24px;left:44px;right:44px;text-align:center;border-top:1px solid #e2e8f0;padding-top:12px">
    <div style="font-size:10px;color:#64748b;margin-bottom:2px">Thank you for your business.</div>
    <div style="font-size:9px;color:#94a3b8">${bName}${profile.abn ? ` · ABN ${profile.abn}` : ""}${profile.email ? ` · ${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}</div>
    ${tagline ? `<div style="font-size:8px;color:#94a3b8;margin-top:2px">${tagline}</div>` : ""}
  </div>

</div>
</body>
</html>`;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const { invoice_id, auth_token } = body;
  if (!invoice_id) {
    return new Response(JSON.stringify({ error: "invoice_id required" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // Verify the user owns this invoice
  let userId = null;
  if (auth_token) {
    const userClient = createClient(
      process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
      process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
    );
    const { data: { user } } = await userClient.auth.getUser(auth_token);
    if (user) userId = user.id;
  }

  // Fetch invoice
  const { data: inv, error: invErr } = await supabase
    .from("bk_invoices")
    .select("*")
    .eq("id", invoice_id)
    .single();

  if (invErr || !inv) {
    return new Response(JSON.stringify({ error: "Invoice not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  // Check ownership
  if (userId && inv.user_id !== userId) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403, headers: { "Content-Type": "application/json" } });
  }

  // Fetch items
  const { data: items } = await supabase
    .from("bk_invoice_items")
    .select("*")
    .eq("invoice_id", invoice_id)
    .order("sort_order");

  // Fetch profile
  const { data: profile } = await supabase
    .from("bk_profiles")
    .select("*")
    .eq("user_id", inv.user_id)
    .eq("business_id", inv.business_id)
    .single();

  // Fetch logo as base64
  const logoDataUrl = await fetchLogoBase64(profile?.logo_url);

  // Build HTML
  const html = buildInvoiceHTML(inv, items || [], profile || {}, logoDataUrl);

  // Launch Puppeteer
  let browser = null;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 794, height: 1123 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
    });

    // Upload to Supabase Storage
    const filePath = `${inv.business_id}/${inv.id}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from("invoices")
      .upload(filePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: true,
      });

    if (uploadErr) {
      console.error("Upload error:", uploadErr);
      return new Response(JSON.stringify({ error: "Failed to upload PDF" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }

    // Update invoice record
    await supabase.from("bk_invoices").update({
      pdf_path: filePath,
      pdf_generated_at: new Date().toISOString(),
    }).eq("id", invoice_id);

    // Generate signed URL (1 hour)
    const { data: signedData } = await supabase.storage
      .from("invoices")
      .createSignedUrl(filePath, 3600);

    return new Response(JSON.stringify({
      success: true,
      pdf_path: filePath,
      signed_url: signedData?.signedUrl,
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("PDF generation error:", err);
    return new Response(JSON.stringify({ error: "PDF generation failed", details: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  } finally {
    if (browser) await browser.close();
  }
};
