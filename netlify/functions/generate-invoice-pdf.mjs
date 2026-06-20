import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY
);

function fmtAUD(n) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

// Escape user-controlled strings before they go into the invoice HTML so a
// stray "<", "&", or quote in a name/address/notes can't break the layout.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Return a shallow copy with the named string fields HTML-escaped. Fields used
// for logic (inv.type, profile.business_id) are intentionally left untouched.
function escFields(obj, keys) {
  const out = { ...(obj || {}) };
  for (const k of keys) if (typeof out[k] === "string") out[k] = esc(out[k]);
  return out;
}

async function fetchLogoBase64(logoUrl) {
  if (!logoUrl) return null;
  try {
    const match = logoUrl.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (match) {
      const [, bucket, path] = match;
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error || !data) {
        console.error("Logo storage download failed:", error?.message);
        return null;
      }
      const buf = Buffer.from(await data.arrayBuffer());
      const ext = path.split(".").pop()?.toLowerCase();
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
      return `data:${mime};base64,${buf.toString("base64")}`;
    }
    const resp = await fetch(logoUrl);
    if (!resp.ok) {
      console.error("Logo fetch failed:", resp.status, resp.statusText);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const mime = resp.headers.get("content-type") || "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (err) {
    console.error("Logo resolution error:", err.message);
    return null;
  }
}

// A single-line description renders as plain bold text. A multi-line one becomes a
// bulleted scope list: non-indented lines get a "•", whitespace-led lines become
// "◦" sub-items. Any leading bullet char the user typed is stripped. The text is
// already HTML-escaped by escFields before this runs.
function bulletizeScope(text, always = false) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length <= 1 && !always) return `<div style="font-weight:600;white-space:pre-wrap">${raw}</div>`;
  return lines.map((l) => {
    const sub = /^\s/.test(l);
    const t = l.trim().replace(/^[-*•◦·]\s*/, "");
    return `<div style="display:flex;gap:7px;margin-left:${sub ? 16 : 0}px;margin-top:3px;line-height:1.4"><span style="color:#64748b;flex-shrink:0">${sub ? "◦" : "•"}</span><span style="font-weight:${sub ? 400 : 600}">${t}</span></div>`;
  }).join("");
}

// Printed acceptance form for quotes: the client fills in their invoicing details
// and signs to accept. Static HTML (blank ruled lines for handwriting / signing).
const ACCEPTANCE_BLOCK = `<div style="margin-top:30px">
  <div style="font-size:15px;font-weight:700;color:#1e293b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Acceptance of Quote</div>
  <div style="font-size:10px;color:#64748b;margin-bottom:18px">To accept this quote, please complete your invoicing details, sign and date below, and return a copy to us.</div>
  <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;margin-bottom:4px">Your Invoicing Details</div>
  <table style="width:100%;border-collapse:collapse;font-size:10px;color:#475569">
    <tr><td style="width:50%;padding:16px 18px 0 0;vertical-align:bottom">Name / Company<div style="border-bottom:1px solid #94a3b8;height:24px"></div></td><td style="width:50%;padding:16px 0 0 0;vertical-align:bottom">ABN<div style="border-bottom:1px solid #94a3b8;height:24px"></div></td></tr>
    <tr><td colspan="2" style="padding:16px 0 0 0;vertical-align:bottom">Billing address<div style="border-bottom:1px solid #94a3b8;height:24px"></div></td></tr>
    <tr><td style="padding:16px 18px 0 0;vertical-align:bottom">Email<div style="border-bottom:1px solid #94a3b8;height:24px"></div></td><td style="padding:16px 0 0 0;vertical-align:bottom">Phone<div style="border-bottom:1px solid #94a3b8;height:24px"></div></td></tr>
    <tr><td style="padding:16px 18px 0 0;vertical-align:bottom">Purchase order&nbsp;# (if any)<div style="border-bottom:1px solid #94a3b8;height:24px"></div></td><td></td></tr>
  </table>
  <table style="width:100%;border-collapse:collapse;font-size:10px;color:#475569;margin-top:6px">
    <tr><td style="width:60%;padding:28px 18px 0 0;vertical-align:bottom">Signature<div style="border-bottom:1.5px solid #1e293b;height:34px"></div></td><td style="width:40%;padding:28px 0 0 0;vertical-align:bottom">Date<div style="border-bottom:1.5px solid #1e293b;height:34px"></div></td></tr>
    <tr><td style="padding:16px 18px 0 0;vertical-align:bottom">Print name<div style="border-bottom:1px solid #94a3b8;height:24px"></div></td><td></td></tr>
  </table>
</div>`;

const DIVISION_META = {
  mworx: { tagline: "Design · Consultancy · Project Management", accent: "#0d9488" },
  mt_management: { tagline: "Short-Term Rental Property Management", accent: "#2563eb" },
  mtmgmt: { tagline: "Short-Term Rental Property Management", accent: "#2563eb" },
};

function normalizeDivision(div) {
  if (!div || div === "mworx") return "mworx";
  if (div === "mtmgmt" || div === "mt_management") return "mt_management";
  return "mworx";
}

function buildInvoiceHTML(inv, items, profile, logoDataUrl) {
  // Escape user-controlled text once, up front. Logic fields (inv.type,
  // profile.business_id) are not in these lists, so comparisons still work.
  inv = escFields(inv, ["number", "contact_name", "contact_company", "contact_abn", "contact_address", "contact_email", "contact_phone", "job", "notes", "terms"]);
  profile = escFields(profile, ["name", "abn", "address", "email", "phone", "bank_name", "account_name", "bsb", "account_number"]);
  items = (items || []).map((it) => escFields(it, ["description", "note"]));
  const divMeta = DIVISION_META[normalizeDivision(inv.division)] || DIVISION_META.mworx;
  const accent = divMeta.accent;
  const docType = inv.type === "quote" ? "QUOTE" : "INVOICE";
  const isQuote = inv.type === "quote";
  const bName = profile.name || "Company";
  const tagline = divMeta.tagline;

  const logoHTML = logoDataUrl
    ? `<img src="${logoDataUrl}" style="max-height:70px;max-width:200px;object-fit:contain;display:block" />`
    : `<div style="font-size:24px;font-weight:800;color:#1e293b;letter-spacing:-0.02em">${bName}</div>`;

  const isLump = inv.pricing_mode === "lump_sum";

  const lumpScope = (items || []).map((i) => i.description || "").filter((d) => d.trim()).join("\n");

  const itemsTable = isLump
    ? `<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <thead><tr style="background:#f8fafc">
          <th style="text-align:left;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b">Scope of Works</th>
        </tr></thead>
        <tbody><tr><td style="padding:12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#1e293b;vertical-align:top">${bulletizeScope(lumpScope, true)}</td></tr></tbody>
      </table>`
    : `<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <thead><tr style="background:#f8fafc">
          <th style="text-align:left;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b">Description</th>
          <th style="text-align:center;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:50px">Qty</th>
          <th style="text-align:right;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:90px">Rate</th>
          <th style="text-align:right;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:100px">Amount</th>
        </tr></thead>
        <tbody>${(items || []).map((item) => {
          const amount = (Number(item.qty) || 0) * (Number(item.rate) || 0);
          return `<tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#1e293b;vertical-align:top">
              ${bulletizeScope(item.description)}
              ${item.note ? `<div style="font-size:10px;color:#6b7280;margin-top:2px;white-space:pre-wrap">${item.note}</div>` : ""}
            </td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:center;vertical-align:top">${Number(item.qty) || 1}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums">${fmtAUD(item.rate || 0)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;font-weight:600;color:#1e293b;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums">${fmtAUD(amount)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;

  const subtotal = isLump ? (Number(inv.total) || 0) : (items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);

  const accountName = profile.account_name || profile.name || bName;

  const paymentSection = !isQuote ? `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px 20px;margin-top:24px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:10px">How to Pay</div>
      <table style="font-size:11px;color:#374151;line-height:1.8;border-collapse:collapse">
        ${profile.bank_name ? `<tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Bank</td><td style="font-weight:600">${profile.bank_name}</td></tr>` : ""}
        <tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Account Name</td><td style="font-weight:600">${accountName}</td></tr>
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
  .page { width: 210mm; min-height: 297mm; padding: 40px 44px 84px; }
  /* Fixed footer repeats at the bottom of every printed A4 page (incl. the T&Cs page). */
  .doc-footer { position: fixed; left: 44px; right: 44px; bottom: 20px; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 12px; background: #fff; }
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
          ${profile.email || ""}${profile.phone ? ` · ${profile.phone}` : ""}
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

  <!-- Line items / scope of works -->
  ${itemsTable}

  <!-- Totals -->
  <div style="display:flex;justify-content:flex-end">
    <div style="width:240px">
      <div style="display:flex;justify-content:space-between;padding:10px 0 4px;margin-top:4px;border-top:2px solid #1e293b">
        <span style="font-size:14px;font-weight:700;color:#1e293b">Total AUD</span>
        <span style="font-size:16px;font-weight:800;color:${accent};font-variant-numeric:tabular-nums">${fmtAUD(subtotal)}</span>
      </div>
    </div>
  </div>

  <!-- Payment / Quote notice -->
  ${paymentSection}

  <!-- Notes -->
  ${inv.notes ? `<div style="font-size:10px;color:#6b7280;line-height:1.6;margin-top:20px;padding-top:10px;border-top:1px solid #e5e7eb;white-space:pre-wrap">${inv.notes}</div>` : ""}

  <!-- Terms & Conditions + acceptance (own page for quotes) -->
  ${(inv.terms && inv.terms.trim()) || isQuote ? `<div style="page-break-before:always;break-before:page;padding-top:8px">
    ${inv.terms && inv.terms.trim() ? `<div style="font-size:16px;font-weight:700;color:#1e293b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid ${accent}">Terms &amp; Conditions</div>
    <div style="font-size:10.5px;color:#475569;line-height:1.75;white-space:pre-wrap">${inv.terms}</div>` : ""}
    ${isQuote ? ACCEPTANCE_BLOCK : ""}
  </div>` : ""}

  <!-- Footer -->
  <div class="doc-footer">
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

  // Authenticate the requesting user
  if (!auth_token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const userClient = createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  );
  const { data: { user } } = await userClient.auth.getUser(auth_token);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const userId = user.id;

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
  if (inv.user_id !== userId) {
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
