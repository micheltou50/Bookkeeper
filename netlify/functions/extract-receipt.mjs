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
              text: `You are a receipt data extractor for an Australian bookkeeping app. Extract data from this receipt image and return ONLY valid JSON with no markdown fences or extra text.

Required JSON structure:
{
  "date": "YYYY-MM-DD",
  "vendor": "Business name on receipt",
  "description": "Brief description of purchase",
  "total": 0.00,
  "gst_included": true,
  "category": "One of: Advertising & Marketing, Bank Fees & Charges, Cleaning, Insurance, Office Supplies, Professional Fees, Rent & Lease, Repairs & Maintenance, Telephone & Internet, Travel & Transport, Utilities, Motor Vehicle, Subscriptions & Software, Linen & Amenities, Cost of Sales, Other",
  "items": [{"name": "item name", "amount": 0.00}]
}

If you cannot read a field clearly, use your best guess. Amounts should be numbers, not strings. Assume AUD. Most Australian receipts include GST in the total.`,
            },
          ],
        },
      ],
    });

    const text = response.content[0].text.trim();
    // Strip markdown fences if present
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
