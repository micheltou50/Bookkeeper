import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";
import { wrapCors } from './lib/cors.mjs';
// The document layout is shared with the in-app preview, so what you see on
// screen is what Chromium prints here — page breaks, footer and all.
import { buildDocHTML } from "../../src/lib/doc-html.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY
);

// When Stripe is configured, invoices (not quotes) get a "Pay by card" button.
const PAY_ENABLED = !!process.env.STRIPE_SECRET_KEY;
const PAY_BASE = process.env.URL || "https://bkeeper.netlify.app";
const SURCHARGE_PCT = Number(process.env.STRIPE_SURCHARGE_PCT ?? "1.7") || 0;

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

const handler = async (req) => {
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

  // Build HTML (shared layout, print mode)
  const { body: docBody, css, footer } = buildDocHTML(inv, items || [], profile || {}, {
    logoDataUrl,
    mode: "pdf",
    pay: PAY_ENABLED ? { base: PAY_BASE, surchargePct: SURCHARGE_PCT } : null,
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${docBody}</body></html>`;

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
      // Footer (business line + "Page n of N") drawn in the @page bottom margin
      // on every page. An empty header keeps Chromium's default (URL + date) off.
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: footer,
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

export default wrapCors(handler);
