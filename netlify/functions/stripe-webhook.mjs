import { createClient } from "@supabase/supabase-js";
import { wrapCors } from "./lib/cors.mjs";
import crypto from "node:crypto";

// Public (no auth) Stripe webhook. The ONLY thing that marks an invoice paid.
// Verifies the raw-body HMAC signature, then on checkout.session.completed
// flips the invoice to paid idempotently.
//
// IMPORTANT: read the body once with req.text() FIRST — the exact bytes Stripe
// signed are needed for the HMAC, and a Request body is a one-shot stream.
// This function must NOT have `export const config = { schedule }` — it must
// stay a plain on-demand function so the body arrives unmodified.

function getConfig() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    serviceKey:
      process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SERVICE_ROLE_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  };
}

// Business-local date (matches how the app sets paid_date elsewhere).
function businessTodayStr() {
  const tz = process.env.BUSINESS_TIMEZONE || "Australia/Sydney";
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Verify a Stripe `stripe-signature` header ("t=...,v1=...[,v1=...]") against the
// raw request body. Rejects if timestamp is >5 min old or no v1 matches.
function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = sigHeader.split(",").map((p) => p.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected);
  return sigs.some((s) => {
    const sBuf = Buffer.from(s);
    return sBuf.length === expectedBuf.length && crypto.timingSafeEqual(sBuf, expectedBuf);
  });
}

const handler = async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const cfg = getConfig();
  const rawBody = await req.text();          // MUST be first, and text() not json()
  const sig = req.headers.get("stripe-signature");

  if (!cfg.webhookSecret) {
    console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET not set");
    return json({ error: "Webhook not configured" }, 500);
  }
  if (!verifySignature(rawBody, sig, cfg.webhookSecret)) {
    return json({ error: "Invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid payload" }, 400);
  }

  // Ignore every event type except a completed checkout.
  if (event.type !== "checkout.session.completed") return json({ received: true });

  const session = event.data?.object || {};
  const meta = session.metadata || {};
  if (!meta.invoice_id) {
    console.warn("stripe-webhook: checkout.session.completed with no invoice_id metadata");
    return json({ received: true, warning: "no invoice_id" });
  }

  if (!cfg.supabaseUrl || !cfg.serviceKey) {
    console.error("stripe-webhook: Supabase service credentials missing");
    return json({ error: "Server not configured" }, 500);
  }

  const supabase = createClient(cfg.supabaseUrl, cfg.serviceKey);
  const paidAmount = (session.amount_total || 0) / 100;
  const surcharge = meta.surcharge != null && meta.surcharge !== "" ? Number(meta.surcharge) : null;

  // Idempotent flip: only the first delivery (stripe_session_id still null)
  // updates a row. Stripe retries match 0 rows -> treated as duplicate.
  const { data, error } = await supabase
    .from("bk_invoices")
    .update({
      status: "paid",
      paid_date: businessTodayStr(),
      stripe_session_id: session.id,
      paid_amount: paidAmount,
      surcharge_amount: surcharge,
    })
    .eq("id", meta.invoice_id)
    .is("stripe_session_id", null)
    .select("id");

  if (error) {
    // Return non-2xx so Stripe retries; the null-guard makes retries safe.
    console.error("stripe-webhook: DB update failed:", error.message);
    return json({ error: "DB update failed" }, 500);
  }
  if (!data || data.length === 0) {
    return json({ received: true, duplicate: true });
  }
  return json({ received: true });
};

export default wrapCors(handler);
