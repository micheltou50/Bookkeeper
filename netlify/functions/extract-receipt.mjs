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
              text: `You are a receipt data extractor for an Australian bookkeeping app. The company is NOT registered for GST — do not extract or mention GST. Extract data from this receipt image and return ONLY valid JSON with no markdown fences, no explanation, no extra text.

EXPENSE CATEGORIES — use ONLY one of these exact strings:
Operating: Advertising & Marketing, Bad Debts, Bank Fees & Charges, Cleaning, Commissions Paid, Donations, Fringe Benefits Tax (FBT), Freight & Postage, Home Office Expenses, Insurance, Interest & Loan Charges, Land Tax, Lease Payments, Legal & Professional Fees, Licences & Permits, Meals & Entertainment, Motor Vehicle, Office Supplies & Stationery, Phone & Internet, Printing & Stationery, Rates & Taxes, Rent & Occupancy, Repairs & Maintenance, Software & Subscriptions, Security, Tools & Equipment (under $1,000), Training & Education, Travel & Accommodation, Uniforms & Protective Clothing, Utilities, Wages & Salaries, Superannuation, Workers Compensation Insurance
Assets: Equipment Purchase (over $1,000), Furniture & Fittings, Vehicles, Depreciation
Labour: Subcontractors, Consulting Fees
Industry: Council & Government Fees, Platform Fees, Professional Memberships, Drafting & CAD Software, Plotting & Printing

If uncertain, use "Office Supplies & Stationery" and add a warning.

RULES:
- Use null for missing date or total — do NOT guess.
- If total is uncertain, return null and add a warning.
- description: brief description of what was purchased (include vendor name if visible).
- businessPurpose: only include when category is Motor Vehicle, Meals & Entertainment, Travel & Accommodation, Donations, or Home Office Expenses; otherwise null.
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
  "businessPurpose": "string or null",
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
