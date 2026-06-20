import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const userClient = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
);

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const authHeader = req.headers.get("authorization");
  const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!authToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const { data: { user } } = await userClient.auth.getUser(authToken);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  try {
    const { image, mediaType } = await req.json();

    if (!image || !mediaType) {
      return new Response(JSON.stringify({ error: "Missing image or mediaType" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: image },
            },
            {
              type: "text",
              text: `You are a receipt data extractor for an Australian bookkeeping app. Extract data from this receipt image and return ONLY valid JSON with no markdown fences, no explanation, no extra text.

TAX CATEGORIES — use ONLY one of these exact strings:
- Advertising & Marketing
- Accounting & Professional Fees (accountant, lawyer, consultant, bookkeeper)
- Bank Fees & Interest (Stripe, PayPal, bank fees, Western Union fees, merchant fees)
- Contractors & Subcontractors (contractors, admin support, overseas helpers)
- Software & Subscriptions (Adobe, Microsoft, Canva, ChatGPT, Claude, Xero, software apps)
- Office & Supplies (printer paper, stationery, small office purchases, Officeworks)
- Equipment & Assets (laptop, phone, monitor, printer, furniture, tools)
- Motor Vehicle (fuel, tolls, rego, servicing, car insurance, parking)
- Travel (flights, hotels, Uber/taxis for business trips)
- Phone & Internet
- Insurance
- Tax & Government Fees (ASIC, business name renewals, ATO payments)
- Other (use when uncertain and add a warning)

RULES:
- Use null for missing date, total, or vendor — do NOT guess.
- If total is uncertain, return null and add a warning.
- If category is uncertain, use "Other" and add a warning.
- Clean vendor names (e.g. "ADOBE SYSTEMS SOFTWARE IRELAND" → "Adobe").
- confidence: 0.0–1.0, how readable and complete the receipt is overall.
- categoryConfidence: 0.0–1.0, how certain the category assignment is.
- warnings: array of short strings about missing or uncertain information.
- Assume AUD unless receipt clearly shows another currency.
- Amounts must be numbers, not strings.

Return this exact JSON structure:
{
  "vendor": "string or null",
  "date": "YYYY-MM-DD or null",
  "total": 0.00,
  "description": "brief description of purchase",
  "category": "one of the listed categories",
  "businessPurpose": "brief business purpose suggestion",
  "confidence": 0.92,
  "categoryConfidence": 0.95,
  "warnings": []
}`,
            },
          ],
        },
      ],
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(clean);

    return new Response(JSON.stringify(parsed), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Receipt extraction error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to process receipt", detail: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
