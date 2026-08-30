import { useState, useEffect, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabaseClient";

const API_BASE = Capacitor.isNativePlatform() ? "https://bkeeper.netlify.app" : "";

const DEFAULT_EMAIL_TEMPLATE_INVOICE = `Hi {first_name},

Please find attached invoice {number} for {amount}.

{due_date_line}

{payment_details}

Kind regards,
{signature}`;

const DEFAULT_EMAIL_TEMPLATE_QUOTE = `Hi {first_name},

Please find attached quote {number} for {amount}.

This quote is valid until {due_date}. Payment details will be provided upon acceptance.

Kind regards,
{signature}`;

const DEFAULT_PROFILE = { name: "", abn: "", address: "", email: "", phone: "", bank_name: "", account_name: "", bsb: "", account_number: "", logo_url: "", email_template_invoice: "", email_template_quote: "", email_signature: "", onedrive_folder: "" };

// Header titles per page. Sub-pages (reimbursements/reconcile live under Expenses,
// quotes under Sales) keep their own title even though they share a nav item.
const PAGE_TITLES = { dashboard: "Dashboard", invoices: "Invoices", quotes: "Quotes", projects: "Projects", contacts: "Contacts" };


// One legal entity in Supabase (business_id = 'mworx'). All existing Mworx
// invoices, expenses, and projects live there today. Division is an extra tag
// on those same rows — not a second business or database setup.
const COMPANY = { id: "mworx", name: "MT Management Pty Ltd" };

const ALL_DIVISIONS = "all";

const DIVISIONS = [
  { id: "mworx", name: "Mworx Group", short: "Mworx", subtitle: "Drafting & planning", accent: "#10b981", invoicePrefix: "MWX", quotePrefix: "QMWX", tagline: "Design · Consultancy · Project Management" },
  { id: "mt_management", name: "MT Management", short: "MT Mgmt", subtitle: "STR property management", accent: "#3b82f6", invoicePrefix: "MTM", quotePrefix: "QMTM", tagline: "Short-Term Rental Property Management" },
];

const DIVISION_MENU_OPTIONS = [
  { id: ALL_DIVISIONS, name: "All", subtitle: "Combined view", accent: "#6366f1" },
  ...DIVISIONS,
];

function DivisionMenu({ division, onSwitch, onClose, style }) {
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 58 }} onClick={onClose} aria-hidden="true" />
      <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 200, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 12px 28px -8px rgba(16,24,40,0.25)", padding: 4, zIndex: 59, ...style }}>
        {DIVISION_MENU_OPTIONS.map((d) => {
          const active = division === d.id;
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => { onSwitch(d.id); onClose(); }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "10px 12px",
                border: "none",
                borderRadius: 7,
                cursor: "pointer",
                background: active ? d.accent + "18" : "transparent",
                borderLeft: active ? `3px solid ${d.accent}` : "3px solid transparent",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: active ? d.accent : "#0f172a" }}>{d.name}</div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 1 }}>{d.subtitle}</div>
            </button>
          );
        })}
      </div>
    </>
  );
}

const fmt = (n) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
// Amount without the currency symbol — for columns whose header already carries "($)".
const fmtNum = (n) => new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
const fmtDate = (d) => { if (!d) return ""; const dt = new Date(d); return isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" }); };
// First word of a name, for friendly email greetings ("Hi John,").
const firstName = (n) => (n || "").trim().split(/\s+/)[0] || "";
// Everything after the first word ("Cameron Mawson" → "Mawson"; "Mary Jane Watson"
// → "Jane Watson"). Empty for single-word names.
const lastName = (n) => (n || "").trim().split(/\s+/).slice(1).join(" ");
// A signature can be plain text or full HTML. Plain text gets nl2br; HTML is
// used verbatim (nl2br would inject stray <br>s between its tags and break it).
const signatureToHtml = (s) => { const t = String(s || ""); return /<[a-z][\s\S]*>/i.test(t) ? t : t.replace(/\n/g, "<br>"); };
const today = () => new Date().toISOString().split("T")[0];

// Whole calendar days an unpaid invoice is past its due date. Returns 0 for
// quotes, drafts, paid/accepted/declined docs, undated invoices, or anything not
// yet due. Uses the same date basis as today() so it matches the server-side
// "overdue" status flip done on load.
const daysOverdue = (inv) => {
  if (!inv || inv.type === "quote" || !inv.due_date) return 0;
  if (inv.status !== "sent" && inv.status !== "overdue") return 0;
  const diff = Math.round((new Date(today()) - new Date(inv.due_date)) / 86400000);
  return diff > 0 ? diff : 0;
};

// Big KPI money, MYOB-style: dollars bold, the cents de-emphasised so the eye
// lands on the figure that matters. Falls back gracefully if there's no ".dd".
function MoneyBig({ value, color = "#0f172a", size = 30 }) {
  const str = fmt(Number(value) || 0);
  const m = str.match(/^(.*?)(\.\d{2})$/);
  const main = m ? m[1] : str;
  const cents = m ? m[2] : "";
  return (
    <span className="bk-num" style={{ fontSize: size, fontWeight: 700, color, letterSpacing: "-0.02em", lineHeight: 1.05, whiteSpace: "nowrap" }}>
      {main}{cents && <span style={{ fontSize: Math.round(size * 0.58), fontWeight: 600, color: "#94a3b8" }}>{cents}</span>}
    </span>
  );
}

const recordDivision = (r) => {
  const d = r?.division;
  if (!d || d === "mworx") return "mworx";
  if (d === "mtmgmt" || d === "mt_management" || d === "MT Management") return "mt_management";
  return "mworx"; // unknown values → treat as Mworx (existing data)
};
const divisionInfo = (id) => {
  if (id === ALL_DIVISIONS) return { id: ALL_DIVISIONS, name: "All Divisions", short: "All", subtitle: "Combined view", accent: "#6366f1", invoicePrefix: "MWX", quotePrefix: "QMWX", tagline: "" };
  return DIVISIONS.find((d) => d.id === id) || DIVISIONS[0];
};
const isValidDivision = (id) => id === ALL_DIVISIONS || DIVISIONS.some((d) => d.id === id);


const sanitizeFilePart = (s) => (s || "").replace(/[/\\:*?"<>|&#%]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const safeFileName = (parts, ext) => parts.map(p => sanitizeFilePart(String(p))).filter(Boolean).join("_") + "." + ext;

function getDocumentPrefix(divisionId, type) {
  const div = divisionInfo(divisionId);
  return type === "quote" ? div.quotePrefix : div.invoicePrefix;
}

function getNextDocumentNumber(invoices, divisionId, type) {
  const prefix = getDocumentPrefix(divisionId, type);
  const yy = String(new Date().getFullYear()).slice(-2);
  const tag = `${prefix}${yy}`;
  const seqs = (invoices || [])
    .filter((i) => recordDivision(i) === divisionId && i.type === type)
    .map((i) => { const n = i.number; if (!n || !n.startsWith(tag)) return 0; const s = Number(n.slice(tag.length)); return Number.isFinite(s) ? s : 0; })
    .filter((s) => s > 0);
  const next = seqs.length ? Math.max(...seqs) + 1 : 1;
  return `${tag}${String(next).padStart(3, "0")}`;
}

// Per-division job/project number in the YY### scheme (e.g. 26106 = 6th job of
// 2026). Continues from the highest existing number for the current year; if
// there are none yet, starts the year at YY101.
// Project numbers are a single sequence for the whole business — NOT per
// division (unlike quote/invoice numbers, which carry a division prefix). A
// per-division count made each new division restart at YY101 and collide with
// another division's existing numbers, so we count across all jobs here.
function getNextJobNumber(jobs) {
  const yy = String(new Date().getFullYear()).slice(-2);
  const nums = (jobs || [])
    .map((j) => { const m = String(j.job_number || "").match(/^(\d{4,})$/); return m ? Number(m[1]) : 0; })
    .filter((n) => n > 0 && String(n).startsWith(yy));
  const next = nums.length ? Math.max(...nums) + 1 : Number(`${yy}101`);
  return String(next);
}

// Built-in application types for projects. The dropdown also offers any custom
// types already saved on other projects, plus an "Add new…" free-text option.
const APPLICATION_TYPES = ["DA", "CC", "CDC", "S4.55", "Drafting Only"];

function addDays(dateStr, days) { const d = new Date(dateStr); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function getDefaultDueDate(type, date) { return addDays(date || today(), type === "quote" ? 30 : 7); }

// ── Australian financial year (1 Jul – 30 Jun) ─────────────────────────────
// An FY is identified by its starting calendar year as a string: "2026" is
// FY2026-27. ALL_FY means "don't filter". Declared as hoisted functions so the
// order of the consts below them can never matter.
const ALL_FY = "all";

// FY containing a "YYYY-MM-DD" date.
function fyOfDate(dateStr) {
  const d = String(dateStr || "").slice(0, 10);
  if (d.length < 7) return null;
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  return Number.isFinite(y) && Number.isFinite(m) ? String(m >= 7 ? y : y - 1) : null;
}

// The FY we are in right now. Deliberately NOT built on today(), which is
// toISOString() and therefore UTC: in Sydney that reads as the previous day
// until 10am, so on the morning of 1 July the app would open on the FY that
// ended the night before.
function currentFY() {
  const d = new Date();
  return String(d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1);
}

function fyBounds(fy) { const y = Number(fy); return { start: `${y}-07-01`, end: `${y + 1}-06-30` }; }
function fyLabel(fy) { return fy === ALL_FY ? "All time" : `FY${String(Number(fy)).slice(-2)}-${String(Number(fy) + 1).slice(-2)}`; }

// A document belongs to an FY by its issue date, never paid_date (often null)
// or created_at (when the row was typed, not the date on the PDF). The slice
// guards against a legacy timestamp-shaped value, which would otherwise compare
// greater than its own FY's end date and fall outside it.
function inFY(row, fy) {
  if (fy === ALL_FY) return true;
  const d = String(row?.date || "").slice(0, 10);
  if (!d) return false;
  const { start, end } = fyBounds(fy);
  return d >= start && d <= end;
}

// Selectable FYs: every year present in the data, plus the current one, plus
// whatever is selected. That last term matters — a value persisted from an
// earlier session with no matching <option> would leave the select painting one
// FY while the app filtered by another, and a reload would not clear it.
function fyChoices(rows, selected) {
  const years = new Set([currentFY()]);
  for (const r of rows || []) { const f = fyOfDate(r?.date); if (f) years.add(f); }
  if (selected && selected !== ALL_FY) years.add(selected);
  return [...years].sort((a, b) => Number(b) - Number(a));
}
const DEFAULT_QUOTE_TERMS = `1. Validity: This quote is valid for 30 days from the date of issue. Pricing may be subject to change after this period.
2. Acceptance: Work commences upon written acceptance of this quote.
3. Fees: Fees are as quoted above.
4. Payment: Fees are invoiced on agreed milestones or on completion and are due within 7 days of each invoice. Final drawings and lodgement of documents are released upon full payment of all invoices.
5. Scope: This quote covers only the scope of works listed above.
6. Variations: Any change to the scope of works may incur additional fees, which will be quoted separately and agreed in writing before proceeding.
7. Exclusions: Unless expressly stated, the following are excluded — council/certifier and statutory lodgement fees; third-party consultant costs (e.g. structural engineer, surveyor, BASIX, geotechnical, certifier); printing and physical models.
8. Approvals: We prepare and lodge documentation to a professional standard but cannot guarantee approval by council, a certifier or any authority; their decisions and processing times are outside our control.
9. Client information & access: The client is responsible for providing accurate information (e.g. survey, existing plans) and reasonable site access. We are not liable for delays or errors arising from incomplete or inaccurate information provided to us.
10. Timeframes: Any timeframes are estimates only and are subject to authority processing times and the client's timely provision of information and approvals.
11. Copyright: All drawings and documents remain our intellectual property. On full payment, the client is granted a licence to use them for this project only and may not reuse them on another site or project without our consent.
12. Liability: Services are provided with reasonable skill and care. To the extent permitted by law, our liability is limited to the fees paid for the services and we are not liable for indirect or consequential loss.`;
// Notes / payment-terms default (free text). Quote T&Cs now live in the separate
// `terms` field (printed on its own page), so a quote's notes start empty.
function getDefaultTerms(type) { return type === "quote" ? "" : "Payment is due within 7 days from the invoice date. Please use the invoice number as the payment reference."; }
// Default for the standalone Terms & Conditions field.
function getDefaultDocTerms(type) { return type === "quote" ? DEFAULT_QUOTE_TERMS : ""; }

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

// Per-project money breakdown. "Remaining" = contract − paid (only paid invoices
// reduce it); we also surface invoiced/outstanding/leftToInvoice for context.
// Contract is the agreed amount = sum of ACCEPTED quotes. But if work is billed
// without a quote (no accepted quotes, or invoiced beyond them), fall back so the
// contract at least covers what's been invoiced — otherwise progress/remaining
// would be 0% / negative for invoice-only projects.
function docTotals(docs) {
  const sum = (arr) => arr.reduce((s, i) => s + (Number(i.total) || 0), 0);
  const quoted = sum(docs.filter((i) => i.type === "quote" && i.status === "accepted"));
  const realInvoices = docs.filter((i) => i.type === "invoice");
  const invoiced = sum(realInvoices.filter((i) => i.status !== "draft"));
  const paid = sum(realInvoices.filter((i) => i.status === "paid"));
  const contract = Math.max(quoted, invoiced);
  return { contract, quoted, invoiced, paid, remaining: contract - paid, outstanding: invoiced - paid, leftToInvoice: contract - invoiced };
}

function projectTotals(project, invoices) {
  return docTotals((invoices || []).filter((i) => i.project_id === project.id));
}

// Display label for a project: prefer the site address, since the "name" is often
// just a description (e.g. "Construction Certificate - Gym"). Falls back to name.
function projectLabel(p) {
  return (p?.address && p.address.trim()) ? p.address.trim() : (p?.name || "");
}

// Group a project's quotes/invoices by consultant. Deliberately keyed on the
// contact_name SNAPSHOT, not contact_id: the snapshot is what was printed on the
// document, and regrouping on the id would change displayed per-consultant totals
// (a row whose contact_id is null would collapse into "Unassigned"). Returns one
// entry per consultant
// with their own totals + their quote/invoice rows, sorted by remaining desc.
function projectConsultants(project, invoices) {
  const linked = (invoices || []).filter((i) => i.project_id === project.id);
  const groups = {};
  for (const doc of linked) {
    const name = (doc.contact_name || doc.contact_company || "Unassigned").trim() || "Unassigned";
    (groups[name] ||= []).push(doc);
  }
  return Object.entries(groups)
    .map(([name, docs]) => ({
      name,
      ...docTotals(docs),
      quotes: docs.filter((d) => d.type === "quote").sort((a, b) => (b.date || "").localeCompare(a.date || "")),
      invoices: docs.filter((d) => d.type === "invoice").sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    }))
    .sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name));
}

const Icons = {
  Dashboard: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  Contacts: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Invoices: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
  Projects: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/><path d="M2 13h20"/></svg>,
  Quotes: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
  Plus: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>,
  X: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>,
  Trash: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>,
  Edit: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Check: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>,
  Send: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>,
  Menu: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>,
  Logout: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>,
  Settings: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  Download: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>,
  More: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>,
  Bell: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>,
  Link: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>,
  Eye: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>,
  Cloud: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>,
  Outlook: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M24 7.387v10.478c0 .23-.08.424-.238.576-.16.154-.353.23-.578.23h-8.26V6.58h8.26c.225 0 .418.077.578.23.159.154.238.347.238.577zM13.73 3.088v18.47L0 18.583V6.07l13.73-2.982z"/></svg>,
  ChevronLeft: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>,
  ChevronRight: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>,
  Filter: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
};

// Mworx brand mark — two green triangles meeting at the centre on a black tile,
// rebuilt as crisp vector art so it stays sharp from a 16px favicon up to the app
// header. MWORX_GREEN is the single source of truth for the brand colour; the same
// values mirror the static /favicon.svg (browser tab). Tweak the hex here to recolour
// the mark everywhere inside the app.
const MWORX_GREEN = "#2ECC71";
const MWORX_BLACK = "#0d0d0d";
function MworxLogo({ size = 32, radius = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style={{ display: "block", flexShrink: 0 }} role="img" aria-label="Mworx">
      <rect width="100" height="100" rx={radius} fill={MWORX_BLACK} />
      <polygon points="15,9 50,51 15,92" fill={MWORX_GREEN} />
      <polygon points="85,9 50,51 85,92" fill={MWORX_GREEN} />
    </svg>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  // Sign-in only — self-service sign-up is intentionally disabled so only
  // pre-provisioned accounts can access the app. New accounts are created by an
  // admin in the Supabase dashboard (public sign-ups are also disabled there).
  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    setInfo("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) setError(error.message);
  };

  // Email a password-reset link. The link returns to this app with a recovery
  // token; onAuthStateChange fires PASSWORD_RECOVERY and shows ResetPasswordScreen.
  const sendReset = async () => {
    setError(""); setInfo("");
    if (!email) { setError("Enter your email above first, then tap “Forgot password?”."); return; }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setInfo("If that email has an account, a reset link is on its way — check your inbox.");
  };

  const inputStyle = { width: "100%", padding: "12px 16px", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, color: "#0f172a", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 12 };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "radial-gradient(120% 120% at 50% 0%, #ecfdf5 0%, #f7f9f8 46%)", fontFamily: "'DM Sans', system-ui, sans-serif", padding: 20 }}>
      <div style={{ background: "#ffffff", borderRadius: 20, border: "1px solid #eef1f0", padding: 40, width: "100%", maxWidth: 400, textAlign: "center", boxShadow: "0 24px 50px -16px rgba(16,24,40,0.18), 0 2px 6px rgba(16,24,40,0.05)" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}><MworxLogo size={68} radius={20} /></div>
        <div style={{ fontSize: 28, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.03em", marginBottom: 4 }}>BookKeeper</div>
        <div style={{ fontSize: 12, color: "#10b981", marginBottom: 32, textTransform: "uppercase", letterSpacing: "0.08em" }}>{COMPANY.name}</div>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" style={inputStyle} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" onKeyDown={(e) => e.key === "Enter" && email && password && handleSubmit()} style={inputStyle} />
        {error && <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>{error}</div>}
        {info && <div style={{ color: "#059669", fontSize: 12, marginBottom: 8 }}>{info}</div>}
        <button disabled={!email || !password || loading} onClick={handleSubmit} style={{ width: "100%", padding: "13px", background: "linear-gradient(180deg, #10b981 0%, #059669 100%)", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: !email || !password || loading ? 0.5 : 1, marginBottom: 8, boxShadow: "0 6px 16px -6px rgba(16,185,129,0.6)" }}>
          {loading ? "..." : "Sign In"}
        </button>
        <button type="button" onClick={sendReset} disabled={loading} style={{ background: "none", border: "none", color: "#64748b", fontSize: 12, cursor: loading ? "default" : "pointer", marginBottom: 12 }}>
          Forgot password?
        </button>
        <div style={{ color: "#94a3b8", fontSize: 11, marginTop: 4 }}>
          Access is restricted to authorised accounts.
        </div>
      </div>
    </div>
  );
}

// Shown when a user follows a password-reset email link — onAuthStateChange fires
// PASSWORD_RECOVERY (see App), which flips into this screen. Sets a new password
// via updateUser (the recovery link already established a session), then hands back.
function ResetPasswordScreen({ onDone }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError("");
    if (pw1.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (pw1 !== pw2) { setError("Passwords don't match."); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    setLoading(false);
    if (error) { setError(error.message); return; }
    setDone(true);
  };

  const finish = () => {
    // Strip the recovery token from the URL, then return control to the app.
    try { window.history.replaceState(null, "", window.location.pathname); } catch { /* ignore */ }
    onDone?.();
  };

  const inputStyle = { width: "100%", padding: "12px 16px", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, color: "#0f172a", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 12 };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "radial-gradient(120% 120% at 50% 0%, #ecfdf5 0%, #f7f9f8 46%)", fontFamily: "'DM Sans', system-ui, sans-serif", padding: 20 }}>
      <div style={{ background: "#ffffff", borderRadius: 20, border: "1px solid #eef1f0", padding: 40, width: "100%", maxWidth: 400, textAlign: "center", boxShadow: "0 24px 50px -16px rgba(16,24,40,0.18), 0 2px 6px rgba(16,24,40,0.05)" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}><MworxLogo size={68} radius={20} /></div>
        <div style={{ fontSize: 24, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.03em", marginBottom: 4 }}>Set a new password</div>
        {done ? (
          <>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 8, marginBottom: 24, lineHeight: 1.5 }}>Your password has been updated and you&apos;re signed in.</div>
            <button onClick={finish} style={{ width: "100%", padding: "13px", background: "linear-gradient(180deg, #10b981 0%, #059669 100%)", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", boxShadow: "0 6px 16px -6px rgba(16,185,129,0.6)" }}>Continue to BookKeeper</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "#64748b", marginTop: 6, marginBottom: 24 }}>Choose a strong password — at least 8 characters.</div>
            <input type={show ? "text" : "password"} value={pw1} onChange={(e) => setPw1(e.target.value)} placeholder="New password" autoComplete="new-password" style={inputStyle} />
            <input type={show ? "text" : "password"} value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Confirm new password" autoComplete="new-password" onKeyDown={(e) => e.key === "Enter" && pw1 && pw2 && submit()} style={inputStyle} />
            <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 12, color: "#64748b", marginBottom: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
            </label>
            {error && <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 10 }}>{error}</div>}
            <button disabled={!pw1 || !pw2 || loading} onClick={submit} style={{ width: "100%", padding: "13px", background: "linear-gradient(180deg, #10b981 0%, #059669 100%)", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: !pw1 || !pw2 || loading ? 0.5 : 1, boxShadow: "0 6px 16px -6px rgba(16,185,129,0.6)" }}>
              {loading ? "..." : "Update Password"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Change-password form embedded in the Settings "Security" panel. The user is
// already signed in, so updateUser applies immediately — no email round-trip.
function ChangePasswordForm({ s, accent }) {
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const submit = async () => {
    setMsg(null);
    if (pw1.length < 8) { setMsg({ ok: false, text: "Password must be at least 8 characters." }); return; }
    if (pw1 !== pw2) { setMsg({ ok: false, text: "Passwords don't match." }); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw1 });
    setBusy(false);
    if (error) { setMsg({ ok: false, text: error.message }); return; }
    setPw1(""); setPw2("");
    setMsg({ ok: true, text: "Password updated. Use it next time you sign in." });
  };

  return (
    <>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
        Set a new password for signing in. Use at least 8 characters — longer and unique is stronger.
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={s.label}>New Password</label>
        <input type={show ? "text" : "password"} value={pw1} onChange={(e) => setPw1(e.target.value)} autoComplete="new-password" placeholder="New password" style={s.input} />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={s.label}>Confirm Password</label>
        <input type={show ? "text" : "password"} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" placeholder="Re-enter new password" onKeyDown={(e) => e.key === "Enter" && submit()} style={s.input} />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#64748b", marginBottom: 10, cursor: "pointer" }}>
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
      </label>
      {msg && <div style={{ fontSize: 12, marginBottom: 10, color: msg.ok ? "#059669" : "#ef4444" }}>{msg.text}</div>}
      <button onClick={submit} disabled={busy || !pw1 || !pw2} style={{ ...s.btn(accent), justifyContent: "center", opacity: busy || !pw1 || !pw2 ? 0.5 : 1 }}>
        {busy ? "Updating…" : "Update Password"}
      </button>
    </>
  );
}

// A single-line description renders as plain bold text. A multi-line one becomes a
// bulleted scope list: non-indented lines get a "•", lines that start with
// whitespace become "◦" sub-items. Any bullet char the user typed is stripped so
// we never double up. Used by both PDF builders.
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

function buildInvoiceHTML(inv, profile, accent, logoDataUrl) {
  const isQuote = inv.type === "quote";
  const docType = isQuote ? "QUOTE" : "INVOICE";
  const bName = profile.name || "Company";
  const tagline = divisionInfo(recordDivision(inv)).tagline;
  const accountName = profile.account_name || profile.name || bName;

  const logoHTML = logoDataUrl
    ? `<img src="${logoDataUrl}" style="max-height:70px;max-width:200px;object-fit:contain;display:block" />`
    : `<div style="font-size:24px;font-weight:800;color:#1e293b;letter-spacing:-0.02em">${bName}</div>`;

  const isLump = inv.pricing_mode === "lump_sum";

  const lumpScope = (inv.items || []).map((i) => i.description || "").filter((d) => d.trim()).join("\n");

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
        <tbody>${(inv.items || []).map((item) => {
          const amount = (Number(item.qty) || 0) * (Number(item.rate) || 0);
          return `<tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#1e293b;vertical-align:top">
              ${bulletizeScope(item.description)}
              ${item.note ? `<div style="font-size:10px;color:#6b7280;margin-top:2px;white-space:pre-wrap">${item.note}</div>` : ""}
            </td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:center;vertical-align:top">${Number(item.qty) || 1}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:right;vertical-align:top">${fmt(item.rate || 0)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;font-weight:600;color:#1e293b;text-align:right;vertical-align:top">${fmt(amount)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>`;

  const subtotal = isLump ? (Number(inv.total) || 0) : (inv.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);

  const paymentSection = !isQuote ? `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px 20px;margin-top:24px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:10px">How to Pay</div>
      <table style="font-size:11px;color:#374151;line-height:1.8">
        ${profile.bank_name ? `<tr><td style="padding-right:20px;color:#6b7280">Bank</td><td style="font-weight:600">${profile.bank_name}</td></tr>` : ""}
        <tr><td style="padding-right:20px;color:#6b7280">Account Name</td><td style="font-weight:600">${accountName}</td></tr>
        ${profile.bsb ? `<tr><td style="padding-right:20px;color:#6b7280">BSB</td><td style="font-weight:600">${profile.bsb}</td></tr>` : ""}
        ${profile.account_number ? `<tr><td style="padding-right:20px;color:#6b7280">Account Number</td><td style="font-weight:600">${profile.account_number}</td></tr>` : ""}
        <tr><td style="padding-right:20px;color:#6b7280">Reference</td><td style="font-weight:600">${inv.number || ""}</td></tr>
      </table>
    </div>` : `
    <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:6px;padding:14px 20px;margin-top:24px">
      <div style="font-size:11px;color:#0f766e;line-height:1.6">This quote is valid for 30 days from the date of issue. Payment details will be provided upon acceptance.</div>
    </div>`;

  return `<div style="width:595px;min-height:842px;background:#fff;padding:40px 44px;font-family:Helvetica Neue,Arial,sans-serif;box-sizing:border-box;display:flex;flex-direction:column">

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
          <tr><td style="color:#94a3b8;padding:3px 14px 3px 0;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">${isQuote ? "Quote Date" : "Invoice Date"}</td><td style="color:#1e293b;font-weight:500;padding:3px 0">${inv.date ? fmtDate(inv.date) : ""}</td></tr>
          ${inv.due_date ? `<tr><td style="color:#94a3b8;padding:3px 14px 3px 0;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">${isQuote ? "Valid Until" : "Due Date"}</td><td style="color:#1e293b;font-weight:500;padding:3px 0">${fmtDate(inv.due_date)}</td></tr>` : ""}
          ${inv.job ? `<tr><td style="color:#94a3b8;padding:3px 14px 3px 0;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Job / Ref</td><td style="color:#1e293b;font-weight:500;padding:3px 0">${inv.job}</td></tr>` : ""}
        </table>
      </div>
    </div>

    ${itemsTable}

    <div style="display:flex;justify-content:flex-end">
      <div style="width:240px">
        <div style="display:flex;justify-content:space-between;padding:10px 0 4px;margin-top:4px;border-top:2px solid #1e293b">
          <span style="font-size:14px;font-weight:700;color:#1e293b">Total AUD</span>
          <span style="font-size:16px;font-weight:800;color:${accent}">${fmt(subtotal)}</span>
        </div>
      </div>
    </div>

    ${paymentSection}

    ${inv.notes ? `<div style="font-size:10px;color:#6b7280;line-height:1.6;margin-top:20px;padding-top:10px;border-top:1px solid #e5e7eb;white-space:pre-wrap">${inv.notes}</div>` : ""}

    ${(inv.terms && inv.terms.trim()) || isQuote ? `<div style="page-break-before:always;break-before:page;padding-top:8px">
      ${inv.terms && inv.terms.trim() ? `<div style="font-size:16px;font-weight:700;color:#1e293b;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid ${accent}">Terms &amp; Conditions</div>
      <div style="font-size:10.5px;color:#475569;line-height:1.75;white-space:pre-wrap">${inv.terms}</div>` : ""}
      ${isQuote ? ACCEPTANCE_BLOCK : ""}
    </div>` : ""}

    <div style="margin-top:auto;padding-top:24px;text-align:center;border-top:1px solid #e2e8f0">
      <div style="font-size:10px;color:#64748b;margin-bottom:2px">Thank you for your business.</div>
      <div style="font-size:9px;color:#94a3b8">${bName}${profile.abn ? ` · ABN ${profile.abn}` : ""}${profile.email ? ` · ${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}</div>
      ${tagline ? `<div style="font-size:8px;color:#94a3b8;margin-top:2px">${tagline}</div>` : ""}
    </div>
  </div>`;
}

// Full-screen, in-app viewer for an invoice/quote. Renders the same HTML the PDF is
// built from inside an isolated <iframe srcDoc>, so there is no window.open()/new tab
// and the mobile/Safari/in-app pop-up blocker can never get in the way (that blocker
// is what produced the old "Allow pop-ups to view the document" message). Defined at
// the top level — not nested in BookkeeperApp — so a parent re-render (e.g. the PDF
// download toggling pdfLoading) doesn't unmount it and reload the iframe.
function DocViewer({ inv, profile, accent, isMobile, pdfLoading, onClose, onDownload, fetchLogoBase64 }) {
  const [html, setHtml] = useState(null);
  const frameRef = useRef(null);
  const docType = inv.type === "quote" ? "Quote" : "Invoice";
  const title = `${docType} ${inv.number || ""}`.trim();

  useEffect(() => {
    let alive = true;
    (async () => {
      const logoDataUrl = await fetchLogoBase64();
      const content = buildInvoiceHTML(inv, profile, accent, logoDataUrl);
      const full = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
        html,body{margin:0;background:#eef2f5;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .bk-sheet{max-width:820px;margin:16px auto;background:#fff;box-shadow:0 2px 14px rgba(16,24,40,.14)}
        .bk-sheet>div{width:100%!important;box-sizing:border-box}
        @media print{body{background:#fff}.bk-sheet{box-shadow:none;margin:0;max-width:none}}
      </style></head><body><div class="bk-sheet">${content}</div></body></html>`;
      if (alive) setHtml(full);
    })();
    return () => { alive = false; };
  }, [inv, profile, accent, fetchLogoBase64]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const printDoc = () => { try { const w = frameRef.current?.contentWindow; if (w) { w.focus(); w.print(); } } catch { /* print unsupported (e.g. iOS WebView) — use Download instead */ } };

  const btn = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "8px 12px", borderRadius: 9, cursor: "pointer", whiteSpace: "nowrap" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "#eef2f5", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "calc(10px + env(safe-area-inset-top)) 12px 10px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexShrink: 0 }}>
        <button onClick={onClose} title="Close" style={{ ...btn, background: "none", border: "none", color: "#64748b", padding: 4 }}><Icons.X /></button>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
        {!isMobile && <button onClick={printDoc} style={{ ...btn, background: "#fff", border: "1px solid #e2e8f0", color: "#334155" }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6v-8z"/></svg> Print</button>}
        <button onClick={() => onDownload(inv)} disabled={pdfLoading === inv.id} style={{ ...btn, background: accent, border: "none", color: "#fff", opacity: pdfLoading === inv.id ? 0.6 : 1 }}><Icons.Download /> {pdfLoading === inv.id ? "..." : "Download PDF"}</button>
      </div>
      {html ? (
        <iframe ref={frameRef} srcDoc={html} title={title} style={{ flex: 1, width: "100%", border: "none" }} />
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: 14 }}>Loading {docType.toLowerCase()}…</div>
      )}
    </div>
  );
}

// In-app "compose email" window for sending a quote/invoice. The user reviews and
// edits the recipient, subject, and body (signature shown separately, toggleable)
// before hitting Send — nothing goes out automatically. Top-level so a parent
// re-render can't remount it and lose the user's edits mid-compose. The PDF is
// generated + attached and the status flips to Sent inside onSend.
function ComposeEmail({ inv, accent, isMobile, defaults, onClose, onSend }) {
  const [to, setTo] = useState(defaults.to);
  const [subject, setSubject] = useState(defaults.subject);
  const [body, setBody] = useState(defaults.body);
  const [includeSig, setIncludeSig] = useState(true);
  const [sending, setSending] = useState(false);
  const docType = inv.type === "quote" ? "Quote" : "Invoice";
  const attachName = `${docType} ${inv.number || "draft"}.pdf`;

  const send = async () => {
    if (!to.trim()) { alert("Add a recipient email address."); return; }
    // Escape the user's plain-text message, then nl2br. The signature is HTML
    // (per Settings — "HTML allowed"), appended as-is, matching the server.
    const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const html = esc(body).replace(/\n/g, "<br>") + (includeSig && defaults.signatureHtml ? `<br><br>${defaults.signatureHtml}` : "");
    setSending(true);
    await onSend({ to: to.trim(), subject: subject.trim(), html });
    setSending(false); // onSend closes the window on success
  };

  const lbl = { display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8", marginBottom: 5 };
  const inp = { width: "100%", boxSizing: "border-box", border: "1px solid #e2e8f0", borderRadius: 8, padding: "9px 11px", fontSize: 13, fontFamily: "inherit", color: "#1e293b", background: "#fff" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: isMobile ? "flex-end" : "center", justifyContent: "center", padding: isMobile ? 0 : 16 }} onClick={(e) => { if (e.target === e.currentTarget && !sending) onClose(); }}>
      <div style={{ background: "#fff", width: isMobile ? "100%" : 560, maxWidth: "100%", maxHeight: "92vh", overflowY: "auto", borderRadius: isMobile ? "16px 16px 0 0" : 14, boxShadow: "0 20px 60px -15px rgba(16,24,40,0.4)", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>Send {docType} {inv.number}</h3>
          <button onClick={onClose} disabled={sending} style={{ background: "none", border: "none", color: "#64748b", cursor: sending ? "default" : "pointer" }}><Icons.X /></button>
        </div>
        <div style={{ marginBottom: 12 }}><label style={lbl}>To</label><input value={to} onChange={(e) => setTo(e.target.value)} style={inp} placeholder="client@example.com" /></div>
        <div style={{ marginBottom: 12 }}><label style={lbl}>Subject</label><input value={subject} onChange={(e) => setSubject(e.target.value)} style={inp} /></div>
        <div style={{ marginBottom: 12 }}><label style={lbl}>Message</label><textarea value={body} onChange={(e) => setBody(e.target.value)} style={{ ...inp, minHeight: 170, resize: "vertical", lineHeight: 1.6 }} /></div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#334155", marginBottom: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={includeSig} onChange={(e) => setIncludeSig(e.target.checked)} /> Include my signature
        </label>
        {includeSig && defaults.signatureHtml && (
          <div style={{ border: "1px solid #eef2f6", background: "#f8fafc", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#475569", marginBottom: 12 }} dangerouslySetInnerHTML={{ __html: defaults.signatureHtml }} />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 8, padding: "9px 12px", fontSize: 12.5, color: "#0f766e", marginBottom: 16 }}>
          <span style={{ fontSize: 15 }}>📎</span> {attachName} <span style={{ color: "#5e7d78" }}>will be attached</span>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} disabled={sending} style={{ border: "1px solid #e2e8f0", background: "#fff", color: "#475569", borderRadius: 8, padding: "10px 16px", fontSize: 13, fontWeight: 600, cursor: sending ? "default" : "pointer" }}>Cancel</button>
          <button onClick={send} disabled={sending} style={{ border: "none", background: accent, color: "#fff", borderRadius: 8, padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: sending ? "wait" : "pointer", opacity: sending ? 0.6 : 1, display: "inline-flex", alignItems: "center", gap: 6 }}>
            {sending ? "Sending…" : <><Icons.Send /> Send</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// Full-screen, in-app viewer for a receipt image or PDF. Like DocViewer, this exists
// so receipts never need window.open()/a new tab. The signed URL is rendered inline:
// PDFs in an <iframe>, images in an <img>. Top-level so a parent re-render doesn't
// reload it.

// Business settings. At MODULE scope, not inside BookkeeperApp: a component
// declared inside App is a new function type on every App render, so React
// unmounts and remounts it and every useState resets — silently emptying the
// ABN, bank details, email templates and signature while they are being typed.
// ChangePasswordForm above is the same pattern and the precedent for this.
//
// panel() below stays a plain function returning JSX. Promoting it to a
// component would reintroduce the very bug this hoist removes, one level down:
// its inputs would remount on every keystroke.

function BusinessSettings({ s, accent, biz, session, profile, saveProfile, setModal, emailConn, connectOutlook, disconnectOutlook, quoteTemplates, renameQuoteTemplate, deleteQuoteTemplate }) {
  const [f, setF] = useState(() => ({
    ...profile,
    email_template_invoice: profile.email_template_invoice || DEFAULT_EMAIL_TEMPLATE_INVOICE,
    email_template_quote: profile.email_template_quote || DEFAULT_EMAIL_TEMPLATE_QUOTE,
  }));
  const [logoPreview, setLogoPreview] = useState(null);
  const fileRef = useRef(null);
  const [reminderRunning, setReminderRunning] = useState(false);
  const [reminderResult, setReminderResult] = useState(null);
  const SHOW_MANUAL_REMINDER_CONTROLS = false; // manual Preview/Send Now buttons hidden; daily auto-reminders unaffected

  const runReminderJob = async (dryRun) => {
    if (!dryRun && !window.confirm("Send overdue payment reminders now? Emails will go out to clients whose invoices are 1, 7, 14 or 30 days overdue.")) return;
    setReminderRunning(true);
    setReminderResult(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const resp = await fetch(`${API_BASE}/.netlify/functions/send-reminders?dryRun=${dryRun ? 1 : 0}&business_id=${encodeURIComponent(biz)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const raw = await resp.text();
      let data;
      try { data = JSON.parse(raw); } catch { data = null; }
      if (!resp.ok || !data) throw new Error((data && data.error) || raw.slice(0, 200) || `Request failed (${resp.status})`);
      setReminderResult(data);
    } catch (err) {
      setReminderResult({ error: err.message });
    } finally {
      setReminderRunning(false);
    }
  };

  useEffect(() => {
    if (!f.logo_url) { setLogoPreview(null); return; }
    const match = f.logo_url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (match) {
      const [, bucket, path] = match;
      supabase.storage.from(bucket).createSignedUrl(path, 3600).then(({ data }) => { if (data?.signedUrl) setLogoPreview(data.signedUrl); });
    } else {
      setLogoPreview(f.logo_url);
    }
  }, [f.logo_url]);

  const handleLogo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const filePath = `${session.user.id}/${biz}_logo_${Date.now()}.${file.name.split(".").pop()}`;
    const { error } = await supabase.storage.from("receipts").upload(filePath, file, { contentType: file.type, upsert: true });
    if (!error) {
      const { data } = supabase.storage.from("receipts").getPublicUrl(filePath);
      // Functional update, not { ...f }: the upload above is awaited, so `f` in
      // this closure is the state as it was when the file was picked. Spreading
      // it would silently revert anything typed while the upload was in flight.
      if (data?.publicUrl) setF((prev) => ({ ...prev, logo_url: data.publicUrl }));
    }
  };

  // Collapsible settings sections — collapsed by default so the modal stays
  // uncluttered; tap a header to expand it. (Defined as a render helper, not a
  // nested component, so inputs keep focus while typing.)
  const [openSections, setOpenSections] = useState({});
  const toggleSection = (id) => setOpenSections((o) => ({ ...o, [id]: !o[id] }));
  const panel = (id, title, subtitle, content) => (
    <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 8 }}>
      <button type="button" onClick={() => toggleSection(id)} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "none", border: "none", cursor: "pointer", padding: "16px 0 12px", textAlign: "left" }}>
        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ ...s.label, margin: 0 }}>{title}</span>
          {subtitle && <span style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>{subtitle}</span>}
        </span>
        <span style={{ color: "#94a3b8", flexShrink: 0, display: "inline-flex", transform: openSections[id] ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}><Icons.ChevronRight /></span>
      </button>
      {openSections[id] && <div style={{ paddingBottom: 12 }}>{content}</div>}
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Business Settings</h3>
        <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label style={s.label}>Logo</label>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {logoPreview ? <img src={logoPreview} alt="Logo" style={{ height: 48, borderRadius: 6, border: "1px solid #e2e8f0" }} /> : <div style={{ width: 48, height: 48, background: "#f7f9f8", borderRadius: 6, border: "1px dashed #e2e8f0" }} />}
          <input ref={fileRef} type="file" accept="image/*" onChange={handleLogo} style={{ display: "none" }} />
          <button onClick={() => fileRef.current?.click()} style={s.btnOutline}>Upload Logo</button>
          {f.logo_url && <button onClick={() => setF({ ...f, logo_url: "" })} style={{ ...s.btnOutline, color: "#ef4444", borderColor: "#ef444440" }}>Remove</button>}
        </div>
      </div>
      <div style={s.grid2}>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Business Name</label><input value={f.name || ""} onChange={(e) => setF({ ...f, name: e.target.value })} style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>ABN</label><input value={f.abn || ""} onChange={(e) => setF({ ...f, abn: e.target.value })} placeholder="12 345 678 901" style={s.input} /></div>
      </div>
      <div style={{ marginBottom: 12 }}><label style={s.label}>Address</label><input value={f.address || ""} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="123 George St, Sydney NSW 2000" style={s.input} /></div>
      <div style={s.grid2}>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Email</label><input type="email" value={f.email || ""} onChange={(e) => setF({ ...f, email: e.target.value })} style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Phone</label><input value={f.phone || ""} onChange={(e) => setF({ ...f, phone: e.target.value })} style={s.input} /></div>
      </div>
      {panel("bank", "Bank Details (shown on invoices)", "Tap to view or edit your bank account", (
        <>
          <div style={s.grid2}>
            <div style={{ marginBottom: 12 }}><label style={s.label}>Bank Name</label><input value={f.bank_name || ""} onChange={(e) => setF({ ...f, bank_name: e.target.value })} placeholder="Commonwealth Bank" style={s.input} /></div>
            <div style={{ marginBottom: 12 }}><label style={s.label}>Account Name</label><input value={f.account_name || ""} onChange={(e) => setF({ ...f, account_name: e.target.value })} placeholder="MT Management Pty Ltd" style={s.input} /></div>
          </div>
          <div style={s.grid2}>
            <div style={{ marginBottom: 12 }}><label style={s.label}>BSB</label><input value={f.bsb || ""} onChange={(e) => setF({ ...f, bsb: e.target.value })} placeholder="062-000" style={s.input} /></div>
            <div style={{ marginBottom: 12 }}><label style={s.label}>Account Number</label><input value={f.account_number || ""} onChange={(e) => setF({ ...f, account_number: e.target.value })} placeholder="1234 5678" style={s.input} /></div>
          </div>
        </>
      ))}
      {panel("saving", "Saving Locations", "Where receipts & project folders are saved in OneDrive", (
        <>
          <div style={{ marginBottom: 12 }}>
            <label style={s.label}>Projects folder</label>
            <input value={f.onedrive_folder || ""} onChange={(e) => setF({ ...f, onedrive_folder: e.target.value })} placeholder="Mworx Group/Projects" style={s.input} />
            <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.5, marginTop: 6 }}>Base OneDrive folder for job/project subfolders. New projects get their own "26106 - Address" subfolder here, and invoice PDFs save into the matching one.</div>
          </div>
          <div style={{ marginTop: 14, padding: "10px 12px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 11, color: "#64748b", lineHeight: 1.6 }}>
            <div style={{ fontWeight: 600, color: "#475569", marginBottom: 4 }}>How to change these</div>
            Type any OneDrive folder path — use <strong>/</strong> for subfolders (e.g. <code style={{ background: "#eef2f6", padding: "1px 4px", borderRadius: 3 }}>Mworx Group/Projects</code>) — then hit <strong>Save Settings</strong>. Folders that don&apos;t exist yet are created automatically. Changing a path doesn&apos;t move files you&apos;ve already saved — only new ones go to the new location.
          </div>
        </>
      ))}
      {panel("email_conn", "Email Integration", emailConn ? `Outlook connected${emailConn.email ? " · " + emailConn.email : ""}` : "Not connected — tap to connect Outlook", (
        emailConn ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#ecfdf5", borderRadius: 8, border: "1px solid #a7f3d0" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#34d399", flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>Outlook Connected</div>
              <div style={{ fontSize: 11, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{emailConn.email || "Connected"}</div>
            </div>
            <button onClick={disconnectOutlook} style={{ ...s.btnOutline, color: "#ef4444", borderColor: "#ef444440", fontSize: 10 }}>Disconnect</button>
          </div>
        ) : (
          <button onClick={connectOutlook} style={{ ...s.btn("#0078d4"), width: "100%", justifyContent: "center" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M24 7.387v10.478c0 .23-.08.424-.238.576-.16.154-.353.23-.578.23h-8.26V6.58h8.26c.225 0 .418.077.578.23.159.154.238.347.238.577zM13.73 3.088v18.47L0 18.583V6.07l13.73-2.982z"/></svg>
            Connect Outlook
          </button>
        )
      ))}
      {panel("email_tpl", "Email Templates", "Customise invoice & quote email wording", (
        <>
        <div style={{ fontSize: 10, color: "#64748b", marginBottom: 10, lineHeight: 1.8 }}>
          Variables: {["{first_name}", "{last_name}", "{contact_name}", "{number}", "{amount}", "{due_date}", "{due_date_line}", "{payment_details}", "{business_name}", "{signature}"].map((v) => (
            <code key={v} style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b", marginRight: 4, whiteSpace: "nowrap" }}>{v}</code>
          ))}
          <div style={{ marginTop: 4, color: "#94a3b8" }}><code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3 }}>{"{first_name}"}</code> = Cameron · <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3 }}>{"{contact_name}"}</code> = Cameron Mawson (full name)</div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={s.label}>Invoice Email</label>
          <textarea value={f.email_template_invoice || ""} onChange={(e) => setF({ ...f, email_template_invoice: e.target.value })} placeholder={DEFAULT_EMAIL_TEMPLATE_INVOICE} rows={8} style={{ ...s.input, fontFamily: "monospace", fontSize: 11, resize: "vertical", minHeight: 120 }} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={s.label}>Quote Email</label>
          <textarea value={f.email_template_quote || ""} onChange={(e) => setF({ ...f, email_template_quote: e.target.value })} placeholder={DEFAULT_EMAIL_TEMPLATE_QUOTE} rows={8} style={{ ...s.input, fontFamily: "monospace", fontSize: 11, resize: "vertical", minHeight: 120 }} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={s.label}>Signature (HTML allowed)</label>
          <textarea value={f.email_signature || ""} onChange={(e) => setF({ ...f, email_signature: e.target.value })} placeholder={`${f.name || "Your name"}\n${f.email || "your@email.com"} · ${f.phone || "+61 ..."}`} rows={5} style={{ ...s.input, fontFamily: "monospace", fontSize: 11, resize: "vertical", minHeight: 80 }} />
        </div>
        </>
      ))}
      {panel("quote_tpl", "Quote Templates", "Reusable quote content — rename or delete", (
        <>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
          Templates are created from the quote editor — open any quote and hit “Save as Template”. New quotes offer them under “Start from template”.
        </div>
        {quoteTemplates.length === 0 ? (
          <div style={{ fontSize: 12, color: "#94a3b8", padding: "4px 0 8px" }}>No templates yet.</div>
        ) : quoteTemplates.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: "#f8fafc", border: "1px solid #eef2f6", borderRadius: 6, marginBottom: 5 }}>
            <span style={{ fontWeight: 600, fontSize: 12, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
            <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>{t.pricing_mode === "lump_sum" ? `Lump sum${t.lump_amount ? ` · ${fmt(Number(t.lump_amount))}` : ""}` : "Itemised"}</span>
            <button onClick={() => renameQuoteTemplate(t)} title="Rename" style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 2 }}><Icons.Edit /></button>
            <button onClick={() => deleteQuoteTemplate(t)} title="Delete" style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: 2 }}><Icons.Trash /></button>
          </div>
        ))}
        </>
      ))}
      {panel("reminders", "Payment Reminders", "Automatic overdue email reminders", (
        <>
        <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
          Overdue reminders send automatically each day at 1, 7, 14 and 30 days overdue, emailed from noreply@mworxgroup.com.au. Each reminder is only ever sent once — nothing for you to do.
        </div>
        {/* Manual Preview / Send Now controls hidden per preference; the daily
            automatic reminders still run. Flip to true to bring them back. */}
        {SHOW_MANUAL_REMINDER_CONTROLS && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => runReminderJob(true)} disabled={reminderRunning} style={{ ...s.btnOutline, opacity: reminderRunning ? 0.5 : 1 }}>{reminderRunning ? "Running…" : "Preview (dry run)"}</button>
          <button onClick={() => runReminderJob(false)} disabled={reminderRunning} style={{ ...s.btn("#f59e0b"), opacity: reminderRunning ? 0.5 : 1 }}>{reminderRunning ? "Running…" : "Send Reminders Now"}</button>
        </div>
        )}
        {reminderResult && (
          <div style={{ marginTop: 10, padding: 12, background: reminderResult.error ? "#fef2f2" : "#f8fafc", border: `1px solid ${reminderResult.error ? "#fecaca" : "#e2e8f0"}`, borderRadius: 8, fontSize: 12, color: "#334155" }}>
            {reminderResult.error ? (
              <div style={{ color: "#991b1b" }}>Error: {reminderResult.error}</div>
            ) : reminderResult.dryRun ? (() => {
              const LABELS = { will_send: "Will send", failed_retryable: "Failed before — will retry", already_sent: "Already sent", in_progress: "Send in progress", no_email_sender: "No email sender configured", skipped_not_due: "Not due yet" };
              const COLORS = { will_send: "#065f46", failed_retryable: "#92400e", already_sent: "#64748b", in_progress: "#64748b", no_email_sender: "#991b1b", skipped_not_due: "#64748b" };
              const willSend = reminderResult.preview.filter(p => p.status === "will_send" || p.status === "failed_retryable").length;
              return (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Preview — {willSend} reminder{willSend === 1 ? "" : "s"} would be sent now:</div>
                  {reminderResult.preview.length === 0 ? <div style={{ color: "#64748b" }}>No overdue invoices found for this business.</div> : reminderResult.preview.map((p, i) => (
                    <div key={i} style={{ color: COLORS[p.status] || "#64748b" }}>• {p.invoice} → {p.to} ({p.daysOverdue}d overdue) — <strong>{LABELS[p.status] || p.status}</strong>{p.sendableVia ? ` · ${p.sendableVia}` : ""}</div>
                  ))}
                </div>
              );
            })() : (
              <div style={{ fontWeight: 600 }}>Sent {reminderResult.sent} · skipped {reminderResult.skipped} · failed {reminderResult.failed}</div>
            )}
          </div>
        )}
        </>
      ))}
      {panel("stripe", "Card Payments", "Let customers pay invoices by card", (
        <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.6 }}>
          When <code>STRIPE_SECRET_KEY</code> is set in Netlify, every invoice gets a secure <strong>Pay by card</strong> button in its PDF and in overdue reminder emails, plus a <strong>Copy pay link</strong> action in each invoice's menu (⋯). Paid invoices are marked <strong>paid</strong> automatically once Stripe confirms — no manual step. A card surcharge (default 1.7%, configurable via <code>STRIPE_SURCHARGE_PCT</code>) is added at checkout so the processing fee is passed to the customer. Cards plus Apple&nbsp;Pay / Google&nbsp;Pay are offered.
        </div>
      ))}
      {panel("security", "Security", `Change the sign-in password for ${session?.user?.email || "your account"}`, (
        <ChangePasswordForm s={s} accent={accent} />
      ))}
      <button onClick={() => saveProfile(f)} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", marginTop: 4 }}>Save Settings</button>
    </div>
  );
}

// Contact form. Module scope for the same reason as BusinessSettings: nested in
// App it was a fresh function type every render, so React remounted it and the
// half-typed contact vanished. Thirty lines, no effects, no refs — it never
// mutated App state itself, it was only ever a bystander to someone else's render.

function ContactForm({ existing, s, accent, setModal, setEditItem, addContact, updateContact, deleteContact }) {
  const [f, setF] = useState(existing || { name: "", email: "", phone: "", type: "client", company: "", abn: "", address: "", notes: "" });
  const [saving, setSaving] = useState(false);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{existing ? "Edit" : "New"} Contact</h3>
        <button onClick={() => { setModal(null); setEditItem(null); }} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
      </div>
      <div style={s.grid2}>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Type</label><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} style={s.select}><option value="client">Client</option><option value="consultant">Consultant</option><option value="supplier">Supplier</option></select></div>
      </div>
      <div style={s.grid2}>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Company</label><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Address</label><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} style={s.input} /></div>
      </div>
      <div style={s.grid2}>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Email</label><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Phone</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} style={s.input} /></div>
      </div>
      <div style={s.grid2}>
        <div style={{ marginBottom: 12 }}><label style={s.label}>ABN</label><input value={f.abn} onChange={(e) => setF({ ...f, abn: e.target.value })} style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Notes</label><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} style={s.input} /></div>
      </div>
      <button disabled={(!f.name && !f.company) || saving} onClick={async () => { setSaving(true); existing ? await updateContact(existing.id, f) : await addContact(f); setSaving(false); }} style={{ ...s.btn(accent), opacity: (!f.name && !f.company) || saving ? 0.4 : 1, width: "100%", justifyContent: "center" }}>{saving ? "Saving…" : existing ? "Save Changes" : "Add Contact"}</button>
      {existing && (
        <button onClick={() => deleteContact(existing.id)} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", marginTop: 8, color: "#ef4444", borderColor: "#ef444440", gap: 6 }}>
          <Icons.Trash /> Delete Contact
        </button>
      )}
    </div>
  );
}

export default function BookkeeperApp() {
  const [session, setSession] = useState(undefined);
  const [recovery, setRecovery] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [editItem, setEditItem] = useState(null);
  const [invoiceSeed, setInvoiceSeed] = useState(null);
  // Tracked as a ref (not state) on purpose: forms are defined inline inside this
  // component, so a parent re-render remounts them and wipes their local state.
  const formDirtyRef = useRef(false);
  // The modal forms are components declared inside App, so their function
  // identity changes on every App render and React remounts them — resetting
  // every useState inside. Any handler that mutates App state while the modal
  // stays open (the inline "quick add contact/project" flows, saving a quote
  // template) therefore wipes whatever the user had typed. These refs keep the
  // in-progress draft alive across that remount. Each is keyed to the document
  // being edited so a draft can never bleed into a different one.
  const projectDraftRef = useRef(null);
  const invoiceDraftRef = useRef(null);
  // A draft belongs only to the modal that owns it. Jumping straight from one
  // modal to another (a project's "+ New Quote", say) never passes through
  // requestCloseModal, so without this an abandoned draft would be resurrected —
  // and could be re-saved — the next time that document was opened. Keyed on
  // `modal` alone, so a mid-edit remount (which leaves `modal` untouched) is
  // unaffected and still restores.
  useEffect(() => {
    if (modal !== "project") projectDraftRef.current = null;
    if (modal !== "invoice") invoiceDraftRef.current = null;
  }, [modal]);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem("bk_navCollapsed") === "1");
  const toggleNav = () => setNavCollapsed((v) => { const nv = !v; localStorage.setItem("bk_navCollapsed", nv ? "1" : "0"); return nv; });

  const [biz] = useState(() => localStorage.getItem("bk_activeBusiness") || COMPANY.id);
  const [division, setDivision] = useState(() => {
    const saved = localStorage.getItem("bk_activeDivision");
    if (saved === "mtmgmt") return "mt_management";
    return isValidDivision(saved) ? saved : "mworx";
  });
  const switchDivision = (id) => {
    const norm = id === "mtmgmt" ? "mt_management" : id;
    if (!isValidDivision(norm) || norm === division) return;
    localStorage.setItem("bk_activeDivision", norm);
    if (norm !== ALL_DIVISIONS) localStorage.setItem("bk_lastSpecificDivision", norm);
    setDivision(norm);
  };
  const [contacts, setContacts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  // Live mirror of `invoices` for async handlers that must read the latest rows
  // rather than a render-time closure (deposit dedup + doc numbering under rapid
  // clicks). Kept in sync by an effect; the deposit path also prepends to it
  // synchronously so a second click sees the just-created row immediately.
  const invoicesRef = useRef([]);
  useEffect(() => { invoicesRef.current = invoices; }, [invoices]);
  // In-flight guards keyed by id — prevent a double-click from creating two
  // deposits for one quote, or firing two concurrent sends of one invoice.
  const depositHandledRef = useRef(new Set());
  const sendInFlightRef = useRef(new Set());
  // DocList view state (filter/search/sort) lives here, not inside DocList,
  // because pageMap rebuilds every render so <PageComponent/> is a fresh type →
  // the page remounts on any action and local state would snap back to defaults
  // (that was the "Draft tab jumps back to Outstanding" bug).
  const [docView, setDocView] = useState({
    // "all", not "outstanding": with every invoice paid the page opened on
    // "No invoices found", which reads as broken rather than as an empty filter.
    // Outstanding is still one tap away.
    invoice: { filter: "all", jobFilter: "", search: "", sortKey: "due_date", sortDir: "desc" },
    quote: { filter: "all", jobFilter: "", search: "", sortKey: "due_date", sortDir: "desc" },
  });
  const [jobs, setJobs] = useState([]);
  const [jobParties, setJobParties] = useState([]); // bk_job_parties rows for this business's projects
  const [quoteTemplates, setQuoteTemplates] = useState([]);
  const [profile, setProfile] = useState({ ...DEFAULT_PROFILE });
  const [emailConn, setEmailConn] = useState(null);

  const [divMenuOpen, setDivMenuOpen] = useState(false);

  // Global financial-year filter. Same shape as `division` above: the value is
  // written to localStorage inside the setter, not from an effect — an effect
  // keyed on a derived array would re-fire on every render and loop.
  const [fy, setFy] = useState(() => {
    try { return localStorage.getItem("bk_activeFY") || currentFY(); } catch { return currentFY(); }
  });
  const switchFY = (id) => {
    if (id === fy) return;
    try { localStorage.setItem("bk_activeFY", id); } catch { /* storage blocked */ }
    // A job whose documents all sit outside the new FY loses its <option>, and a
    // stale jobFilter would then filter the list to nothing with no visible cause.
    setDocView((prev) => ({ invoice: { ...prev.invoice, jobFilter: "" }, quote: { ...prev.quote, jobFilter: "" } }));
    setFy(id);
  };
  // After saving a document, follow it: a doc dated outside the selected FY would
  // otherwise vanish on save and look like the save failed.
  const followDocFY = (dateStr) => { const f = fyOfDate(dateStr); if (f && fy !== ALL_FY && f !== fy) switchFY(f); };

  const divInfo = divisionInfo(division);
  const accent = divInfo.accent;
  const insertDivision = division === ALL_DIVISIONS ? (localStorage.getItem("bk_lastSpecificDivision") || "mworx") : division;
  const inActiveDiv = (r) => division === ALL_DIVISIONS || recordDivision(r) === division;
  const divInvoices = invoices.filter(inActiveDiv);
  const divJobs = jobs.filter(inActiveDiv);
  // FY-scoped views for display only. divInvoices/divJobs above stay lifetime and
  // are what document numbering, the form seeds, the job/contact pickers and every
  // project money total must keep reading — hand getNextDocumentNumber an
  // FY-filtered array and it reissues numbers that already exist.
  const fyInvoices = divInvoices.filter((r) => inFY(r, fy));
  // A project is in the FY if it is still open, or if it has a document dated in
  // it. Never by created_at: projects span years.
  const fyJobs = divJobs.filter((p) => ["active", "lead"].includes(p.status || "active") || fyInvoices.some((d) => d.project_id === p.id));
  // Caption for anything scoped to the selected FY, so a figure never sits on
  // screen without saying what period it covers.
  const fyTag = fy === ALL_FY ? "all time" : fyLabel(fy);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    // Supabase emits SIGNED_IN / TOKEN_REFRESHED when the tab regains focus or the
    // token auto-refreshes. Replacing the session object on those events re-runs
    // loadData and makes the whole page "refresh". Only update when the signed-in
    // user actually changes (real sign-in/out), so focus/refresh is a no-op.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      // A reset-email link signs the user in with a recovery session; show the
      // set-new-password screen instead of the app until they choose one.
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession((prev) => (prev && newSession && prev.user?.id === newSession.user?.id ? prev : newSession));
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Close any modal, but if a form reported unsaved changes (formDirty), confirm first.
  // A secondary action that switches to a DIFFERENT modal abandons the open
  // form: the [modal] effect above clears that form's draft ref as soon as
  // `modal` changes. Closing asks first; switching away was doing it silently.
  // Same confirmation, same formDirtyRef — just at the other exit.
  const confirmLeaveDirtyForm = (what) =>
    !formDirtyRef.current || window.confirm(`Are you sure? Any unsaved changes to this ${what} will be lost.`);

  const requestCloseModal = (alwaysConfirm = false) => {
    if ((alwaysConfirm || formDirtyRef.current) && !window.confirm("Are you sure you want to close? Any unsaved changes will be lost.")) return;
    formDirtyRef.current = false;
    projectDraftRef.current = null;
    invoiceDraftRef.current = null;
    setModal(null);
    setEditItem(null);
    setInvoiceSeed(null);
  };

  const loadData = useCallback(async (businessId) => {
    if (!session) return;
    setLoading(true);
    try {
    const [cRes, iRes, pRes, jRes, eRes, qtRes] = await Promise.all([
      supabase.from("bk_contacts").select("*").eq("business_id", businessId).order("name"),
      supabase.from("bk_invoices").select("*").eq("business_id", businessId).order("date", { ascending: false }),
      supabase.from("bk_profiles").select("*").eq("business_id", businessId).maybeSingle(),
      supabase.from("bk_jobs").select("*").eq("business_id", businessId).order("last_used_at", { ascending: false }),
      supabase.from("bk_email_connections").select("*").eq("business_id", businessId).eq("provider", "outlook").maybeSingle(),
      supabase.from("bk_quote_templates").select("*").eq("business_id", businessId).order("name"),
    ]);

    const loadedInvoices = iRes.data || [];
    if (loadedInvoices.length) {
      const ids = loadedInvoices.map((i) => i.id);
      const { data: items } = await supabase.from("bk_invoice_items").select("*").in("invoice_id", ids).order("sort_order");
      const itemMap = {};
      for (const item of items || []) {
        (itemMap[item.invoice_id] ||= []).push(item);
      }
      for (const inv of loadedInvoices) {
        inv.items = itemMap[inv.id] || [];
      }
    }

    // Parties are keyed by job (no business_id column) — fetch for the loaded jobs.
    const loadedJobs = jRes.data || [];
    let loadedParties = [];
    if (loadedJobs.length) {
      const { data: parties } = await supabase.from("bk_job_parties").select("*").in("job_id", loadedJobs.map((j) => j.id));
      loadedParties = parties || [];
    }

    setContacts(cRes.data || []);
    setInvoices(loadedInvoices);
    setJobs(loadedJobs);
    setJobParties(loadedParties);
    setQuoteTemplates(qtRes.data || []);
    setProfile(pRes.data || { ...DEFAULT_PROFILE, business_id: businessId, name: "Mworx Group", onedrive_folder: "Mworx Group" });
    setEmailConn(eRes.data || null);
    setLoading(false);

    // Mark overdue invoices server-side. Scope to type "invoice" only — quotes share
    // this table with status "sent" and a 30-day "valid until" due_date, so without
    // this filter every quote flips to "overdue" (a status absent from the quote tabs)
    // 30 days after it's sent and disappears from the UI.
    await supabase.from("bk_invoices")
      .update({ status: "overdue" })
      .eq("business_id", businessId)
      .eq("type", "invoice")
      .eq("status", "sent")
      .lt("due_date", today());
    // Refresh invoices if any were updated
    const { data: freshInv } = await supabase.from("bk_invoices").select("*").eq("business_id", businessId).order("date", { ascending: false });
    if (freshInv) {
      for (const inv of freshInv) {
        const existing = loadedInvoices.find((i) => i.id === inv.id);
        inv.items = existing?.items || [];
      }
      setInvoices(freshInv);
    }
    } catch (err) {
      console.error("Failed to load data:", err);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (session) loadData(biz);
  }, [session, biz, loadData]);

  const logout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setContacts([]);
    setInvoices([]);
    setJobs([]);
    setProfile({ ...DEFAULT_PROFILE });
    setEmailConn(null);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outlookStatus = params.get("outlook");
    if (outlookStatus === "connected") {
      const connectedEmail = params.get("email") || "";
      setEmailConn((prev) => prev ? { ...prev, email: connectedEmail } : { email: connectedEmail, provider: "outlook" });
      window.history.replaceState({}, "", window.location.pathname);
    } else if (outlookStatus === "error") {
      console.error("Outlook connection error:", params.get("reason"));
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const jobNames = [...new Set(fyInvoices.map((i) => i.job).filter(Boolean))].sort();

  // --- Mutation functions: each writes directly to its table ---

  // Centralized write helper. supabase-js NEVER throws on a query error — it
  // resolves to { data, error } — so a mutation whose `error` is left unchecked
  // looks like a success even when the row was rejected (RLS, constraint, network)
  // and the user's record silently vanishes. Route inserts/updates/deletes through
  // this: it surfaces the failure to the user and returns { ok } so callers can
  // bail before closing the modal or optimistically mutating local state.
  // `friendly` maps a Postgres error code to a plain-English message shown instead
  // of the raw driver text (e.g. "23505" -> "that number is already used"). The raw
  // error still goes to the console.
  const sbWrite = async (query, action = "save", friendly = null) => {
    const { data, error } = await query;
    if (error) {
      console.error(`Supabase ${action} failed:`, error);
      alert(friendly?.[error.code] || `Failed to ${action}: ${error.message || "unknown error"}`);
      return { ok: false, data: null, error };
    }
    return { ok: true, data, error: null };
  };

  // Insert with division when the column exists (migration 0007). Existing Mworx
  // Supabase rows keep working before migration: division is omitted and treated
  // as mworx. MT Management saves require the migration first.
  const sbInsert = async (table, row, action, multi = false, friendly = null) => {
    let query = supabase.from(table).insert(row);
    query = multi ? query.select() : query.select().single();
    let res = await sbWrite(query, action, friendly);
    // The retry below is keyed on the *message* text, so any other error whose
    // message happens to contain "division" would be misread as a missing column
    // and silently re-inserted. A unique-violation (23505) naming an index on the
    // division column is exactly that case, so exclude it explicitly.
    if (!res.ok && res.error?.code !== "23505" && res.error?.message?.match(/division/i) && "division" in row) {
      if (row.division !== "mworx") {
        alert("To save MT Management records, apply supabase/migrations/0007_divisions.sql in Supabase first.");
        return res;
      }
      const { division: _d, ...noDiv } = row;
      query = supabase.from(table).insert(noDiv);
      query = multi ? query.select() : query.select().single();
      res = await sbWrite(query, action, friendly);
    }
    return res;
  };











  const addContact = async (c, keepModal) => {
    const row = { user_id: session.user.id, business_id: biz, name: c.name, email: c.email, phone: c.phone, type: c.type, company: c.company, abn: c.abn, address: c.address, notes: c.notes };
    const { ok, data: inserted } = await sbWrite(supabase.from("bk_contacts").insert(row).select().single(), "save contact");
    if (!ok) return null;
    if (inserted) setContacts((prev) => [...prev, inserted].sort((a, b) => (a.name || "").localeCompare(b.name || "")));
    if (!keepModal) setModal(null);
    return inserted;
  };

  const updateContact = async (id, c) => {
    const row = { name: c.name, email: c.email, phone: c.phone, type: c.type, company: c.company, abn: c.abn, address: c.address, notes: c.notes };
    const { ok, data: updated } = await sbWrite(supabase.from("bk_contacts").update(row).eq("id", id).select().single(), "update contact");
    if (!ok) return;
    if (updated) setContacts((prev) => prev.map((x) => (x.id === id ? updated : x)).sort((a, b) => (a.name || "").localeCompare(b.name || "")));
    setModal(null);
    setEditItem(null);
  };

  const deleteContact = async (id) => {
    if (!window.confirm("Delete this contact? Linked quotes and invoices will be kept but unlinked. This cannot be undone.")) return;
    const { ok } = await sbWrite(supabase.from("bk_contacts").delete().eq("id", id), "delete contact");
    if (!ok) return;
    setContacts((prev) => prev.filter((c) => c.id !== id));
    // bk_invoices.contact_id is ON DELETE SET NULL, so the DB has already cleared
    // the link on this contact's documents. Mirror that locally — otherwise the
    // in-memory rows keep a dangling id that a later save would write back.
    setInvoices((prev) => prev.map((i) => (i.contact_id === id ? { ...i, contact_id: null } : i)));
    setModal(null);
    setEditItem(null);
  };

  // Resolve the saved contact a document belongs to. Invoices/quotes store a
  // contact *snapshot* (name/email/company/…) and that snapshot stays the record;
  // contact_id is the stable link the accounting sync needs.
  //
  // The picker writes `c.name || c.company`, so that is the primary key. The two
  // fallbacks recover historical rows written before the picker existed: one stored
  // a company name ("Enspect Pty Ltd" — the contact's key is "Nick Papouttsakis"),
  // another a shortened first name. Each step must match exactly one contact, since
  // bk_contacts has no uniqueness on name. Returns null when nothing matches —
  // contact_id stays nullable and the snapshot is unaffected.
  const contactIdFor = (name, email) => {
    const n = (name || "").trim().toLowerCase();
    const e = (email || "").trim().toLowerCase();
    const only = (pred) => { const hits = contacts.filter(pred); return hits.length === 1 ? hits[0].id : null; };
    const norm = (v) => (v || "").trim().toLowerCase();
    if (n) {
      const byKey = only((c) => norm(c.name || c.company) === n);
      if (byKey) return byKey;
      const byCompany = only((c) => norm(c.company) === n);
      if (byCompany) return byCompany;
    }
    if (e) return only((c) => norm(c.email) === e);
    return null;
  };

  // A blank number is legal (an unnumbered draft) but must be stored as NULL, not
  // "": the unique index skips NULLs, so two blank drafts would otherwise collide.
  const normNumber = (v) => (v || "").trim() || null;

  // The only constraint a user can trip by hand — the Number field is free text.
  const DUP_NUMBER = (n) => ({ "23505": `Document number ${(n || "").trim() || "(blank)"} is already used in this division. Change the number and save again.` });

  const addInvoice = async (inv) => {
    const items = inv.items || [];
    const row = { user_id: session.user.id, business_id: biz, number: normNumber(inv.number), type: inv.type, division: insertDivision, date: inv.date || null, due_date: inv.due_date || null, contact_id: contactIdFor(inv.contact_name, inv.contact_email), contact_name: inv.contact_name, contact_email: inv.contact_email, contact_company: inv.contact_company, contact_abn: inv.contact_abn, contact_address: inv.contact_address, contact_phone: inv.contact_phone, job: inv.job, project_id: inv.project_id || null, notes: inv.notes, terms: inv.terms || null, status: inv.status, total: inv.total, pricing_mode: inv.pricing_mode || "itemised" };
    const { ok, data: inserted } = await sbInsert("bk_invoices", row, "save invoice", false, DUP_NUMBER(inv.number));
    if (!ok) return;
    if (inserted) {
      if (items.length) {
        const itemRows = items.map((it, idx) => ({ invoice_id: inserted.id, description: it.description, note: it.note, qty: Number(it.qty) || 1, rate: Number(it.rate) || 0, sort_order: idx }));
        const itemsRes = await sbWrite(supabase.from("bk_invoice_items").insert(itemRows).select(), "save invoice items");
        if (!itemsRes.ok) return;
        inserted.items = itemsRes.data || [];
      } else {
        inserted.items = [];
      }
      setInvoices((prev) => [inserted, ...prev]);
    }
    if (inserted && emailConn) saveToOneDrive("invoice", inserted.id, { silent: true });
    formDirtyRef.current = false;
    invoiceDraftRef.current = null;
    setModal(null);
    setEditItem(null);
    setInvoiceSeed(null);
    return inserted;
  };

  const updateInvoice = async (id, updates) => {
    const ALLOWED_INVOICE_COLS = ["number", "type", "date", "due_date", "contact_name", "contact_email", "contact_company", "contact_abn", "contact_address", "contact_phone", "job", "project_id", "notes", "terms", "status", "total", "paid_date", "pricing_mode"];
    const dbUpdates = {};
    for (const k of ALLOWED_INVOICE_COLS) if (k in updates) dbUpdates[k] = updates[k];
    if ("date" in dbUpdates) dbUpdates.date = dbUpdates.date || null;
    if ("due_date" in dbUpdates) dbUpdates.due_date = dbUpdates.due_date || null;
    if ("paid_date" in dbUpdates) dbUpdates.paid_date = dbUpdates.paid_date || null;
    // project_id is a uuid column; the form sends "" for "No project". Postgres
    // rejects "" as a uuid, so coalesce to null (matches addInvoice).
    if ("project_id" in dbUpdates) dbUpdates.project_id = dbUpdates.project_id || null;
    if ("number" in dbUpdates) dbUpdates.number = normNumber(dbUpdates.number);
    // contact_id is deliberately NOT in the allow-list. The form spreads the whole
    // DB row into its state, so a whitelisted contact_id would carry the value the
    // document was loaded with — and the contact picker rewrites contact_name
    // without touching it, which would save a link contradicting the snapshot.
    // Re-derive it from the name the user actually chose (same rule as
    // updateProject), so the link always agrees with what's printed.
    if ("contact_name" in updates) dbUpdates.contact_id = contactIdFor(updates.contact_name, updates.contact_email);
    const items = updates.items;
    const { ok: updOk } = await sbWrite(supabase.from("bk_invoices").update(dbUpdates).eq("id", id), "save invoice", DUP_NUMBER(dbUpdates.number ?? updates.number));
    if (!updOk) return;
    if (items) {
      // Insert the replacement items FIRST, then delete the rows that aren't part of
      // the new set. The old delete-then-insert lost every line item permanently if
      // the insert failed (no transaction, neither error checked). Insert-first means
      // a failed insert aborts before anything is destroyed.
      const itemRows = items.map((it, idx) => ({ invoice_id: id, description: it.description, note: it.note, qty: Number(it.qty) || 1, rate: Number(it.rate) || 0, sort_order: idx }));
      const insRes = await sbWrite(supabase.from("bk_invoice_items").insert(itemRows).select(), "save invoice items");
      if (!insRes.ok) return;
      const newItems = insRes.data || [];
      const newIds = newItems.map((it) => it.id);
      const delQuery = newIds.length
        ? supabase.from("bk_invoice_items").delete().eq("invoice_id", id).not("id", "in", `(${newIds.join(",")})`)
        : supabase.from("bk_invoice_items").delete().eq("invoice_id", id);
      const delRes = await sbWrite(delQuery, "update invoice items");
      if (!delRes.ok) return;
      setInvoices((prev) => prev.map((i) => (i.id === id ? { ...i, ...dbUpdates, items: newItems } : i)));
    } else {
      setInvoices((prev) => prev.map((i) => (i.id === id ? { ...i, ...dbUpdates } : i)));
    }
    // Keep a DRAFT's pending OneDrive copy in sync after a content edit. Issued
    // docs (sent/overdue/paid) are left alone here so their filed record isn't
    // silently overwritten — they only update on an explicit re-send. If the
    // number/type changed, tell the server the old name so it drops that stale copy.
    const oldRow = invoices.find((i) => i.id === id);
    const finalStatus = "status" in dbUpdates ? dbUpdates.status : oldRow?.status;
    if ("items" in updates && emailConn && finalStatus === "draft") {
      const newName = oneDriveDocName(dbUpdates.type || oldRow?.type, dbUpdates.number ?? oldRow?.number, id);
      const oldName = oldRow ? oneDriveDocName(oldRow.type, oldRow.number, id) : null;
      const prev = oldName && oldName !== newName
        ? { name: oldName, subfolder: (oldRow?.type === "quote" ? "Quotes" : "Invoices") }
        : {};
      regenAndFileOneDrive(id, prev);
    }
    formDirtyRef.current = false;
    invoiceDraftRef.current = null;
    setModal(null);
    setEditItem(null);
    setInvoiceSeed(null);
    return true; // callers (saveAndCompose) gate the compose step on a successful save
  };

  // Once a document has been handed to the accounting system it is a record there,
  // not ours to remove. Rows that predate the myob_sync_status column (or a stale
  // tab) have no value at all, so treat anything falsy as "not synced".
  // A BEFORE DELETE trigger enforces the same rule in the database; this is the
  // readable half, so the user gets an explanation instead of a driver error.
  const myobSynced = (inv) => !!inv?.myob_sync_status && inv.myob_sync_status !== "not_synced";
  const blockedByMyob = (inv) => {
    alert(`${inv.type === "quote" ? "Quote" : "Invoice"} ${inv.number || ""} is recorded in MYOB and can't be deleted here.\n\nReverse or credit it in MYOB first.`);
  };

  const deleteInvoice = async (id) => {
    // Check before the confirm — never ask someone to confirm an action we refuse.
    const existing = invoicesRef.current.find((i) => i.id === id);
    if (myobSynced(existing)) { blockedByMyob(existing); return; }
    if (!window.confirm("Delete this invoice? This cannot be undone.")) return;
    const { ok } = await sbWrite(supabase.from("bk_invoices").delete().eq("id", id), "delete invoice");
    if (!ok) return;
    setInvoices((prev) => prev.filter((i) => i.id !== id));
    setModal(null);
    setEditItem(null);
  };

  // Bulk actions for the invoices list (one DB round-trip, one state update each).
  const bulkMarkInvoicesPaid = async (ids) => {
    const pids = invoices.filter((i) => ids.includes(i.id) && i.type === "invoice" && i.status !== "paid").map((i) => i.id);
    if (!pids.length) return true;
    const { ok } = await sbWrite(supabase.from("bk_invoices").update({ status: "paid", paid_date: today() }).in("id", pids), "mark invoices paid");
    if (!ok) return false;
    const set = new Set(pids);
    setInvoices((prev) => prev.map((i) => set.has(i.id) ? { ...i, status: "paid", paid_date: i.paid_date || today() } : i));
    return true;
  };

  const bulkDeleteInvoices = async (ids) => {
    if (!ids.length) return false;
    // "Select all" can pick up the whole filtered list, so a mixed selection is
    // normal. Delete what we're allowed to and say what was skipped, rather than
    // refusing the lot. Only the allowed ids reach the DB *and* local state, so
    // the list can't show a row as gone while it still exists.
    const selected = invoicesRef.current.filter((i) => ids.includes(i.id));
    const blocked = selected.filter(myobSynced);
    const allowed = ids.filter((id) => !blocked.some((b) => b.id === id));
    if (!allowed.length) {
      alert(`${blocked.length === 1 ? "That invoice is" : `All ${blocked.length} selected invoices are`} recorded in MYOB and can't be deleted here.\n\nReverse or credit ${blocked.length === 1 ? "it" : "them"} in MYOB first.`);
      return false;
    }
    const skipNote = blocked.length ? `\n\n${blocked.length} synced to MYOB will be skipped: ${blocked.map((b) => b.number).filter(Boolean).join(", ")}` : "";
    if (!window.confirm(`Delete ${allowed.length} invoice${allowed.length === 1 ? "" : "s"}? This cannot be undone.${skipNote}`)) return false;
    const { ok } = await sbWrite(supabase.from("bk_invoices").delete().in("id", allowed), "delete invoices");
    if (!ok) return false;
    const set = new Set(allowed);
    setInvoices((prev) => prev.filter((i) => !set.has(i.id)));
    return true;
  };

  const upsertJob = async (jobName, contactName) => {
    const trimmed = (jobName || "").trim();
    if (!trimmed) return;
    const norm = trimmed.toLowerCase();
    const existing = divJobs.find((j) => j.name.trim().toLowerCase() === norm);
    if (existing) {
      const upd = { last_used_at: new Date().toISOString() };
      const contact = contactName ? contacts.find((c) => (c.name || c.company) === contactName) : null;
      if (contact && !existing.contact_id) upd.contact_id = contact.id;
      await supabase.from("bk_jobs").update(upd).eq("id", existing.id);
      setJobs((prev) => prev.map((j) => j.id === existing.id ? { ...j, ...upd } : j));
    } else {
      const contact = contactName ? contacts.find((c) => (c.name || c.company) === contactName) : null;
      const row = { user_id: session.user.id, business_id: biz, division: insertDivision, name: trimmed, contact_id: contact?.id || null, job_number: getNextJobNumber(jobs) };
      const { data: inserted } = await sbInsert("bk_jobs", row, "save job");
      if (inserted) setJobs((prev) => [inserted, ...prev]);
    }
  };

  // --- Projects (stored in bk_jobs) ---

  const createProject = async (p) => {
    const contact = p.contact_name ? contacts.find((c) => (c.name || c.company) === p.contact_name) : null;
    const row = { user_id: session.user.id, business_id: biz, division: insertDivision, name: (p.name || "").trim(), contact_id: contact?.id || null, address: p.address || null, notes: p.notes || null, contract_value: Number(p.contract_value) || 0, status: p.status || "active", application_type: p.application_type || null, job_number: (p.job_number || "").trim() || getNextJobNumber(jobs) };
    const { ok, data: inserted } = await sbInsert("bk_jobs", row, "create project");
    if (!ok) return null;
    if (inserted) {
      setJobs((prev) => [inserted, ...prev]);
      // Attach the clients/consultants picked in the form (bk_job_parties).
      const partyRows = (p.parties || []).map((x) => ({ job_id: inserted.id, contact_id: x.contact_id, role: x.role || "client" }));
      if (partyRows.length) {
        const { data: insParties } = await supabase.from("bk_job_parties").insert(partyRows).select();
        if (insParties) setJobParties((prev) => [...prev, ...insParties]);
      }
      // Create the matching OneDrive folder ("26106 - 10 McPherson Road …").
      // Best-effort: never block project creation on the Microsoft connection.
      if (emailConn) saveToOneDrive("project", inserted.id, { silent: true });
    }
    return inserted;
  };

  // --- Project parties (bk_job_parties) ---

  const addJobParty = async (jobId, contactId, role) => {
    const { ok, data } = await sbWrite(supabase.from("bk_job_parties").insert({ job_id: jobId, contact_id: contactId, role: role || "client" }).select().single(), "add project contact");
    if (ok && data) setJobParties((prev) => [...prev, data]);
    return ok ? data : null;
  };

  const removeJobParty = async (partyId) => {
    const { ok } = await sbWrite(supabase.from("bk_job_parties").delete().eq("id", partyId), "remove project contact");
    if (ok) setJobParties((prev) => prev.filter((p) => p.id !== partyId));
    return ok;
  };

  // --- Quote templates (bk_quote_templates) ---

  const renameQuoteTemplate = async (t) => {
    const name = window.prompt("Template name:", t.name);
    if (!name || !name.trim() || name.trim() === t.name) return;
    const { ok, data } = await sbWrite(supabase.from("bk_quote_templates").update({ name: name.trim(), updated_at: new Date().toISOString() }).eq("id", t.id).select().single(), "rename template");
    if (ok && data) setQuoteTemplates((prev) => prev.map((x) => (x.id === t.id ? data : x)).sort((a, b) => a.name.localeCompare(b.name)));
  };

  const deleteQuoteTemplate = async (t) => {
    if (!window.confirm(`Delete template "${t.name}"? Quotes already created from it are not affected.`)) return;
    const { ok } = await sbWrite(supabase.from("bk_quote_templates").delete().eq("id", t.id), "delete template");
    if (ok) setQuoteTemplates((prev) => prev.filter((x) => x.id !== t.id));
  };

  const updateProject = async (id, p) => {
    const row = {};
    if ("name" in p) row.name = (p.name || "").trim();
    if ("contact_name" in p) { const c = contacts.find((x) => (x.name || x.company) === p.contact_name); row.contact_id = c?.id || null; }
    if ("address" in p) row.address = p.address || null;
    if ("notes" in p) row.notes = p.notes || null;
    if ("contract_value" in p) row.contract_value = Number(p.contract_value) || 0;
    if ("status" in p) row.status = p.status;
    if ("application_type" in p) row.application_type = p.application_type || null;
    // Only overwrite the number when a non-empty value is supplied; never blank it.
    if ("job_number" in p && (p.job_number || "").trim()) row.job_number = p.job_number.trim();
    if ("accepted_quote_id" in p) row.accepted_quote_id = p.accepted_quote_id;
    const { ok, data: updated } = await sbWrite(supabase.from("bk_jobs").update(row).eq("id", id).select().single(), "update project");
    if (!ok) return null;
    if (updated) setJobs((prev) => prev.map((j) => (j.id === id ? updated : j)));
    return updated;
  };

  // Accept a quote: mark it accepted and ensure it's linked to a project (creating
  // one from the quote if needed). The project contract value is computed as the sum
  // of all accepted quotes, so there's nothing to seed here.
  const acceptQuote = async (quote) => {
    let projectId = quote.project_id;
    let project = projectId ? jobs.find((j) => j.id === projectId) : null;
    if (!project) {
      project = await createProject({ name: (quote.job || quote.contact_name || quote.number || "Project").trim(), contact_name: quote.contact_name, address: quote.contact_address });
      projectId = project?.id;
    }
    if (!projectId) return null;
    const invUpd = { status: "accepted", project_id: projectId, job: projectLabel(project) };
    const { ok } = await sbWrite(supabase.from("bk_invoices").update(invUpd).eq("id", quote.id), "accept quote");
    if (!ok) return null;
    setInvoices((prev) => prev.map((i) => (i.id === quote.id ? { ...i, ...invUpd } : i)));
    fileIssuedToOneDrive(quote.id); // accepted quote → move from pending into the project folder
    // A signed-up job is no longer a lead.
    if ((project.status || "active") === "lead") { await updateProject(projectId, { status: "active" }); return { ...project, status: "active" }; }
    return project;
  };

  // --- Deposit invoice on quote acceptance ---

  // Create a draft "stage 1 deposit" invoice for an accepted quote. Quiet insert
  // (no modal side effects). division/number derive from the QUOTE row, not the
  // currently viewed division, so a quote accepted from the "All divisions" view
  // still numbers correctly. converted_from_quote_id links it back to the quote
  // and is the idempotency lock — one deposit per quote, ever.
  const createDepositInvoice = async (quote, project, pct) => {
    const division = recordDivision(quote);
    // Number off the live ref, not the render-time closure, so a deposit created
    // moments after another insert can't reuse a number.
    const number = getNextDocumentNumber(invoicesRef.current.filter((i) => recordDivision(i) === division), division, "invoice");
    const amount = Math.round((Number(quote.total) || 0) * pct) / 100; // pct% of total, exact to the cent
    const description = `Deposit — ${pct}% of accepted quote ${quote.number}`;
    const row = {
      user_id: session.user.id, business_id: biz, division, number, type: "invoice",
      date: today(), due_date: getDefaultDueDate("invoice", today()),
      contact_id: quote.contact_id || contactIdFor(quote.contact_name, quote.contact_email),
      contact_name: quote.contact_name, contact_email: quote.contact_email, contact_company: quote.contact_company,
      contact_abn: quote.contact_abn, contact_address: quote.contact_address, contact_phone: quote.contact_phone,
      job: projectLabel(project), project_id: project.id,
      notes: getDefaultTerms("invoice"), terms: null, status: "draft",
      total: amount, pricing_mode: "lump_sum", converted_from_quote_id: quote.id,
    };
    const { ok, data: inserted } = await sbInsert("bk_invoices", row, "create deposit invoice", false, DUP_NUMBER(number));
    if (!ok || !inserted) return null;
    const itemsRes = await sbWrite(supabase.from("bk_invoice_items").insert({ invoice_id: inserted.id, description, note: "", qty: 1, rate: 0, sort_order: 0 }).select(), "save deposit item");
    inserted.items = itemsRes.ok ? (itemsRes.data || []) : [];
    invoicesRef.current = [inserted, ...invoicesRef.current]; // synchronous, so an immediate re-check/renumber sees it
    setInvoices((prev) => [inserted, ...prev]);
    if (emailConn) saveToOneDrive("invoice", inserted.id, { silent: true });
    return inserted;
  };

  // Ask (every time, no default) whether to raise the deposit invoice for a
  // freshly accepted quote, then open the draft for review. Skips silently if
  // this quote already has one. depositHandledRef is claimed synchronously up
  // front so a double-click (whose closure still sees a deposit-free invoices
  // array) can't slip a second deposit through before the first row exists.
  const offerDepositInvoice = async (quote, project) => {
    if (!project || !quote?.id || !(Number(quote.total) > 0)) return null;
    if (depositHandledRef.current.has(quote.id)) return null;
    if (invoicesRef.current.some((i) => i.converted_from_quote_id === quote.id)) return null;
    depositHandledRef.current.add(quote.id);
    const release = () => depositHandledRef.current.delete(quote.id); // re-allow on skip/cancel/failure
    const raw = window.prompt(`Quote ${quote.number} accepted (${fmt(quote.total)}).\n\nCreate the deposit invoice now? Enter the deposit percentage (e.g. 30) — or Cancel to skip.`, "");
    if (raw == null || String(raw).trim() === "") { release(); return null; }
    const pct = Number(String(raw).replace("%", "").trim());
    if (!isFinite(pct) || pct <= 0 || pct > 100) { release(); alert("Deposit skipped — the percentage must be a number between 1 and 100."); return null; }
    const inserted = await createDepositInvoice(quote, project, pct);
    if (inserted) { setInvoiceSeed(null); setEditItem(inserted); setModal("invoice"); }
    else release();
    return inserted;
  };

  const deleteProject = async (id) => {
    if (!window.confirm("Delete this project? Linked quotes and invoices will be kept but unlinked. This cannot be undone.")) return;
    const { ok } = await sbWrite(supabase.from("bk_jobs").delete().eq("id", id), "delete project");
    if (!ok) return;
    // The DB FK on bk_invoices.project_id is ON DELETE SET NULL, so linked docs are
    // unlinked automatically; just mirror that in local state.
    setJobs((prev) => prev.filter((j) => j.id !== id));
    setInvoices((prev) => prev.map((i) => (i.project_id === id ? { ...i, project_id: null } : i)));
    setModal(null);
    setEditItem(null);
  };

  const saveProfile = async (p) => {
    const row = { user_id: session.user.id, business_id: biz, name: p.name, abn: p.abn, address: p.address, email: p.email, phone: p.phone, bank_name: p.bank_name, account_name: p.account_name, bsb: p.bsb, account_number: p.account_number, logo_url: p.logo_url, email_template_invoice: p.email_template_invoice || "", email_template_quote: p.email_template_quote || "", email_signature: p.email_signature || "", onedrive_folder: p.onedrive_folder || "" };
    const { ok, data: saved } = await sbWrite(supabase.from("bk_profiles").upsert(row, { onConflict: "user_id,business_id" }).select().single(), "save settings");
    if (!ok) return;
    if (saved) setProfile(saved);
    setModal(null);
  };

  const fetchLogoBase64 = async () => {
    if (!profile.logo_url) return null;
    try {
      const match = profile.logo_url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
      if (match) {
        const [, bucket, path] = match;
        const { data, error } = await supabase.storage.from(bucket).download(path);
        if (error || !data) return null;
        return await new Promise((resolve) => { const r = new FileReader(); r.onloadend = () => resolve(r.result); r.readAsDataURL(data); });
      }
      const resp = await fetch(profile.logo_url);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      return await new Promise((resolve) => { const r = new FileReader(); r.onloadend = () => resolve(r.result); r.readAsDataURL(blob); });
    } catch { return null; }
  };

  const [pdfLoading, setPdfLoading] = useState(null);
  const [viewDoc, setViewDoc] = useState(null);

  const downloadPDF = async (inv) => {
    const pdfName = safeFileName([inv.number || "draft", inv.contact_name || "Client", inv.job, inv.date].filter(Boolean), "pdf");
    setPdfLoading(inv.id);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const resp = await fetch(`${API_BASE}/.netlify/functions/generate-invoice-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: inv.id, auth_token: token }),
      });
      const result = await resp.json();
      if (!resp.ok || !result.signed_url) throw new Error(result.error || "PDF generation failed");
      const pdfResp = await fetch(result.signed_url);
      const blob = await pdfResp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = pdfName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Server PDF unavailable, using browser print (A4):", err);
      // Print to a true A4 page via the browser (like Microsoft Word): content flows
      // and paginates onto A4, and the footer is pinned to the bottom of every page.
      const logoDataUrl = await fetchLogoBase64();
      const content = buildInvoiceHTML(inv, profile, accent, logoDataUrl);
      const printDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${inv.number || "Document"}</title><style>
        @page { size: A4; margin: 14mm 13mm 16mm; }
        html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        body > div { width: 100% !important; min-height: 0 !important; padding: 0 !important; display: block !important; box-sizing: border-box; }
        body > div > div:last-child { position: fixed !important; bottom: 6mm; left: 13mm; right: 13mm; margin: 0 !important; }
      </style></head><body>${content}</body></html>`;
      const iframe = document.createElement("iframe");
      Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
      document.body.appendChild(iframe);
      const cw = iframe.contentWindow;
      cw.document.open();
      cw.document.write(printDoc);
      cw.document.close();
      await new Promise((r) => setTimeout(r, 400));
      cw.focus();
      cw.print();
      setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* already gone */ } }, 1000);
    } finally {
      setPdfLoading(null);
    }
  };

  // Open a read-only view of the document *inside* the app (see the DocViewer
  // component). Previously this did window.open("", "_blank"), which mobile/Safari
  // and the iOS in-app WebView block by default — that's where the "Allow pop-ups to
  // view the document" message came from. Rendering it in-app removes the pop-up
  // entirely, so View can never be blocked.
  const viewInvoice = (inv) => setViewDoc(inv);

  // Plain-text default signature, used by the mailto fallback and as the base for
  // the compose window's signature preview.
  const defaultSignatureText = () => {
    const bName = profile.name || "our company";
    // Treat a whitespace-only signature as empty so the fallback still applies.
    return (profile.email_signature || "").trim() ? profile.email_signature : `${bName}${profile.abn ? `\nABN: ${profile.abn}` : ""}${profile.email ? `\n${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}`;
  };

  // withSignature:false strips the {signature} placeholder so the compose window
  // can prefill the message body and show/append the signature separately.
  const buildEmailBody = (inv, { withSignature = true } = {}) => {
    const isQuote = inv.type === "quote";
    const bName = profile.name || "our company";
    const template = isQuote
      ? (profile.email_template_quote || DEFAULT_EMAIL_TEMPLATE_QUOTE)
      : (profile.email_template_invoice || DEFAULT_EMAIL_TEMPLATE_INVOICE);
    const sig = withSignature ? defaultSignatureText() : "";
    const dueDateLine = inv.due_date ? `Payment is due by ${fmtDate(inv.due_date)}.` : "";
    const paymentDetails = profile.bsb ? `Bank details:\n${profile.bank_name ? `Bank: ${profile.bank_name}\n` : ""}Account: ${profile.account_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}` : "";
    return template
      // {first_name} → "Cameron", {last_name} → "Mawson", {contact_name} → full name.
      // Replace last_name before contact_name so the substrings don't collide.
      .replace(/\{first_name\}/g, firstName(inv.contact_name))
      .replace(/\{last_name\}/g, lastName(inv.contact_name))
      .replace(/\{contact_name\}/g, inv.contact_name || "there")
      .replace(/\{number\}/g, inv.number || "")
      .replace(/\{amount\}/g, fmt(inv.total || 0))
      .replace(/\{due_date\}/g, inv.due_date ? fmtDate(inv.due_date) : "")
      .replace(/\{due_date_line\}/g, dueDateLine)
      .replace(/\{payment_details\}/g, paymentDetails)
      .replace(/\{business_name\}/g, bName)
      .replace(/\{signature\}/g, sig);
  };

  const sendInvoice = (inv) => {
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    const bName = profile.name || "our company";
    const subject = `${docType} ${inv.number} from ${bName}`;
    const body = buildEmailBody(inv);
    window.open(`mailto:${inv.contact_email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    downloadPDF(inv);
    // Note: this only opens the user's email app + downloads the PDF. We cannot
    // know whether the email was actually sent, so we do NOT auto-mark "sent".
    // Use "Open in Outlook" for a tracked send, or set the status manually.
  };

  const [outlookDraftLoading, setOutlookDraftLoading] = useState(null);
  // The doc currently open in the compose-email window (null = closed). Set by
  // openComposeFor after a save; the ComposeEmail component prefills from it.
  const [composeDoc, setComposeDoc] = useState(null);
  const openComposeFor = (inv) => { if (inv?.id) setComposeDoc(inv); };
  // Send the composed email (edited subject/body/recipient) via Outlook, PDF
  // attached. Closes the window only on success so a failure keeps the edits.
  const handleComposeSend = async ({ to, subject, html }) => {
    const ok = await sendInvoiceNow(composeDoc, { skipConfirm: true, subjectOverride: subject, htmlOverride: html, toOverride: to });
    if (ok) setComposeDoc(null);
    return ok;
  };

  // One-click REAL send: fresh PDF, then send-invoice-outlook WITHOUT the draft
  // flag — the server attaches the PDF, applies the email template, sends from
  // the user's Outlook, and flips draft→sent + sent_at. We mirror that status
  // locally (updateInvoice can't: sent_at isn't client-writable, and it would
  // close whatever modal is open).
  const sendInvoiceNow = async (inv, opts = {}) => {
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    if (!emailConn) { alert("Connect Outlook in Settings first."); return false; }
    if (!inv.contact_email) { alert(`This ${docType.toLowerCase()} has no contact email — add one first.`); return false; }
    if (sendInFlightRef.current.has(inv.id)) return false; // already sending this one
    if (!opts.skipConfirm && !window.confirm(`Send ${docType.toLowerCase()} ${inv.number} (${fmt(inv.total || 0)}) to ${inv.contact_email} with the PDF attached?`)) return false;
    sendInFlightRef.current.add(inv.id);
    setOutlookDraftLoading(inv.id);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) throw new Error("Not authenticated");
      // Always (re)generate the PDF so the attachment reflects the latest edits.
      const pdfResp = await fetch(`${API_BASE}/.netlify/functions/generate-invoice-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: inv.id, auth_token: token }),
      });
      if (!pdfResp.ok) {
        let detail = "";
        try { detail = (await pdfResp.json()).error || ""; } catch { /* ignore */ }
        throw new Error("Could not generate the PDF, so nothing was sent. " + (detail || "Please try again."));
      }
      // Overrides come from the compose window (edited subject/body/recipient).
      const sendBody = { invoice_id: inv.id };
      if (opts.subjectOverride != null) sendBody.subject_override = opts.subjectOverride;
      if (opts.htmlOverride != null) sendBody.html_override = opts.htmlOverride;
      if (opts.toOverride != null) sendBody.to_override = opts.toOverride;
      const resp = await fetch(`${API_BASE}/.netlify/functions/send-invoice-outlook`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(sendBody),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(result.error || "Send failed");
      // Mirror the server-side status flip (draft→sent + sent_at) into local state.
      const sentAt = new Date().toISOString();
      setInvoices((prev) => prev.map((i) => (i.id === inv.id ? { ...i, status: i.status === "draft" ? "sent" : i.status, sent_at: i.sent_at || sentAt } : i)));
      // Re-file the fresh PDF to OneDrive (Admin/Quotes|Invoices) quietly.
      saveToOneDrive("invoice", inv.id, { silent: true });
      if (!opts.silentSuccess) alert(`${docType} ${inv.number} sent to ${opts.toOverride || result.sent_to || inv.contact_email}.`);
      return true;
    } catch (err) {
      console.error("Send error:", err);
      alert(`Failed to send: ${err.message}`);
      return false;
    } finally {
      sendInFlightRef.current.delete(inv.id);
      // Only clear the spinner slot if it still belongs to this invoice, so a
      // concurrent send of a different doc doesn't get its spinner wiped.
      setOutlookDraftLoading((cur) => (cur === inv.id ? null : cur));
    }
  };

  const sendReminder = (inv) => {
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    const bName = profile.name || "our company";
    const subject = `Reminder: ${docType} ${inv.number} from ${bName}`;
    const overdueDays = inv.due_date ? Math.max(0, Math.floor((Date.now() - new Date(inv.due_date)) / 86400000)) : 0;
    const sig = profile.email_signature || `${bName}${profile.abn ? `\nABN: ${profile.abn}` : ""}${profile.email ? `\n${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}`;
    const body = `Hi ${firstName(inv.contact_name)},\n\nThis is a friendly reminder that ${docType.toLowerCase()} ${inv.number} for ${fmt(inv.total || 0)} ${overdueDays > 0 ? `was due ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago` : "is due for payment"}.\n\n${profile.bsb ? `Bank details:\n${profile.bank_name ? `Bank: ${profile.bank_name}\n` : ""}Account: ${profile.account_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}\n\n` : ""}Please let us know if you have any questions.\n\nKind regards,\n${sig}`;
    window.open(`mailto:${inv.contact_email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    markOverdueQuiet(inv);
  };

  // Send the reminder email directly via Resend (the same service the automated
  // reminders use), rather than opening a mailto draft. Falls back to the draft if
  // the email service isn't reachable (e.g. running locally).
  const sendReminderViaResend = async (inv) => {
    if (!inv.contact_email) { alert("This invoice has no contact email."); return; }
    if (!window.confirm(`Email a payment reminder to ${inv.contact_name || inv.contact_email} now?`)) return;
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const resp = await fetch(`${API_BASE}/.netlify/functions/send-reminders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_id: inv.id, business_id: biz }),
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) throw new Error((data && data.error) || `Request failed (${resp.status})`);
      alert(`Reminder emailed to ${data.sent_to || inv.contact_email}.`);
      markOverdueQuiet(inv);
    } catch (err) {
      if (window.confirm(`Couldn't send via the email service (${err.message}).\n\nOpen an email draft instead?`)) sendReminder(inv);
    }
  };

  const markPaid = (inv) => {
    updateInvoice(inv.id, { status: "paid", paid_date: today() });
    fileIssuedToOneDrive(inv.id);
  };

  // Close the draft→sent loop after a document is emailed: offer to flip a still
  // "draft" doc to "sent" so overdue tracking + automatic reminders kick in. We ask
  // (rather than auto-set) because an email send can't be confirmed programmatically.
  const offerMarkSent = async (inv) => {
    if (!inv || inv.status !== "draft") return false;
    const isInvoice = inv.type !== "quote";
    const msg = isInvoice
      ? `Mark invoice ${inv.number} as Sent?\n\nThis starts due-date tracking and enables the automatic payment reminders.`
      : `Mark quote ${inv.number} as Sent?`;
    if (!window.confirm(msg)) return false;
    await updateInvoice(inv.id, { status: "sent" });
    fileIssuedToOneDrive(inv.id); // now issued → move into the project folder
    return true;
  };

  // Mark paid without closing the current modal (used inside the Project modal).
  // Flip a lapsed invoice to "overdue" without disturbing an open form.
  //
  // Both reminder senders used updateInvoice for this, but updateInvoice ends by
  // closing the modal and nulling invoiceDraftRef — so sending a reminder from
  // inside an open invoice discarded every unsaved edit, with no confirmation.
  // The status flip is incidental bookkeeping, not a save; it has no business
  // touching the modal. Same shape as markPaidQuiet below, for the same reason.
  const markOverdueQuiet = async (inv) => {
    if (!(inv.due_date && new Date(inv.due_date) < new Date() && inv.status === "sent")) return;
    const upd = { status: "overdue" };
    const { ok } = await sbWrite(supabase.from("bk_invoices").update(upd).eq("id", inv.id), "mark overdue");
    if (!ok) return;
    setInvoices((prev) => prev.map((i) => (i.id === inv.id ? { ...i, ...upd } : i)));
  };

  const markPaidQuiet = async (inv) => {
    const upd = { status: "paid", paid_date: today() };
    const { ok } = await sbWrite(supabase.from("bk_invoices").update(upd).eq("id", inv.id), "mark paid");
    if (!ok) return;
    setInvoices((prev) => prev.map((i) => (i.id === inv.id ? { ...i, ...upd } : i)));
    fileIssuedToOneDrive(inv.id);
  };

  // Save an invoice PDF or expense receipt to OneDrive via the Netlify function
  // (reuses the Microsoft connection). silent=true for auto-save (no popups).
  // The OneDrive filename for a doc — must match the server's (sanitize + prefix).
  const oneDriveDocName = (type, number, id) => String(`${type === "quote" ? "Quote" : "Invoice"} ${number || id}`).replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim() + ".pdf";

  const saveToOneDrive = async (kind, id, opts = {}) => {
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) return false;
      const resp = await fetch(`${API_BASE}/.netlify/functions/onedrive-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        // prev_name/prev_subfolder let the server clear a stale central copy after a rename.
        body: JSON.stringify({ kind, id, prev_name: opts.prevName || null, prev_subfolder: opts.prevSubfolder || null }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { if (!opts.silent) alert(data.error || "Could not save to OneDrive."); return false; }
      // `pending` means OneDrive is still copying the project folder from the
      // master. It will finish on its own — say so rather than implying the
      // folder is ready to open right now.
      if (!opts.silent) alert(data.pending
        ? `OneDrive is creating ${data.savedTo} from the master folder. It'll appear in a moment.`
        : `Saved to OneDrive → ${data.savedTo || "done"}`);
      return true;
    } catch {
      if (!opts.silent) alert("Could not reach OneDrive. Please try again.");
      return false;
    }
  };

  // Regenerate the PDF (so it reflects the latest edits — onedrive-upload only
  // rebuilds when there's no stored PDF, and there always is one after create),
  // then re-file it. Fire-and-forget; used when a DRAFT is edited so its pending
  // OneDrive copy stays current. Issued docs are never auto-refiled — they only
  // move/update on an explicit send, preserving the sent record.
  const regenAndFileOneDrive = async (invId, prev = {}) => {
    if (!emailConn) return;
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) return;
      await fetch(`${API_BASE}/.netlify/functions/generate-invoice-pdf`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: invId, auth_token: token }),
      });
    } catch { /* best-effort */ }
    saveToOneDrive("invoice", invId, { silent: true, prevName: prev.name, prevSubfolder: prev.subfolder });
  };

  // A draft that becomes issued (sent/accepted/paid) outside the compose flow —
  // "mark sent", accept a quote, mark paid — must still move from the central
  // pending area into its project folder. Best-effort, silent. (The compose send
  // already re-files itself.)
  const fileIssuedToOneDrive = (invId) => { if (emailConn) saveToOneDrive("invoice", invId, { silent: true }); };

  const connectOutlook = async () => {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    if (!token) return;
    try {
      const resp = await fetch(`${API_BASE}/.netlify/functions/outlook-oauth-start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ business_id: biz }),
      });
      const result = await resp.json();
      if (!resp.ok || !result.url) throw new Error(result.error || "Failed to start OAuth");
      window.location.href = result.url;
    } catch (err) {
      console.error("Outlook connect failed:", err);
      alert("Failed to connect Outlook: " + err.message);
    }
  };

  const disconnectOutlook = async () => {
    if (!emailConn?.id) return;
    const { ok } = await sbWrite(supabase.from("bk_email_connections").delete().eq("id", emailConn.id), "disconnect Outlook");
    if (!ok) return;
    setEmailConn(null);
  };


  if (session === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#f7f9f8", color: "#64748b" }}>Loading...</div>;
  if (recovery) return <ResetPasswordScreen onDone={() => setRecovery(false)} />;
  if (!session) return <LoginScreen />;
  if (loading) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#f7f9f8", color: "#64748b", fontFamily: "'DM Sans', sans-serif" }}>Loading...</div>;

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Icons.Dashboard },
    { id: "invoices", label: "Invoices", icon: Icons.Invoices },
    { id: "quotes", label: "Quotes", icon: Icons.Quotes },
    { id: "projects", label: "Projects", icon: Icons.Projects },
    { id: "contacts", label: "Contacts", icon: Icons.Contacts },
  ];
  const activeNav = page;

  const badgeBg = { "#34d399": "#ecfdf5", "#3b82f6": "#eff6ff", "#64748b": "#f1f5f9", "#ef4444": "#fef2f2", "#f59e0b": "#fffbeb" };
  const badgeTx = { "#34d399": "#065f46", "#3b82f6": "#1e40af", "#64748b": "#475569", "#ef4444": "#991b1b", "#f59e0b": "#92400e" };
  const s = {
    app: { display: "flex", height: "100vh", fontFamily: "'DM Sans', system-ui, sans-serif", background: "#f7f9f8", color: "#0f172a", fontSize: "13px", overflow: "hidden" },
    sidebar: { width: 220, background: "#ffffff", borderRight: "1px solid #e2e8f0", display: "flex", flexDirection: "column", flexShrink: 0, position: "relative", zIndex: 40 },
    sidebarMobile: { position: "fixed", inset: 0, zIndex: 40 },
    logo: { padding: "20px 16px 12px", borderBottom: "1px solid #e2e8f0" },
    bizSwitcher: { padding: "12px", borderBottom: "1px solid #e2e8f0" },
    bizBtn: (active, color) => ({ width: "100%", padding: "8px 10px", border: "none", borderRadius: 6, cursor: "pointer", textAlign: "left", fontSize: 12, fontWeight: 600, background: active ? color + "18" : "transparent", color: active ? color : "#64748b", borderLeft: active ? `3px solid ${color}` : "3px solid transparent", marginBottom: 2 }),
    divBtn: (active, color) => ({ width: "100%", padding: "8px 10px", border: "none", borderRadius: 6, cursor: "pointer", textAlign: "left", fontSize: 12, fontWeight: 600, background: active ? color + "18" : "transparent", color: active ? color : "#64748b", borderLeft: active ? `3px solid ${color}` : "3px solid transparent", marginBottom: 2 }),
    nav: { flex: 1, padding: "8px", overflowY: "auto" },
    navBtn: (active) => ({ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "none", borderRadius: 6, cursor: "pointer", background: active ? "#ecfdf5" : "transparent", color: active ? "#059669" : "#64748b", fontSize: 13, fontWeight: active ? 600 : 400, marginBottom: 1, textAlign: "left", borderLeft: active ? `3px solid ${accent}` : "3px solid transparent" }),
    main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 },
    header: { padding: "12px 16px", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#ffffff", gap: 8, flexWrap: "wrap" },
    content: { flex: 1, padding: "16px", overflowY: "auto" },
    card: { background: "#ffffff", borderRadius: 14, border: "1px solid #eef1f0", padding: "16px", marginBottom: 12, boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 6px 16px -8px rgba(16,24,40,0.08)" },
    statCard: () => ({ background: "#ffffff", borderRadius: 14, border: "1px solid #eef1f0", padding: "20px 24px", minWidth: 0, boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 6px 16px -8px rgba(16,24,40,0.08)" }),
    btn: (bg, small) => ({ padding: small ? "7px 14px" : "9px 18px", background: bg || accent, color: "#fff", border: "none", borderRadius: 9, cursor: "pointer", fontSize: small ? 11 : 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", boxShadow: "0 1px 2px rgba(16,24,40,0.10)" }),
    btnOutline: { padding: "7px 14px", background: "#ffffff", color: "#475569", border: "1px solid #e2e8f0", borderRadius: 9, cursor: "pointer", fontSize: 11, fontWeight: 600 },
    table: { width: "100%", borderCollapse: "collapse" },
    th: { textAlign: "left", padding: "8px 10px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#94a3b8", borderBottom: "1px solid #e2e8f0" },
    td: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 13 },
    input: { width: "100%", padding: "9px 12px", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 9, color: "#0f172a", fontSize: 13, outline: "none", boxSizing: "border-box" },
    select: { width: "100%", padding: "9px 12px", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 9, color: "#0f172a", fontSize: 13, outline: "none", boxSizing: "border-box" },
    label: { display: "block", fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" },
    modalOverlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.38)", backdropFilter: "blur(3px)", WebkitBackdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 },
    modalContent: { background: "#ffffff", borderRadius: 16, border: "1px solid #eef1f0", width: "100%", maxWidth: 560, maxHeight: "85vh", overflow: "auto", padding: "20px", boxShadow: "0 24px 50px -12px rgba(16,24,40,0.32)" },
    badge: (color) => ({ display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 10, fontWeight: 600, background: badgeBg[color] || color + "15", color: badgeTx[color] || color }),
    grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
    pill: (active) => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 13px", fontSize: 12, fontWeight: 600, borderRadius: 20, cursor: "pointer", whiteSpace: "nowrap", border: active ? "1px solid transparent" : "1px solid #e2e8f0", background: active ? accent : "#ffffff", color: active ? "#ffffff" : "#64748b" }),
    pillCount: (active) => ({ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 17, height: 16, padding: "0 5px", borderRadius: 8, fontSize: 10, fontWeight: 700, background: active ? "rgba(255,255,255,0.22)" : "#f1f5f9", color: active ? "#ffffff" : "#94a3b8" }),
    miniStat: { flex: "1 1 120px", minWidth: 0, background: "#ffffff", borderRadius: 12, border: "1px solid #eef1f0", padding: "11px 14px", boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  };


  const fySelectEl = (extra) => (
    <select value={fy} onChange={(e) => switchFY(e.target.value)} aria-label="Financial year"
      style={{ ...s.select, width: "auto", padding: "7px 10px", fontSize: 12, fontWeight: 600, color: "#475569", cursor: "pointer", ...extra }}>
      {[ALL_FY, ...fyChoices(divInvoices, fy)].map((id) => <option key={id} value={id}>{fyLabel(id)}</option>)}
    </select>
  );

  const FilterPills = ({ tabs, active, onChange }) => (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)} style={s.pill(active === t.key)}>
          {t.label}{t.count != null && <span style={s.pillCount(active === t.key)}>{t.count}</span>}
        </button>
      ))}
    </div>
  );

  const ListStat = ({ label, value, color, note }) => (
    <div style={s.miniStat}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || "#0f172a", marginTop: 3, letterSpacing: "-0.01em" }}>{value}</div>
      {note && <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>{note}</div>}
    </div>
  );

  const EmptyState = ({ icon: Icon, title, hint }) => (
    <div style={{ padding: "44px 20px", textAlign: "center" }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: "#ecfdf5", display: "inline-flex", alignItems: "center", justifyContent: "center", color: accent, marginBottom: 12 }}>{Icon ? <Icon /> : null}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: "#94a3b8", margin: "4px auto 0", maxWidth: 300, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );






  const InvoiceForm = ({ existing }) => {
    const defaultType = "invoice";
    const seed = invoiceSeed || {};
    const seedType = seed.type || defaultType;
    const seedContact = seed.contact_name ? contacts.find((c) => (c.name || c.company) === seed.contact_name) : null;
    const init = existing
      ? { ...existing, pricing_mode: existing.pricing_mode || "itemised", lump_amount: existing.pricing_mode === "lump_sum" ? String(existing.total ?? "") : "", terms: existing.terms ?? "" }
      : { number: getNextDocumentNumber(divInvoices, insertDivision, seedType), type: seedType, date: today(), due_date: getDefaultDueDate(seedType, today()), contact_name: seed.contact_name || "", contact_email: seedContact?.email || "", contact_company: seedContact?.company || "", contact_abn: seedContact?.abn || "", contact_address: seedContact?.address || "", contact_phone: seedContact?.phone || "", job: seed.projectName || "", project_id: seed.project_id || "", pricing_mode: seed.pricing_mode || "itemised", lump_amount: seed.lump_amount || "", items: (seed.items && seed.items.length) ? seed.items.map((it) => ({ description: it.description || "", note: it.note || "", qty: it.qty ?? 1, rate: it.rate ?? "" })) : [{ description: "", note: "", qty: 1, rate: "" }], notes: seed.notes != null ? seed.notes : getDefaultTerms(seedType), terms: seed.terms != null ? seed.terms : getDefaultDocTerms(seedType), status: "draft" };
    // Draft survival across a remount (see invoiceDraftRef). The key ties the
    // draft to this exact document — a saved invoice by id, a new one by its
    // seed — so a restored draft can never land in the wrong form.
    const draftKey = existing ? `id:${existing.id}` : `new:${JSON.stringify(invoiceSeed || {})}`;
    const draft = invoiceDraftRef.current && invoiceDraftRef.current.key === draftKey ? invoiceDraftRef.current : null;
    const [f, setF] = useState(() => draft?.f || init);
    const [dueDateEdited, setDueDateEdited] = useState(() => (draft ? draft.dueDateEdited : !!existing));
    const invOverdue = existing && f.type !== "quote" ? daysOverdue({ status: existing.status, due_date: f.due_date }) : 0;
    const [notesEdited, setNotesEdited] = useState(() => (draft ? draft.notesEdited : !!existing));
    const [termsEdited, setTermsEdited] = useState(() => (draft ? draft.termsEdited : !!existing));
    const updateType = (newType) => {
      const autoNum = !existing && !f._numberEdited;
      const updates = { ...f, type: newType, number: autoNum ? getNextDocumentNumber(divInvoices, insertDivision, newType) : f.number };
      if (!dueDateEdited) updates.due_date = getDefaultDueDate(newType, f.date);
      if (!notesEdited) updates.notes = getDefaultTerms(newType);
      if (!termsEdited) updates.terms = getDefaultDocTerms(newType);
      setF(updates);
    };
    const updateDate = (newDate) => {
      const updates = { ...f, date: newDate };
      if (!dueDateEdited) updates.due_date = getDefaultDueDate(f.type, newDate);
      setF(updates);
    };
    // The quick-add panels hold typed text too, so they ride along in the draft.
    const [quickAdd, setQuickAdd] = useState(() => draft?.quickAdd ?? false);
    const [qa, setQa] = useState(() => draft?.qa || { name: "", email: "", company: "", phone: "", abn: "", address: "" });
    const [projectAdd, setProjectAdd] = useState(() => draft?.projectAdd ?? false);
    const [pa, setPa] = useState(() => draft?.pa || { name: "", contract_value: "", address: "" });
    const [saving, setSaving] = useState(false);
    // Keep the draft current so a remount mid-edit restores the latest values.
    // `saving` is deliberately NOT carried: it belongs to an in-flight save owned
    // by the dying instance, and restoring it would strand the button disabled.
    const liveDraft = { key: draftKey, f, dueDateEdited, notesEdited, termsEdited, quickAdd, qa, projectAdd, pa };
    useEffect(() => { invoiceDraftRef.current = liveDraft; });
    // Handlers that mutate App state (quick-add) must stash the *post-click*
    // values synchronously: the remount kills this instance, so the setF right
    // after the await never lands. This runs before React flushes the re-render.
    const stashDraft = (nextF) => { invoiceDraftRef.current = { ...liveDraft, f: nextF }; };
    const initialSnapshot = useRef(JSON.stringify(init));
    useEffect(() => { formDirtyRef.current = JSON.stringify(f) !== initialSnapshot.current; }, [f]);
    const updateItem = (idx, field, val) => { const items = [...f.items]; items[idx] = { ...items[idx], [field]: val }; setF({ ...f, items }); };
    const addItem = () => setF({ ...f, items: [...f.items, { description: "", note: "", qty: 1, rate: "" }] });
    const removeItem = (idx) => setF({ ...f, items: f.items.filter((_, i) => i !== idx) });
    const isLump = f.pricing_mode === "lump_sum";
    const total = isLump ? (Number(f.lump_amount) || 0) : f.items.reduce((sum, i) => sum + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
    const selectedContact = contacts.find((c) => (c.name || c.company) === f.contact_name);
    const sortedJobs = [...divJobs].sort((a, b) => { const aMatch = selectedContact && a.contact_id === selectedContact.id ? 0 : 1; const bMatch = selectedContact && b.contact_id === selectedContact.id ? 0 : 1; return aMatch - bMatch || new Date(b.last_used_at) - new Date(a.last_used_at); });
    // An issued invoice is a record. Editing its figures is discouraged — offer a
    // "revised invoice" (a fresh draft copy) instead, which keeps the original.
    const isIssued = !!existing && f.type !== "quote" && ["sent", "overdue", "paid"].includes(existing.status);
    // "Figures changed" also covers line-item edits that net to the same total
    // (swapped amounts, changed descriptions/qty) — those still alter the record.
    const itemsSig = (arr) => JSON.stringify((arr || []).map((i) => ({ d: i.description || "", n: i.note || "", q: Number(i.qty) || 0, r: Number(i.rate) || 0 })));
    const figuresChanged = isIssued && (
      Number(existing.total || 0) !== total ||
      String(existing.number || "") !== String(f.number || "") ||
      itemsSig(existing.items) !== itemsSig(f.items)
    );
    const reviseInvoice = () => {
      setInvoiceSeed({
        type: "invoice",
        contact_name: f.contact_name,
        project_id: f.project_id || "",
        projectName: f.job,
        pricing_mode: f.pricing_mode || "itemised",
        lump_amount: isLump ? String(total) : "",
        items: f.items.map((it) => ({ description: it.description, note: it.note, qty: it.qty, rate: it.rate })),
        notes: f.notes,   // carry the original's notes + T&Cs onto the revised copy
        terms: f.terms,
      });
      setEditItem(null);
      setModal("invoice");
    };
    const saveInv = async () => {
      // Guard editing a sent invoice's figures: warn before overwriting the record.
      if (figuresChanged && !window.confirm(`Invoice ${existing.number} was already sent to the client${existing.sent_at ? ` on ${fmtDate(existing.sent_at)}` : ""}, and you've changed its figures.\n\nSaving overwrites your record of what was billed. Normally you'd issue a REVISED invoice instead — Cancel, then "Create revised invoice".\n\nSave over the original anyway?`)) return null;
      const inv = { ...f, total, items: isLump ? [{ description: f.items[0]?.description || "", note: "", qty: 1, rate: 0 }] : f.items };
      let saved;
      // Gate on success: updateInvoice/addInvoice return falsy on failure, so a
      // failed save yields saved=null and saveAndSend won't email a stale doc.
      if (existing) { const ok = await updateInvoice(existing.id, inv); saved = ok ? { ...existing, ...inv } : null; }
      else { saved = await addInvoice(inv); }
      if (saved && !inv.project_id) upsertJob(inv.job, inv.contact_name);
      return saved;
    };
    // Save, then open the compose window so the user reviews/edits the email and
    // hits Send themselves — nothing goes out automatically.
    const saveAndCompose = async () => {
      const saved = await saveInv();
      if (saved?.id) openComposeFor(saved);
    };
    const canCompose = !!emailConn && !!(f.contact_email || "").trim();

    // Contacts attached to the selected project (bk_job_parties) — offered first
    // in the "Addressed to" dropdown, consultants included.
    const projParties = f.project_id ? jobParties.filter((p) => p.job_id === f.project_id) : [];
    const partyContacts = projParties.map((p) => { const c = contacts.find((x) => x.id === p.contact_id); return c ? { ...c, _role: p.role } : null; }).filter(Boolean);
    const otherContacts = contacts.filter((c) => (c.type === "client" || c.type === "consultant") && !partyContacts.some((pc) => pc.id === c.id));

    // Quote templates: applying one fills the editable content; saving captures it.
    const applyTemplate = (id) => {
      const t = quoteTemplates.find((x) => x.id === id);
      if (!t) return;
      const tItems = Array.isArray(t.items) && t.items.length ? t.items.map((it) => ({ description: it.description || "", note: it.note || "", qty: it.qty ?? 1, rate: it.rate ?? "" })) : [{ description: "", note: "", qty: 1, rate: "" }];
      setF({ ...f, pricing_mode: t.pricing_mode || "itemised", items: tItems, lump_amount: t.lump_amount != null ? String(t.lump_amount) : "", notes: t.notes != null ? t.notes : f.notes, terms: t.terms != null ? t.terms : f.terms });
      setNotesEdited(true);
      setTermsEdited(true);
    };
    const saveAsTemplate = async () => {
      const name = window.prompt("Template name:", f.job || "");
      if (!name || !name.trim()) return;
      const row = {
        user_id: session.user.id,
        business_id: biz,
        name: name.trim(),
        pricing_mode: f.pricing_mode || "itemised",
        items: isLump ? [{ description: f.items[0]?.description || "", note: "", qty: 1, rate: 0 }] : f.items.map((it) => ({ description: it.description || "", note: it.note || "", qty: it.qty ?? 1, rate: it.rate ?? "" })),
        lump_amount: isLump ? (Number(f.lump_amount) || 0) : null,
        notes: f.notes || null,
        terms: f.terms || null,
      };
      const { ok, data } = await sbWrite(supabase.from("bk_quote_templates").insert(row).select().single(), "save template");
      if (ok && data) { setQuoteTemplates((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name))); alert(`Template "${data.name}" saved — it's available under "Start from template" on new quotes.`); }
    };

    // One-click quote → invoice (MYOB's headline action). Persists any quote edits,
    // marks the quote Accepted + linked to a project (keeping contract tracking
    // coherent), then opens a fresh draft invoice pre-filled with the same line
    // items, contact and project. The quote is preserved.
    const convertToInvoice = async () => {
      if (!window.confirm(`Convert quote ${f.number} to an invoice?\n\nThe quote is marked Accepted, and a new draft invoice opens — pre-filled with these line items and linked to the same project.`)) return;
      const itemsForLump = [{ description: f.items[0]?.description || "", note: "", qty: 1, rate: 0 }];
      await updateInvoice(existing.id, { ...f, total, items: isLump ? itemsForLump : f.items });
      const proj = await acceptQuote({ ...existing, ...f, total });
      setInvoiceSeed({
        type: "invoice",
        contact_name: f.contact_name,
        project_id: proj?.id || f.project_id || "",
        projectName: proj ? projectLabel(proj) : f.job,
        pricing_mode: f.pricing_mode || "itemised",
        lump_amount: isLump ? String(total) : "",
        items: isLump ? itemsForLump : f.items.map((it) => ({ description: it.description, note: it.note, qty: it.qty, rate: it.rate })),
      });
      setEditItem(null);
      setModal("invoice");
    };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{existing ? "Edit" : "New"} {f.type === "quote" ? "Quote" : "Invoice"}</h3>
          <button onClick={() => requestCloseModal()} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        {isIssued && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "12px 14px", marginBottom: 16 }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12.5, color: "#92400e", lineHeight: 1.5 }}>
                This invoice was already sent to the client{existing.sent_at ? ` on ${fmtDate(existing.sent_at)}` : ""}. It's a record of what you billed — to change the amount, issue a <strong>revised invoice</strong> instead of editing this one.
              </div>
              <button type="button" onClick={reviseInvoice} style={{ ...s.btn(accent, true), fontSize: 11, marginTop: 8 }}><Icons.Plus /> Create revised invoice</button>
            </div>
          </div>
        )}
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Type</label><select value={f.type} onChange={(e) => updateType(e.target.value)} style={s.select}><option value="invoice">Invoice</option><option value="quote">Quote</option></select></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Number</label><input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value, _numberEdited: true })} style={s.input} /></div>
        </div>
        {f.type === "quote" && !existing && quoteTemplates.length > 0 && (
          <div style={{ background: `${accent}10`, border: `1px solid ${accent}40`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <label style={{ ...s.label, color: accent }}>Start from template</label>
            <select value="" onChange={(e) => { if (e.target.value) applyTemplate(e.target.value); }} style={s.select}>
              <option value="">Choose a template…</option>
              {quoteTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 5 }}>Fills the scope, price, notes and T&amp;Cs — everything stays editable. To make a new template, save any quote with “Save as Template”.</div>
          </div>
        )}
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Date</label><input type="date" value={f.date} onChange={(e) => updateDate(e.target.value)} style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>{f.type === "quote" ? "Valid Until" : "Due Date"}{invOverdue > 0 && <span style={{ color: "#ef4444", fontWeight: 600, textTransform: "none", marginLeft: 6 }}>· {invOverdue} {invOverdue === 1 ? "day" : "days"} overdue</span>}</label><input type="date" value={f.due_date || ""} onChange={(e) => { setDueDateEdited(true); setF({ ...f, due_date: e.target.value }); }} style={s.input} /></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}>
            <label style={s.label}>Contact</label>
            <div style={{ display: "flex", gap: 4 }}>
              <select value={f.contact_name || ""} onChange={(e) => { const c = contacts.find(c => (c.name || c.company) === e.target.value); setF({ ...f, contact_name: e.target.value, contact_email: c?.email || "", contact_company: c?.company || "", contact_abn: c?.abn || "", contact_address: c?.address || "", contact_phone: c?.phone || "" }); }} style={{ ...s.select, flex: 1 }}>
                <option value="">Select...</option>
                {partyContacts.length > 0 && (
                  <optgroup label="On this project">
                    {partyContacts.map((c) => <option key={c.id} value={c.name || c.company}>{(c.name || c.company) + (c._role === "consultant" ? " · consultant" : "")}</option>)}
                  </optgroup>
                )}
                {partyContacts.length > 0 ? (
                  <optgroup label="All contacts">
                    {otherContacts.map((c) => <option key={c.id} value={c.name || c.company}>{c.name || c.company}</option>)}
                  </optgroup>
                ) : (
                  otherContacts.map((c) => <option key={c.id} value={c.name || c.company}>{c.name || c.company}</option>)
                )}
              </select>
              <button type="button" onClick={() => setQuickAdd(qa => !qa)} style={{ background: accent, border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "0 10px", fontSize: 16, fontWeight: 700, lineHeight: 1 }} title="Quick add contact">+</button>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Status</label><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={s.select}>{f.type === "quote" ? (<><option value="draft">Draft</option><option value="sent">Sent</option><option value="accepted">Accepted</option><option value="declined">Declined</option></>) : (<><option value="draft">Draft</option><option value="sent">Sent</option><option value="paid">Paid</option><option value="overdue">Overdue</option></>)}</select></div>
        </div>
        {quickAdd && (
          <div style={{ background: "#f1f5f9", borderRadius: 8, padding: 12, marginBottom: 12, border: `1px solid ${accent}30` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: accent, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Quick Add Client</div>
            <div style={s.grid2}>
              <div style={{ marginBottom: 8 }}><input value={qa.name} onChange={(e) => setQa({ ...qa, name: e.target.value })} placeholder="Name" style={{ ...s.input, fontSize: 12 }} /></div>
              <div style={{ marginBottom: 8 }}><input value={qa.company} onChange={(e) => setQa({ ...qa, company: e.target.value })} placeholder="Company" style={{ ...s.input, fontSize: 12 }} /></div>
            </div>
            <div style={s.grid2}>
              <div style={{ marginBottom: 8 }}><input value={qa.email} onChange={(e) => setQa({ ...qa, email: e.target.value })} placeholder="Email" style={{ ...s.input, fontSize: 12 }} /></div>
              <div style={{ marginBottom: 8 }}><input value={qa.phone} onChange={(e) => setQa({ ...qa, phone: e.target.value })} placeholder="Phone" style={{ ...s.input, fontSize: 12 }} /></div>
            </div>
            <div style={s.grid2}>
              <div style={{ marginBottom: 8 }}><input value={qa.abn} onChange={(e) => setQa({ ...qa, abn: e.target.value })} placeholder="ABN" style={{ ...s.input, fontSize: 12 }} /></div>
              <div style={{ marginBottom: 8 }}><input value={qa.address} onChange={(e) => setQa({ ...qa, address: e.target.value })} placeholder="Address" style={{ ...s.input, fontSize: 12 }} /></div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button disabled={!qa.name && !qa.company} onClick={async () => { const inserted = await addContact({ ...qa, type: "client", notes: "" }, true); if (inserted) { const nextF = { ...f, contact_name: inserted.name || inserted.company || "", contact_email: inserted.email || "", contact_company: inserted.company || "", contact_abn: inserted.abn || "", contact_address: inserted.address || "", contact_phone: inserted.phone || "" }; stashDraft(nextF); setF(nextF); } setQa({ name: "", email: "", company: "", phone: "", abn: "", address: "" }); setQuickAdd(false); }} style={{ ...s.btn(accent), fontSize: 12, opacity: !qa.name && !qa.company ? 0.4 : 1 }}>Add & Select</button>
              <button onClick={() => { setQuickAdd(false); setQa({ name: "", email: "", company: "", phone: "", abn: "", address: "" }); }} style={{ ...s.btnOutline, fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <label style={s.label}>Project</label>
          <div style={{ display: "flex", gap: 4 }}>
            <select value={f.project_id || ""} onChange={(e) => { const p = jobs.find((j) => j.id === e.target.value); setF({ ...f, project_id: e.target.value || "", job: p ? projectLabel(p) : (e.target.value ? f.job : "") }); }} style={{ ...s.select, flex: 1 }}>
              <option value="">No project</option>
              {sortedJobs.map((j) => <option key={j.id} value={j.id}>{projectLabel(j)}</option>)}
            </select>
            <button type="button" onClick={() => setProjectAdd((v) => !v)} style={{ background: accent, border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "0 10px", fontSize: 16, fontWeight: 700, lineHeight: 1 }} title="New project">+</button>
          </div>
        </div>
        {projectAdd && (
          <div style={{ background: "#f1f5f9", borderRadius: 8, padding: 12, marginBottom: 12, border: `1px solid ${accent}30` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: accent, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>New Project</div>
            <div style={{ marginBottom: 8 }}><input value={pa.name} onChange={(e) => setPa({ ...pa, name: e.target.value })} placeholder="Project name (e.g. 5 Midleton Ave Bexley North)" style={{ ...s.input, fontSize: 12 }} /></div>
            <div style={{ marginBottom: 8 }}><input value={pa.address} onChange={(e) => setPa({ ...pa, address: e.target.value })} placeholder="Address (optional)" style={{ ...s.input, fontSize: 12 }} /></div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>The contract value builds up automatically from accepted quotes.</div>
            <div style={{ display: "flex", gap: 6 }}>
              <button disabled={!pa.name.trim()} onClick={async () => { const created = await createProject({ name: pa.name, contact_name: f.contact_name, address: pa.address }); if (created) { const nextF = { ...f, project_id: created.id, job: projectLabel(created) }; stashDraft(nextF); setF(nextF); } setPa({ name: "", contract_value: "", address: "" }); setProjectAdd(false); }} style={{ ...s.btn(accent), fontSize: 12, opacity: !pa.name.trim() ? 0.4 : 1 }}>Add & Select</button>
              <button onClick={() => { setProjectAdd(false); setPa({ name: "", contract_value: "", address: "" }); }} style={{ ...s.btnOutline, fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        )}
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <label style={s.label}>Pricing</label>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {[["itemised", "Itemised"], ["lump_sum", "Lump sum"]].map(([val, lbl]) => (
              <button key={val} type="button" onClick={() => setF({ ...f, pricing_mode: val })} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", background: f.pricing_mode === val ? accent + "20" : "transparent", color: f.pricing_mode === val ? accent : "#64748b", borderColor: f.pricing_mode === val ? accent : "#e2e8f0" }}>{lbl}</button>
            ))}
          </div>
          <label style={s.label}>{isLump ? "Scope of Works" : "Line Items"}</label>
          {isLump ? (
            <>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>One deliverable per line — press Enter for each new line. Indent a line (start with spaces) to make it a sub-item. Bullets are added automatically. The price is the single lump sum below.</div>
              <textarea value={f.items[0]?.description || ""} onChange={(e) => updateItem(0, "description", e.target.value)} placeholder={"Redrawing the plans for CC approval with:\n   RLs to the floor areas\n   Wall Schedule\n   Window Schedule"} style={{ ...s.input, fontSize: 12, minHeight: 150, resize: "vertical", lineHeight: 1.5, fontFamily: "inherit" }} />
            </>
          ) : (
            <>
              {f.items.map((item, idx) => (
                <div key={idx} style={{ marginBottom: 8, padding: 10, background: "#f7f9f8", borderRadius: 6 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "2fr 50px 80px 24px", gap: 6, alignItems: "flex-start" }}>
                    <textarea value={item.description} onChange={(e) => updateItem(idx, "description", e.target.value)} placeholder="Description (you can use multiple lines — heading + sub-items)" rows={1} style={{ ...s.input, fontSize: 12, minHeight: 36, resize: "vertical", lineHeight: 1.4 }} />
                    <input type="number" value={item.qty} onChange={(e) => updateItem(idx, "qty", e.target.value)} placeholder="Qty" style={{ ...s.input, fontSize: 12 }} />
                    <input type="number" step="0.01" value={item.rate} onChange={(e) => updateItem(idx, "rate", e.target.value)} placeholder="Rate" style={{ ...s.input, fontSize: 12 }} />
                    {f.items.length > 1 && <button onClick={() => removeItem(idx)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: "8px 0 0" }}><Icons.Trash /></button>}
                  </div>
                  <textarea value={item.note || ""} onChange={(e) => updateItem(idx, "note", e.target.value)} placeholder="Note (optional — shown on PDF)" rows={1} style={{ ...s.input, fontSize: 11, marginTop: 4, color: "#94a3b8", minHeight: 30, resize: "vertical", lineHeight: 1.4 }} />
                </div>
              ))}
              <button onClick={addItem} style={{ ...s.btnOutline, marginTop: 4 }}>+ Add Line</button>
            </>
          )}
        </div>
        <div style={{ marginTop: 12, marginBottom: 16, background: "#f1f5f9", borderRadius: 8, padding: 12 }}>
          {isLump ? (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Lump Sum (AUD)</span>
              <input type="number" step="0.01" value={f.lump_amount} onChange={(e) => setF({ ...f, lump_amount: e.target.value })} placeholder="0.00" style={{ ...s.input, maxWidth: 140, textAlign: "right", fontWeight: 700 }} />
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, color: "#0f172a" }}><span>Total</span><span>{fmt(total)}</span></div>
          )}
        </div>
        <div style={{ marginBottom: 16 }}><label style={s.label}>Notes / Payment Terms</label><textarea value={f.notes} onChange={(e) => { setNotesEdited(true); setF({ ...f, notes: e.target.value }); }} placeholder="Payment terms, notes, etc." style={{ ...s.input, minHeight: 60, resize: "vertical" }} /></div>
        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Terms &amp; Conditions {f.terms ? "(prints on its own page at the end)" : "(optional)"}</label>
          <textarea value={f.terms || ""} onChange={(e) => { setTermsEdited(true); setF({ ...f, terms: e.target.value }); }} placeholder="Full terms & conditions — printed on a separate page at the end of the PDF. Leave blank for none." style={{ ...s.input, minHeight: 120, resize: "vertical", lineHeight: 1.5 }} />
        </div>
        {canCompose ? (<>
          <button disabled={saving} onClick={async () => { setSaving(true); await saveAndCompose(); setSaving(false); }} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", opacity: saving ? 0.5 : 1, gap: 6 }}>{saving ? "Saving…" : <><Icons.Send /> {existing ? "Save" : "Create"} &amp; Email…</>}</button>
          <button disabled={saving} onClick={async () => { setSaving(true); await saveInv(); setSaving(false); }} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", marginTop: 8, opacity: saving ? 0.5 : 1 }}>{saving ? "Saving…" : `${existing ? "Save" : "Create"} only (email later)`}</button>
        </>) : (
          <button disabled={saving} onClick={async () => { setSaving(true); await saveInv(); setSaving(false); }} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", opacity: saving ? 0.5 : 1 }}>{saving ? "Saving…" : `${existing ? "Update" : "Create"} ${f.type === "quote" ? "Quote" : "Invoice"}`}</button>
        )}
        {f.type === "quote" && (
          <button onClick={saveAsTemplate} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", marginTop: 8, gap: 6 }}>☆ Save as Template</button>
        )}
        {existing && (<>
          {/* Emailing goes through "Save & Email…" (the compose window) above.
              An Outlook-draft handoff still lives in the list ⋯ menu for power users. */}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={() => downloadPDF(existing)} disabled={pdfLoading === existing.id} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: pdfLoading === existing.id ? "#94a3b8" : "#8b5cf6", borderColor: "#8b5cf640", gap: 6, opacity: pdfLoading === existing.id ? 0.5 : 1 }}>
              <Icons.Download /> {pdfLoading === existing.id ? "Generating…" : "Download PDF"}
            </button>
            {f.type !== "quote" && (existing.status === "sent" || existing.status === "overdue") && (
              <button onClick={() => sendReminderViaResend(existing)} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#f59e0b", borderColor: "#f59e0b40", gap: 6 }}>
                ! Email Reminder
              </button>
            )}
          </div>
          {f.type === "quote" && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              {existing.status !== "accepted" && (
                <button onClick={async () => { const inv = { ...f, total }; await updateInvoice(existing.id, inv); const proj = await acceptQuote({ ...existing, ...inv }); setModal(null); setEditItem(null); if (proj) { alert(`Quote accepted and added to project "${proj.name}".`); await offerDepositInvoice({ ...existing, ...inv, status: "accepted" }, proj); } }} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#10b981", borderColor: "#10b98140", gap: 6 }}>
                  <Icons.Check /> Accept Quote
                </button>
              )}
              <button onClick={convertToInvoice} style={{ ...s.btn(accent), flex: 1, justifyContent: "center", gap: 6 }}>
                <Icons.Invoices /> Convert to Invoice
              </button>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {existing.status !== "paid" && f.type !== "quote" && (
              <button onClick={() => { markPaid(existing); setModal(null); setEditItem(null); }} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#34d399", borderColor: "#34d39940", gap: 6 }}>
                <Icons.Check /> Mark Paid
              </button>
            )}
            <button onClick={() => deleteInvoice(existing.id)} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#ef4444", borderColor: "#ef444440", gap: 6 }}>
              <Icons.Trash /> Delete
            </button>
          </div>
        </>)}
      </div>
    );
  };

  const ProjectForm = ({ existing }) => {
    const init = existing
      ? { name: existing.name || "", address: existing.address || "", notes: existing.notes || "", status: existing.status || "active", application_type: existing.application_type || "", job_number: existing.job_number || "" }
      : { name: "", address: "", notes: "", status: "active", application_type: "", job_number: getNextJobNumber(jobs) };
    // Draft survival across a remount (see projectDraftRef), keyed to this
    // project so a draft can't bleed into another one. This also covers the
    // saved-project edit path: attaching/removing a contact there remounts the
    // form, which would otherwise discard unsaved edits *and* silently drop the
    // user out of edit mode (editMode re-initialises to !existing === false).
    const draftKey = existing ? `id:${existing.id}` : "new";
    const pDraft = projectDraftRef.current && projectDraftRef.current.key === draftKey ? projectDraftRef.current : null;
    const [f, setF] = useState(() => pDraft?.f || init);
    const [saving, setSaving] = useState(false);
    // Existing projects open read-only; Edit unlocks the fields. New projects
    // start straight in edit mode. Dirty tracking mirrors InvoiceForm so the
    // backdrop/X only nag about unsaved changes when there actually are any.
    const [editMode, setEditMode] = useState(() => (pDraft ? pDraft.editMode : !existing));
    const initialSnapshot = useRef(JSON.stringify(init));
    useEffect(() => { formDirtyRef.current = editMode && JSON.stringify(f) !== initialSnapshot.current; }, [f, editMode]);
    // Application type options: built-ins + any custom types already in use.
    const [appTypeCustom, setAppTypeCustom] = useState(() => (pDraft ? pDraft.appTypeCustom : false));
    const appTypeOptions = [...new Set([...APPLICATION_TYPES, ...jobs.map((j) => j.application_type).filter(Boolean), ...(f.application_type ? [f.application_type] : [])])];
    // Clients/consultants attached to this project. Existing projects edit the
    // live bk_job_parties rows; new projects collect locally and save on create.
    const [newParties, setNewParties] = useState(() => (existing ? [] : (pDraft?.newParties || [])));
    const partyList = existing ? jobParties.filter((p) => p.job_id === existing.id) : newParties;
    const partyContactOf = (p) => contacts.find((c) => c.id === p.contact_id);
    const availableContacts = contacts.filter((c) => !partyList.some((p) => p.contact_id === c.id));
    const [pickId, setPickId] = useState(() => pDraft?.pickId || "");
    const [pickRole, setPickRole] = useState(() => pDraft?.pickRole || "client");
    const pickContact = (id) => { setPickId(id); const c = contacts.find((x) => x.id === id); if (c) setPickRole(c.type === "consultant" ? "consultant" : "client"); };
    const addParty = async () => {
      if (!pickId) return;
      if (existing) await addJobParty(existing.id, pickId, pickRole);
      else setNewParties((prev) => [...prev, { contact_id: pickId, role: pickRole }]);
      setPickId("");
    };
    const removeParty = async (p) => {
      if (existing) await removeJobParty(p.id);
      else setNewParties((prev) => prev.filter((x) => x.contact_id !== p.contact_id));
    };
    const [pQuickAdd, setPQuickAdd] = useState(() => pDraft?.pQuickAdd ?? false);
    const [pQa, setPQa] = useState(() => pDraft?.pQa || { name: "", company: "", email: "", phone: "" });
    // Keep the draft current so any remount restores the latest values.
    const liveDraft = { key: draftKey, f, newParties, editMode, appTypeCustom, pickId, pickRole, pQuickAdd, pQa };
    useEffect(() => { projectDraftRef.current = liveDraft; });
    const quickAddParty = async () => {
      const inserted = await addContact({ ...pQa, type: pickRole, abn: "", address: "", notes: "" }, true);
      if (!inserted) return;
      if (existing) await addJobParty(existing.id, inserted.id, pickRole);
      else {
        const nextParties = [...newParties, { contact_id: inserted.id, role: pickRole }];
        // addContact() ran setContacts(), which remounts this form; persist the
        // new party + current fields now so the fresh instance restores them.
        projectDraftRef.current = { ...liveDraft, newParties: nextParties };
        setNewParties(nextParties);
      }
      setPQa({ name: "", company: "", email: "", phone: "" });
      setPQuickAdd(false);
    };
    // Job/project number: shown read-only in view mode; editable in edit mode
    // (new projects pre-fill the next number in the business-wide sequence).
    const projNumber = existing ? (existing.job_number || "—") : f.job_number;
    const t = existing ? projectTotals(existing, invoices) : { contract: 0, invoiced: 0, paid: 0, remaining: 0, outstanding: 0, leftToInvoice: 0 };
    const consultants = existing ? projectConsultants(existing, invoices) : [];
    const statusColors = { draft: "#64748b", sent: "#3b82f6", paid: "#34d399", overdue: "#ef4444", accepted: "#34d399", declined: "#64748b" };
    const pct = t.contract > 0 ? Math.min(100, Math.round((t.paid / t.contract) * 100)) : 0;
    const save = async () => {
      // Manual number is allowed, but warn if it collides with another project.
      const num = (f.job_number || "").trim();
      if (num) {
        const clash = jobs.find((j) => j.id !== existing?.id && String(j.job_number || "") === num);
        if (clash && !window.confirm(`Project #${num} is already used by "${projectLabel(clash)}".\n\nUse it anyway?`)) return;
      }
      if (existing) {
        const updated = await updateProject(existing.id, f);
        if (updated) { initialSnapshot.current = JSON.stringify(f); formDirtyRef.current = false; setEditItem(updated); setEditMode(false); }
      } else {
        // Only tear the form down once the insert actually succeeded. createProject
        // returns null on failure (RLS, network, missing division migration) — the
        // user gets an error alert, so closing here would delete everything they
        // typed with no way back. Mirrors the `if (updated)` guard above.
        const created = await createProject({ ...f, parties: newParties });
        if (created) {
          projectDraftRef.current = null;
          formDirtyRef.current = false;
          setModal(null);
          setEditItem(null);
        }
      }
    };
    const cancelEdit = () => { setF(init); setAppTypeCustom(false); formDirtyRef.current = false; setEditMode(false); };
    const projStatusMeta = { active: { label: "Active", color: "#10b981" }, lead: { label: "Lead", color: "#f59e0b" }, job_lost: { label: "Job Lost", color: "#94a3b8" }, finalised: { label: "Finalised", color: "#3b82f6" } };
    const openDoc = (inv) => { setEditItem(inv); setModal("invoice"); };
    const newDoc = (type, contactName) => { setInvoiceSeed({ type, project_id: existing.id, projectName: projectLabel(existing), contact_name: contactName || "" }); setEditItem(null); setModal("invoice"); };

    const Stat = ({ label, value, color }) => (
      <div style={{ flex: 1, minWidth: 80 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#94a3b8" }}>{label}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: color || "#0f172a", marginTop: 2 }}>{fmt(value)}</div>
      </div>
    );

    const DocRow = ({ d, action }) => (
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: "#fff", border: "1px solid #eef2f6", borderRadius: 6, marginBottom: 5 }}>
        <span style={{ fontWeight: 600, fontSize: 12, cursor: "pointer" }} onClick={() => openDoc(d)}>{d.number}</span>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>{d.date ? fmtDate(d.date) : ""}</span>
        <span style={s.badge(statusColors[d.status] || "#64748b")}>{d.status}</span>
        <span style={{ marginLeft: "auto", fontWeight: 600, fontSize: 12 }}>{fmt(d.total || 0)}</span>
        {action}
      </div>
    );

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{existing ? (projectLabel(existing) || "Project") : "New Project"}</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {existing && !editMode && (
              <button onClick={() => setEditMode(true)} style={{ ...s.btnOutline, fontSize: 11, gap: 5 }}><Icons.Edit /> Edit</button>
            )}
            <button onClick={() => requestCloseModal()} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <span style={{ ...s.label, margin: 0 }}>Project #</span>
          {editMode ? (
            <>
              <input value={f.job_number} onChange={(e) => setF({ ...f, job_number: e.target.value })} style={{ ...s.input, width: 110, fontWeight: 700, color: accent, fontVariantNumeric: "tabular-nums" }} />
              <span style={{ fontSize: 11, color: "#94a3b8" }}>{existing ? "editable" : "next in sequence — editable"}</span>
            </>
          ) : (
            <span style={{ fontWeight: 700, fontSize: 14, color: accent, fontVariantNumeric: "tabular-nums" }}>{projNumber}</span>
          )}
          {!editMode && existing && existing.application_type && <span style={s.badge(accent)}>{existing.application_type}</span>}
          {!editMode && existing && <span style={s.badge((projStatusMeta[existing.status || "active"] || projStatusMeta.active).color)}>{(projStatusMeta[existing.status || "active"] || projStatusMeta.active).label}</span>}
        </div>

        {existing && (
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Stat label="Contract" value={t.contract} />
              <Stat label="Invoiced" value={t.invoiced} color="#3b82f6" />
              <Stat label="Paid" value={t.paid} color="#10b981" />
              <Stat label="Remaining" value={t.remaining} color={t.remaining > 0 ? "#0f172a" : "#10b981"} />
            </div>
            <div style={{ height: 8, background: "#e2e8f0", borderRadius: 4, marginTop: 12, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: "#10b981" }} />
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>{pct}% paid · {fmt(t.outstanding)} invoiced but unpaid{t.quoted > 0 ? ` · ${fmt(t.quoted)} quoted` : " · no accepted quote (using invoiced)"}</div>
          </div>
        )}

        {!editMode && existing && (
          <>
            {existing.name ? (
              <div style={{ marginBottom: 12 }}>
                <label style={s.label}>Description</label>
                <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.5 }}>{existing.name}</div>
              </div>
            ) : null}
            {existing.notes ? (
              <div style={{ marginBottom: 12 }}>
                <label style={s.label}>Notes</label>
                <div style={{ fontSize: 12.5, color: "#64748b", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{existing.notes}</div>
              </div>
            ) : null}
            <div style={{ marginBottom: 16 }}>
              <label style={s.label}>Clients &amp; Consultants</label>
              {partyList.length === 0 ? (
                <div style={{ fontSize: 12, color: "#94a3b8" }}>None attached yet — hit Edit to add people.</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {partyList.map((p) => { const c = partyContactOf(p); if (!c) return null; return (
                    <span key={p.contact_id} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #e2e8f0", background: "#f8fafc", borderRadius: 16, padding: "4px 10px", fontSize: 12, fontWeight: 600 }}>
                      {c.name || c.company}
                      <span style={s.badge(p.role === "consultant" ? "#8b5cf6" : "#34d399")}>{p.role}</span>
                    </span>
                  ); })}
                </div>
              )}
            </div>
          </>
        )}

        {editMode && (<>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Address (shown as the project label)</label><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="e.g. 10 Mcpherson Road Smeaton Grange NSW" style={s.input} /></div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}>
            <label style={s.label}>Application Type</label>
            {appTypeCustom ? (
              <div style={{ display: "flex", gap: 4 }}>
                <input autoFocus value={f.application_type} onChange={(e) => setF({ ...f, application_type: e.target.value })} placeholder="e.g. OC" style={{ ...s.input, flex: 1 }} />
                <button type="button" onClick={() => setAppTypeCustom(false)} title="Done" style={{ background: accent, border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "0 10px", fontSize: 13, fontWeight: 700 }}>✓</button>
              </div>
            ) : (
              <select value={f.application_type || ""} onChange={(e) => { if (e.target.value === "__custom") { setAppTypeCustom(true); setF({ ...f, application_type: "" }); } else setF({ ...f, application_type: e.target.value }); }} style={s.select}>
                <option value="">None</option>
                {appTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
                <option value="__custom">+ Add new type…</option>
              </select>
            )}
          </div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Status</label><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={s.select}><option value="active">Active</option><option value="job_lost">Job Lost</option><option value="lead">Lead</option><option value="finalised">Finalised</option></select></div>
        </div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Name / Description</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Construction Certificate - Gym" style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Notes</label><textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Notes (optional)" style={{ ...s.input, minHeight: 50, resize: "vertical" }} /></div>

        <div style={{ marginBottom: 16 }}>
          <label style={s.label}>Clients &amp; Consultants</label>
          {partyList.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
              {partyList.map((p) => { const c = partyContactOf(p); if (!c) return null; return (
                <span key={p.contact_id} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #e2e8f0", background: "#f8fafc", borderRadius: 16, padding: "4px 10px", fontSize: 12, fontWeight: 600 }}>
                  {c.name || c.company}
                  <span style={s.badge(p.role === "consultant" ? "#8b5cf6" : "#34d399")}>{p.role}</span>
                  <button onClick={() => removeParty(p)} title="Remove from project" style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>✕</button>
                </span>
              ); })}
            </div>
          )}
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <select value={pickId} onChange={(e) => pickContact(e.target.value)} style={{ ...s.select, flex: 1 }}>
              <option value="">Add a contact…</option>
              {availableContacts.map((c) => <option key={c.id} value={c.id}>{(c.name || c.company) + (c.type === "consultant" ? " · consultant" : c.type === "supplier" ? " · supplier" : "")}</option>)}
            </select>
            <div style={{ display: "inline-flex", border: "1px solid #e2e8f0", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
              {[["client", "Client"], ["consultant", "Consultant"]].map(([val, lbl]) => (
                <button key={val} type="button" onClick={() => setPickRole(val)} style={{ background: pickRole === val ? accent : "transparent", color: pickRole === val ? "#fff" : "#64748b", border: "none", cursor: "pointer", padding: "7px 9px", fontSize: 10.5, fontWeight: 700 }}>{lbl}</button>
              ))}
            </div>
            <button type="button" disabled={!pickId} onClick={addParty} title="Add to project" style={{ background: accent, border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "0 10px", fontSize: 16, fontWeight: 700, lineHeight: "30px", opacity: pickId ? 1 : 0.4 }}>+</button>
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 5 }}>
            Attach one or many — quotes for this project offer these people first.{" "}
            <button type="button" onClick={() => setPQuickAdd((v) => !v)} style={{ background: "none", border: "none", color: accent, cursor: "pointer", padding: 0, fontSize: 11, fontWeight: 700 }}>+ New contact</button>
          </div>
          {pQuickAdd && (
            <div style={{ background: "#f1f5f9", borderRadius: 8, padding: 12, marginTop: 8, border: `1px solid ${accent}30` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: accent, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Quick Add {pickRole === "consultant" ? "Consultant" : "Client"}</div>
              <div style={s.grid2}>
                <div style={{ marginBottom: 8 }}><input value={pQa.name} onChange={(e) => setPQa({ ...pQa, name: e.target.value })} placeholder="Name" style={{ ...s.input, fontSize: 12 }} /></div>
                <div style={{ marginBottom: 8 }}><input value={pQa.company} onChange={(e) => setPQa({ ...pQa, company: e.target.value })} placeholder="Company" style={{ ...s.input, fontSize: 12 }} /></div>
              </div>
              <div style={s.grid2}>
                <div style={{ marginBottom: 8 }}><input value={pQa.email} onChange={(e) => setPQa({ ...pQa, email: e.target.value })} placeholder="Email" style={{ ...s.input, fontSize: 12 }} /></div>
                <div style={{ marginBottom: 8 }}><input value={pQa.phone} onChange={(e) => setPQa({ ...pQa, phone: e.target.value })} placeholder="Phone" style={{ ...s.input, fontSize: 12 }} /></div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button disabled={!pQa.name && !pQa.company} onClick={quickAddParty} style={{ ...s.btn(accent), fontSize: 12, opacity: !pQa.name && !pQa.company ? 0.4 : 1 }}>Add & Attach</button>
                <button onClick={() => { setPQuickAdd(false); setPQa({ name: "", company: "", email: "", phone: "" }); }} style={{ ...s.btnOutline, fontSize: 12 }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        </>)}

        {existing && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ ...s.label, margin: 0 }}>Quotes &amp; Invoices by Contact ({consultants.length})</label>
              <button onClick={() => newDoc("quote")} style={{ ...s.btn(accent, true), fontSize: 11 }}><Icons.Plus /> New Quote</button>
            </div>
            {consultants.length === 0 ? (
              <div style={{ fontSize: 12, color: "#94a3b8", padding: "8px 0" }}>No quotes or invoices yet. Add a quote per consultant/client — each accepted quote adds to the contract.</div>
            ) : consultants.map((c) => (
              <div key={c.name} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>quoted {fmt(c.contract)} · paid {fmt(c.paid)} · <span style={{ fontWeight: 700, color: c.remaining > 0 ? "#0f172a" : "#10b981" }}>{fmt(c.remaining)} left</span></div>
                </div>
                {c.quotes.map((q) => (
                  <DocRow key={q.id} d={q} action={q.status !== "accepted" && q.status !== "declined" ? <button onClick={async () => { if (!confirmLeaveDirtyForm("project")) return; const proj = await acceptQuote(q); if (proj) await offerDepositInvoice(q, proj); }} style={{ ...s.btn("#10b981", true), fontSize: 11 }}><Icons.Check /> Accept</button> : null} />
                ))}
                {c.invoices.map((iv) => (
                  <DocRow key={iv.id} d={iv} action={iv.status !== "paid" ? <button onClick={() => markPaidQuiet(iv)} style={{ ...s.btnOutline, fontSize: 11, color: "#34d399", borderColor: "#34d39940" }}><Icons.Check /> Paid</button> : null} />
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button onClick={() => newDoc("quote", c.name)} style={{ ...s.btnOutline, fontSize: 11 }}>+ Quote</button>
                  <button onClick={() => newDoc("invoice", c.name)} style={{ ...s.btnOutline, fontSize: 11 }}>+ Invoice</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {editMode && (<>
          <button disabled={saving || !(f.name.trim() || (f.address || "").trim())} onClick={async () => { setSaving(true); await save(); setSaving(false); }} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", opacity: saving || !(f.name.trim() || (f.address || "").trim()) ? 0.5 : 1 }}>{saving ? "Saving…" : existing ? "Save Changes" : "Create Project"}</button>
          {existing && (
            <button onClick={cancelEdit} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", marginTop: 8 }}>Cancel</button>
          )}
          {existing && (
            <button onClick={() => deleteProject(existing.id)} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", color: "#ef4444", borderColor: "#ef444440", gap: 6, marginTop: 8 }}><Icons.Trash /> Delete Project</button>
          )}
        </>)}
      </div>
    );
  };



  // Operational dashboard: what is owed, what is late, and what needs a decision.
  // Deliberately no accounting metrics — MYOB owns those now.
  const DashboardPage = () => {
    // Two roots. The lifetime one feeds the debtor figures: money still owed and
    // quotes still unanswered do not belong to a financial year. The FY one feeds
    // everything that is genuinely a period metric.
    const realInvoices = divInvoices.filter((i) => i.type !== "quote");
    const quotes = divInvoices.filter((i) => i.type === "quote");
    const fyRealInvoices = fyInvoices.filter((i) => i.type !== "quote");
    const unpaid = realInvoices.filter((i) => i.status === "sent" || i.status === "overdue");
    const outstanding = unpaid.reduce((sum, i) => sum + Number(i.total || 0), 0);
    const overdueInvoices = unpaid.filter((i) => daysOverdue(i) > 0).sort((a, b) => daysOverdue(b) - daysOverdue(a));
    const overdueTotal = overdueInvoices.reduce((sum, i) => sum + Number(i.total || 0), 0);
    // Was "paid this month", which a financial year can only ever contain one of;
    // under any past FY it read $0.00 permanently. Anchored on the issue date, the
    // same field the FY filter uses, rather than the old (paid_date || date) mix
    // that put some rows on a cash basis and others on an accrual one.
    const paidThisFY = fyRealInvoices.filter((i) => i.status === "paid");
    const paidThisFYTotal = paidThisFY.reduce((sum, i) => sum + Number(i.total || 0), 0);
    const activeProjects = fyJobs.filter((p) => (p.status || "active") === "active");
    const projectsRemaining = activeProjects.reduce((sum, p) => sum + projectTotals(p, divInvoices).remaining, 0);
    const openQuotes = quotes.filter((q) => q.status === "sent");
    // Projects that still have accepted-quote value left to invoice.
    //
    // Deliberately computed per PROJECT, not per quote. An invoice raised the
    // normal way carries no link back to the quote it fulfils — only the
    // deposit-on-accept flow sets converted_from_quote_id — so asking "has this
    // quote been invoiced?" answers no for almost every quote, while hiding the
    // ones that genuinely still owe an invoice.
    const ISSUED_STATUSES = new Set(["sent", "overdue", "paid"]);
    // The project SET is FY-scoped; the documents behind each figure are not.
    // Slicing the docs would invent phantom balances wherever an accepted quote
    // and the invoices fulfilling it fall either side of 30 June.
    const leftToInvoice = fyJobs.map((proj) => {
      const docs = divInvoices.filter((d) => d.project_id === proj.id);
      if (!docs.some((d) => d.type === "quote" && d.status === "accepted")) return null;
      const quoted = docs.filter((d) => d.type === "quote" && d.status === "accepted").reduce((sum, d) => sum + Number(d.total || 0), 0);
      const issued = docs.filter((d) => d.type === "invoice" && ISSUED_STATUSES.has(d.status)).reduce((sum, d) => sum + Number(d.total || 0), 0);
      return { proj, remaining: quoted - issued };
    }).filter((x) => x && x.remaining > 0.01);
    const draftDocs = fyInvoices.filter((i) => i.status === "draft");
    const recentInvoices = [...fyRealInvoices].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 6);
    const topProjects = activeProjects.map((p) => ({ p, t: projectTotals(p, divInvoices) })).sort((a, b) => b.t.remaining - a.t.remaining).slice(0, 6);
    const attention = [
      ...overdueInvoices.slice(0, 4).map((i) => ({ key: "o" + i.id, tone: "#ef4444", label: `${i.number} — ${daysOverdue(i)} day${daysOverdue(i) === 1 ? "" : "s"} overdue`, sub: i.contact_name || i.contact_company || "", amount: i.total, go: () => { setEditItem(i); setModal("invoice"); } })),
      ...leftToInvoice.slice(0, 3).map(({ proj, remaining }) => ({ key: "a" + proj.id, tone: "#0ea5e9", label: `${proj.job_number || "Project"} — left to invoice`, sub: projectLabel(proj), amount: remaining, go: () => { setEditItem(proj); setModal("project"); } })),
      ...draftDocs.slice(0, 3).map((d) => ({ key: "d" + d.id, tone: "#94a3b8", label: `${d.number} still a draft`, sub: d.contact_name || d.contact_company || "", amount: d.total, go: () => { setEditItem(d); setModal("invoice"); } })),
    ];

    const tile = (label, value, sub, opts = {}) => (
      <div className={opts.onClick ? "bk-card-hover" : undefined} style={{ ...s.statCard(), cursor: opts.onClick ? "pointer" : "default" }} onClick={opts.onClick}>
        <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
        <div style={{ marginTop: 8 }}><MoneyBig value={value} color={opts.color} /></div>
        <div style={{ fontSize: 12, color: opts.subColor || "#065f46", marginTop: 6, fontWeight: 500 }}>{sub}</div>
      </div>
    );

    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
          {tile("Outstanding", outstanding, `${unpaid.length} unpaid · all time`, { onClick: () => setPage("invoices") })}
          {tile("Overdue", overdueTotal, overdueInvoices.length ? `${overdueInvoices.length} past due · all time` : "nothing late · all time", { color: overdueTotal > 0 ? "#b91c1c" : undefined, subColor: overdueTotal > 0 ? "#b91c1c" : "#94a3b8", onClick: () => setPage("invoices") })}
          {tile("Paid", paidThisFYTotal, `${paidThisFY.length} invoice${paidThisFY.length === 1 ? "" : "s"} · ${fyTag}`)}
          {tile("Active Projects", projectsRemaining, `${activeProjects.length} active · remaining`, { onClick: () => setPage("projects") })}
        </div>

        {attention.length > 0 && (
          <div style={s.card}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700 }}>Needs attention</h4>
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}><tbody>
                {attention.map((a) => (
                  <tr key={a.key} onClick={a.go} style={{ cursor: "pointer" }}>
                    <td style={{ ...s.td, width: 6, paddingRight: 0 }}><span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 3, background: a.tone }} /></td>
                    <td style={{ ...s.td, fontWeight: 500 }}>{a.label}<div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>{a.sub}</div></td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(a.amount || 0)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          </div>
        )}

        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Recent Invoices <span style={{ fontWeight: 500, color: "#94a3b8", fontSize: 12 }}>· {fyTag}</span></h4>
            <button onClick={() => setPage("invoices")} style={s.btnOutline}>View All</button>
          </div>
          {recentInvoices.length === 0 ? (
            <div style={{ color: "#94a3b8", fontSize: 12, padding: "20px 0", textAlign: "center" }}>No invoices in {fyTag}</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}><tbody>
                {recentInvoices.map((inv) => (
                  <tr key={inv.id} onClick={() => { setEditItem(inv); setModal("invoice"); }} style={{ cursor: "pointer" }}>
                    <td style={{ ...s.td, color: "#94a3b8", width: 70, fontSize: 11 }}>{fmtDate(inv.date)}</td>
                    <td style={{ ...s.td, fontWeight: 500 }}>{inv.number}<div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>{inv.contact_name || inv.contact_company || ""}</div></td>
                    <td style={{ ...s.td }}><span style={s.badge(statusBadge(inv.status).color)}>{statusBadge(inv.status).label}</span></td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(inv.total || 0)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </div>

        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Active Projects</h4>
            <button onClick={() => setPage("projects")} style={s.btnOutline}>View All</button>
          </div>
          {topProjects.length === 0 ? (
            <div style={{ color: "#94a3b8", fontSize: 12, padding: "20px 0", textAlign: "center" }}>No active projects</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}><tbody>
                {topProjects.map(({ p, t }) => (
                  <tr key={p.id} onClick={() => { setEditItem(p); setModal("project"); }} style={{ cursor: "pointer" }}>
                    <td style={{ ...s.td, color: "#94a3b8", width: 70, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{p.job_number || ""}</td>
                    <td style={{ ...s.td, fontWeight: 500 }}>{projectLabel(p)}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(t.remaining)}<div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 400 }}>remaining</div></td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </div>

        {openQuotes.length > 0 && (
          <div className="bk-card-hover" style={{ ...s.card, cursor: "pointer" }} onClick={() => setPage("quotes")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Quotes awaiting a decision</h4>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{openQuotes.length} sent · {fmt(openQuotes.reduce((sum, q) => sum + Number(q.total || 0), 0))} · all time</div>
              </div>
              <span style={{ fontSize: 20, color: "#94a3b8" }}>→</span>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginTop: 12 }}>
          <button onClick={() => { setEditItem(null); setInvoiceSeed({ type: "invoice" }); setModal("invoice"); }} style={{ ...s.btn("#3b82f6"), justifyContent: "center", padding: "14px" }}><Icons.Plus /> New Invoice</button>
          <button onClick={() => { setEditItem(null); setInvoiceSeed({ type: "quote" }); setModal("invoice"); }} style={{ ...s.btn(accent), justifyContent: "center", padding: "14px" }}><Icons.Plus /> New Quote</button>
          <button onClick={() => { projectDraftRef.current = null; setEditItem(null); setModal("project"); }} style={{ ...s.btn("#6366f1"), justifyContent: "center", padding: "14px" }}><Icons.Plus /> New Project</button>
        </div>
      </div>
    );
  };


  const DocList = ({ docType }) => {
    const isQuoteList = docType === "quote";
    // Filter/search/sort come from parent-persisted docView so they survive the
    // page remount on every action. Selection + menu stay local (resetting those
    // after an action is the desired behaviour).
    const view = docView[docType];
    const { filter, jobFilter, search, sortKey, sortDir } = view;
    const patchView = (patch) => setDocView((prev) => ({ ...prev, [docType]: { ...prev[docType], ...patch } }));
    const setFilter = (v) => patchView({ filter: v });
    const setJobFilter = (v) => patchView({ jobFilter: v });
    const setSearch = (v) => patchView({ search: v });
    const setSortKey = (v) => patchView({ sortKey: v });
    const setSortDir = (v) => patchView({ sortDir: typeof v === "function" ? v(view.sortDir) : v });
    const [selected, setSelected] = useState(() => new Set());
    const [menu, setMenu] = useState(null); // overflow "⋯" menu: { id, x, y } | null
    const statusTabs = isQuoteList ? ["all", "draft", "sent", "accepted", "declined"] : ["all", "outstanding", "paid", "overdue", "draft"];
    const ofType = (i) => isQuoteList ? i.type === "quote" : i.type !== "quote";
    const byDateDesc = (a, b) => (b.date || "").localeCompare(a.date || "");
    const sorted = fyInvoices.filter(ofType).sort(byDateDesc);
    // Debtor views ignore the FY. An unpaid invoice, or a quote nobody has
    // answered, is still open work whichever year it was issued in, so
    // Outstanding/Overdue (and Awaiting, for quotes) read the lifetime set.
    const allTime = divInvoices.filter(ofType).sort(byDateDesc);
    const debtorFilter = isQuoteList ? filter === "sent" : (filter === "outstanding" || filter === "overdue");
    const filtered = (debtorFilter ? allTime : sorted).filter((i) => {
      if (filter === "outstanding") { if (i.status !== "sent" && i.status !== "overdue") return false; } else if (filter !== "all" && i.status !== filter) return false;
      if (jobFilter && i.job !== jobFilter) return false;
      if (search && !(i.number || "").toLowerCase().includes(search.toLowerCase()) && !(i.contact_name || "").toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    const statusColors = { draft: "#64748b", sent: "#3b82f6", paid: "#34d399", overdue: "#ef4444", accepted: "#34d399", declined: "#64748b" };
    const sumTotals = (arr) => arr.reduce((acc, i) => acc + Number(i.total || 0), 0);
    // Each tab counts the set its own filter will actually draw from, so the
    // number on the pill always matches the rows behind it.
    const tabs = statusTabs.map((st) => {
      const debtorTab = isQuoteList ? st === "sent" : (st === "outstanding" || st === "overdue");
      const src = debtorTab ? allTime : sorted;
      return { key: st, label: st.charAt(0).toUpperCase() + st.slice(1), count: st === "all" ? sorted.length : st === "outstanding" ? src.filter((i) => i.status === "sent" || i.status === "overdue").length : src.filter((i) => i.status === st).length };
    });
    const fyNote = fy === ALL_FY ? null : fyLabel(fy);
    const tiles = isQuoteList
      ? [{ label: "Total quoted", value: fmt(sumTotals(sorted)), note: fyNote }, { label: "Accepted", value: fmt(sumTotals(sorted.filter((i) => i.status === "accepted"))), color: "#10b981", note: fyNote }, { label: "Awaiting", value: fmt(sumTotals(allTime.filter((i) => i.status === "draft" || i.status === "sent"))), color: "#3b82f6", note: "all time" }]
      : [{ label: "Invoiced", value: fmt(sumTotals(sorted.filter((i) => i.status !== "draft"))), note: fyNote }, { label: "Outstanding", value: fmt(sumTotals(allTime.filter((i) => i.status === "sent" || i.status === "overdue"))), color: "#3b82f6", note: "all time" }, { label: "Overdue", value: fmt(sumTotals(allTime.filter((i) => i.status === "overdue"))), color: "#ef4444", note: "all time" }];

    // Invoices: MYOB-style sortable columns + bulk selection. Quotes keep the
    // original date-sorted list untouched.
    const balanceOf = (i) => i.status === "paid" ? 0 : Number(i.total || 0);
    const sortVal = (i) => ({ date: i.date || "", number: i.number || "", customer: (i.contact_name || i.contact_company || "").toLowerCase(), total: Number(i.total || 0), balance: balanceOf(i), due_date: i.due_date || "" })[sortKey] ?? "";
    const rows = isQuoteList ? filtered : [...filtered].sort((a, b) => {
      const va = sortVal(a), vb = sortVal(b);
      const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sortDir === "asc" ? cmp : -cmp;
    });
    const allSelected = rows.length > 0 && rows.every((i) => selected.has(i.id));
    const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((i) => i.id)));
    const toggleOne = (id) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

    const SortTh = ({ label, k, align }) => (
      <th onClick={() => { if (sortKey === k) setSortDir((d) => d === "asc" ? "desc" : "asc"); else { setSortKey(k); setSortDir("asc"); } }} style={{ ...s.th, textAlign: align || "left", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{label}<span style={{ fontSize: 9, color: sortKey === k ? "#0f172a" : "#cbd5e1" }}>{sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span></span>
      </th>
    );

    // Two primary actions inline (Send, Mark paid / Accept); everything else lives
    // in the "⋯" overflow menu (rendered once at list level, below).
    const actionsCell = (inv) => {
      const primaryDone = isQuoteList ? (inv.status === "accepted" || inv.status === "declined") : (inv.status === "paid");
      return (
        <td style={{ ...s.td, whiteSpace: "nowrap", textAlign: "right" }}>
          <div style={{ display: "inline-flex", gap: 2, alignItems: "center", justifyContent: "flex-end" }}>
            <button onClick={() => viewInvoice(inv)} title="View" style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 4 }}><Icons.Eye /></button>
            <button onClick={async () => { if (emailConn) { openComposeFor(inv); } else { sendInvoice(inv); await offerMarkSent(inv); } }} disabled={outlookDraftLoading === inv.id} title={emailConn ? "Compose email (PDF attached)" : "Send via email app"} style={{ background: "none", border: "none", color: "#3b82f6", cursor: outlookDraftLoading === inv.id ? "wait" : "pointer", padding: 4 }}>{outlookDraftLoading === inv.id ? "…" : <Icons.Send />}</button>
            {!primaryDone && <button onClick={async () => { if (isQuoteList) { const proj = await acceptQuote(inv); if (proj) await offerDepositInvoice(inv, proj); } else { markPaid(inv); } }} title={isQuoteList ? "Accept quote" : "Mark paid"} style={{ background: "none", border: "none", color: "#10b981", cursor: "pointer", padding: 4 }}><Icons.Check /></button>}
            <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu((m) => m?.id === inv.id ? null : { id: inv.id, x: r.right, y: r.bottom }); }} title="More actions" style={{ background: menu?.id === inv.id ? "#eef2f6" : "none", border: "none", color: "#64748b", cursor: "pointer", padding: 4, borderRadius: 6 }}><Icons.More /></button>
          </div>
        </td>
      );
    };

    return (
      <div>
        <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          {tiles.map((t) => <ListStat key={t.label} label={t.label} value={t.value} color={t.color} note={t.note} />)}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <FilterPills tabs={tabs} active={filter} onChange={setFilter} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={isQuoteList ? "Search quotes..." : "Search invoices..."} style={{ ...s.input, maxWidth: 180, flex: "1 1 140px", marginLeft: "auto" }} />
          <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} style={{ ...s.select, maxWidth: 180 }}>
            <option value="">All Jobs</option>
            {jobNames.map(j => <option key={j} value={j}>{j}</option>)}
          </select>
        </div>
        <div style={s.card}>
          {!isQuoteList && selected.size > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginBottom: 10, background: "#ecfdf5", border: `1px solid ${accent}30`, borderRadius: 9 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "#065f46" }}>{selected.size} selected</span>
              <button onClick={async () => { const ok = await bulkMarkInvoicesPaid([...selected]); if (ok) setSelected(new Set()); }} style={{ ...s.btnOutline, color: "#059669", borderColor: `${accent}40`, display: "inline-flex", alignItems: "center", gap: 5 }}><Icons.Check /> Mark paid</button>
              <button onClick={async () => { const done = await bulkDeleteInvoices([...selected]); if (done) setSelected(new Set()); }} style={{ ...s.btnOutline, color: "#ef4444", borderColor: "#ef444440", display: "inline-flex", alignItems: "center", gap: 5 }}><Icons.Trash /> Delete</button>
              <button onClick={() => setSelected(new Set())} style={{ ...s.btnOutline, marginLeft: "auto" }}>Clear</button>
            </div>
          )}
          {rows.length === 0 ? (
            <EmptyState icon={isQuoteList ? Icons.Quotes : Icons.Invoices} title={`No ${isQuoteList ? "quotes" : "invoices"} ${filter === "all" && !search && !jobFilter && fy === ALL_FY ? "yet" : "found"}`} hint={filter === "all" && !search && !jobFilter ? (fy === ALL_FY ? `New ${isQuoteList ? "quotes" : "invoices"} you create will appear here.` : `Nothing dated in ${fyLabel(fy)}. Try another financial year.`) : "Try a different filter or search term."} />
          ) : isQuoteList ? (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Number</th><th style={s.th}>Date</th><th style={s.th}>Contact</th><th style={s.th}>Job</th><th style={s.th}>Status</th><th style={{ ...s.th, textAlign: "right" }}>Total</th><th style={{ ...s.th, width: 100 }}></th></tr></thead>
                <tbody>{rows.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{inv.number}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{fmtDate(inv.date)}</td>
                    <td style={s.td}>{inv.contact_name || inv.contact_company || "--"}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{inv.job || ""}</td>
                    <td style={s.td}><span style={s.badge(statusColors[inv.status] || "#64748b")}>{inv.status}</span></td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmt(inv.total || 0)}</td>
                    {actionsCell(inv)}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr>
                  <th style={{ ...s.th, width: 34, textAlign: "center" }}><input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ width: 15, height: 15, accentColor: accent, cursor: "pointer" }} /></th>
                  <SortTh label="Issue date" k="date" />
                  <SortTh label="Invoice no" k="number" />
                  <SortTh label="Customer" k="customer" />
                  <SortTh label="Amount ($)" k="total" align="right" />
                  <SortTh label="Balance due ($)" k="balance" align="right" />
                  <SortTh label="Due date" k="due_date" />
                  <th style={{ ...s.th, width: 100 }}></th>
                </tr></thead>
                <tbody>{rows.map((inv) => {
                  const balance = balanceOf(inv);
                  const od = daysOverdue(inv);
                  return (
                    <tr key={inv.id} style={selected.has(inv.id) ? { background: "#ecfdf5" } : undefined}>
                      <td style={{ ...s.td, textAlign: "center" }}><input type="checkbox" checked={selected.has(inv.id)} onChange={() => toggleOne(inv.id)} style={{ width: 15, height: 15, accentColor: accent, cursor: "pointer" }} /></td>
                      <td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(inv.date)}</td>
                      <td style={{ ...s.td, fontWeight: 600 }}>{inv.number}{inv.stripe_session_id && <span title={`Paid by card — ${fmtNum(inv.paid_amount || inv.total || 0)}${inv.surcharge_amount ? ` (incl. ${fmtNum(inv.surcharge_amount)} surcharge)` : ""}`} style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", color: "#0d9488", border: "1px solid #99f6e4", borderRadius: 4, padding: "1px 5px", verticalAlign: "middle" }}>CARD</span>}</td>
                      <td style={s.td}>{inv.contact_name || inv.contact_company || "--"}</td>
                      <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmtNum(inv.total || 0)}</td>
                      <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap", color: balance === 0 ? "#94a3b8" : "#0f172a" }}>{fmtNum(balance)}</td>
                      <td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(inv.due_date)}{od > 0 && <span style={{ display: "block", color: "#ef4444", fontWeight: 600, fontSize: 10, marginTop: 2 }}>{od} {od === 1 ? "day" : "days"} overdue</span>}</td>
                      {actionsCell(inv)}
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </div>
        {menu && (() => {
          const mi = rows.find((i) => i.id === menu.id);
          if (!mi) return null;
          const item = (label, icon, onClick, danger) => (
            <button key={label} className="bk-menuitem" onClick={() => { setMenu(null); onClick(); }} style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "8px 11px", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: danger ? "#ef4444" : "#334155", textAlign: "left", borderRadius: 7 }}>
              <span style={{ display: "inline-flex", width: 16, justifyContent: "center", color: danger ? "#ef4444" : "#64748b" }}>{icon}</span>{label}
            </button>
          );
          return (
            <>
              <div onClick={() => setMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
              <div style={{ position: "fixed", top: menu.y + 4, left: Math.max(8, menu.x - 212), width: 212, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 11, boxShadow: "0 14px 32px -10px rgba(16,24,40,0.30)", padding: 5, zIndex: 61 }}>
                {emailConn && item("Compose email…", <Icons.Send />, () => openComposeFor(mi))}
                {!emailConn && item("Email via default app", <Icons.Send />, async () => { sendInvoice(mi); await offerMarkSent(mi); })}
                {item("Download PDF", <Icons.Download />, () => downloadPDF(mi))}
                {item("Save to OneDrive", <Icons.Cloud />, () => saveToOneDrive("invoice", mi.id))}
                {item("Edit", <Icons.Edit />, () => { setEditItem(mi); setModal("invoice"); })}
                {!isQuoteList && (mi.status === "sent" || mi.status === "overdue") && item("Send payment reminder", <Icons.Bell />, () => sendReminderViaResend(mi))}
                {!isQuoteList && mi.pay_token && item("Copy pay link", <Icons.Link />, () => {
                  const url = `${API_BASE || "https://bkeeper.netlify.app"}/.netlify/functions/pay-invoice?invoice=${mi.id}&t=${mi.pay_token}`;
                  navigator.clipboard?.writeText(url);
                  alert("Card payment link copied to clipboard.");
                })}
                {item(isQuoteList ? "Delete quote" : "Delete invoice", <Icons.Trash />, () => deleteInvoice(mi.id), true)}
              </div>
            </>
          );
        })()}
      </div>
    );
  };

  const InvoicesPage = () => <DocList docType="invoice" />;
  const QuotesPage = () => <DocList docType="quote" />;

  const ProjectsPage = () => {
    const [statusFilter, setStatusFilter] = useState("all");
    const [search, setSearch] = useState("");
    const [sortKey, setSortKey] = useState("job_number");
    const [sortDir, setSortDir] = useState("asc");
    const consultantsLabel = (parties) => parties.length === 0 ? "—" : parties.length === 1 ? parties[0].name : `${parties.length} consultants/clients`;
    // Billing-derived contacts first; if the project has no docs yet, fall back
    // to the clients/consultants explicitly attached via bk_job_parties.
    const partiesFor = (p) => {
      const derived = projectConsultants(p, divInvoices);
      if (derived.length) return derived;
      return jobParties.filter((x) => x.job_id === p.id).map((x) => { const c = contacts.find((cc) => cc.id === x.contact_id); return { name: c?.name || c?.company || "—" }; });
    };
    const sortVal = (r) => {
      switch (sortKey) {
        case "project": return projectLabel(r.p).toLowerCase();
        case "consultants": return consultantsLabel(r.parties).toLowerCase();
        case "contract": return r.t.contract;
        case "invoiced": return r.t.invoiced;
        case "paid": return r.t.paid;
        case "remaining": return r.t.remaining;
        case "progress": return r.t.contract > 0 ? r.t.paid / r.t.contract : 0;
        default: return r.p.job_number || "";
      }
    };
    // fyJobs, not divJobs: a project is included if it is still open (active or
    // lead) or has a document dated in the FY. Never by created_at — projects run
    // across years, and one started last June is not last year's work.
    // The money in each row still comes from divInvoices, so every total stays a
    // lifetime figure.
    const rows = fyJobs
      .filter((p) => statusFilter === "all" || (p.status || "active") === statusFilter)
      .filter((p) => !search || (p.name || "").toLowerCase().includes(search.toLowerCase()))
      .map((p) => ({ p, t: projectTotals(p, divInvoices), parties: partiesFor(p) }))
      .sort((a, b) => { const va = sortVal(a), vb = sortVal(b); const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb)); return sortDir === "asc" ? cmp : -cmp; });
    const SortTh = ({ label, k, align, width }) => (
      <th onClick={() => { if (sortKey === k) setSortDir((d) => d === "asc" ? "desc" : "asc"); else { setSortKey(k); setSortDir(["contract", "invoiced", "paid", "remaining", "progress"].includes(k) ? "desc" : "asc"); } }} style={{ ...s.th, textAlign: align || "left", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", ...(width ? { width } : {}) }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{label}<span style={{ fontSize: 9, color: sortKey === k ? "#0f172a" : "#cbd5e1" }}>{sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span></span>
      </th>
    );
    return (
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <FilterPills tabs={[{ key: "active", label: "Active" }, { key: "job_lost", label: "Job Lost" }, { key: "lead", label: "Lead" }, { key: "finalised", label: "Finalised" }, { key: "all", label: "All" }].map((st) => ({ ...st, count: st.key === "all" ? fyJobs.length : fyJobs.filter((p) => (p.status || "active") === st.key).length }))} active={statusFilter} onChange={setStatusFilter} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects..." style={{ ...s.input, maxWidth: 200, flex: "1 1 140px", marginLeft: "auto" }} />
        </div>
        <div style={s.card}>
          {rows.length === 0 ? (
            <EmptyState icon={Icons.Projects} title={statusFilter === "all" && !search && fy === ALL_FY ? "No projects yet" : "No projects found"} hint={statusFilter === "all" && !search ? (fy === ALL_FY ? "Projects build up automatically when you accept quotes." : `No open projects, and none with a document dated in ${fyLabel(fy)}.`) : "Try a different status or search term."} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><SortTh label="Job #" k="job_number" /><SortTh label="Project" k="project" /><SortTh label="Consultants/Clients" k="consultants" /><SortTh label="Contract" k="contract" align="right" /><SortTh label="Invoiced" k="invoiced" align="right" /><SortTh label="Paid" k="paid" align="right" /><SortTh label="Remaining" k="remaining" align="right" /><SortTh label="Progress" k="progress" width={120} /></tr></thead>
                <tbody>{rows.map(({ p, t, parties }) => {
                  const pct = t.contract > 0 ? Math.min(100, Math.round((t.paid / t.contract) * 100)) : 0;
                  return (
                    <tr key={p.id} onClick={() => { setEditItem(p); setModal("project"); }} style={{ cursor: "pointer" }}>
                      <td style={{ ...s.td, color: "#64748b", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{p.job_number || "—"}</td>
                      <td style={{ ...s.td, fontWeight: 600 }}>{projectLabel(p)}{p.application_type ? <span style={{ ...s.badge(accent), marginLeft: 6 }}>{p.application_type}</span> : null}{p.address && p.name && p.name !== projectLabel(p) ? <div style={{ fontSize: 11, fontWeight: 400, color: "#94a3b8" }}>{p.name}</div> : null}</td>
                      <td style={{ ...s.td, color: "#64748b", fontSize: 12 }}>{consultantsLabel(parties)}</td>
                      <td style={{ ...s.td, textAlign: "right" }}>{fmt(t.contract)}</td>
                      <td style={{ ...s.td, textAlign: "right", color: "#3b82f6" }}>{fmt(t.invoiced)}</td>
                      <td style={{ ...s.td, textAlign: "right", color: "#10b981" }}>{fmt(t.paid)}</td>
                      <td style={{ ...s.td, textAlign: "right", fontWeight: 700 }}>{fmt(t.remaining)}</td>
                      <td style={s.td}>
                        <div style={{ height: 6, background: "#e2e8f0", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: "#10b981" }} /></div>
                        <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>{pct}% paid</div>
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  };

  const ContactsPage = () => {
    const [filter, setFilter] = useState("all");
    const filtered = contacts.filter((c) => filter === "all" || c.type === filter);
    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          <FilterPills tabs={[{ key: "all", label: "All", count: contacts.length }, { key: "client", label: "Clients", count: contacts.filter((c) => c.type === "client").length }, { key: "consultant", label: "Consultants", count: contacts.filter((c) => c.type === "consultant").length }, { key: "supplier", label: "Suppliers", count: contacts.filter((c) => c.type === "supplier").length }]} active={filter} onChange={setFilter} />
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? <EmptyState icon={Icons.Contacts} title="No contacts yet" hint="Add clients and suppliers to reuse them on quotes and invoices." /> : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Name</th><th style={s.th}>Company</th><th style={s.th}>Email</th><th style={s.th}>Type</th><th style={{ ...s.th, width: 70 }}></th></tr></thead>
                <tbody>{filtered.map((c) => (
                  <tr key={c.id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{c.name || c.company}</td>
                    <td style={{ ...s.td, color: "#64748b" }}>{c.company || "--"}</td>
                    <td style={{ ...s.td, color: "#64748b", fontSize: 11 }}>{c.email || "--"}</td>
                    <td style={s.td}><span style={s.badge(c.type === "client" ? "#34d399" : c.type === "consultant" ? "#8b5cf6" : "#f59e0b")}>{c.type}</span></td>
                    <td style={{ ...s.td, display: "flex", gap: 4 }}>
                      <button onClick={() => { setEditItem(c); setModal("contact"); }} title="Edit" style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 2 }}><Icons.Edit /></button>
                      <button onClick={() => deleteContact(c.id)} title="Delete" style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 2 }}><Icons.Trash /></button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  };


  // ═══ MOBILE COMPONENTS ═══

  const MobileTabBar = () => (
    <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center", padding: "8px 0 calc(env(safe-area-inset-bottom) + 10px)", borderTop: "0.5px solid #e2e8f0", background: "#ffffff", flexShrink: 0 }}>
      {navItems.map(({ id, label, icon: Icon }) => (
        <button key={id} onClick={() => setPage(id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", padding: "4px 12px", color: activeNav === id ? accent : "#94a3b8" }}>
          <Icon />
          <span style={{ fontSize: 10, fontWeight: 500 }}>{label}</span>
        </button>
      ))}
    </div>
  );

  const MobileHeader = () => (
    <div style={{ padding: "calc(env(safe-area-inset-top) + 14px) 20px 12px", background: "#ffffff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div style={{ position: "relative" }}>
          <button type="button" onClick={() => setDivMenuOpen((v) => !v)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: "#94a3b8", textTransform: "uppercase" }}>{COMPANY.name}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", letterSpacing: -0.5, marginTop: 2 }}>{PAGE_TITLES[page] || ""}</div>
            <div style={{ fontSize: 12, color: accent, fontWeight: 600, marginTop: 4, display: "inline-flex", alignItems: "center", gap: 4 }}>
              {divInfo.name}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ opacity: 0.7, transform: divMenuOpen ? "rotate(180deg)" : "none", transition: "transform .15s ease" }}><path d="M6 9l6 6 6-6"/></svg>
            </div>
          </button>
          {divMenuOpen && <DivisionMenu division={division} onSwitch={switchDivision} onClose={() => setDivMenuOpen(false)} />}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        {page !== "dashboard" && (
          <button onClick={() => { if (page === "quotes") { setEditItem(null); setInvoiceSeed({ type: "quote" }); setModal("invoice"); } else if (page === "invoices") { setEditItem(null); setInvoiceSeed({ type: "invoice" }); setModal("invoice"); } else if (page === "projects") { setEditItem(null); setModal("project"); } else if (page === "contacts") setModal("contact"); }} style={{ width: 34, height: 34, borderRadius: 17, background: accent, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
            <Icons.Plus />
          </button>
        )}
        <button onClick={() => setModal("settings")} style={{ width: 34, height: 34, borderRadius: 17, background: "#f1f5f9", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>
          <Icons.Settings />
        </button>
        <button onClick={logout} style={{ width: 34, height: 34, borderRadius: 17, background: "#f1f5f9", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b" }}>
          <Icons.Logout />
        </button>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>{fySelectEl({ width: "100%" })}</div>
    </div>
  );

  const MobileRow = ({ primary, secondary, right, rightSub, badge, isLast, onClick, action }) => (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: isLast ? "none" : "0.5px solid #f1f5f9", gap: 10, cursor: onClick ? "pointer" : "default" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{primary}</div>
        {secondary && <div style={{ fontSize: 13, color: "#64748b", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{secondary}</div>}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {badge && <span style={s.badge(badge.color)}>{badge.label}</span>}
        {right && <div style={{ fontSize: 15, fontWeight: 600, color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>{right}</div>}
        {rightSub && <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 1 }}>{rightSub}</div>}
      </div>
      {action && <div style={{ flexShrink: 0, marginLeft: 4 }}>{action}</div>}
    </div>
  );

  const MobileSection = ({ title, children, onViewAll }) => (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 20px", marginBottom: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "#0f172a" }}>{title}</span>
        {onViewAll && <button onClick={onViewAll} style={{ fontSize: 13, color: accent, background: "none", border: "none", cursor: "pointer", fontWeight: 500 }}>View All</button>}
      </div>
      <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );

  const MobileFilterTabs = ({ tabs, active, onChange }) => (
    <div style={{ display: "flex", gap: 6, padding: "0 20px", overflowX: "auto" }}>
      {tabs.map(tab => (
        <button key={tab} onClick={() => onChange(tab)} style={{ padding: "5px 12px", fontSize: 13, fontWeight: 500, borderRadius: 16, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, border: active === tab ? "none" : "1px solid #e2e8f0", background: active === tab ? accent : "#ffffff", color: active === tab ? "#fff" : "#64748b" }}>{tab}</button>
      ))}
    </div>
  );

  const statusBadge = (status) => {
    const map = { paid: { color: "#34d399", label: "Paid" }, sent: { color: "#3b82f6", label: "Sent" }, draft: { color: "#64748b", label: "Draft" }, overdue: { color: "#ef4444", label: "Overdue" }, accepted: { color: "#34d399", label: "Accepted" }, declined: { color: "#64748b", label: "Declined" } };
    return map[status] || map.draft;
  };

  const MobileDashboard = () => {
    // Mirrors DashboardPage exactly — same two roots, same exception.
    const realInvoices = divInvoices.filter((i) => i.type !== "quote");
    const fyRealInvoices = fyInvoices.filter((i) => i.type !== "quote");
    const unpaid = realInvoices.filter((i) => i.status === "sent" || i.status === "overdue");
    const outstanding = unpaid.reduce((sum, i) => sum + Number(i.total || 0), 0);
    const overdueInvoices = unpaid.filter((i) => daysOverdue(i) > 0).sort((a, b) => daysOverdue(b) - daysOverdue(a));
    const overdueTotal = overdueInvoices.reduce((sum, i) => sum + Number(i.total || 0), 0);
    const paidThisFY = fyRealInvoices.filter((i) => i.status === "paid");
    const activeProjects = fyJobs.filter((p) => (p.status || "active") === "active");
    const projectsRemaining = activeProjects.reduce((sum, p) => sum + projectTotals(p, divInvoices).remaining, 0);
    const recentInvoices = [...fyRealInvoices].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 4);
    const tile = (label, value, sub, color) => (
      <div style={{ flex: 1, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 16px" }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#94a3b8" }}>{label}</div>
        <div style={{ marginTop: 4 }}><MoneyBig value={value} size={22} color={color} /></div>
        <div style={{ fontSize: 11, color: color || "#065f46", marginTop: 4, fontWeight: 500 }}>{sub}</div>
      </div>
    );
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ display: "flex", gap: 10, padding: "8px 16px 0" }}>
          {tile("Outstanding", outstanding, `${unpaid.length} unpaid · all time`)}
          {tile("Overdue", overdueTotal, overdueInvoices.length ? `${overdueInvoices.length} past due · all time` : "nothing late · all time", overdueTotal > 0 ? "#b91c1c" : undefined)}
        </div>
        <div style={{ display: "flex", gap: 10, padding: "10px 16px 0" }}>
          {tile("Paid", paidThisFY.reduce((sum, i) => sum + Number(i.total || 0), 0), `${paidThisFY.length} invoice${paidThisFY.length === 1 ? "" : "s"} · ${fyTag}`)}
          {tile("Projects", projectsRemaining, `${activeProjects.length} active`)}
        </div>
        {overdueInvoices.length > 0 && (
          <MobileSection title="Needs attention" onViewAll={() => setPage("invoices")}>
            {overdueInvoices.slice(0, 4).map((inv, i) => (
              <MobileRow key={inv.id} primary={`${inv.number} — ${inv.contact_name || inv.contact_company || ""}`} secondary={`${daysOverdue(inv)} day${daysOverdue(inv) === 1 ? "" : "s"} overdue`} right={fmt(inv.total || 0)} isLast={i === Math.min(3, overdueInvoices.length - 1)} onClick={() => { setEditItem(inv); setModal("invoice"); }} />
            ))}
          </MobileSection>
        )}
        <MobileSection title="Recent Invoices" onViewAll={() => setPage("invoices")}>
          {recentInvoices.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No invoices in {fyTag}</div> : recentInvoices.map((inv, i) => (
            <MobileRow key={inv.id} primary={`${inv.number} — ${inv.contact_name || inv.contact_company || ""}`} secondary={inv.job || ""} badge={statusBadge(inv.status)} right={fmt(inv.total || 0)} isLast={i === recentInvoices.length - 1} onClick={() => { setEditItem(inv); setModal("invoice"); }} />
          ))}
        </MobileSection>
        <MobileSection title="Active Projects" onViewAll={() => setPage("projects")}>
          {activeProjects.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No active projects</div> : activeProjects.slice(0, 3).map((p, i) => (
            <MobileRow key={p.id} primary={projectLabel(p)} secondary={p.job_number || ""} right={fmt(projectTotals(p, divInvoices).remaining)} rightSub="remaining" isLast={i === Math.min(2, activeProjects.length - 1)} onClick={() => { setEditItem(p); setModal("project"); }} />
          ))}
        </MobileSection>
        <div style={{ display: "flex", gap: 8, padding: "20px 16px 0" }}>
          <button onClick={() => { setEditItem(null); setInvoiceSeed({ type: "invoice" }); setModal("invoice"); }} style={{ ...s.btn("#3b82f6"), flex: 1, justifyContent: "center", padding: "12px", borderRadius: 12, fontSize: 13 }}><Icons.Plus /> Invoice</button>
          <button onClick={() => { setEditItem(null); setInvoiceSeed({ type: "quote" }); setModal("invoice"); }} style={{ ...s.btn(accent), flex: 1, justifyContent: "center", padding: "12px", borderRadius: 12, fontSize: 13 }}><Icons.Plus /> Quote</button>
          <button onClick={() => { projectDraftRef.current = null; setEditItem(null); setModal("project"); }} style={{ ...s.btn("#6366f1"), flex: 1, justifyContent: "center", padding: "12px", borderRadius: 12, fontSize: 13 }}><Icons.Plus /> Project</button>
        </div>
      </div>
    );
  };


  const MobileDocs = ({ docType }) => {
    const isQuoteList = docType === "quote";
    const [tab, setTab] = useState("All");
    const tabs = isQuoteList ? ["All", "Draft", "Sent", "Accepted", "Declined"] : ["All", "Outstanding", "Paid", "Overdue", "Draft"];
    const ofType = (i) => isQuoteList ? i.type === "quote" : i.type !== "quote";
    const byDateDesc = (a, b) => (b.date || "").localeCompare(a.date || "");
    const sorted = fyInvoices.filter(ofType).sort(byDateDesc);
    // Same debtor exception as the desktop list.
    const allTime = divInvoices.filter(ofType).sort(byDateDesc);
    const debtorTab = isQuoteList ? tab === "Sent" : (tab === "Outstanding" || tab === "Overdue");
    const filtered = (debtorTab ? allTime : sorted).filter((inv) => tab === "All" || (tab === "Outstanding" ? (inv.status === "sent" || inv.status === "overdue") : inv.status === tab.toLowerCase()));
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ paddingTop: 8, paddingBottom: 12 }}>
          <MobileFilterTabs tabs={tabs} active={tab} onChange={setTab} />
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {filtered.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No {isQuoteList ? "quotes" : "invoices"} found{fy !== ALL_FY && !debtorTab ? ` in ${fyLabel(fy)}` : ""}</div> : filtered.map((inv, i) => (
            <MobileRow key={inv.id} primary={`${inv.number} — ${inv.contact_name || inv.contact_company || ""}`} secondary={<>{fmtDate(inv.date)}{inv.job ? ` · ${inv.job}` : ""}{daysOverdue(inv) > 0 && <span style={{ color: "#ef4444", fontWeight: 600 }}> · {daysOverdue(inv)}{daysOverdue(inv) === 1 ? " day overdue" : " days overdue"}</span>}</>} badge={statusBadge(inv.status)} right={fmt(inv.total || 0)} isLast={i === filtered.length - 1} onClick={() => viewInvoice(inv)} action={<button onClick={(e) => { e.stopPropagation(); setEditItem(inv); setModal("invoice"); }} title="Edit" style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 6 }}><Icons.Edit /></button>} />
          ))}
        </div>
      </div>
    );
  };
  const MobileInvoices = () => <MobileDocs docType="invoice" />;
  const MobileQuotes = () => <MobileDocs docType="quote" />;

  const MobileProjects = () => {
    const [tab, setTab] = useState("All");
    const rows = fyJobs
      .filter((p) => tab === "All" || (p.status || "active") === ({ "Active": "active", "Job Lost": "job_lost", "Lead": "lead", "Finalised": "finalised" })[tab])
      .map((p) => ({ p, t: projectTotals(p, divInvoices) }))
      .sort((a, b) => b.t.remaining - a.t.remaining);
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ paddingTop: 8, paddingBottom: 12 }}>
          <MobileFilterTabs tabs={["Active", "Job Lost", "Lead", "Finalised", "All"]} active={tab} onChange={setTab} />
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {rows.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No projects found{fy === ALL_FY ? "" : ` for ${fyLabel(fy)}`}</div> : rows.map(({ p, t }, i) => (
            <MobileRow key={p.id} primary={projectLabel(p)} secondary={`${p.job_number ? p.job_number + " · " : ""}${fmt(t.paid)} paid of ${fmt(t.contract)}`} right={fmt(t.remaining)} rightSub="remaining" isLast={i === rows.length - 1} onClick={() => { setEditItem(p); setModal("project"); }} />
          ))}
        </div>
      </div>
    );
  };

  const MobileContacts = () => {
    const [tab, setTab] = useState("All");
    const filtered = contacts.filter((c) => { if (tab === "Clients") return c.type === "client"; if (tab === "Consultants") return c.type === "consultant"; if (tab === "Suppliers") return c.type === "supplier"; return true; });
    const typeBadge = (type) => ({ color: type === "client" ? "#34d399" : type === "consultant" ? "#8b5cf6" : "#f59e0b", label: type === "client" ? "Client" : type === "consultant" ? "Consultant" : "Supplier" });
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ paddingTop: 8, paddingBottom: 12 }}>
          <MobileFilterTabs tabs={["All", "Clients", "Consultants", "Suppliers"]} active={tab} onChange={setTab} />
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {filtered.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No contacts found</div> : filtered.map((c, i) => (
            <MobileRow key={c.id} primary={c.name} secondary={c.email || ""} badge={typeBadge(c.type)} isLast={i === filtered.length - 1} onClick={() => { setEditItem(c); setModal("contact"); }} />
          ))}
        </div>
      </div>
    );
  };



  const MobileLayout = () => (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#f7f9f8", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <MobileHeader />
      <div style={{ flex: 1, overflow: "auto" }}>
        {page === "dashboard" && <MobileDashboard />}
        {page === "quotes" && <MobileQuotes />}
        {page === "invoices" && <MobileInvoices />}
        {page === "projects" && <MobileProjects />}
        {page === "contacts" && <MobileContacts />}
      </div>
      <MobileTabBar />
    </div>
  );

  const pageMap = { dashboard: DashboardPage, quotes: QuotesPage, invoices: InvoicesPage, projects: ProjectsPage, contacts: ContactsPage };
  const PageComponent = pageMap[page] || DashboardPage;

  // Prefill for the compose-email window: recipient + subject + message (signature
  // stripped from the body; shown/appended separately) + the HTML signature.
  const composeDefaults = composeDoc ? {
    to: composeDoc.contact_email || "",
    subject: `${composeDoc.type === "quote" ? "Quote" : "Invoice"} ${composeDoc.number || ""} from ${profile.name || "Our company"}`.trim(),
    body: buildEmailBody(composeDoc, { withSignature: false }).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd(),
    signatureHtml: signatureToHtml(defaultSignatureText()),
  } : null;

  const SidebarContent = () => (
    <>
      <div style={{ ...s.logo, position: "relative", padding: navCollapsed ? "16px 6px 12px" : "20px 16px 12px", textAlign: navCollapsed ? "center" : "left" }}>
        <button
          type="button"
          onClick={() => setDivMenuOpen((v) => !v)}
          title="Switch division"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", width: "100%", textAlign: navCollapsed ? "center" : "left" }}
        >
          {navCollapsed ? (
            <div style={{ margin: "0 auto", width: 34 }}><MworxLogo size={34} radius={9} /></div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <MworxLogo size={26} radius={7} />
                <div style={{ fontSize: 17, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.02em" }}>BookKeeper</div>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" style={{ transform: divMenuOpen ? "rotate(180deg)" : "none", transition: "transform .15s ease" }}><path d="M6 9l6 6 6-6"/></svg>
              </div>
              <div style={{ fontSize: 12, color: accent, fontWeight: 600, marginTop: 4 }}>{divInfo.name}</div>
              <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>{COMPANY.name}</div>
            </>
          )}
        </button>
        {divMenuOpen && (
          <DivisionMenu
            division={division}
            onSwitch={switchDivision}
            onClose={() => setDivMenuOpen(false)}
            style={navCollapsed ? { left: "calc(100% + 8px)", top: 0, minWidth: 210 } : undefined}
          />
        )}
      </div>
      <div style={s.nav}>
        {navItems.map((item) => (
          <button key={item.id} onClick={() => setPage(item.id)} title={navCollapsed ? item.label : undefined} style={{ ...s.navBtn(activeNav === item.id), justifyContent: navCollapsed ? "center" : "flex-start", padding: navCollapsed ? "10px 0" : "9px 12px", gap: navCollapsed ? 0 : 10 }}>
            <item.icon />{!navCollapsed && <span>{item.label}</span>}
          </button>
        ))}
      </div>
      <div style={{ padding: 12, borderTop: "1px solid #e2e8f0", display: "flex", flexDirection: "column", gap: 6 }}>
        <button onClick={toggleNav} title={navCollapsed ? "Expand sidebar" : "Collapse sidebar"} style={{ ...s.btnOutline, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11 }}>{navCollapsed ? <Icons.ChevronRight /> : <><Icons.ChevronLeft /> Collapse</>}</button>
        <div style={{ display: "flex", flexDirection: navCollapsed ? "column" : "row", gap: 6 }}>
          <button onClick={() => setModal("settings")} title="Settings" style={{ ...s.btnOutline, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11 }}><Icons.Settings />{!navCollapsed && <span>Settings</span>}</button>
          <button onClick={logout} title="Sign Out" style={{ ...s.btnOutline, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11 }}><Icons.Logout />{!navCollapsed && <span>Sign Out</span>}</button>
        </div>
      </div>
    </>
  );

  // The modal lives at ONE position in ONE return, for both layouts.
  //
  // It used to be duplicated inside two structurally different returns — the
  // mobile fragment rendered it as child 1, the desktop fragment buried it inside
  // the s.app div — which shifted every following sibling by one index. React
  // reconciles unkeyed siblings by position, so crossing the 768px breakpoint
  // unmounted the modal AND all three viewers below it. That is why typing an
  // email in ComposeEmail and then resizing across the breakpoint lost the body:
  // ComposeEmail is already at module scope, so nothing else was protecting it.
  //
  // Only the panel's own style differs between layouts (bottom sheet vs centred),
  // so that is the single ternary. This is a plain element, not a component —
  // introducing one would either remount the overlay on every App render (if
  // declared inside App) or need s.modalOverlay/s.modalContent threaded through
  // for no gain (if declared at module scope).
  const modalBlock = modal && (
    <div className="bk-overlay" style={s.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) requestCloseModal(modal !== "project" && modal !== "invoice"); }}>
      <div className="bk-modal" style={isMobile
        ? { ...s.modalContent, maxWidth: "100%", borderRadius: "16px 16px 0 0", position: "fixed", bottom: 0, left: 0, right: 0, maxHeight: "90vh", overflowY: "auto" }
        : s.modalContent}>
        {/* key: now that this form no longer remounts, opening a different
            contact must still start from that contact's values rather than
            reusing the previous one's state. */}
        {modal === "contact" && <ContactForm key={editItem?.id ?? "new"} existing={editItem} s={s} accent={accent} setModal={setModal} setEditItem={setEditItem} addContact={addContact} updateContact={updateContact} deleteContact={deleteContact} />}
        {modal === "invoice" && <InvoiceForm existing={editItem} />}
        {modal === "project" && <ProjectForm existing={editItem} />}
        {modal === "settings" && <BusinessSettings s={s} accent={accent} biz={biz} session={session} profile={profile} saveProfile={saveProfile} setModal={setModal} emailConn={emailConn} connectOutlook={connectOutlook} disconnectOutlook={disconnectOutlook} quoteTemplates={quoteTemplates} renameQuoteTemplate={renameQuoteTemplate} deleteQuoteTemplate={deleteQuoteTemplate} />}
      </div>
    </div>
  );

  // Slot order below is load-bearing and identical in both layouts:
  //   0 layout · 1 modal · 2 viewDoc · 3 composeDoc
  return (
    <>
      {isMobile ? <MobileLayout /> : (
      <div style={s.app}>
        <div style={{ ...s.sidebar, width: navCollapsed ? 72 : 220, transition: "width .15s ease" }}><SidebarContent /></div>
        <div style={s.main}>
          <div style={s.header}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{PAGE_TITLES[page] || ""}</div>
              <div style={{ fontSize: 10, color: accent, fontWeight: 600, marginTop: 2 }}>{divInfo.name}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              {fySelectEl()}
              {page === "quotes" && <button onClick={() => { setEditItem(null); setInvoiceSeed({ type: "quote" }); setModal("invoice"); }} style={s.btn(accent, true)}><Icons.Plus /> Quote</button>}
              {page === "invoices" && <button onClick={() => { setEditItem(null); setInvoiceSeed({ type: "invoice" }); setModal("invoice"); }} style={s.btn(accent, true)}><Icons.Plus /> Invoice</button>}
              {page === "projects" && <button onClick={() => { projectDraftRef.current = null; setEditItem(null); setModal("project"); }} style={s.btn(accent, true)}><Icons.Plus /> Project</button>}
              {page === "contacts" && <button onClick={() => setModal("contact")} style={s.btn(accent, true)}><Icons.Plus /> Contact</button>}
            </div>
          </div>
          <div style={s.content}><PageComponent /></div>
        </div>
      </div>
      )}
      {modalBlock}
      {viewDoc && <DocViewer inv={viewDoc} profile={profile} accent={accent} isMobile={isMobile} pdfLoading={pdfLoading} onClose={() => setViewDoc(null)} onDownload={downloadPDF} fetchLogoBase64={fetchLogoBase64} />}
      {composeDoc && <ComposeEmail inv={composeDoc} accent={accent} isMobile={isMobile} defaults={composeDefaults} onClose={() => setComposeDoc(null)} onSend={handleComposeSend} />}
    </>
  );
}
