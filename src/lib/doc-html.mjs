// The ONE layout for quotes and invoices. Used by the Netlify PDF function
// (mode "pdf": Chromium paginates, and draws the footer from `footer`), by the
// in-app preview (mode "screen": the same content laid out on A4 sheets, split
// only where the document says so), and by the preview's edit mode (mode
// "edit": the editable text blocks become textareas in place).
//
// Page breaks are part of the document, not the renderer: a scope line, or a
// line of notes/terms, consisting of just "---" is a page break. The form
// inserts them as a "Page break" row; the preview shows where they land.
//
// Plain ES module, no DOM, no React — it has to run in a Lambda too.

export const PAGE_BREAK = "---";
// A line that is only dashes (any kind — people type "—" for "---"), or the
// words "page break" with or without brackets, is a page break.
export const isPageBreak = (s) => /^\s*(?:[-–—]{2,}|[–—]|\[?\s*page\s*break\s*\]?)\s*$/i.test(String(s ?? ""));

export const DIVISION_META = {
  mworx: { tagline: "Design · Consultancy · Project Management", accent: "#0d9488" },
  mt_management: { tagline: "Short-Term Rental Property Management", accent: "#2563eb" },
  mtmgmt: { tagline: "Short-Term Rental Property Management", accent: "#2563eb" },
};

export function normalizeDivision(div) {
  if (!div || div === "mworx") return "mworx";
  if (div === "mtmgmt" || div === "mt_management") return "mt_management";
  return "mworx";
}

const fmtAUD = (n) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(Number(n) || 0);
const fmtDate = (d) => {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
};

// Escape user-controlled strings so a stray "<", "&" or quote in a name,
// address or note can't break the layout.
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escFields = (obj, keys) => {
  const out = { ...(obj || {}) };
  for (const k of keys) if (typeof out[k] === "string") out[k] = esc(out[k]);
  return out;
};

// Split text into segments at "---" lines. Returns { segments, trailingBreak }:
// a "---" as the very last line means "break after this block".
function splitAtBreaks(text) {
  const lines = String(text || "").split(/\r?\n/);
  const segments = [];
  let cur = [];
  let trailingBreak = false;
  for (const l of lines) {
    if (isPageBreak(l)) { segments.push(cur.join("\n")); cur = []; }
    else cur.push(l);
  }
  if (cur.join("").trim()) segments.push(cur.join("\n"));
  else if (segments.length) trailingBreak = true;
  return { segments: segments.map((s) => s.replace(/^\n+|\n+$/g, "")).filter((s) => s.trim()), trailingBreak };
}

// A multi-line description becomes a bulleted scope list: non-indented lines
// get a "•", whitespace-led lines become "◦" sub-items. Any leading bullet
// char the user typed is stripped. Page-break lines are never printed.
function bulletizeScope(text, always = false) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !isPageBreak(l));
  if (lines.length <= 1 && !always) return `<div style="font-weight:600;white-space:pre-wrap">${lines[0] ?? raw}</div>`;
  return lines.map((l) => {
    const sub = /^\s/.test(l);
    const t = l.trim().replace(/^[-*•◦·]\s*/, "");
    return `<div class="scope-line" style="display:flex;gap:7px;margin-left:${sub ? 16 : 0}px;margin-top:3px;line-height:1.4"><span style="color:#64748b;flex-shrink:0">${sub ? "◦" : "•"}</span><span style="font-weight:${sub ? 400 : 600}">${t}</span></div>`;
  }).join("");
}

const TH = (extra = "") => `text-align:left;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;${extra}`;

// Printed acceptance form for quotes: the client fills in their invoicing
// details and signs to accept. Blank ruled lines for handwriting.
const acceptanceBlock = (inv) => `<div class="keep" style="margin-top:30px">
  <div style="font-size:15px;font-weight:700;color:#1e293b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Acceptance of Quote</div>
  <div style="font-size:11px;color:#334155;font-weight:600;margin-bottom:10px;padding:8px 11px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px">
    Quote ${inv.number || ""}${inv.date ? ` &middot; ${fmtDate(inv.date)}` : ""} &middot; Total ${fmtAUD(inv.total || 0)}${inv.job ? `<div style="font-weight:400;color:#64748b;margin-top:3px">${inv.job}</div>` : ""}
  </div>
  <div style="font-size:10px;color:#334155;line-height:1.6;margin-bottom:14px;padding:9px 11px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px">
    By accepting this quotation, the client confirms that they have read and agree to the Scope of Works, fees, payment schedule and Terms &amp; Conditions contained in this quotation.
  </div>
  <div style="font-size:10px;color:#64748b;margin-bottom:18px">This quote may be accepted either by signing and returning this page, or by written acceptance by email.</div>
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

// The raw editable text of a document's scope: one line per item, a leading
// space marking a sub-item, "---" marking a page break. Round-trips through
// scopeTextToItems below.
export function itemsToScopeText(items) {
  return (items || []).map((i) => String(i.description ?? "")).filter((d) => d.trim()).join("\n");
}
export function scopeTextToItems(text) {
  return String(text || "").split(/\r?\n/).filter((l) => l.trim()).map((l) => ({
    description: isPageBreak(l) ? PAGE_BREAK : (/^\s/.test(l) ? " " : "") + l.trim(),
    note: "", qty: 1, rate: "",
  }));
}

// Group items into runs separated by page-break items.
function groupItems(items) {
  const groups = [[]];
  for (const it of items || []) {
    if (isPageBreak(it.description)) { if (groups[groups.length - 1].length) groups.push([]); continue; }
    groups[groups.length - 1].push(it);
  }
  return groups.filter((g) => g.length);
}

const PAGE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background: #fff; color: #1e293b; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .keep { break-inside: avoid; page-break-inside: avoid; }
  table { break-inside: auto; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .section-head { break-after: avoid; page-break-after: avoid; }
  .prose { orphans: 3; widows: 3; }
`;

// Print margins (mm). The bottom one is where the footer is drawn.
export const PAGE_MARGIN = { top: 12, side: 12, bottom: 24 };

/**
 * Build the document.
 * @param inv      bk_invoices row (type, number, dates, contact_*, job, notes, terms, total, payment_plan, division, pay_token)
 * @param items    bk_invoice_items rows in order
 * @param profile  bk_profiles row (name, abn, email, phone, bank details, gst_not_registered)
 * @param opts     { logoDataUrl, pay: {base, surchargePct} | null, mode: "pdf" | "screen" | "edit" }
 * @returns { body, css, footer, sheets }  — `footer` is Chromium's footerTemplate (pdf mode)
 */
export function buildDocHTML(inv, items, profile, opts = {}) {
  const { logoDataUrl = null, pay = null, mode = "pdf" } = opts;
  inv = escFields(inv, ["number", "contact_name", "contact_company", "contact_abn", "contact_address", "contact_email", "contact_phone", "job", "notes", "terms"]);
  profile = escFields(profile, ["name", "abn", "address", "email", "phone", "bank_name", "account_name", "bsb", "account_number"]);
  const rawItems = items || inv.items || [];
  items = rawItems.map((it) => escFields(it, ["description", "note"]));

  const divMeta = DIVISION_META[normalizeDivision(inv.division)] || DIVISION_META.mworx;
  const accent = divMeta.accent;
  const tagline = divMeta.tagline;
  const isQuote = inv.type === "quote";
  const docType = isQuote ? "QUOTE" : "INVOICE";
  const bName = profile.name || "Company";
  const isLump = inv.pricing_mode === "lump_sum";
  const editing = mode === "edit";

  const logoHTML = logoDataUrl
    ? `<img src="${logoDataUrl}" style="max-height:70px;max-width:200px;object-fit:contain;display:block" />`
    : `<div style="font-size:24px;font-weight:800;color:#1e293b;letter-spacing:-0.02em">${bName}</div>`;

  // parts: [{ html, breakBefore }] in document order. "breakBefore" is the only
  // pagination the template ever asserts; Chromium (pdf) or the sheet splitter
  // (screen) does the rest.
  const parts = [];
  const push = (html, breakBefore = false) => parts.push({ html, breakBefore });

  push(`
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
    <div>
      ${logoHTML}
      <div style="margin-top:10px">
        ${profile.abn ? `<div style="font-size:10px;color:#475569;font-weight:600;margin-bottom:3px">ABN ${profile.abn}</div>` : ""}
        <div style="font-size:10px;color:#6b7280;line-height:1.6">${profile.email || ""}${profile.phone ? ` · ${profile.phone}` : ""}</div>
      </div>
    </div>
    <div style="text-align:right">
      <div style="font-size:32px;font-weight:700;color:#1e293b;letter-spacing:0.04em;text-transform:uppercase">${docType}</div>
      <div style="font-size:14px;font-weight:700;color:#374151;margin-top:4px">${inv.number || ""}</div>
    </div>
  </div>
  <div style="height:2px;background:${accent};margin-bottom:24px"></div>
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
  </div>`);

  // ── Scope / line items ───────────────────────────────────────────────────
  // Plain-text editing in place. Wrapping stays on (long lines wrap, leading
  // spaces are kept), and the button drops a page-break line at the cursor.
  const editBox = (name, value, rows, hint) => `<div style="margin:6px 0 14px">
      <textarea data-edit="${name}" spellcheck="false" style="width:100%;min-height:${rows * 18}px;font:11px/1.5 'Helvetica Neue',Helvetica,Arial,sans-serif;color:#1e293b;border:1.5px dashed ${accent};border-radius:6px;padding:10px 12px;background:#fbfffe;resize:vertical;white-space:pre-wrap;overflow-wrap:break-word">${value}</textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:4px">
        <div style="font-size:9px;color:#94a3b8">${hint}</div>
        <button type="button" data-insert-break="${name}" style="flex-shrink:0;font:600 9px/1 'Helvetica Neue',Helvetica,Arial,sans-serif;color:#475569;background:#fff;border:1px solid #cbd5e1;border-radius:5px;padding:5px 8px;cursor:pointer">⤓ Page break at cursor</button>
      </div>
    </div>`;
  const BREAK_HINT = "Type PAGE BREAK on its own line (or ---) to start a new page there.";

  if (editing && isLump) {
    push(`<div class="section-head" style="${TH("border-bottom:2px solid #1e293b;background:#f8fafc")}">Scope of Works</div>
      ${editBox("scope", itemsToScopeText(rawItems), 8, `One line per item; start a line with a space for a sub-item. ${BREAK_HINT}`)}`);
  } else {
    const groups = groupItems(items);
    groups.forEach((g, gi) => {
      const cont = gi ? " (continued)" : "";
      const table = isLump
        ? `<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <thead><tr style="background:#f8fafc"><th style="${TH()}">Scope of Works${cont}</th></tr></thead>
            <tbody><tr><td style="padding:12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#1e293b;vertical-align:top">${bulletizeScope(g.map((i) => i.description || "").join("\n"), true)}${(() => { const n = g.map((i) => i.note || "").filter((x) => x.trim()).join("\n"); return n ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #e5e7eb;font-size:10px;color:#6b7280;line-height:1.6;white-space:pre-wrap">${n}</div>` : ""; })()}</td></tr></tbody>
          </table>`
        : `<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <thead><tr style="background:#f8fafc">
              <th style="${TH()}">Description${cont}</th>
              <th style="${TH("text-align:center;width:50px")}">Qty</th>
              <th style="${TH("text-align:right;width:90px")}">Rate</th>
              <th style="${TH("text-align:right;width:100px")}">Amount</th>
            </tr></thead>
            <tbody>${g.map((item) => {
              const amount = (Number(item.qty) || 0) * (Number(item.rate) || 0);
              return `<tr>
                <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#1e293b;vertical-align:top">${bulletizeScope(item.description)}${item.note ? `<div style="font-size:10px;color:#6b7280;margin-top:2px;white-space:pre-wrap">${item.note}</div>` : ""}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:center;vertical-align:top">${Number(item.qty) || 1}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums">${fmtAUD(item.rate || 0)}</td>
                <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;font-weight:600;color:#1e293b;text-align:right;vertical-align:top;font-variant-numeric:tabular-nums">${fmtAUD(amount)}</td>
              </tr>`;
            }).join("")}</tbody>
          </table>`;
      push(table, gi > 0);
    });
    if (editing && !isLump) push(`<div style="font-size:9px;color:#94a3b8;margin:-8px 0 12px">Line items with quantities and rates are edited in the form.</div>`);
  }

  // ── Totals, schedule, payment ────────────────────────────────────────────
  const subtotal = isLump ? (Number(inv.total) || 0) : items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
  const accountName = profile.account_name || profile.name || bName;

  const planRows = isQuote && Array.isArray(inv.payment_plan) && inv.payment_plan.length
    ? (() => {
        const t = Number(inv.total) || 0;
        const rows = inv.payment_plan.map((st) => ({ label: esc(st.label || ""), amount: Math.round(((t * (Number(st.percent) || 0)) / 100) * 100) / 100, percent: Number(st.percent) || 0 }));
        const summed = rows.reduce((s, r) => s + r.amount, 0);
        const pct = inv.payment_plan.reduce((s, st) => s + (Number(st.percent) || 0), 0);
        if (rows.length && Math.abs(pct - 100) < 0.005) rows[rows.length - 1].amount = Math.round((rows[rows.length - 1].amount + (t - summed)) * 100) / 100;
        return rows;
      })()
    : [];
  const paymentPlanHTML = planRows.length ? `
    <div class="keep" style="margin-top:18px;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
      <div style="background:#f8fafc;padding:8px 12px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;border-bottom:1px solid #e2e8f0">Payment Schedule</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px;color:#1e293b">
        ${planRows.map((r, i) => `<tr>
          <td style="padding:8px 12px;${i ? "border-top:1px solid #f1f5f9;" : ""}">${r.label}</td>
          <td style="padding:8px 12px;text-align:right;color:#64748b;white-space:nowrap;${i ? "border-top:1px solid #f1f5f9;" : ""}">${Math.round(r.percent * 100) / 100}%</td>
          <td style="padding:8px 12px;text-align:right;font-weight:600;white-space:nowrap;${i ? "border-top:1px solid #f1f5f9;" : ""}">${fmtAUD(r.amount)}</td>
        </tr>`).join("")}
      </table>
    </div>` : "";

  const paymentSection = !isQuote ? `
    <div class="keep" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px 20px;margin-top:24px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:10px">How to Pay</div>
      <table style="font-size:11px;color:#374151;line-height:1.8;border-collapse:collapse">
        ${profile.bank_name ? `<tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Bank</td><td style="font-weight:600">${profile.bank_name}</td></tr>` : ""}
        <tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Account Name</td><td style="font-weight:600">${accountName}</td></tr>
        ${profile.bsb ? `<tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">BSB</td><td style="font-weight:600">${profile.bsb}</td></tr>` : ""}
        ${profile.account_number ? `<tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Account Number</td><td style="font-weight:600">${profile.account_number}</td></tr>` : ""}
        <tr><td style="padding-right:20px;color:#6b7280;white-space:nowrap">Reference</td><td style="font-weight:600">${inv.number || ""}</td></tr>
      </table>
    </div>` : `
    <div class="keep" style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:6px;padding:14px 20px;margin-top:24px">
      <div style="font-size:11px;color:#0f766e;line-height:1.6">${inv.due_date ? `This quote is valid until ${fmtDate(inv.due_date)}.` : ""} Payment details will be provided upon acceptance.</div>
    </div>`;

  const payButtonHTML = (pay && !isQuote && inv.pay_token) ? `
    <div style="text-align:center;margin-top:20px">
      <a href="${pay.base}/.netlify/functions/pay-invoice?invoice=${inv.id}&t=${inv.pay_token}" style="display:inline-block;background:${accent};color:#fff;padding:12px 30px;border-radius:6px;font-size:12px;font-weight:700;text-decoration:none">Pay ${fmtAUD(subtotal)} by card</a>
      <div style="font-size:9px;color:#94a3b8;margin-top:6px">${pay.surchargePct > 0 ? `A ${pay.surchargePct}% card surcharge applies at checkout. ` : ""}Or pay by bank transfer using the details above.</div>
    </div>` : "";

  push(`
  <div style="display:flex;justify-content:flex-end">
    <div style="width:240px">
      <div style="display:flex;justify-content:space-between;padding:10px 0 4px;margin-top:4px;border-top:2px solid #1e293b">
        <span style="font-size:14px;font-weight:700;color:#1e293b">Total AUD</span>
        <span style="font-size:16px;font-weight:800;color:${accent};font-variant-numeric:tabular-nums">${fmtAUD(subtotal)}</span>
      </div>
      ${profile.gst_not_registered ? `<div style="text-align:right;font-size:9px;color:#94a3b8;padding-top:2px">GST not applicable</div>` : ""}
    </div>
  </div>
  ${paymentPlanHTML}
  ${paymentSection}
  ${payButtonHTML}`);

  // ── Notes / exclusions ───────────────────────────────────────────────────
  const notesHead = isQuote ? `<div class="section-head" style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:6px">Exclusions</div>` : "";
  let breakBeforeAcceptance = false;
  if (editing) {
    push(`<div style="margin-top:20px;padding-top:10px;border-top:1px solid #e5e7eb">${notesHead}${editBox("notes", inv.notes || "", 5, `${isQuote ? "Exclusions and caveats. " : "Notes and payment terms. "}${BREAK_HINT}${isQuote ? " One at the very end puts the acceptance form on a new page." : ""}`)}</div>`);
    // While editing, the acceptance form sits where the SAVED notes put it.
    breakBeforeAcceptance = splitAtBreaks(inv.notes || "").trailingBreak;
  } else if (inv.notes && inv.notes.trim()) {
    const { segments, trailingBreak } = splitAtBreaks(inv.notes);
    segments.forEach((seg, si) => {
      push(`<div style="margin-top:20px;padding-top:10px;border-top:1px solid #e5e7eb">${si === 0 ? notesHead : ""}<div class="prose" style="font-size:10px;color:#6b7280;line-height:1.6;white-space:pre-wrap">${seg}</div></div>`, si > 0);
    });
    breakBeforeAcceptance = trailingBreak;
  }

  // ── Acceptance (quotes) ──────────────────────────────────────────────────
  if (isQuote) push(acceptanceBlock(inv), breakBeforeAcceptance);

  // ── Terms — always last, always on a fresh page ──────────────────────────
  const termsHead = `<div class="section-head" style="font-size:16px;font-weight:700;color:#1e293b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid ${accent}">Terms &amp; Conditions</div>`;
  if (editing) {
    push(`${termsHead}${editBox("terms", inv.terms || "", 12, `Printed last, on its own page. ${BREAK_HINT}`)}`, true);
  } else if (inv.terms && inv.terms.trim()) {
    const { segments } = splitAtBreaks(inv.terms);
    segments.forEach((seg, si) => {
      push(`${si === 0 ? termsHead : ""}<div class="prose" style="font-size:9.5px;color:#475569;line-height:1.65;white-space:pre-wrap">${seg}</div>`, true);
    });
  }

  // ── Footer (identical text in every mode) ────────────────────────────────
  const footerInner = (pageLabel) => `
    <div style="font-size:8px;color:#64748b">Thank you for your business.</div>
    <div style="font-size:7.5px;color:#94a3b8;margin-top:1px">${bName}${profile.abn ? ` · ABN ${profile.abn}` : ""}${profile.email ? ` · ${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}</div>
    ${tagline ? `<div style="font-size:7px;color:#94a3b8;margin-top:1px">${tagline}</div>` : ""}
    <div style="font-size:7px;color:#cbd5e1;letter-spacing:0.04em;margin-top:4px">${pageLabel}</div>`;
  // Chromium footerTemplate: inline styles only, no page CSS reaches it.
  const footer = `<div style="width:100%;margin:0 ${PAGE_MARGIN.side}mm;font-family:Helvetica,Arial,sans-serif;text-align:center;border-top:1px solid #e2e8f0;padding-top:6px">${footerInner('Page <span class="pageNumber"></span> of <span class="totalPages"></span>')}</div>`;

  // ── Assemble ─────────────────────────────────────────────────────────────
  if (mode === "pdf") {
    const body = parts.map((p) => `<div${p.breakBefore ? ' style="break-before:page;page-break-before:always"' : ""}>${p.html}</div>`).join("\n");
    const css = `@page { size: A4; margin: ${PAGE_MARGIN.top}mm ${PAGE_MARGIN.side}mm ${PAGE_MARGIN.bottom}mm; }${PAGE_CSS}`;
    return { body, css, footer, sheets: 1 };
  }

  // screen / edit: A4 sheets. A sheet starts at every asserted break. In edit
  // mode a sheet may grow past A4 (the text is being changed) and says so.
  const sheets = [];
  for (const p of parts) {
    if (!sheets.length || p.breakBefore) sheets.push([]);
    sheets[sheets.length - 1].push(p.html);
  }
  const n = sheets.length;
  const sheetHTML = sheets.map((s, i) => `<div class="bk-sheet${editing ? " bk-sheet-edit" : ""}">
    <div class="bk-sheet-body">${s.join("\n")}</div>
    <div class="bk-sheet-foot">${footerInner(editing ? "" : `Page ${i + 1} of ${n}`)}</div>
  </div>`).join("\n");
  const css = `${PAGE_CSS}
  html, body { background: #eef2f5; }
  .bk-wrap { padding: 16px 0 40px; }
  .bk-sheet { position: relative; width: 210mm; height: 297mm; margin: 0 auto 18px; background: #fff; box-shadow: 0 2px 14px rgba(16,24,40,.14); padding: ${PAGE_MARGIN.top}mm ${PAGE_MARGIN.side}mm ${PAGE_MARGIN.bottom}mm; overflow: hidden; }
  .bk-sheet-edit { height: auto; min-height: 297mm; overflow: visible; }
  .bk-sheet-body { height: 100%; overflow: hidden; }
  .bk-sheet-edit .bk-sheet-body { height: auto; overflow: visible; }
  .bk-sheet-foot { position: absolute; left: ${PAGE_MARGIN.side}mm; right: ${PAGE_MARGIN.side}mm; bottom: 8mm; text-align: center; border-top: 1px solid #e2e8f0; padding-top: 6px; }
  .bk-overflow { position: absolute; left: ${PAGE_MARGIN.side}mm; right: ${PAGE_MARGIN.side}mm; bottom: ${PAGE_MARGIN.bottom - 2}mm; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; font: 600 10px/1.4 Helvetica, Arial, sans-serif; padding: 6px 10px; border-radius: 6px; text-align: center; }
  .bk-sheet-edit .bk-overflow { position: static; margin-top: 12px; }
  .bk-sheet-edit .bk-sheet-foot { position: static; margin-top: 18px; }
  @media (max-width: 840px) { .bk-wrap { zoom: 0.5; } }
  @media print { html, body { background: #fff; } .bk-wrap { padding: 0; } .bk-sheet { box-shadow: none; margin: 0; page-break-after: always; } .bk-overflow { display: none; } }`;
  const overflowMsg = (mm) => `This page overflows by about ${mm} mm. The PDF will spill it onto the next page — put PAGE BREAK on its own line where you want the break.`;
  const script = editing
    ? `<script>(function(){
        var mm=96/25.4, a4=(297-${PAGE_MARGIN.top}-${PAGE_MARGIN.bottom})*mm;
        function fit(t){t.style.height='auto';t.style.height=(t.scrollHeight+6)+'px';}
        function check(){document.querySelectorAll('.bk-sheet').forEach(function(s){var b=s.querySelector('.bk-sheet-body');var old=s.querySelector('.bk-overflow');if(old)old.remove();var over=b.scrollHeight-a4;if(over>1){var w=document.createElement('div');w.className='bk-overflow';w.textContent=${JSON.stringify(overflowMsg("__MM__"))}.replace('__MM__',Math.ceil(over/mm));b.appendChild(w);}});}
        document.querySelectorAll('textarea[data-edit]').forEach(function(t){t.addEventListener('input',function(){fit(t);check();});fit(t);});
        document.querySelectorAll('[data-insert-break]').forEach(function(btn){btn.addEventListener('click',function(){var t=document.querySelector('textarea[data-edit="'+btn.getAttribute('data-insert-break')+'"]');if(!t)return;var s=t.selectionStart,e=t.selectionEnd,v=t.value,before=v.slice(0,s),after=v.slice(e);var ins=(before&&!/\\n$/.test(before)?'\\n':'')+'PAGE BREAK'+(after&&!/^\\n/.test(after)?'\\n':'');t.value=before+ins+after;t.selectionStart=t.selectionEnd=before.length+ins.length;fit(t);check();t.focus();});});
        check();
      })();</script>`
    : `<script>(function(){var mm=96/25.4;document.querySelectorAll('.bk-sheet').forEach(function(s){var b=s.querySelector('.bk-sheet-body');var over=b.scrollHeight-b.clientHeight;if(over>1){var w=document.createElement('div');w.className='bk-overflow';w.textContent=${JSON.stringify(overflowMsg("__MM__"))}.replace('__MM__',Math.ceil(over/mm));s.appendChild(w);}});})();</script>`;
  return { body: `<div class="bk-wrap">${sheetHTML}</div>${script}`, css, footer, sheets: n };
}
