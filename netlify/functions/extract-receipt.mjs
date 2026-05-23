import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
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
      model: "claude-haiku-3-5-20241022",
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

GST TREATMENT — use ONLY one of these exact strings:
- GST included (Australian tax invoice clearly shows GST amount or states "includes GST")
- No GST (receipt shows no GST, supplier appears non-GST-registered)
- GST free (receipt explicitly says GST-free items)
- BAS excluded (overseas/foreign supplier, not subject to Australian GST)
- Input taxed (financial supplies, residential rent)
- Unsure (unclear from receipt)

RULES:
- Use null for missing date, total, vendor, or gstAmount — do NOT guess.
- Do NOT invent or calculate GST amount if not explicitly shown on the receipt.
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
  "gstAmount": 0.00,
  "description": "brief description of purchase",
  "category": "one of the listed categories",
  "gstTreatment": "one of the listed treatments",
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
