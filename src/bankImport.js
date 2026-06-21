// Bank statement import: parse a CSV/OFX export, then classify each line as an
// invoice payment, a categorised expense, a duplicate, or something needing
// review. Pure functions only (no DOM / React) so the same code runs in the
// browser and under Node (see local-test-bankimport.mjs).
//
// Amount convention everywhere: positive = money IN, negative = money OUT.

// ---------------------------------------------------------------------------
// ATO-aligned expense categories (shared with App.jsx expense form).
// Category names in CATEGORY_RULES MUST match EXPENSE_CATEGORIES.
// ---------------------------------------------------------------------------
export const EXPENSE_CATEGORY_GROUPS = [
  {
    label: "Operating Expenses",
    categories: [
      "Advertising & Marketing", "Bad Debts", "Bank Fees & Charges", "Cleaning", "Commissions Paid",
      "Donations", "Fringe Benefits Tax (FBT)", "Freight & Postage", "Home Office Expenses", "Insurance",
      "Interest & Loan Charges", "Land Tax", "Lease Payments", "Legal & Professional Fees", "Licences & Permits",
      "Meals & Entertainment", "Motor Vehicle", "Office Supplies & Stationery", "Phone & Internet",
      "Printing & Stationery", "Rates & Taxes", "Rent & Occupancy", "Repairs & Maintenance",
      "Software & Subscriptions", "Computers & Electronics", "Security", "Tools & Equipment (under $1,000)", "Training & Education",
      "Travel & Accommodation", "Uniforms & Protective Clothing", "Utilities", "Wages & Salaries",
      "Superannuation", "Workers Compensation Insurance",
    ],
  },
  {
    label: "Assets & Capital",
    categories: ["Equipment Purchase (over $1,000)", "Furniture & Fittings", "Vehicles", "Depreciation"],
  },
  {
    label: "Subcontractors & Labour",
    categories: ["Subcontractors", "Consulting Fees"],
  },
  {
    label: "Industry Specific",
    categories: ["Council & Government Fees", "Platform Fees", "Professional Memberships", "Drafting & CAD Software", "Plotting & Printing"],
  },
  {
    label: "Transfers (not an expense)",
    categories: ["Internal transfer"],
  },
];

export const EXPENSE_CATEGORIES = EXPENSE_CATEGORY_GROUPS.flatMap((g) => g.categories);

export const BUSINESS_PURPOSE_CATEGORIES = new Set([
  "Motor Vehicle", "Meals & Entertainment", "Travel & Accommodation", "Donations", "Home Office Expenses",
]);

const DEFAULT_EXPENSE_CATEGORY = "Office Supplies & Stationery";

const CATEGORY_RULES = [
  [/facebook|fb ?ads|meta (pl|ads|platforms)|google ads|adwords|linkedin|mailchimp|instagram ads|\bseo\b/i, "Advertising & Marketing"],
  [/accountant|bookkeep|lawyer|legal|solicitor|consult|advisor|advisory|\baudit/i, "Legal & Professional Fees"],
  [/bank fee|account fee|monthly fee|service fee|interest charge|overdrawn|merchant fee|stripe|paypal|square ?(au|inc|up)|gocardless|transaction fee|atm fee|fx fee|foreign (transaction|currency) fee/i, "Bank Fees & Charges"],
  [/subcontract|freelanc|contractor|fiverr|upwork/i, "Subcontractors"],
  [/autocad|revit|sketchup|drafting|\bcad\b|rhino|archicad/i, "Drafting & CAD Software"],
  [/plotter|large format|blueprint|plan print|a0 print|a1 print/i, "Plotting & Printing"],
  [/airbnb|guesty|hostaway|hospitable|property management platform/i, "Platform Fees"],
  [/adobe|microsoft|msft|office ?365|canva|chatgpt|openai|claude|anthropic|figma|notion|slack|zoom|github|gitlab|atlassian|jira|dropbox|google ?(cloud|workspace|gsuite)|aws|amazon web|godaddy|namecheap|vercel|netlify|squarespace|\bwix\b|shopify|xero|myob|quickbooks?|spotify|apple\.com\/bill|icloud|linktree/i, "Software & Subscriptions"],
  [/officeworks|stationery|australia ?post|auspost|post office|reply paid|printer (ink|paper)|toner/i, "Office Supplies & Stationery"],
  [/jb ?hi-?fi|harvey norman|the good guys|\bdell\b|hp store|apple (pty|store|australia)|apple\.com(?!\/bill)|\blenovo\b|\basus\b|\bacer\b|\bsamsung\b|kogan|\blogitech\b/i, "Computers & Electronics"],
  [/bunnings|total tools|sydney tools|\bikea\b/i, "Tools & Equipment (under $1,000)"],
  [/\bbp\b|shell|caltex|ampol|7-?eleven|united petroleum|\bmobil\b|fuel|petrol|\bservo\b|linkt|e-?toll|\btoll\b|citylink|eastlink|vicroads|\brego\b|car wash|wilson parking|secure parking|\bparking\b/i, "Motor Vehicle"],
  [/qantas|jetstar|virgin aus|\brex\b air|webjet|flight ?centre|\bhotel\b|\bmotel\b|airbnb|booking\.com|expedia|trivago|uber(?! ?eats)|\bcab\b|\btaxi\b|\bdidi\b|rydges|accor|hilton|marriott/i, "Travel & Accommodation"],
  [/telstra|optus|vodafone|\btpg\b|aussie ?broadband|belong|amaysim|iinet|\bdodo\b|internode|superloop|\bnbn\b|mobile plan|broadband/i, "Phone & Internet"],
  [/insurance|\baami\b|allianz|\bnrma\b|\bqbe\b|\bbupa\b|medibank|\bhcf\b|\bcgu\b|budget direct|\byoui\b|comminsure|workers comp/i, "Insurance"],
  [/\basic\b|\bato\b|australian tax|business name|fair ?work|austrac|ip australia|land tax|council rates|council fee|lodgement fee|certifier|da fee/i, "Council & Government Fees"],
  [/restaurant|cafe|coffee|uber eats|menulog|deliveroo|doordash|lunch|dinner|entertainment/i, "Meals & Entertainment"],
];

// Money-out lines that usually AREN'T expenses (internal moves, owner draws).
// These get flagged for review rather than auto-booked to an expense account.
const TRANSFER_RE = /transfer|tfr\b|to savings|own account|internal|withdrawal|cash ?out|\batm\b|drawings?|owner (draw|contribution)|director loan|loan repayment|payid to/i;

const STOPWORDS = new Set(["pty", "ltd", "the", "and", "for", "co", "inc", "au", "aus", "australia", "trust", "group", "services", "service", "payment", "pmt", "invoice", "inv", "ref", "tfr", "card", "value", "date", "eftpos", "visa", "mastercard", "debit", "credit", "purchase", "withdrawal", "deposit"]);

// ---------------------------------------------------------------------------
// Low-level parsing helpers
// ---------------------------------------------------------------------------

// Split CSV text into rows of cells. Handles quoted fields, escaped quotes
// ("") and commas/newlines inside quotes. Returns string[][].
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      // handled by \n
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

// Parse a date in the formats Australian banks emit → ISO "YYYY-MM-DD" or null.
// Ambiguous numeric dates are read DAY-FIRST (DD/MM/YYYY), the AU convention.
export function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) > 70 ? "19" : "20") + y;
    if (Number(mo) > 12 && Number(d) <= 12) [d, mo] = [mo, d]; // tolerate US order
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  if ((m = s.match(/^(\d{1,2})[ \-]([A-Za-z]{3})[A-Za-z]*[ \-](\d{2,4})$/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    let y = m[3]; if (y.length === 2) y = "20" + y;
    if (mo) return `${y}-${pad(mo)}-${pad(m[1])}`;
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

// Parse a money string → Number (sign preserved) or NaN. Handles $, commas,
// (parentheses) for negatives, and trailing/leading DR/CR markers.
export function parseAmount(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim();
  if (s === "") return NaN;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\bdr\b|\bdebit\b/i.test(s)) sign = -1;
  if (/\bcr\b|\bcredit\b/i.test(s)) sign = Math.abs(sign);
  s = s.replace(/[^0-9.\-+]/g, "");
  if (s === "" || s === "-" || s === "+") return NaN;
  const n = Number(s);
  return isNaN(n) ? NaN : sign * n;
}

const isDateCol = (vals) => vals.filter((v) => parseDate(v)).length >= Math.max(1, vals.length * 0.6);
const isNumCol = (vals) => vals.filter((v) => !isNaN(parseAmount(v))).length >= Math.max(1, vals.length * 0.6);
const avgLen = (vals) => vals.reduce((s, v) => s + String(v).trim().length, 0) / (vals.length || 1);

const HEADER_RE = /date|amount|amt|description|narrative|details|debit|credit|balance|payee|memo|particulars|reference|transaction|withdrawal|deposit|merchant/i;

// Work out which columns hold date / description / amount (or debit+credit).
// Returns { headerless, date, desc:[...], amount, debit, credit }.
export function detectColumns(rows) {
  const first = rows[0] || [];
  const looksHeader = first.some((c) => HEADER_RE.test(c)) && !first.some((c) => parseDate(c));
  const body = looksHeader ? rows.slice(1) : rows;
  const cols = Math.max(...rows.map((r) => r.length));
  const colVals = (idx) => body.map((r) => r[idx] ?? "");

  if (looksHeader) {
    const h = first.map((c) => c.toLowerCase().trim());
    const find = (re) => h.findIndex((c) => re.test(c));
    const map = { headerless: false, desc: [] };
    map.date = find(/date/);
    const debit = find(/debit|withdrawal|paid out|money out|^dr$/);
    const credit = find(/credit|deposit|paid in|money in|^cr$/);
    const amount = find(/^amount$|amount|^amt$|\bvalue\b/);
    if (debit >= 0 && credit >= 0) { map.debit = debit; map.credit = credit; }
    else if (amount >= 0) map.amount = amount;
    else if (debit >= 0) map.amount = debit; // single signed column mislabelled
    h.forEach((c, i) => {
      if (i === map.date || i === map.amount || i === map.debit || i === map.credit) return;
      if (/description|narrative|details|payee|memo|particulars|transaction|merchant|reference/.test(c)) map.desc.push(i);
    });
    if (!map.desc.length) {
      h.forEach((c, i) => { if (i !== map.date && i !== map.amount && i !== map.debit && i !== map.credit && !/balance/.test(c)) map.desc.push(i); });
    }
    return map;
  }

  // Headerless: infer roles by sampling the data.
  const map = { headerless: true, desc: [] };
  const numeric = [];
  for (let i = 0; i < cols; i++) {
    const vals = colVals(i);
    if (map.date == null && isDateCol(vals)) { map.date = i; continue; }
    if (isNumCol(vals)) numeric.push(i);
  }
  if (numeric.length >= 2) {
    // Last numeric column is almost always a running balance; drop it.
    const balance = numeric[numeric.length - 1];
    const cands = numeric.filter((i) => i !== balance);
    const withNeg = cands.find((i) => colVals(i).some((v) => parseAmount(v) < 0));
    map.amount = withNeg != null ? withNeg : cands[0];
  } else if (numeric.length === 1) {
    map.amount = numeric[0];
  }
  let best = -1, bestLen = -1;
  for (let i = 0; i < cols; i++) {
    if (i === map.date || i === map.amount) continue;
    const l = avgLen(colVals(i));
    if (l > bestLen) { bestLen = l; best = i; }
  }
  if (best >= 0) map.desc.push(best);
  return map;
}

// Turn parsed cells + a column map into normalised { date, description, amount }.
function rowsFromCells(rows, map) {
  const first = rows[0] || [];
  const looksHeader = !map.headerless && first.some((c) => HEADER_RE.test(c));
  const body = looksHeader ? rows.slice(1) : rows;
  const out = [];
  for (const r of body) {
    const date = parseDate(r[map.date]);
    let amount;
    if (map.debit != null || map.credit != null) {
      const dr = parseAmount(r[map.debit]); const cr = parseAmount(r[map.credit]);
      amount = (isNaN(cr) ? 0 : cr) - (isNaN(dr) ? 0 : dr);
    } else {
      amount = parseAmount(r[map.amount]);
    }
    const description = (map.desc || []).map((i) => (r[i] ?? "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!date && isNaN(amount)) continue;
    if (isNaN(amount) || amount === 0) continue;
    out.push({ date, description: description || "(no description)", amount: Math.round(amount * 100) / 100, raw: r });
  }
  return out;
}

// Minimal OFX/QFX reader: pull <STMTTRN> blocks. OFX is SGML-ish, so tags are
// often unclosed — match up to the next tag/newline.
function parseOFX(text) {
  const rows = [];
  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  const tag = (b, t) => { const m = b.match(new RegExp(`<${t}>([^<\r\n]*)`, "i")); return m ? m[1].trim() : ""; };
  for (const b of blocks) {
    const dRaw = tag(b, "DTPOSTED").slice(0, 8); // YYYYMMDD
    const date = dRaw.length === 8 ? `${dRaw.slice(0, 4)}-${dRaw.slice(4, 6)}-${dRaw.slice(6, 8)}` : parseDate(tag(b, "DTPOSTED"));
    const amount = parseAmount(tag(b, "TRNAMT"));
    const description = (tag(b, "NAME") || tag(b, "MEMO") || tag(b, "PAYEE")).replace(/\s+/g, " ").trim();
    const fitid = tag(b, "FITID");
    if (isNaN(amount) || amount === 0) continue;
    rows.push({ date, description: description || "(no description)", amount: Math.round(amount * 100) / 100, bank_ref: fitid || null, raw: b });
  }
  return rows;
}

// Top-level: text + filename → { format, columnMap, rows, warnings, error }.
export function parseBankFile(text, filename = "") {
  if (!text || !text.trim()) return { error: "The file is empty." };
  const isOFX = /\.(ofx|qfx)$/i.test(filename) || /<OFX>|<STMTTRN>/i.test(text);
  if (isOFX) {
    const rows = parseOFX(text);
    if (!rows.length) return { error: "Couldn't find any transactions in this OFX file." };
    return { format: "ofx", columnMap: null, rows, warnings: [] };
  }
  const cells = parseCSV(text);
  if (cells.length < 1) return { error: "Couldn't read any rows from this CSV." };
  const columnMap = detectColumns(cells);
  const warnings = [];
  if (columnMap.date == null) warnings.push("No date column detected — check the mapping.");
  if (columnMap.amount == null && columnMap.debit == null && columnMap.credit == null) warnings.push("No amount column detected — check the mapping.");
  const rows = rowsFromCells(cells, columnMap);
  if (!rows.length) return { error: "Couldn't read any transactions — try adjusting the column mapping.", columnMap, format: "csv" };
  return { format: "csv", columnMap, rows, warnings };
}

// ---------------------------------------------------------------------------
// Matching / classification
// ---------------------------------------------------------------------------

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const tokens = (s) => norm(s).split(" ").filter((t) => t.length > 2 && !STOPWORDS.has(t));

export function suggestExpenseCategory(description) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(description)) return cat;
  return DEFAULT_EXPENSE_CATEGORY;
}

// Best open invoice for a money-in line, or null. Confidence:
//   high   — amount matches AND (invoice number or payer name appears)
//   medium — amount matches uniquely, no name confirmation
//   else   — no confident match
export function matchInvoice(row, invoices) {
  const open = (invoices || []).filter((i) => i.type === "invoice" && (i.status === "sent" || i.status === "overdue"));
  if (!open.length) return null;
  const amt = Math.abs(Number(row.amount));
  const descToks = new Set(tokens(row.description));
  const exact = open.filter((i) => Math.abs(Number(i.total || 0) - amt) < 0.01);
  const pool = exact.length ? exact : open;
  const scored = pool.map((i) => {
    const nameToks = tokens(`${i.contact_name || ""} ${i.contact_company || ""}`);
    const overlap = nameToks.filter((t) => descToks.has(t)).length;
    const numHit = !!(i.number && norm(row.description).includes(norm(i.number)));
    const amtHit = Math.abs(Number(i.total || 0) - amt) < 0.01;
    return { i, overlap, numHit, amtHit };
  }).sort((a, b) => (b.numHit - a.numHit) || (b.amtHit - a.amtHit) || (b.overlap - a.overlap));
  const best = scored[0];
  if (!best || !best.amtHit) return null;
  let confidence;
  if (best.numHit || best.overlap > 0) confidence = "high";
  else if (exact.length === 1) confidence = "medium";
  else return null; // exact amount but several candidates and nothing to disambiguate
  return { id: best.i.id, number: best.i.number, contact: best.i.contact_name || best.i.contact_company || "", total: Number(best.i.total || 0), confidence };
}

// An existing transaction this row likely duplicates (same amount, within 4
// days, sharing a description/vendor word), or null.
export function findDuplicate(row, existingTxns) {
  const amt = Math.abs(Number(row.amount));
  const descToks = new Set(tokens(row.description));
  for (const t of existingTxns || []) {
    if (Math.abs(Math.abs(Number(t.amount)) - amt) > 0.005) continue;
    if (!t.date || !row.date) continue;
    if (Math.abs((new Date(t.date) - new Date(row.date)) / 86400000) > 4) continue;
    const toks = new Set(tokens(`${t.description || ""} ${t.contact || ""}`));
    let shared = 0; descToks.forEach((x) => { if (toks.has(x)) shared++; });
    if (shared >= 1 || descToks.size === 0) return t;
  }
  return null;
}

// Stable key for soft de-duplication across imports (see migration 0003).
export function makeDedupeKey(row) {
  return [row.date, Math.round(Math.abs(Number(row.amount)) * 100), norm(row.description).replace(/\s+/g, "").slice(0, 32)].join("|");
}

// Classify every parsed row. ctx = { invoices, existingTxns }.
// Each item gains: direction, status, include (default tick), and the relevant
// suggestion (invoice / account / reviewReason / duplicateOf).
export function categoriseRows(rows, ctx = {}) {
  const { invoices = [], existingTxns = [] } = ctx;
  return rows.map((row, idx) => {
    const direction = row.amount >= 0 ? "in" : "out";
    const base = { ...row, _k: idx, direction, dedupe_key: makeDedupeKey(row) };
    const dup = findDuplicate(row, existingTxns);
    if (dup) return { ...base, status: "duplicate", duplicateOf: dup.id, include: false };
    if (direction === "in") {
      const inv = matchInvoice(row, invoices);
      if (inv) return { ...base, status: "invoice", invoice: inv, include: true };
      return { ...base, status: "review", reviewReason: "Unmatched deposit", include: false };
    }
    if (TRANSFER_RE.test(row.description)) return { ...base, status: "review", reviewReason: "Looks like a transfer", include: false };
    const account = suggestExpenseCategory(row.description);
    return { ...base, status: "expense", account, include: true };
  });
}

// One-call convenience used by the UI.
export function processBankFile(text, filename, ctx) {
  const parsed = parseBankFile(text, filename);
  if (parsed.error) return parsed;
  return { ...parsed, items: categoriseRows(parsed.rows, ctx) };
}

// Roll the classified items up into the counts the review screen shows.
export function summarise(items) {
  const c = { total: items.length, invoice: 0, expense: 0, review: 0, duplicate: 0, income: 0 };
  for (const it of items) {
    if (it.status === "invoice") { c.invoice++; c.income++; }
    else if (it.status === "expense") c.expense++;
    else if (it.status === "review") { c.review++; if (it.direction === "in") c.income++; }
    else if (it.status === "duplicate") c.duplicate++;
  }
  return c;
}
