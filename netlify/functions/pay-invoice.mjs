import { createClient } from "@supabase/supabase-js";
import { wrapCors } from "./lib/cors.mjs";

// Public (no auth) customer-facing endpoint for paying an invoice by card.
// Two modes on one GET:
//   ?result=success|cancelled  -> branded HTML shown after Stripe redirects back
//   ?invoice=<id>&t=<pay_token> -> validate, create a Stripe Checkout Session,
//                                  302 the browser to Stripe's hosted page.
// Env is resolved at request time (not module load) so a missing var during
// debugging doesn't cache a null client — same reasoning as send-reminders.mjs.

function getConfig() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    serviceKey:
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SERVICE_ROLE_KEY,
    stripeKey: process.env.STRIPE_SECRET_KEY,
    surchargePct: Number(process.env.STRIPE_SURCHARGE_PCT ?? "1.7") || 0,
    siteUrl: process.env.URL || "https://bkeeper.netlify.app",
  };
}

function fmtAUD(n) {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(n) || 0);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A minimal, self-contained branded page (same inline-style approach as the
// reminder email HTML). Used for every customer-visible outcome.
function page({ heading, sub, accent = "#0d9488", tone = "neutral", cta = null }, status = 200) {
  const toneBg = tone === "success" ? "#f0fdf4" : tone === "error" ? "#fef2f2" : "#f8fafc";
  const toneBorder = tone === "success" ? "#bbf7d0" : tone === "error" ? "#fecaca" : "#e2e8f0";
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:48px 16px">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">
      <div style="background:${accent};height:4px"></div>
      <div style="padding:36px">
        <div style="background:${toneBg};border:1px solid ${toneBorder};border-radius:10px;padding:24px 28px;text-align:center">
          <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1e293b">${esc(heading)}</h1>
          <p style="margin:0;font-size:14px;color:#475569;line-height:1.6">${sub}</p>
        </div>
        ${cta ? `<div style="text-align:center;margin-top:24px"><a href="${esc(cta.href)}" style="display:inline-block;background:${accent};color:#fff;padding:13px 28px;border-radius:8px;font-weight:700;text-decoration:none">${esc(cta.label)}</a></div>` : ""}
      </div>
    </div>
    <p style="text-align:center;font-size:11px;color:#94a3b8;margin-top:16px">Secure payment powered by Stripe.</p>
  </div>
</body>
</html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const handler = async (req) => {
  const cfg = getConfig();
  let params;
  try {
    params = new URL(req.url).searchParams;
  } catch {
    return page({ heading: "Invalid link", sub: "This payment link is malformed.", tone: "error" }, 400);
  }

  // Safe env diagnostic (booleans/counts only, never values). Temporary — used
  // to confirm the Stripe env vars reach the function runtime.
  if (params.get("diag") === "1") {
    return new Response(JSON.stringify({
      has_stripe_secret_key: !!cfg.stripeKey,
      has_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
      has_supabase_service: !!cfg.serviceKey,
      surcharge_pct: cfg.surchargePct,
      env_count: Object.keys(process.env).length,
      netlify: !!process.env.NETLIFY,
      context: process.env.CONTEXT || null,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // ---- Result mode (Stripe redirected the customer back here) ----
  const result = params.get("result");
  if (result === "success") {
    return page({ heading: "Payment received", sub: "Thank you — your payment is being confirmed and a receipt will follow shortly. You can close this window.", tone: "success" });
  }
  if (result === "cancelled") {
    const invoice = params.get("invoice");
    const t = params.get("t");
    const retry = invoice && t ? { href: `${cfg.siteUrl}/.netlify/functions/pay-invoice?invoice=${encodeURIComponent(invoice)}&t=${encodeURIComponent(t)}`, label: "Try again" } : null;
    return page({ heading: "Payment cancelled", sub: "No charge was made. You can retry whenever you're ready.", cta: retry });
  }

  // ---- Pay mode ----
  const invoiceId = params.get("invoice");
  const token = params.get("t");
  if (!invoiceId || !token) {
    return page({ heading: "Invalid link", sub: "This payment link is missing information.", tone: "error" }, 400);
  }
  if (!cfg.stripeKey) {
    return page({ heading: "Card payments unavailable", sub: "Online card payment isn't set up yet. Please use the bank details on your invoice.", tone: "error" }, 503);
  }
  if (!cfg.supabaseUrl || !cfg.serviceKey) {
    return page({ heading: "Something went wrong", sub: "We couldn't load this invoice. Please try again later.", tone: "error" }, 500);
  }

  const supabase = createClient(cfg.supabaseUrl, cfg.serviceKey);
  const { data: inv, error } = await supabase.from("bk_invoices").select("*").eq("id", invoiceId).maybeSingle();

  if (error || !inv) {
    return page({ heading: "Invoice not found", sub: "This payment link doesn't match an invoice.", tone: "error" }, 404);
  }
  // Constant token compare (both are plain strings here).
  if (!inv.pay_token || String(inv.pay_token) !== String(token)) {
    return page({ heading: "Invalid link", sub: "This payment link isn't valid. Please use the most recent link from your invoice or reminder email.", tone: "error" }, 403);
  }
  if (inv.type === "quote") {
    return page({ heading: "Not payable", sub: "Quotes can't be paid online. Please contact us if you'd like to proceed.", tone: "error" }, 400);
  }
  if (inv.status === "paid") {
    return page({ heading: "Already paid", sub: `Invoice ${esc(inv.number || "")} has already been paid. Thank you!`, tone: "success" });
  }
  const base = Number(inv.total) || 0;
  if (base <= 0) {
    return page({ heading: "Nothing to pay", sub: "This invoice has no outstanding amount.", tone: "error" }, 400);
  }

  const baseCents = Math.round(base * 100);
  const surchargeCents = cfg.surchargePct > 0 ? Math.round(baseCents * (cfg.surchargePct / 100)) : 0;

  const form = new URLSearchParams();
  form.set("mode", "payment");
  // Omit payment_method_types entirely so Stripe offers card + Apple/Google Pay
  // per the account's Dashboard settings.
  form.append("line_items[0][price_data][currency]", "aud");
  form.append("line_items[0][price_data][unit_amount]", String(baseCents));
  form.append("line_items[0][price_data][product_data][name]", `Invoice ${inv.number || ""}`.trim());
  form.append("line_items[0][quantity]", "1");
  if (surchargeCents > 0) {
    form.append("line_items[1][price_data][currency]", "aud");
    form.append("line_items[1][price_data][unit_amount]", String(surchargeCents));
    form.append("line_items[1][price_data][product_data][name]", "Card processing surcharge");
    form.append("line_items[1][quantity]", "1");
  }
  if (inv.contact_email) form.set("customer_email", inv.contact_email);
  form.set("success_url", `${cfg.siteUrl}/.netlify/functions/pay-invoice?result=success&invoice=${encodeURIComponent(inv.id)}`);
  form.set("cancel_url", `${cfg.siteUrl}/.netlify/functions/pay-invoice?result=cancelled&invoice=${encodeURIComponent(inv.id)}&t=${encodeURIComponent(inv.pay_token)}`);
  form.append("metadata[invoice_id]", inv.id);
  form.append("metadata[invoice_number]", inv.number || "");
  form.append("metadata[surcharge]", (surchargeCents / 100).toFixed(2));

  try {
    const resp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        // Same invoice + amount clicked twice within 24h returns the same session
        // rather than creating duplicates.
        "Idempotency-Key": `pay_${inv.id}_${baseCents + surchargeCents}`,
      },
      body: form.toString(),
    });
    const session = await resp.json();
    if (!resp.ok || !session.url) {
      console.error("Stripe session create failed:", JSON.stringify(session).slice(0, 500));
      return page({ heading: "Couldn't start payment", sub: "We hit a problem reaching the payment processor. Please try again in a moment.", tone: "error" }, 502);
    }
    return new Response(null, { status: 302, headers: { Location: session.url } });
  } catch (e) {
    console.error("Stripe session error:", e.message);
    return page({ heading: "Couldn't start payment", sub: "We hit a problem reaching the payment processor. Please try again in a moment.", tone: "error" }, 502);
  }
};

export default wrapCors(handler);
