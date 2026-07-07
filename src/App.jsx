import { useState, useEffect, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabaseClient";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_GROUPS, BUSINESS_PURPOSE_CATEGORIES, processBankFile } from "./bankImport";

const API_BASE = Capacitor.isNativePlatform() ? "https://bkeeper.netlify.app" : "";

const REVENUE_ACCOUNTS = [
  { code: "4000", name: "Sales Revenue", type: "Revenue" },
  { code: "4200", name: "Service Revenue", type: "Revenue" },
  { code: "4300", name: "Other Income", type: "Revenue" },
];
const EXPENSE_ACCOUNTS = EXPENSE_CATEGORIES.map((name, i) => ({
  code: String(6000 + i * 10),
  name,
  type: "Expense",
}));
const DEFAULT_ACCOUNTS = [...REVENUE_ACCOUNTS, ...EXPENSE_ACCOUNTS];

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

const DEFAULT_PROFILE = { name: "", abn: "", address: "", email: "", phone: "", bank_name: "", account_name: "", bsb: "", account_number: "", logo_url: "", email_template_invoice: "", email_template_quote: "", email_signature: "", onedrive_folder: "", onedrive_receipts_folder: "" };

// Header titles per page. Sub-pages (reimbursements/reconcile live under Expenses,
// quotes under Sales) keep their own title even though they share a nav item.
const PAGE_TITLES = { dashboard: "Dashboard", expenses: "Expenses", reimbursements: "Reimbursements", reconcile: "Bank Reconciliation", invoices: "Sales", quotes: "Sales", projects: "Projects", contacts: "Contacts", pnl: "Profit & Loss" };

const isReconciled = (r) => !!(r?.reconciliation_id || r?.reconciled_at);

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

function periodBounds(type, value) {
  if (type === "month") {
    const [y, m] = value.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return { start: `${value}-01`, end: `${value}-${String(lastDay).padStart(2, "0")}`, label: new Date(y, m - 1).toLocaleDateString("en-AU", { month: "long", year: "numeric" }) };
  }
  if (type === "quarter") {
    const y = Number(value.slice(0, 4));
    const q = Number(value.slice(-1));
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    const endDay = new Date(y, endMonth, 0).getDate();
    return { start: `${y}-${String(startMonth).padStart(2, "0")}-01`, end: `${y}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`, label: `Q${q} ${y}` };
  }
  const y = Number(value);
  return { start: `${y}-01-01`, end: `${y}-12-31`, label: String(y) };
}
const inPeriod = (dateStr, start, end) => !!dateStr && dateStr >= start && dateStr <= end;

const sanitizeFilePart = (s) => (s || "").replace(/[/\\:*?"<>|&#%]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const safeFileName = (parts, ext) => parts.map(p => sanitizeFilePart(String(p))).filter(Boolean).join("_") + "." + ext;
const fmtAmtFile = (n) => Number(n).toFixed(2).replace(".", "-");

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
function getNextJobNumber(jobs, divisionId) {
  const yy = String(new Date().getFullYear()).slice(-2);
  const nums = (jobs || [])
    .filter((j) => recordDivision(j) === divisionId)
    .map((j) => { const m = String(j.job_number || "").match(/^(\d{4,})$/); return m ? Number(m[1]) : 0; })
    .filter((n) => n > 0 && String(n).startsWith(yy));
  const next = nums.length ? Math.max(...nums) + 1 : Number(`${yy}101`);
  return String(next);
}

function addDays(dateStr, days) { const d = new Date(dateStr); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function getDefaultDueDate(type, date) { return addDays(date || today(), type === "quote" ? 30 : 7); }
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

// Group a project's quotes/invoices by consultant (keyed on contact_name, since
// invoices store contact_name but not contact_id). Returns one entry per consultant
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
  Expenses: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
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
  Camera: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  Menu: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>,
  Logout: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>,
  Settings: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  Download: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>,
  Reconcile: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>,
  More: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>,
  Bell: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/></svg>,
  Eye: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>,
  Cloud: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>,
  Reimburse: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
  Outlook: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M24 7.387v10.478c0 .23-.08.424-.238.576-.16.154-.353.23-.578.23h-8.26V6.58h8.26c.225 0 .418.077.578.23.159.154.238.347.238.577zM13.73 3.088v18.47L0 18.583V6.07l13.73-2.982z"/></svg>,
  Reports: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>,
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

// Full-screen, in-app viewer for a receipt image or PDF. Like DocViewer, this exists
// so receipts never need window.open()/a new tab. The signed URL is rendered inline:
// PDFs in an <iframe>, images in an <img>. Top-level so a parent re-render doesn't
// reload it.
function ReceiptViewer({ receipt, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const ext = (receipt.name || "").split(".").pop().toLowerCase();
  const isPdf = ext === "pdf";
  const btn = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "8px 12px", borderRadius: 9, cursor: "pointer", whiteSpace: "nowrap", textDecoration: "none" };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "#1e293b", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "calc(10px + env(safe-area-inset-top)) 12px 10px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexShrink: 0 }}>
        <button onClick={onClose} title="Close" style={{ ...btn, background: "none", border: "none", color: "#64748b", padding: 4 }}><Icons.X /></button>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Receipt</div>
        {receipt.url && <a href={receipt.url} target="_blank" rel="noopener noreferrer" style={{ ...btn, background: "#fff", border: "1px solid #e2e8f0", color: "#334155" }}><Icons.Download /> Open original</a>}
      </div>
      {!receipt.url ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#cbd5e1", fontSize: 14 }}>Loading receipt…</div>
      ) : isPdf ? (
        <iframe src={receipt.url} title="Receipt" style={{ flex: 1, width: "100%", border: "none", background: "#fff" }} />
      ) : (
        <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <img src={receipt.url} alt="Receipt" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 6 }} />
        </div>
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
  const [aiData, setAiData] = useState(null);
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
  const [txns, setTxns] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [profile, setProfile] = useState({ ...DEFAULT_PROFILE });
  const [emailConn, setEmailConn] = useState(null);
  const [categoryRules, setCategoryRules] = useState([]);

  const [lastReconciliation, setLastReconciliation] = useState(null);
  const [reconciliations, setReconciliations] = useState([]);
  const [navMenu, setNavMenu] = useState(null); // sidebar sub-menu popover: { x, y, items } | null
  const [divMenuOpen, setDivMenuOpen] = useState(false);
  const navMenuTimer = useRef(null);
  // Sidebar sub-menus open on hover; a short close delay lets the cursor travel
  // from the nav item into the popover without it vanishing.
  const openNavMenu = (e, items) => { setDivMenuOpen(false); if (navMenuTimer.current) clearTimeout(navMenuTimer.current); navMenuTimer.current = null; const r = e.currentTarget.getBoundingClientRect(); setNavMenu({ x: r.right, y: r.top, items }); };
  const holdNavMenu = () => { if (navMenuTimer.current) clearTimeout(navMenuTimer.current); navMenuTimer.current = null; };
  const closeNavMenuSoon = () => { if (navMenuTimer.current) clearTimeout(navMenuTimer.current); navMenuTimer.current = setTimeout(() => setNavMenu(null), 220); };

  const divInfo = divisionInfo(division);
  const accent = divInfo.accent;
  const insertDivision = division === ALL_DIVISIONS ? (localStorage.getItem("bk_lastSpecificDivision") || "mworx") : division;
  const inActiveDiv = (r) => division === ALL_DIVISIONS || recordDivision(r) === division;
  const divTxns = txns.filter(inActiveDiv);
  const divInvoices = invoices.filter(inActiveDiv);
  const divJobs = jobs.filter(inActiveDiv);
  const accounts = DEFAULT_ACCOUNTS;

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
  const requestCloseModal = (alwaysConfirm = false) => {
    if ((alwaysConfirm || formDirtyRef.current) && !window.confirm("Are you sure you want to close? Any unsaved changes will be lost.")) return;
    if (aiData?.receiptPath) supabase.storage.from("receipts").remove([aiData.receiptPath]).catch(() => {});
    formDirtyRef.current = false;
    setModal(null);
    setEditItem(null);
    setInvoiceSeed(null);
    setAiData(null);
  };

  const loadData = useCallback(async (businessId) => {
    if (!session) return;
    setLoading(true);
    try {
    const [cRes, iRes, tRes, pRes, jRes, eRes, rRes] = await Promise.all([
      supabase.from("bk_contacts").select("*").eq("business_id", businessId).order("name"),
      supabase.from("bk_invoices").select("*").eq("business_id", businessId).order("date", { ascending: false }),
      supabase.from("bk_transactions").select("*").eq("business_id", businessId).order("date", { ascending: false }),
      supabase.from("bk_profiles").select("*").eq("business_id", businessId).maybeSingle(),
      supabase.from("bk_jobs").select("*").eq("business_id", businessId).order("last_used_at", { ascending: false }),
      supabase.from("bk_email_connections").select("*").eq("business_id", businessId).eq("provider", "outlook").maybeSingle(),
      supabase.from("bk_category_rules").select("*").eq("business_id", businessId),
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

    setContacts(cRes.data || []);
    setInvoices(loadedInvoices);
    setTxns(tRes.data || []);
    setJobs(jRes.data || []);
    setProfile(pRes.data || { ...DEFAULT_PROFILE, business_id: businessId, name: "Mworx Group", onedrive_folder: "Mworx Group", onedrive_receipts_folder: "Mworx Group/Receipts" });
    setEmailConn(eRes.data || null);
    setCategoryRules(rRes.data || []);
    const { data: recs } = await supabase.from("bk_reconciliations").select("*").eq("business_id", businessId).order("statement_date", { ascending: false }).limit(20);
    setReconciliations(recs || []);
    setLastReconciliation((recs && recs[0]) || null);
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
    setTxns([]);
    setJobs([]);
    setProfile({ ...DEFAULT_PROFILE });
    setEmailConn(null);
    setCategoryRules([]);
    setReconciliations([]);
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

  const jobNames = [...new Set([...divInvoices.map((i) => i.job), ...divTxns.map((t) => t.job)].filter(Boolean))].sort();
  const pendingReimbursements = txns.filter((t) => t.payment_source === "personal" && t.reimbursement_required && t.reimbursement_status === "pending");
  const pendingReimbTotal = pendingReimbursements.reduce((sum, t) => sum + Number(t.amount), 0);

  // --- Mutation functions: each writes directly to its table ---

  // Centralized write helper. supabase-js NEVER throws on a query error — it
  // resolves to { data, error } — so a mutation whose `error` is left unchecked
  // looks like a success even when the row was rejected (RLS, constraint, network)
  // and the user's record silently vanishes. Route inserts/updates/deletes through
  // this: it surfaces the failure to the user and returns { ok } so callers can
  // bail before closing the modal or optimistically mutating local state.
  const sbWrite = async (query, action = "save") => {
    const { data, error } = await query;
    if (error) {
      console.error(`Supabase ${action} failed:`, error);
      alert(`Failed to ${action}: ${error.message || "unknown error"}`);
      return { ok: false, data: null, error };
    }
    return { ok: true, data, error: null };
  };

  // Insert with division when the column exists (migration 0007). Existing Mworx
  // Supabase rows keep working before migration: division is omitted and treated
  // as mworx. MT Management saves require the migration first.
  const sbInsert = async (table, row, action, multi = false) => {
    let query = supabase.from(table).insert(row);
    query = multi ? query.select() : query.select().single();
    let res = await sbWrite(query, action);
    if (!res.ok && res.error?.message?.match(/division/i) && "division" in row) {
      if (row.division !== "mworx") {
        alert("To save MT Management records, apply supabase/migrations/0007_divisions.sql in Supabase first.");
        return res;
      }
      const { division: _d, ...noDiv } = row;
      query = supabase.from(table).insert(noDiv);
      query = multi ? query.select() : query.select().single();
      res = await sbWrite(query, action);
    }
    return res;
  };

  // View a receipt image/PDF *inside* the app (see the ReceiptViewer component).
  // Previously this did window.open(signedUrl, "_blank") AFTER awaiting the signed
  // URL — and because the tap gesture is already spent by the time the await
  // resolves, mobile/Safari reliably blocked it as a pop-up. Rendering it in-app
  // sidesteps that entirely. The bucket is private, so we still mint a short-lived
  // signed URL first, then hand it to the in-app viewer.
  const openReceipt = async (t) => {
    if (!t?.receipt_path) { alert("No receipt attached to this expense."); return; }
    const { data, error } = await supabase.storage.from("receipts").createSignedUrl(t.receipt_path, 600);
    if (error || !data?.signedUrl) { alert("Could not load receipt. Please try again."); return; }
    setViewReceipt({ url: data.signedUrl, name: t.receipt_path.split("/").pop() });
  };

  // ---- Learned categorisation -------------------------------------------------
  // Remember "merchant keyword -> category" from the user's own choices and reuse
  // it for imports, receipt scans, and manual entry. Best-effort & silent.
  const CAT_STOPWORDS = new Set(["pty", "ltd", "the", "and", "for", "au", "aus", "australia", "card", "value", "date", "payment", "pmt", "direct", "debit", "credit", "purchase", "transfer", "fast", "from", "account", "inv", "ref", "eftpos", "visa", "mastercard", "group", "services", "service", "store", "online", "www", "com"]);
  const catKeyword = (text) => {
    const toks = String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/)
      .filter((t) => t.length > 2 && !CAT_STOPWORDS.has(t) && !/^\d+$/.test(t));
    return toks[0] || "";
  };
  const learnedCategoryFor = (text) => {
    const hay = " " + String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
    let best = null;
    for (const r of categoryRules) {
      if (r.keyword && hay.includes(" " + r.keyword + " ")) {
        if (!best || (r.hits || 0) > (best.hits || 0) || ((r.hits || 0) === (best.hits || 0) && r.keyword.length > best.keyword.length)) best = r;
      }
    }
    return best && EXPENSE_CATEGORIES.includes(best.category) ? best.category : null;
  };
  const learnCategory = async (merchant, description, category) => {
    if (!category || !EXPENSE_CATEGORIES.includes(category)) return;
    const keyword = catKeyword(merchant) || catKeyword(description);
    if (!keyword) return;
    const existing = categoryRules.find((r) => r.keyword === keyword);
    if (existing && existing.category === category) {
      supabase.from("bk_category_rules").update({ hits: (existing.hits || 1) + 1, updated_at: new Date().toISOString() }).eq("id", existing.id).then(() => {}, () => {});
      setCategoryRules((prev) => prev.map((r) => (r.id === existing.id ? { ...r, hits: (r.hits || 1) + 1 } : r)));
      return;
    }
    const row = { user_id: session.user.id, business_id: biz, keyword, category, hits: (existing?.hits || 0) + 1, updated_at: new Date().toISOString() };
    const { data } = await supabase.from("bk_category_rules").upsert(row, { onConflict: "business_id,keyword" }).select().single();
    if (data) setCategoryRules((prev) => [...prev.filter((r) => !(r.business_id === data.business_id && r.keyword === data.keyword)), data]);
  };

  const addTransaction = async (t) => {
    const ps = t.payment_source || "business";
    const isReimburse = ps === "personal_reimburse";
    const isPersonalNoReimburse = ps === "personal_no_reimburse";
    const isPersonal = isReimburse || isPersonalNoReimburse;
    const row = { user_id: session.user.id, business_id: biz, division: insertDivision, date: t.date, type: t.type, description: t.description, amount: Number(t.amount) || 0, account: t.account, contact: null, merchant: t.merchant || null, reference: t.reference, receipt_path: t.receipt_path || t.receiptPath || "", job: t.job, payment_source: isPersonal ? "personal" : ps, paid_by: isPersonal ? (t.paid_by || "Michel") : null, reimbursement_required: isReimburse, reimbursement_status: isReimburse ? "pending" : isPersonalNoReimburse ? "do_not_reimburse" : "not_required", reimbursement_date: null, reimbursement_amount: isReimburse ? (Number(t.amount) || 0) : null, reimbursement_reference: null, business_purpose: BUSINESS_PURPOSE_CATEGORIES.has(t.account) ? (t.business_purpose || null) : null, ai_category_confidence: t.ai_category_confidence != null ? Number(t.ai_category_confidence) : null, ai_extraction_confidence: t.ai_extraction_confidence != null ? Number(t.ai_extraction_confidence) : null, ai_warnings: t.ai_warnings?.length ? t.ai_warnings : null };
    const { ok, data: inserted } = await sbInsert("bk_transactions", row, "save expense");
    if (!ok) return;
    if (inserted) {
      if (inserted.receipt_path) {
        const ext = (inserted.receipt_path.split(".").pop() || "jpg").toLowerCase();
        const newName = safeFileName([inserted.date, (inserted.merchant || inserted.description || "Expense").slice(0, 40), inserted.account || "Uncategorised", fmtAmtFile(inserted.amount), inserted.id], ext);
        const newPath = `${session.user.id}/${newName}`;
        const { error: moveErr } = await supabase.storage.from("receipts").move(inserted.receipt_path, newPath);
        if (!moveErr) {
          await supabase.from("bk_transactions").update({ receipt_path: newPath }).eq("id", inserted.id);
          inserted.receipt_path = newPath;
        }
      }
      setTxns((prev) => [inserted, ...prev]);
      learnCategory(inserted.merchant, inserted.description, inserted.account);
    }
    if (inserted && inserted.receipt_path && emailConn) saveToOneDrive("expense", inserted.id, { silent: true });
    setModal(null);
    setAiData(null);
  };

  // Insert several scanned expenses at once (batch receipts) without closing the
  // modal per item. Mirrors addTransaction's per-row handling: receipt rename,
  // category learning, OneDrive filing. Returns the inserted rows.
  const addExpensesBatch = async (items) => {
    const inserted = [];
    for (const t of items) {
      const isPersonal = !!t.personal_card;
      const row = { user_id: session.user.id, business_id: biz, division: insertDivision, date: t.date, type: "expense", description: t.description, amount: Number(t.amount) || 0, account: t.account, contact: null, merchant: t.merchant || null, reference: t.reference || null, receipt_path: t.receipt_path || "", payment_source: isPersonal ? "personal" : "business", paid_by: isPersonal ? "Michel" : null, reimbursement_required: isPersonal, reimbursement_status: isPersonal ? "pending" : "not_required", business_purpose: BUSINESS_PURPOSE_CATEGORIES.has(t.account) ? (t.business_purpose || null) : null };
      const { ok, data } = await sbInsert("bk_transactions", row, "save expense");
      if (!ok || !data) continue;
      let rec = data;
      if (rec.receipt_path) {
        const ext = (rec.receipt_path.split(".").pop() || "jpg").toLowerCase();
        const newName = safeFileName([rec.date, (rec.merchant || rec.description || "Expense").slice(0, 40), rec.account || "Uncategorised", fmtAmtFile(rec.amount), rec.id], ext);
        const newPath = `${session.user.id}/${newName}`;
        const { error: moveErr } = await supabase.storage.from("receipts").move(rec.receipt_path, newPath);
        if (!moveErr) { await supabase.from("bk_transactions").update({ receipt_path: newPath }).eq("id", rec.id); rec = { ...rec, receipt_path: newPath }; }
      }
      setTxns((prev) => [rec, ...prev]);
      learnCategory(rec.merchant, rec.description, rec.account);
      if (rec.receipt_path && emailConn) saveToOneDrive("expense", rec.id, { silent: true });
      inserted.push(rec);
    }
    return inserted;
  };

  const updateTransaction = async (id, t) => {
    const orig = txns.find((x) => x.id === id);
    const ps = t.payment_source || "business";
    const isReimburse = ps === "personal_reimburse";
    const isPersonalNoReimburse = ps === "personal_no_reimburse";
    const isPersonal = isReimburse || isPersonalNoReimburse;
    const row = { date: t.date, type: t.type, description: t.description, amount: Number(t.amount) || 0, account: t.account, contact: null, merchant: t.merchant || null, reference: t.reference, receipt_path: t.receipt_path || null, job: t.job, payment_source: isPersonal ? "personal" : ps, paid_by: isPersonal ? (t.paid_by || "Michel") : null, reimbursement_required: isReimburse, reimbursement_status: isReimburse ? (t.reimbursement_status === "reimbursed" ? "reimbursed" : "pending") : isPersonalNoReimburse ? "do_not_reimburse" : "not_required", reimbursement_date: isReimburse ? (t.reimbursement_date || null) : null, reimbursement_amount: isReimburse ? (t.reimbursement_amount != null ? Number(t.reimbursement_amount) : (Number(t.amount) || 0)) : null, reimbursement_reference: isReimburse ? (t.reimbursement_reference || null) : null, business_purpose: BUSINESS_PURPOSE_CATEGORIES.has(t.account) ? (t.business_purpose || null) : null };
    const { ok, data: updated } = await sbWrite(supabase.from("bk_transactions").update(row).eq("id", id).select().single(), "update expense");
    if (!ok) return;
    if (updated) setTxns((prev) => prev.map((x) => (x.id === id ? updated : x)));
    if (updated && updated.receipt_path && updated.receipt_path !== (orig?.receipt_path || null) && emailConn) saveToOneDrive("expense", updated.id, { silent: true });
    if (updated) learnCategory(updated.merchant, updated.description, updated.account);
    setModal(null);
    setEditItem(null);
  };

  const deleteTransaction = async (id) => {
    if (!window.confirm("Delete this transaction? This cannot be undone.")) return;
    const { ok } = await sbWrite(supabase.from("bk_transactions").delete().eq("id", id), "delete expense");
    if (!ok) return;
    setTxns((prev) => prev.filter((t) => t.id !== id));
    setModal(null);
    setEditItem(null);
  };

  const updateIncome = async (id, f) => {
    const row = { date: f.date, amount: Number(f.amount) || 0, description: f.description, account: f.account };
    const { ok, data } = await sbWrite(supabase.from("bk_transactions").update(row).eq("id", id).select().single(), "update income");
    if (!ok) return;
    if (data) setTxns((prev) => prev.map((x) => (x.id === id ? data : x)));
    setModal(null);
    setEditItem(null);
  };

  const markReimbursed = async (id, { status, date, amount, reference }) => {
    const row = { reimbursement_status: status, reimbursement_date: date || null, reimbursement_amount: amount != null ? Number(amount) : null, reimbursement_reference: reference || null };
    const { ok, data: updated } = await sbWrite(supabase.from("bk_transactions").update(row).eq("id", id).select().single(), "update reimbursement");
    if (!ok) return;
    if (updated) setTxns((prev) => prev.map((x) => (x.id === id ? updated : x)));
  };

  const completeReconciliation = async ({ statementDate, closingBalance, openingBalance, txnIds, invoiceIds }) => {
    const row = { user_id: session.user.id, business_id: biz, statement_date: statementDate, opening_balance: openingBalance, closing_balance: closingBalance };
    const { ok, data: rec, error } = await sbWrite(supabase.from("bk_reconciliations").insert(row).select().single(), "save reconciliation");
    if (!ok) {
      if (error?.code === "42P01") alert("Bank reconciliation needs migration 0009 applied in Supabase first.");
      return false;
    }
    const stamp = new Date().toISOString();
    const patch = { reconciled_at: stamp, reconciliation_id: rec.id };
    if (txnIds.length) {
      const tRes = await sbWrite(supabase.from("bk_transactions").update(patch).in("id", txnIds), "reconcile expenses");
      if (!tRes.ok) return false;
    }
    if (invoiceIds.length) {
      const iRes = await sbWrite(supabase.from("bk_invoices").update(patch).in("id", invoiceIds), "reconcile invoices");
      if (!iRes.ok) return false;
    }
    const txnSet = new Set(txnIds);
    const invSet = new Set(invoiceIds);
    setTxns((prev) => prev.map((t) => (txnSet.has(t.id) ? { ...t, ...patch } : t)));
    setInvoices((prev) => prev.map((i) => (invSet.has(i.id) ? { ...i, ...patch } : i)));
    setLastReconciliation(rec);
    return true;
  };

  // Reverse a whole reconciliation/import batch: delete the expenses & income it
  // created, clear the reconciled marks from anything it matched, and remove the
  // reconciliation record. Invoices it marked paid stay paid (adjust in Sales).
  const undoReconciliation = async (recId) => {
    if (!window.confirm("Undo this reconciliation?\n\nThis deletes the expenses and income this import created, clears the reconciled marks from any matched items, and removes the reconciliation record. Any invoices it marked paid stay paid — change those in Sales if needed.")) return false;
    const d1 = await sbWrite(supabase.from("bk_transactions").delete().eq("reconciliation_id", recId).eq("source", "bank"), "remove imported transactions");
    if (!d1.ok) return false;
    await sbWrite(supabase.from("bk_transactions").update({ reconciled_at: null, reconciliation_id: null }).eq("reconciliation_id", recId), "clear reconciled marks");
    await sbWrite(supabase.from("bk_invoices").update({ reconciled_at: null, reconciliation_id: null }).eq("reconciliation_id", recId), "clear invoice marks");
    await sbWrite(supabase.from("bk_reconciliations").delete().eq("id", recId), "delete reconciliation");
    await loadData(biz);
    return true;
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
    if (!window.confirm("Delete this contact? This cannot be undone.")) return;
    const { ok } = await sbWrite(supabase.from("bk_contacts").delete().eq("id", id), "delete contact");
    if (!ok) return;
    setContacts((prev) => prev.filter((c) => c.id !== id));
    setModal(null);
    setEditItem(null);
  };

  const addInvoice = async (inv) => {
    const items = inv.items || [];
    const row = { user_id: session.user.id, business_id: biz, number: inv.number, type: inv.type, division: insertDivision, date: inv.date || null, due_date: inv.due_date || null, contact_name: inv.contact_name, contact_email: inv.contact_email, contact_company: inv.contact_company, contact_abn: inv.contact_abn, contact_address: inv.contact_address, contact_phone: inv.contact_phone, job: inv.job, project_id: inv.project_id || null, notes: inv.notes, terms: inv.terms || null, status: inv.status, total: inv.total, pricing_mode: inv.pricing_mode || "itemised" };
    const { ok, data: inserted } = await sbInsert("bk_invoices", row, "save invoice");
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
    setModal(null);
    setEditItem(null);
    setInvoiceSeed(null);
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
    const items = updates.items;
    const { ok: updOk } = await sbWrite(supabase.from("bk_invoices").update(dbUpdates).eq("id", id), "save invoice");
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
    formDirtyRef.current = false;
    setModal(null);
    setEditItem(null);
    setInvoiceSeed(null);
  };

  const deleteInvoice = async (id) => {
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
    if (!window.confirm(`Delete ${ids.length} invoice${ids.length === 1 ? "" : "s"}? This cannot be undone.`)) return false;
    const { ok } = await sbWrite(supabase.from("bk_invoices").delete().in("id", ids), "delete invoices");
    if (!ok) return false;
    const set = new Set(ids);
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
      const row = { user_id: session.user.id, business_id: biz, division: insertDivision, name: trimmed, contact_id: contact?.id || null, job_number: getNextJobNumber(jobs, insertDivision) };
      const { data: inserted } = await sbInsert("bk_jobs", row, "save job");
      if (inserted) setJobs((prev) => [inserted, ...prev]);
    }
  };

  // --- Projects (stored in bk_jobs) ---

  const createProject = async (p) => {
    const contact = p.contact_name ? contacts.find((c) => (c.name || c.company) === p.contact_name) : null;
    const row = { user_id: session.user.id, business_id: biz, division: insertDivision, name: (p.name || "").trim(), contact_id: contact?.id || null, address: p.address || null, notes: p.notes || null, contract_value: Number(p.contract_value) || 0, status: p.status || "active", job_number: getNextJobNumber(jobs, insertDivision) };
    const { ok, data: inserted } = await sbInsert("bk_jobs", row, "create project");
    if (!ok) return null;
    if (inserted) {
      setJobs((prev) => [inserted, ...prev]);
      // Create the matching OneDrive folder ("26106 - 10 McPherson Road …").
      // Best-effort: never block project creation on the Microsoft connection.
      if (emailConn) saveToOneDrive("project", inserted.id, { silent: true });
    }
    return inserted;
  };

  const updateProject = async (id, p) => {
    const row = {};
    if ("name" in p) row.name = (p.name || "").trim();
    if ("contact_name" in p) { const c = contacts.find((x) => (x.name || x.company) === p.contact_name); row.contact_id = c?.id || null; }
    if ("address" in p) row.address = p.address || null;
    if ("notes" in p) row.notes = p.notes || null;
    if ("contract_value" in p) row.contract_value = Number(p.contract_value) || 0;
    if ("status" in p) row.status = p.status;
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
    // A signed-up job is no longer a lead.
    if ((project.status || "active") === "lead") { await updateProject(projectId, { status: "active" }); return { ...project, status: "active" }; }
    return project;
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
    const row = { user_id: session.user.id, business_id: biz, name: p.name, abn: p.abn, address: p.address, email: p.email, phone: p.phone, bank_name: p.bank_name, account_name: p.account_name, bsb: p.bsb, account_number: p.account_number, logo_url: p.logo_url, email_template_invoice: p.email_template_invoice || "", email_template_quote: p.email_template_quote || "", email_signature: p.email_signature || "", onedrive_folder: p.onedrive_folder || "", onedrive_receipts_folder: p.onedrive_receipts_folder || "" };
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
  const [viewReceipt, setViewReceipt] = useState(null);

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

  const buildEmailBody = (inv) => {
    const isQuote = inv.type === "quote";
    const bName = profile.name || "our company";
    const template = isQuote
      ? (profile.email_template_quote || DEFAULT_EMAIL_TEMPLATE_QUOTE)
      : (profile.email_template_invoice || DEFAULT_EMAIL_TEMPLATE_INVOICE);
    const sig = profile.email_signature || `${bName}${profile.abn ? `\nABN: ${profile.abn}` : ""}${profile.address ? `\n${profile.address}` : ""}${profile.email ? `\n${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}`;
    const dueDateLine = inv.due_date ? `Payment is due by ${fmtDate(inv.due_date)}.` : "";
    const paymentDetails = profile.bsb ? `Bank details:\n${profile.bank_name ? `Bank: ${profile.bank_name}\n` : ""}Account: ${profile.account_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}` : "";
    return template
      // Greeting uses the first name only ("Hi John,"). {first_name} is the
      // preferred placeholder; {contact_name} resolves the same way since it's
      // only ever used in the greeting line.
      .replace(/\{first_name\}/g, firstName(inv.contact_name))
      .replace(/\{contact_name\}/g, firstName(inv.contact_name))
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

  const createOutlookDraft = async (inv) => {
    if (!emailConn) { alert("Connect Outlook in Settings first."); return; }
    setOutlookDraftLoading(inv.id);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) throw new Error("Not authenticated");
      // Always (re)generate the PDF so the attachment reflects the latest edits.
      // Fail hard if it doesn't succeed — never create a draft without the PDF.
      const pdfResp = await fetch(`${API_BASE}/.netlify/functions/generate-invoice-pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: inv.id, auth_token: token }),
      });
      if (!pdfResp.ok) {
        let detail = "";
        try { detail = (await pdfResp.json()).error || ""; } catch { /* ignore */ }
        throw new Error("Could not generate the invoice PDF, so the Outlook draft was not created. " + (detail || "Please try again."));
      }
      const resp = await fetch(`${API_BASE}/.netlify/functions/send-invoice-outlook`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: inv.id, draft: true }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || "Draft creation failed");
      if (result.webLink && !isMobile) window.open(result.webLink, "_blank");
      alert("Draft created in Outlook with PDF attached. Open Outlook to review and send.");
      return true;
    } catch (err) {
      console.error("Outlook draft error:", err);
      alert("Failed to create Outlook draft: " + err.message);
      return false;
    } finally {
      setOutlookDraftLoading(null);
    }
  };

  const sendReminder = (inv) => {
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    const bName = profile.name || "our company";
    const subject = `Reminder: ${docType} ${inv.number} from ${bName}`;
    const overdueDays = inv.due_date ? Math.max(0, Math.floor((Date.now() - new Date(inv.due_date)) / 86400000)) : 0;
    const sig = profile.email_signature || `${bName}${profile.abn ? `\nABN: ${profile.abn}` : ""}${profile.address ? `\n${profile.address}` : ""}${profile.email ? `\n${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}`;
    const body = `Hi ${firstName(inv.contact_name)},\n\nThis is a friendly reminder that ${docType.toLowerCase()} ${inv.number} for ${fmt(inv.total || 0)} ${overdueDays > 0 ? `was due ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago` : "is due for payment"}.\n\n${profile.bsb ? `Bank details:\n${profile.bank_name ? `Bank: ${profile.bank_name}\n` : ""}Account: ${profile.account_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}\n\n` : ""}Please let us know if you have any questions.\n\nKind regards,\n${sig}`;
    window.open(`mailto:${inv.contact_email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    if (inv.due_date && new Date(inv.due_date) < new Date() && inv.status === "sent") updateInvoice(inv.id, { status: "overdue" });
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
      if (inv.due_date && new Date(inv.due_date) < new Date() && inv.status === "sent") updateInvoice(inv.id, { status: "overdue" });
    } catch (err) {
      if (window.confirm(`Couldn't send via the email service (${err.message}).\n\nOpen an email draft instead?`)) sendReminder(inv);
    }
  };

  const markPaid = (inv) => {
    updateInvoice(inv.id, { status: "paid", paid_date: today() });
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
    return true;
  };

  // Mark paid without closing the current modal (used inside the Project modal).
  const markPaidQuiet = async (inv) => {
    const upd = { status: "paid", paid_date: today() };
    const { ok } = await sbWrite(supabase.from("bk_invoices").update(upd).eq("id", inv.id), "mark paid");
    if (!ok) return;
    setInvoices((prev) => prev.map((i) => (i.id === inv.id ? { ...i, ...upd } : i)));
  };

  // Save an invoice PDF or expense receipt to OneDrive via the Netlify function
  // (reuses the Microsoft connection). silent=true for auto-save (no popups).
  const saveToOneDrive = async (kind, id, opts = {}) => {
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) return false;
      const resp = await fetch(`${API_BASE}/.netlify/functions/onedrive-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, id }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) { if (!opts.silent) alert(data.error || "Could not save to OneDrive."); return false; }
      if (!opts.silent) alert(`Saved to OneDrive → ${data.savedTo || "done"}`);
      return true;
    } catch {
      if (!opts.silent) alert("Could not reach OneDrive. Please try again.");
      return false;
    }
  };

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
    { id: "expenses", label: "Expenses", icon: Icons.Expenses, submenu: [{ id: "expenses", label: "Expenses", icon: Icons.Expenses }, { id: "reimbursements", label: "Reimbursements", icon: Icons.Reimburse }, { id: "reconcile", label: "Bank Reconciliation", icon: Icons.Reconcile }] },
    { id: "invoices", label: "Sales", icon: Icons.Invoices, submenu: [{ id: "invoices", label: "Invoices", icon: Icons.Invoices }, { id: "quotes", label: "Quotes", icon: Icons.Quotes }] },
    { id: "pnl", label: "P&L", icon: Icons.Reports },
    { id: "projects", label: "Projects", icon: Icons.Projects },
    { id: "contacts", label: "Contacts", icon: Icons.Contacts },
  ];
  // Sub-pages reached via in-page toggles map to their parent nav item for the
  // active highlight: reimburse/reconcile sit under Expenses, quotes under Sales.
  const activeNav = ({ reimbursements: "expenses", reconcile: "expenses", quotes: "invoices" })[page] || page;

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

  // Shared list-screen UX bits (pills with counts, summary tiles, friendly empty
  // states) so every table screen looks and behaves consistently.
  const ReconciledMark = () => (
    <span style={{ display: "inline-flex", alignItems: "center", marginLeft: 6, padding: "1px 7px", borderRadius: 10, fontSize: 9, fontWeight: 600, background: "#ecfdf5", color: "#059669", whiteSpace: "nowrap" }} title="Reconciled to bank statement">✓ Bank</span>
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

  const ListStat = ({ label, value, color }) => (
    <div style={s.miniStat}>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#94a3b8" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || "#0f172a", marginTop: 3, letterSpacing: "-0.01em" }}>{value}</div>
    </div>
  );

  const EmptyState = ({ icon: Icon, title, hint }) => (
    <div style={{ padding: "44px 20px", textAlign: "center" }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: "#ecfdf5", display: "inline-flex", alignItems: "center", justifyContent: "center", color: accent, marginBottom: 12 }}>{Icon ? <Icon /> : null}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>{title}</div>
      {hint && <div style={{ fontSize: 12, color: "#94a3b8", margin: "4px auto 0", maxWidth: 300, lineHeight: 1.5 }}>{hint}</div>}
    </div>
  );

  const ReceiptCapture = () => {
    const [phase, setPhase] = useState("capture");
    const [rawUrl, setRawUrl] = useState(null);
    const [scannedUrl, setScannedUrl] = useState(null);
    const [error, setError] = useState("");
    const [corners, setCorners] = useState(null);
    const [dragging, setDragging] = useState(null);
    const [imgNat, setImgNat] = useState({ w: 0, h: 0 });
    const fileRef = useRef(null);
    const containerRef = useRef(null);
    const imgRef = useRef(null);

    const handleFile = (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setError("");
      setRawUrl(URL.createObjectURL(file));
      setPhase("scan");
    };

    const onImgLoad = () => {
      const img = imgRef.current;
      if (!img) return;
      const w = img.naturalWidth, h = img.naturalHeight;
      setImgNat({ w, h });
      setCorners([{ x: w * 0.05, y: h * 0.05 }, { x: w * 0.95, y: h * 0.05 }, { x: w * 0.95, y: h * 0.95 }, { x: w * 0.05, y: h * 0.95 }]);
    };

    const getPos = (e) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: Math.max(0, Math.min(imgNat.w, ((clientX - rect.left) / rect.width) * imgNat.w)), y: Math.max(0, Math.min(imgNat.h, ((clientY - rect.top) / rect.height) * imgNat.h)) };
    };

    const onPointerDown = (idx) => (e) => { e.preventDefault(); setDragging(idx); };
    const onPointerMove = (e) => { if (dragging === null) return; const p = getPos(e); if (p) setCorners((c) => c.map((pt, i) => (i === dragging ? p : pt))); };
    const onPointerUp = () => setDragging(null);

    const doScan = async () => {
      setPhase("scanning");
      const img = new Image();
      img.src = rawUrl;
      await new Promise((r) => { img.onload = r; });

      const dist = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
      const outW = Math.round(Math.max(dist(corners[0], corners[1]), dist(corners[3], corners[2])));
      const outH = Math.round(Math.max(dist(corners[0], corners[3]), dist(corners[1], corners[2])));

      const srcC = document.createElement("canvas");
      srcC.width = img.naturalWidth; srcC.height = img.naturalHeight;
      const srcCtx = srcC.getContext("2d");
      srcCtx.drawImage(img, 0, 0);
      const srcData = srcCtx.getImageData(0, 0, srcC.width, srcC.height);

      const dstC = document.createElement("canvas");
      dstC.width = outW; dstC.height = outH;
      const dstCtx = dstC.getContext("2d");
      const dstData = dstCtx.createImageData(outW, outH);

      const [tl, tr, br, bl] = corners;
      for (let dy = 0; dy < outH; dy++) {
        const t = dy / outH;
        const lx = tl.x + t * (bl.x - tl.x), ly = tl.y + t * (bl.y - tl.y);
        const rx = tr.x + t * (br.x - tr.x), ry = tr.y + t * (br.y - tr.y);
        for (let dx = 0; dx < outW; dx++) {
          const u = dx / outW;
          const sx = Math.round(lx + u * (rx - lx)), sy = Math.round(ly + u * (ry - ly));
          if (sx >= 0 && sx < srcC.width && sy >= 0 && sy < srcC.height) {
            const si = (sy * srcC.width + sx) * 4, di = (dy * outW + dx) * 4;
            dstData.data[di] = srcData.data[si]; dstData.data[di + 1] = srcData.data[si + 1]; dstData.data[di + 2] = srcData.data[si + 2]; dstData.data[di + 3] = 255;
          }
        }
      }
      dstCtx.putImageData(dstData, 0, 0);

      const enhC = document.createElement("canvas");
      enhC.width = outW; enhC.height = outH;
      const enhCtx = enhC.getContext("2d");
      enhCtx.filter = "contrast(1.4) brightness(1.1) saturate(0.2)";
      enhCtx.drawImage(dstC, 0, 0);

      const dataUrl = enhC.toDataURL("image/jpeg", 0.92);
      setScannedUrl(dataUrl);

      setPhase("processing");
      let filePath = null;
      try {
        const base64 = dataUrl.split(",")[1];
        const blob = await (await fetch(dataUrl)).blob();
        filePath = `${session.user.id}/${Date.now()}_receipt.jpg`;
        await supabase.storage.from("receipts").upload(filePath, blob, { contentType: "image/jpeg" });
        const token = (await supabase.auth.getSession()).data.session?.access_token;
        const resp = await fetch(`${API_BASE}/.netlify/functions/extract-receipt`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ image: base64, mediaType: "image/jpeg" }) });
        if (!resp.ok) throw new Error("Failed to process receipt");
        const result = await resp.json();
        const fromReimbursements = page === "reimbursements";
        setAiData({ ...result, receiptPath: filePath, scannedUrl: dataUrl, fromReimbursements });
        setModal("expense");
      } catch (err) {
        if (filePath) supabase.storage.from("receipts").remove([filePath]).catch(() => {});
        setError(err.message || "Failed to process receipt");
        setPhase("scan");
      }
    };

    const reset = () => { setPhase("capture"); setRawUrl(null); setScannedUrl(null); setCorners(null); setError(""); };

    const cornerStyle = (c) => {
      if (!containerRef.current || !imgNat.w) return { display: "none" };
      const rect = containerRef.current.getBoundingClientRect();
      return { position: "absolute", left: (c.x / imgNat.w) * rect.width - 10, top: (c.y / imgNat.h) * rect.height - 10, width: 20, height: 20, borderRadius: "50%", background: accent, border: "3px solid #fff", cursor: "grab", touchAction: "none", zIndex: 2 };
    };

    const polyPoints = () => {
      if (!corners || !containerRef.current || !imgNat.w) return "";
      const rect = containerRef.current.getBoundingClientRect();
      return corners.map((c) => `${(c.x / imgNat.w) * rect.width},${(c.y / imgNat.h) * rect.height}`).join(" ");
    };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{phase === "scan" ? "Crop Receipt" : "Snap Receipt"}</h3>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>

        {phase === "capture" && (
          <div>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display: "none" }} />
            <button onClick={() => fileRef.current?.click()} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", padding: "20px", fontSize: 15 }}><Icons.Camera /> Take Photo of Receipt</button>
            <div style={{ textAlign: "center", color: "#64748b", fontSize: 12, marginTop: 12 }}>or choose from gallery</div>
            <input type="file" accept="image/*" onChange={handleFile} style={{ display: "block", margin: "8px auto 0", color: "#64748b", fontSize: 12 }} />
          </div>
        )}

        {phase === "scan" && rawUrl && (
          <div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>Drag the corners to the edges of the receipt</div>
            <div ref={containerRef} style={{ position: "relative", userSelect: "none", marginBottom: 12 }} onMouseMove={onPointerMove} onMouseUp={onPointerUp} onTouchMove={onPointerMove} onTouchEnd={onPointerUp}>
              <img ref={imgRef} src={rawUrl} onLoad={onImgLoad} alt="Receipt" style={{ width: "100%", display: "block", borderRadius: 8, border: "1px solid #e2e8f0" }} />
              {corners && (
                <>
                  <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 1 }}>
                    <polygon points={polyPoints()} fill={accent + "20"} stroke={accent} strokeWidth="2" strokeDasharray="6 3" />
                  </svg>
                  {corners.map((c, i) => <div key={i} style={cornerStyle(c)} onMouseDown={onPointerDown(i)} onTouchStart={onPointerDown(i)} />)}
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={doScan} style={{ ...s.btn(accent), flex: 1, justifyContent: "center" }}>Scan & Extract</button>
              <button onClick={reset} style={s.btnOutline}>Retake</button>
            </div>
          </div>
        )}

        {(phase === "scanning" || phase === "processing") && (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            {scannedUrl && <img src={scannedUrl} alt="Scanned" style={{ width: "60%", borderRadius: 8, border: "1px solid #e2e8f0", marginBottom: 12 }} />}
            <div style={{ color: "#94a3b8" }}>{phase === "scanning" ? "Scanning receipt..." : "Reading receipt with AI..."}</div>
          </div>
        )}

        {error && <div style={{ color: "#ef4444", fontSize: 13, padding: 12, background: "#fef2f2", borderRadius: 8, marginTop: 12 }}>{error}</div>}
      </div>
    );
  };

  const ExpenseForm = ({ existing }) => {
    const derivePersonalCard = (e) => {
      if (!e) return false;
      return e.payment_source === "personal";
    };
    const ai = !existing ? aiData : null;
    const fromReimbursements = ai?.fromReimbursements;
    const initPersonalCard = existing ? derivePersonalCard(existing) : (fromReimbursements || false);
    const defaultCategory = EXPENSE_CATEGORIES.includes("Office Supplies & Stationery") ? "Office Supplies & Stationery" : EXPENSE_CATEGORIES[0];
    const init = existing
      ? { ...existing, personal_card: initPersonalCard, business_purpose: existing.business_purpose || "", merchant: existing.merchant || "" }
      : ai
        ? { date: ai.date || today(), type: "expense", description: ai.description || ai.vendor || "", amount: ai.total != null ? String(ai.total) : "", account: learnedCategoryFor(ai.vendor || ai.description) || (EXPENSE_CATEGORIES.includes(ai.category) ? ai.category : defaultCategory), merchant: ai.vendor || "", reference: "", job: "", receipt_path: ai.receiptPath || "", personal_card: initPersonalCard, business_purpose: ai.businessPurpose || "", ai_category_confidence: ai.categoryConfidence || null, ai_extraction_confidence: ai.confidence || null, ai_warnings: ai.warnings || null }
        : { date: today(), type: "expense", description: "", amount: "", account: defaultCategory, merchant: "", reference: "", job: "", personal_card: false, business_purpose: "" };
    const [f, setF] = useState({ ...init, amount: String(init.amount || "") });
    const [saving, setSaving] = useState(false);
    const needsBusinessPurpose = BUSINESS_PURPOSE_CATEGORIES.has(f.account);
    const hasWarnings = ai && (ai.confidence < 0.7 || ai.warnings?.length > 0);
    const receiptInputRef = useRef(null);
    const [uploadingReceipt, setUploadingReceipt] = useState(false);
    const [extracting, setExtracting] = useState(false);
    const [extractInfo, setExtractInfo] = useState(null);
    const origReceiptRef = useRef(existing?.receipt_path || null);
    const draftPathRef = useRef(ai?.receiptPath || null);
    const handleReceiptFile = async (e) => {
      const file = e.target.files?.[0];
      if (e.target) e.target.value = "";
      if (!file) return;
      setUploadingReceipt(true);
      try {
        const isPdf = (file.type || "").includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
        const ext = isPdf ? "pdf" : ((file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg");
        const path = `${session.user.id}/${Date.now()}_receipt.${ext}`;
        const { error } = await supabase.storage.from("receipts").upload(path, file, { contentType: file.type || "image/jpeg" });
        if (error) { alert("Could not upload the receipt. Please try again."); return; }
        if (draftPathRef.current && draftPathRef.current !== origReceiptRef.current) supabase.storage.from("receipts").remove([draftPathRef.current]).catch(() => {});
        draftPathRef.current = path;
        setF((prev) => ({ ...prev, receipt_path: path }));
        // For an image receipt on a new expense, let the AI read it and fill the blanks.
        if (!existing) {
          setExtracting(true);
          setExtractInfo(null);
          try {
            const base64 = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(",")[1]); fr.onerror = reject; fr.readAsDataURL(file); });
            const token = (await supabase.auth.getSession()).data.session?.access_token;
            const resp = await fetch(`${API_BASE}/.netlify/functions/extract-receipt`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ image: base64, mediaType: file.type || (isPdf ? "application/pdf" : "image/jpeg") }) });
            if (resp.ok) {
              const r = await resp.json();
              setF((prev) => ({
                ...prev,
                merchant: prev.merchant || r.vendor || "",
                description: prev.description || r.description || r.vendor || "",
                amount: prev.amount && prev.amount !== "" ? prev.amount : (r.total != null ? String(r.total) : ""),
                date: r.date || prev.date,
                account: learnedCategoryFor(r.vendor || r.description) || (EXPENSE_CATEGORIES.includes(r.category) ? r.category : prev.account),
                business_purpose: prev.business_purpose || r.businessPurpose || "",
                reference: prev.reference || r.reference || "",
              }));
              setExtractInfo({ confidence: r.confidence, warnings: r.warnings || [] });
            } else {
              setExtractInfo({ error: true });
            }
          } catch { setExtractInfo({ error: true }); }
          finally { setExtracting(false); }
        }
      } finally { setUploadingReceipt(false); }
    };
    const removeReceiptDraft = () => {
      const cur = f.receipt_path;
      if (cur && cur === draftPathRef.current && cur !== origReceiptRef.current) { supabase.storage.from("receipts").remove([cur]).catch(() => {}); draftPathRef.current = null; }
      setF((prev) => ({ ...prev, receipt_path: "" }));
    };
    const toSave = () => ({
      ...f,
      payment_source: f.personal_card ? "personal_reimburse" : "business",
      paid_by: f.personal_card ? "Michel" : null,
      business_purpose: needsBusinessPurpose ? (f.business_purpose || "") : "",
    });
    const categorySelect = (
      <select value={f.account} onChange={(e) => { const account = e.target.value; setF({ ...f, account, business_purpose: BUSINESS_PURPOSE_CATEGORIES.has(account) ? f.business_purpose : "" }); }} style={s.select}>
        {!EXPENSE_CATEGORIES.includes(f.account) && f.account ? <option value={f.account}>{f.account} (legacy)</option> : null}
        {EXPENSE_CATEGORY_GROUPS.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </optgroup>
        ))}
      </select>
    );
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{existing ? "Edit" : "New"} Expense</h3>
            {!existing && <button type="button" onClick={() => setModal("batch")} title="Add many receipts at once" style={{ ...s.btnOutline, color: "#7c3aed", borderColor: "#7c3aed40", padding: "3px 9px", fontSize: 11, gap: 5 }}><Icons.Camera /> Batch</button>}
          </div>
          <button onClick={() => { if (ai?.receiptPath) supabase.storage.from("receipts").remove([ai.receiptPath]).catch(() => {}); if (draftPathRef.current && draftPathRef.current !== origReceiptRef.current) supabase.storage.from("receipts").remove([draftPathRef.current]).catch(() => {}); setModal(null); setEditItem(null); setAiData(null); }} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        {ai && (
          <div style={{ background: hasWarnings ? "#fffbeb" : "#ecfdf5", border: "1px solid " + (hasWarnings ? "#fde68a" : "#86efac"), borderRadius: 8, padding: 12, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              {ai.scannedUrl && <img src={ai.scannedUrl} alt="Receipt" style={{ width: 60, height: 80, objectFit: "cover", borderRadius: 6, border: "1px solid #e2e8f0" }} />}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>AI extracted receipt details</div>
                <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>Overall confidence: {Math.round((ai.confidence || 0) * 100)}%{ai.categoryConfidence != null ? ` · Category: ${Math.round(ai.categoryConfidence * 100)}%` : ""}</div>
                {ai.warnings?.length > 0 && ai.warnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: "#92400e", marginTop: 2 }}>Warning: {w}</div>)}
                {hasWarnings && <div style={{ fontSize: 11, color: "#92400e", fontWeight: 600, marginTop: 4 }}>Please review these details before saving.</div>}
              </div>
            </div>
          </div>
        )}
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Date</label><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Amount (AUD)</label><input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" style={s.input} /></div>
        </div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Merchant</label><input value={f.merchant || ""} onChange={(e) => { const m = e.target.value; const learned = learnedCategoryFor(m); setF((prev) => ({ ...prev, merchant: m, ...(learned ? { account: learned } : {}) })); }} placeholder="e.g. Bunnings Warehouse" style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Description</label><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. 20x 90mm screws, timber battens" style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Category</label>{categorySelect}</div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Reference</label><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="Receipt number" style={s.input} /></div>
        {needsBusinessPurpose && (
          <div style={{ marginBottom: 12 }}><label style={s.label}>Business Purpose</label><input value={f.business_purpose} onChange={(e) => setF({ ...f, business_purpose: e.target.value })} placeholder="Why was this purchased? (required for ATO-scrutinised categories)" style={s.input} /></div>
        )}
        <div style={{ marginBottom: 12, padding: "12px 14px", background: f.personal_card ? "#fffbeb" : "#f8fafc", border: `1px solid ${f.personal_card ? "#fde68a" : "#e2e8f0"}`, borderRadius: 9 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", margin: 0 }}>
            <input type="checkbox" checked={!!f.personal_card} onChange={(e) => setF({ ...f, personal_card: e.target.checked })} style={{ width: 16, height: 16, accentColor: accent }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>Paid on personal card</span>
          </label>
          {f.personal_card && (
            <div style={{ fontSize: 11, color: "#92400e", marginTop: 10, fontWeight: 500 }}>Will appear in Reimbursements as pending — owed to Michel</div>
          )}
        </div>
        <div style={{ marginBottom: 12, padding: "12px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 9 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>Receipt</span>
            {f.receipt_path ? <span style={{ fontSize: 12, color: "#059669", fontWeight: 600 }}>✓ Attached</span> : <span style={{ fontSize: 11, color: "#94a3b8" }}>Optional</span>}
          </div>
          <input ref={receiptInputRef} type="file" accept="image/*,application/pdf" capture="environment" onChange={handleReceiptFile} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button type="button" disabled={uploadingReceipt || extracting} onClick={() => receiptInputRef.current?.click()} style={{ ...s.btnOutline, color: "#8b5cf6", borderColor: "#8b5cf640", gap: 6, opacity: uploadingReceipt || extracting ? 0.5 : 1 }}><Icons.Camera /> {uploadingReceipt ? "Uploading…" : extracting ? "Reading…" : (f.receipt_path ? "Replace" : "Snap / attach")}</button>
            {f.receipt_path && <button type="button" onClick={() => openReceipt({ receipt_path: f.receipt_path })} style={{ ...s.btnOutline, gap: 6 }}>View</button>}
            {f.receipt_path && <button type="button" onClick={removeReceiptDraft} style={{ ...s.btnOutline, color: "#ef4444", borderColor: "#ef444440" }}>Remove</button>}
          </div>
          {extracting && <div style={{ fontSize: 12, color: "#8b5cf6", fontWeight: 600, marginTop: 8 }}>Reading the receipt with AI…</div>}
          {!extracting && extractInfo && !extractInfo.error && <div style={{ fontSize: 11, color: "#059669", fontWeight: 600, marginTop: 8 }}>AI filled the details{extractInfo.confidence != null ? ` · ${Math.round(extractInfo.confidence * 100)}% confidence` : ""} — please review.{extractInfo.warnings?.length ? ` ${extractInfo.warnings.join(" ")}` : ""}</div>}
          {!extracting && extractInfo?.error && <div style={{ fontSize: 11, color: "#92400e", marginTop: 8 }}>Couldn't auto-read this receipt — enter the details manually.</div>}
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8, lineHeight: 1.5 }}>{emailConn ? "Photograph or attach a receipt — the AI reads it to fill the fields, and it's filed to your OneDrive receipts folder as a PDF when you save." : "Photograph or attach a receipt — the AI reads it to fill the fields. Connect Microsoft in Settings to also file it to OneDrive."}</div>
        </div>
        <button disabled={!f.description || !f.amount || saving} onClick={async () => { setSaving(true); const payload = toSave(); existing ? await updateTransaction(existing.id, payload) : await addTransaction(payload); setSaving(false); }} style={{ ...s.btn(accent), opacity: !f.description || !f.amount || saving ? 0.4 : 1, width: "100%", justifyContent: "center" }}>{saving ? "Saving…" : existing ? "Save Changes" : "Add Expense"}</button>
        {existing && !existing.receipt_path && existing.payment_source === "personal" && (
          <div style={{ marginTop: 8, padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, fontSize: 12, color: "#991b1b", fontWeight: 500 }}>Missing receipt for personally paid expense</div>
        )}
        {existing && (
          <button onClick={() => deleteTransaction(existing.id)} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", marginTop: 8, color: "#ef4444", borderColor: "#ef444440", gap: 6 }}>
            <Icons.Trash /> Delete Expense
          </button>
        )}
      </div>
    );
  };

  const BatchReceipts = () => {
    const [phase, setPhase] = useState("select"); // select | scanning | review | saving | done
    const [drafts, setDrafts] = useState([]);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [dragOver, setDragOver] = useState(false);
    const [savedCount, setSavedCount] = useState(0);
    const fileRef = useRef(null);
    const defCat = EXPENSE_CATEGORIES.includes("Office Supplies & Stationery") ? "Office Supplies & Stationery" : EXPENSE_CATEGORIES[0];

    const scanOne = async (file, i) => {
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const base = { key: `${i}-${file.name}`, include: true, isPdf, status: "ok", merchant: "", amount: "", date: today(), account: defCat, description: "", business_purpose: "", reference: "", confidence: null, warnings: [], receipt_path: "", scannedUrl: "" };
      try {
        const ext = isPdf ? "pdf" : (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
        const path = `${session.user.id}/${Date.now()}_${i}_receipt.${ext}`;
        const up = await supabase.storage.from("receipts").upload(path, file, { contentType: file.type || (isPdf ? "application/pdf" : "image/jpeg") });
        if (up.error) return { ...base, status: "error" };
        base.receipt_path = path;
        const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsDataURL(file); });
        if (!isPdf) base.scannedUrl = dataUrl;
        const token = (await supabase.auth.getSession()).data.session?.access_token;
        const resp = await fetch(`${API_BASE}/.netlify/functions/extract-receipt`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ image: dataUrl.split(",")[1], mediaType: file.type || (isPdf ? "application/pdf" : "image/jpeg") }) });
        if (!resp.ok) return { ...base, status: "scanfail" };
        const r = await resp.json();
        return { ...base, merchant: r.vendor || "", description: r.description || r.vendor || "", amount: r.total != null ? String(r.total) : "", date: r.date || base.date, account: learnedCategoryFor(r.vendor || r.description) || (EXPENSE_CATEGORIES.includes(r.category) ? r.category : defCat), business_purpose: r.businessPurpose || "", reference: r.reference || "", confidence: r.confidence, warnings: r.warnings || [] };
      } catch { return { ...base, status: "scanfail" }; }
    };

    const onFiles = async (fileList) => {
      const files = [...(fileList || [])].filter((f) => { const t = f.type || ""; return t.startsWith("image/") || t === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"); }).slice(0, 25);
      if (!files.length) { alert("Drop receipt images (JPG, PNG) or PDFs."); return; }
      setPhase("scanning");
      setProgress({ done: 0, total: files.length });
      const out = [];
      for (let i = 0; i < files.length; i++) { out.push(await scanOne(files[i], i)); setProgress({ done: i + 1, total: files.length }); }
      setDrafts(out);
      setPhase("review");
    };

    const upd = (key, patch) => setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    const chosen = drafts.filter((d) => d.include && d.amount && Number(d.amount) > 0);

    const addAll = async () => {
      if (!chosen.length) { alert("Set an amount on at least one receipt to add it."); return; }
      setPhase("saving");
      const dropped = drafts.filter((d) => !d.include && d.receipt_path).map((d) => d.receipt_path);
      if (dropped.length) supabase.storage.from("receipts").remove(dropped).catch(() => {});
      const added = await addExpensesBatch(chosen.map((d) => ({ date: d.date, amount: d.amount, account: d.account, merchant: d.merchant, description: d.description || d.merchant || "Expense", business_purpose: d.business_purpose, reference: d.reference, receipt_path: d.receipt_path })));
      setSavedCount(added.length);
      setPhase("done");
    };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Batch Receipts</h3>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        {phase === "select" && (
          <>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple onChange={(e) => onFiles(e.target.files)} style={{ display: "none" }} />
            <div onClick={() => fileRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={(e) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); }} style={{ border: `2px dashed ${dragOver ? accent : "#cbd5e1"}`, borderRadius: 12, padding: "40px 20px", textAlign: "center", cursor: "pointer", background: dragOver ? "#ecfdf5" : "#f8fafc" }}>
              <div style={{ color: accent, marginBottom: 8, display: "flex", justifyContent: "center" }}><Icons.Camera /></div>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>Drop receipt photos or PDFs here, or click to choose</div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Up to 25 files. Images are auto-read by AI — PDFs go straight to manual entry.</div>
            </div>
          </>
        )}
        {phase === "scanning" && (
          <div style={{ padding: "30px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>Uploading &amp; reading… {progress.done}/{progress.total}</div>
            <div style={{ height: 8, background: "#e2e8f0", borderRadius: 4, marginTop: 14, overflow: "hidden" }}><div style={{ height: "100%", width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`, background: accent, transition: "width .2s" }} /></div>
          </div>
        )}
        {phase === "review" && (
          <>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>{drafts.length} scanned · {chosen.length} ready to add. Review and edit, then add.</div>
            <div style={{ maxHeight: "55vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
              {drafts.map((d) => (
                <div key={d.key} style={{ border: "1px solid #e2e8f0", borderRadius: 10, padding: 10, opacity: d.include ? 1 : 0.5, background: "#fff" }}>
                  <div style={{ display: "flex", gap: 10 }}>
                    <input type="checkbox" checked={d.include} onChange={() => upd(d.key, { include: !d.include })} style={{ width: 16, height: 16, accentColor: accent, marginTop: 2, flexShrink: 0 }} />
                    {d.isPdf ? <div style={{ width: 44, height: 56, borderRadius: 6, border: "1px solid #e2e8f0", background: "#fef3c7", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#92400e" }}>PDF</div> : d.scannedUrl ? <img src={d.scannedUrl} alt="" style={{ width: 44, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid #e2e8f0", flexShrink: 0 }} /> : null}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {d.status === "scanfail" && <div style={{ fontSize: 11, color: "#92400e", marginBottom: 4 }}>{d.isPdf ? "Couldn't read PDF — enter manually" : "Couldn't auto-read — enter manually"}</div>}
                      {d.status === "error" && <div style={{ fontSize: 11, color: "#92400e", marginBottom: 4 }}>Upload failed</div>}
                      {d.status === "ok" && d.confidence != null && <div style={{ fontSize: 10, color: d.confidence < 0.7 ? "#92400e" : "#94a3b8", marginBottom: 4 }}>{d.isPdf ? "PDF · " : ""}AI {Math.round(d.confidence * 100)}%{d.warnings?.length ? ` · ${d.warnings.join(" ")}` : ""}</div>}
                      {d.status === "ok" && d.confidence == null && d.isPdf && <div style={{ fontSize: 11, color: "#92400e", marginBottom: 4 }}>PDF — enter details manually</div>}
                      <div style={s.grid2}>
                        <input value={d.merchant} onChange={(e) => upd(d.key, { merchant: e.target.value })} placeholder="Merchant" style={{ ...s.input, marginBottom: 6 }} />
                        <input type="number" step="0.01" value={d.amount} onChange={(e) => upd(d.key, { amount: e.target.value })} placeholder="Amount" style={{ ...s.input, marginBottom: 6 }} />
                      </div>
                      <div style={s.grid2}>
                        <input type="date" value={d.date} onChange={(e) => upd(d.key, { date: e.target.value })} style={{ ...s.input, marginBottom: 0 }} />
                        <select value={d.account} onChange={(e) => upd(d.key, { account: e.target.value })} style={{ ...s.select, marginBottom: 0 }}>{EXPENSE_CATEGORY_GROUPS.map((g) => <optgroup key={g.label} label={g.label}>{g.categories.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>)}</select>
                      </div>
                      {d.reference && <input value={d.reference} onChange={(e) => upd(d.key, { reference: e.target.value })} placeholder="Receipt #" style={{ ...s.input, marginTop: 6, marginBottom: 0, fontSize: 11 }} />}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button disabled={!chosen.length} onClick={addAll} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", marginTop: 12, opacity: chosen.length ? 1 : 0.5 }}>Add {chosen.length} expense{chosen.length === 1 ? "" : "s"}</button>
          </>
        )}
        {phase === "saving" && <div style={{ padding: "30px 10px", textAlign: "center", fontSize: 14, fontWeight: 600, color: "#0f172a" }}>Adding expenses…</div>}
        {phase === "done" && (
          <div style={{ padding: "30px 10px", textAlign: "center" }}>
            <div style={{ width: 54, height: 54, borderRadius: 27, background: "#ecfdf5", color: "#059669", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icons.Check /></div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", marginTop: 12 }}>{savedCount} expense{savedCount === 1 ? "" : "s"} added</div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>They're in your Expenses{emailConn ? " and filed to OneDrive" : ""}.</div>
            <button onClick={() => setModal(null)} style={{ ...s.btn(accent), marginTop: 18 }}>Done</button>
          </div>
        )}
      </div>
    );
  };

  const IncomeForm = ({ existing }) => {
    const [f, setF] = useState({ date: existing?.date || today(), amount: String(existing?.amount ?? ""), description: existing?.description || "", account: existing?.account || "Other Income" });
    const [saving, setSaving] = useState(false);
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Edit Income</h3>
          <button onClick={() => { setModal(null); setEditItem(null); }} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        {isReconciled(existing) && <div style={{ fontSize: 11, color: "#059669", fontWeight: 600, marginBottom: 14 }}>✓ Reconciled to a bank statement</div>}
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Date</label><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Amount (AUD)</label><input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" style={s.input} /></div>
        </div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Description</label><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Refund, owner deposit" style={s.input} /></div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Income account</label><select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} style={s.select}>{!REVENUE_ACCOUNTS.some((a) => a.name === f.account) && f.account ? <option value={f.account}>{f.account}</option> : null}{REVENUE_ACCOUNTS.map((a) => <option key={a.code} value={a.name}>{a.name}</option>)}</select></div>
        <button disabled={!f.amount || saving} onClick={async () => { setSaving(true); await updateIncome(existing.id, f); setSaving(false); }} style={{ ...s.btn(accent), opacity: !f.amount || saving ? 0.4 : 1, width: "100%", justifyContent: "center" }}>{saving ? "Saving…" : "Save Changes"}</button>
        <button onClick={() => deleteTransaction(existing.id)} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", marginTop: 8, color: "#ef4444", borderColor: "#ef444440", gap: 6 }}><Icons.Trash /> Delete Income</button>
      </div>
    );
  };

  const ContactForm = ({ existing }) => {
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
          <div style={{ marginBottom: 12 }}><label style={s.label}>Type</label><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} style={s.select}><option value="client">Client</option><option value="supplier">Supplier</option></select></div>
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
  };

  const InvoiceForm = ({ existing }) => {
    const defaultType = "invoice";
    const seed = invoiceSeed || {};
    const seedType = seed.type || defaultType;
    const seedContact = seed.contact_name ? contacts.find((c) => (c.name || c.company) === seed.contact_name) : null;
    const init = existing
      ? { ...existing, pricing_mode: existing.pricing_mode || "itemised", lump_amount: existing.pricing_mode === "lump_sum" ? String(existing.total ?? "") : "", terms: existing.terms ?? "" }
      : { number: getNextDocumentNumber(divInvoices, insertDivision, seedType), type: seedType, date: today(), due_date: getDefaultDueDate(seedType, today()), contact_name: seed.contact_name || "", contact_email: seedContact?.email || "", contact_company: seedContact?.company || "", contact_abn: seedContact?.abn || "", contact_address: seedContact?.address || "", contact_phone: seedContact?.phone || "", job: seed.projectName || "", project_id: seed.project_id || "", pricing_mode: seed.pricing_mode || "itemised", lump_amount: seed.lump_amount || "", items: (seed.items && seed.items.length) ? seed.items.map((it) => ({ description: it.description || "", note: it.note || "", qty: it.qty ?? 1, rate: it.rate ?? "" })) : [{ description: "", note: "", qty: 1, rate: "" }], notes: getDefaultTerms(seedType), terms: getDefaultDocTerms(seedType), status: "draft" };
    const [f, setF] = useState(init);
    const [dueDateEdited, setDueDateEdited] = useState(!!existing);
    const invOverdue = existing && f.type !== "quote" ? daysOverdue({ status: existing.status, due_date: f.due_date }) : 0;
    const [notesEdited, setNotesEdited] = useState(!!existing);
    const [termsEdited, setTermsEdited] = useState(!!existing);
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
    const [quickAdd, setQuickAdd] = useState(false);
    const [qa, setQa] = useState({ name: "", email: "", company: "", phone: "", abn: "", address: "" });
    const [projectAdd, setProjectAdd] = useState(false);
    const [pa, setPa] = useState({ name: "", contract_value: "", address: "" });
    const [saving, setSaving] = useState(false);
    const initialSnapshot = useRef(JSON.stringify(init));
    useEffect(() => { formDirtyRef.current = JSON.stringify(f) !== initialSnapshot.current; }, [f]);
    const updateItem = (idx, field, val) => { const items = [...f.items]; items[idx] = { ...items[idx], [field]: val }; setF({ ...f, items }); };
    const addItem = () => setF({ ...f, items: [...f.items, { description: "", note: "", qty: 1, rate: "" }] });
    const removeItem = (idx) => setF({ ...f, items: f.items.filter((_, i) => i !== idx) });
    const isLump = f.pricing_mode === "lump_sum";
    const total = isLump ? (Number(f.lump_amount) || 0) : f.items.reduce((sum, i) => sum + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
    const selectedContact = contacts.find((c) => (c.name || c.company) === f.contact_name);
    const sortedJobs = [...divJobs].sort((a, b) => { const aMatch = selectedContact && a.contact_id === selectedContact.id ? 0 : 1; const bMatch = selectedContact && b.contact_id === selectedContact.id ? 0 : 1; return aMatch - bMatch || new Date(b.last_used_at) - new Date(a.last_used_at); });
    const saveInv = async () => { const inv = { ...f, total, items: isLump ? [{ description: f.items[0]?.description || "", note: "", qty: 1, rate: 0 }] : f.items }; if (existing) { await updateInvoice(existing.id, inv); } else { await addInvoice(inv); } if (!inv.project_id) upsertJob(inv.job, inv.contact_name); };

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
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Type</label><select value={f.type} onChange={(e) => updateType(e.target.value)} style={s.select}><option value="invoice">Invoice</option><option value="quote">Quote</option></select></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Number</label><input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value, _numberEdited: true })} style={s.input} /></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Date</label><input type="date" value={f.date} onChange={(e) => updateDate(e.target.value)} style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>{f.type === "quote" ? "Valid Until" : "Due Date"}{invOverdue > 0 && <span style={{ color: "#ef4444", fontWeight: 600, textTransform: "none", marginLeft: 6 }}>· {invOverdue} {invOverdue === 1 ? "day" : "days"} overdue</span>}</label><input type="date" value={f.due_date || ""} onChange={(e) => { setDueDateEdited(true); setF({ ...f, due_date: e.target.value }); }} style={s.input} /></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}>
            <label style={s.label}>Contact</label>
            <div style={{ display: "flex", gap: 4 }}>
              <select value={f.contact_name || ""} onChange={(e) => { const c = contacts.find(c => (c.name || c.company) === e.target.value); setF({ ...f, contact_name: e.target.value, contact_email: c?.email || "", contact_company: c?.company || "", contact_abn: c?.abn || "", contact_address: c?.address || "", contact_phone: c?.phone || "" }); }} style={{ ...s.select, flex: 1 }}><option value="">Select...</option>{contacts.filter((c) => c.type === "client").map((c) => <option key={c.id} value={c.name || c.company}>{c.name || c.company}</option>)}</select>
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
              <button disabled={!qa.name && !qa.company} onClick={async () => { const inserted = await addContact({ ...qa, type: "client", notes: "" }, true); if (inserted) setF({ ...f, contact_name: inserted.name || inserted.company || "", contact_email: inserted.email || "", contact_company: inserted.company || "", contact_abn: inserted.abn || "", contact_address: inserted.address || "", contact_phone: inserted.phone || "" }); setQa({ name: "", email: "", company: "", phone: "", abn: "", address: "" }); setQuickAdd(false); }} style={{ ...s.btn(accent), fontSize: 12, opacity: !qa.name && !qa.company ? 0.4 : 1 }}>Add & Select</button>
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
              <button disabled={!pa.name.trim()} onClick={async () => { const created = await createProject({ name: pa.name, contact_name: f.contact_name, address: pa.address }); if (created) setF({ ...f, project_id: created.id, job: projectLabel(created) }); setPa({ name: "", contract_value: "", address: "" }); setProjectAdd(false); }} style={{ ...s.btn(accent), fontSize: 12, opacity: !pa.name.trim() ? 0.4 : 1 }}>Add & Select</button>
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
        <button disabled={saving} onClick={async () => { setSaving(true); await saveInv(); setSaving(false); }} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", opacity: saving ? 0.5 : 1 }}>{saving ? "Saving…" : `${existing ? "Update" : "Create"} ${f.type === "quote" ? "Quote" : "Invoice"}`}</button>
        {existing && (<>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={async () => { const inv = { ...f, total }; if (existing) { await updateInvoice(existing.id, inv); } if (!inv.project_id) upsertJob(inv.job, inv.contact_name); sendInvoice({ ...existing, ...inv }); await offerMarkSent({ ...existing, ...inv }); }} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#3b82f6", borderColor: "#3b82f640", gap: 6 }}>
              <Icons.Send /> Open Email + PDF
            </button>
            <button disabled={outlookDraftLoading === existing.id} onClick={async () => { const inv = { ...f, total }; if (existing) { await updateInvoice(existing.id, inv); } if (!inv.project_id) upsertJob(inv.job, inv.contact_name); const ok = await createOutlookDraft({ ...existing, ...inv }); if (ok) await offerMarkSent({ ...existing, ...inv }); }} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#0078d4", borderColor: "#0078d440", gap: 6, opacity: outlookDraftLoading === existing.id ? 0.5 : 1 }}>
              <Icons.Outlook /> {outlookDraftLoading === existing.id ? "Creating…" : "Open in Outlook"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
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
                <button onClick={async () => { const inv = { ...f, total }; await updateInvoice(existing.id, inv); const proj = await acceptQuote({ ...existing, ...inv }); setModal(null); setEditItem(null); if (proj) alert(`Quote accepted and added to project "${proj.name}".`); }} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#10b981", borderColor: "#10b98140", gap: 6 }}>
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
      ? { name: existing.name || "", address: existing.address || "", notes: existing.notes || "", status: existing.status || "active" }
      : { name: "", address: "", notes: "", status: "active" };
    const [f, setF] = useState(init);
    const [saving, setSaving] = useState(false);
    // Job/project number: existing projects keep theirs; new ones preview the
    // number that will be auto-assigned on save (same YY### scheme as the insert).
    const projNumber = existing ? (existing.job_number || "—") : getNextJobNumber(jobs, insertDivision);
    const t = existing ? projectTotals(existing, invoices) : { contract: 0, invoiced: 0, paid: 0, remaining: 0, outstanding: 0, leftToInvoice: 0 };
    const consultants = existing ? projectConsultants(existing, invoices) : [];
    const statusColors = { draft: "#64748b", sent: "#3b82f6", paid: "#34d399", overdue: "#ef4444", accepted: "#34d399", declined: "#64748b" };
    const pct = t.contract > 0 ? Math.min(100, Math.round((t.paid / t.contract) * 100)) : 0;
    const save = async () => { if (existing) { await updateProject(existing.id, f); } else { await createProject(f); } setModal(null); setEditItem(null); };
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{existing ? (projectLabel(existing) || "Project") : "New Project"}</h3>
          <button onClick={() => { setModal(null); setEditItem(null); }} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <span style={{ ...s.label, margin: 0 }}>Project #</span>
          <span style={{ fontWeight: 700, fontSize: 14, color: accent, fontVariantNumeric: "tabular-nums" }}>{projNumber}</span>
          {!existing && <span style={{ fontSize: 11, color: "#94a3b8" }}>auto-assigned</span>}
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

        <div style={{ marginBottom: 12 }}><label style={s.label}>Address (shown as the project label)</label><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="e.g. 10 Mcpherson Road Smeaton Grange NSW" style={s.input} /></div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Name / Description</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Construction Certificate - Gym" style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Status</label><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={s.select}><option value="active">Active</option><option value="job_lost">Job Lost</option><option value="lead">Lead</option><option value="finalised">Finalised</option></select></div>
        </div>
        <div style={{ marginBottom: 16 }}><label style={s.label}>Notes</label><textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Notes (optional)" style={{ ...s.input, minHeight: 50, resize: "vertical" }} /></div>

        {existing && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <label style={{ ...s.label, margin: 0 }}>Consultants/Clients ({consultants.length})</label>
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
                  <DocRow key={q.id} d={q} action={q.status !== "accepted" && q.status !== "declined" ? <button onClick={() => acceptQuote(q)} style={{ ...s.btn("#10b981", true), fontSize: 11 }}><Icons.Check /> Accept</button> : null} />
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

        <button disabled={saving || !(f.name.trim() || (f.address || "").trim())} onClick={async () => { setSaving(true); await save(); setSaving(false); }} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", opacity: saving || !(f.name.trim() || (f.address || "").trim()) ? 0.5 : 1 }}>{saving ? "Saving…" : existing ? "Update Project" : "Create Project"}</button>
        {existing && (
          <button onClick={() => deleteProject(existing.id)} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", color: "#ef4444", borderColor: "#ef444440", gap: 6, marginTop: 8 }}><Icons.Trash /> Delete Project</button>
        )}
      </div>
    );
  };

  const BusinessSettings = () => {
    const [f, setF] = useState(() => ({
      ...profile,
      email_template_invoice: profile.email_template_invoice || DEFAULT_EMAIL_TEMPLATE_INVOICE,
      email_template_quote: profile.email_template_quote || DEFAULT_EMAIL_TEMPLATE_QUOTE,
    }));
    const [logoPreview, setLogoPreview] = useState(null);
    const fileRef = useRef(null);
    const [reminderRunning, setReminderRunning] = useState(false);
    const [reminderResult, setReminderResult] = useState(null);

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
        if (data?.publicUrl) setF({ ...f, logo_url: data.publicUrl });
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
            <div>
              <label style={s.label}>Receipts folder</label>
              <input value={f.onedrive_receipts_folder || ""} onChange={(e) => setF({ ...f, onedrive_receipts_folder: e.target.value })} placeholder="Mworx Group/Receipts" style={s.input} />
              <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.5, marginTop: 6 }}>Separate folder for scanned receipts saved as PDFs (e.g. 2026-06-20_Vendor_45.00_Category.pdf). If empty, receipts fall back to the projects folder. Powered by the Microsoft connection below — if you just enabled OneDrive, Disconnect & reconnect to grant file access.</div>
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
          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
            Variables: <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b" }}>{"{contact_name}"}</code> <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b" }}>{"{number}"}</code> <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b" }}>{"{amount}"}</code> <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b" }}>{"{due_date}"}</code> <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b" }}>{"{due_date_line}"}</code> <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b" }}>{"{payment_details}"}</code> <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b" }}>{"{business_name}"}</code> <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: 3, color: "#64748b" }}>{"{signature}"}</code>
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
        {panel("reminders", "Payment Reminders", "Automatic overdue email reminders", (
          <>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 10, lineHeight: 1.5 }}>
            Overdue reminders send automatically each day at 1, 7, 14 and 30 days overdue, emailed from noreply@mworxgroup.com.au. Each reminder is only ever sent once. Use Preview to see who would be emailed right now, or Send Now to run immediately.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => runReminderJob(true)} disabled={reminderRunning} style={{ ...s.btnOutline, opacity: reminderRunning ? 0.5 : 1 }}>{reminderRunning ? "Running…" : "Preview (dry run)"}</button>
            <button onClick={() => runReminderJob(false)} disabled={reminderRunning} style={{ ...s.btn("#f59e0b"), opacity: reminderRunning ? 0.5 : 1 }}>{reminderRunning ? "Running…" : "Send Reminders Now"}</button>
          </div>
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
        {panel("security", "Security", `Change the sign-in password for ${session?.user?.email || "your account"}`, (
          <ChangePasswordForm s={s} accent={accent} />
        ))}
        <button onClick={() => saveProfile(f)} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", marginTop: 4 }}>Save Settings</button>
      </div>
    );
  };

  const PnlPage = () => {
    const now = new Date();
    const defaultMonth = now.toISOString().slice(0, 7);
    const defaultQuarter = `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
    const defaultYear = String(now.getFullYear());
    const [periodType, setPeriodType] = useState("month");
    const [periodValue, setPeriodValue] = useState(defaultMonth);
    const bounds = periodBounds(periodType, periodValue);
    const realInvoices = divInvoices.filter((i) => i.type !== "quote");
    const incomeInvoices = realInvoices.filter((i) => i.status === "paid" && inPeriod(i.paid_date || i.date, bounds.start, bounds.end));
    const incomeTxns = divTxns.filter((t) => t.type === "income" && inPeriod(t.date, bounds.start, bounds.end));
    const expenseTxns = divTxns.filter((t) => t.type === "expense" && t.account !== "Internal transfer" && inPeriod(t.date, bounds.start, bounds.end));
    const totalIncome = incomeInvoices.reduce((sum, i) => sum + Number(i.total || 0), 0) + incomeTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const totalExpenses = expenseTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const net = totalIncome - totalExpenses;
    const onTypeChange = (type) => {
      setPeriodType(type);
      if (type === "month") setPeriodValue(defaultMonth);
      else if (type === "quarter") setPeriodValue(defaultQuarter);
      else setPeriodValue(defaultYear);
    };
    const periodInput = periodType === "month" ? (
      <input type="month" value={periodValue} onChange={(e) => setPeriodValue(e.target.value)} style={{ ...s.input, maxWidth: 180 }} />
    ) : periodType === "quarter" ? (
      <select value={periodValue} onChange={(e) => setPeriodValue(e.target.value)} style={{ ...s.select, maxWidth: 140 }}>
        {[0, 1, 2, 3].map((i) => {
          const y = now.getFullYear();
          const q = Math.floor(now.getMonth() / 3) + 1 - i;
          const adjY = q <= 0 ? y - 1 : y;
          const adjQ = q <= 0 ? q + 4 : q;
          const val = `${adjY}-Q${adjQ}`;
          return <option key={val} value={val}>Q{adjQ} {adjY}</option>;
        })}
      </select>
    ) : (
      <select value={periodValue} onChange={(e) => setPeriodValue(e.target.value)} style={{ ...s.select, maxWidth: 120 }}>
        {[0, 1, 2, 3, 4].map((i) => {
          const y = now.getFullYear() - i;
          return <option key={y} value={String(y)}>{y}</option>;
        })}
      </select>
    );
    if (isMobile) {
      const incomeRows = [
        ...incomeInvoices.map((i) => ({ id: i.id, date: i.paid_date || i.date, label: `${i.number} — ${i.contact_name || i.contact_company || ""}`, amount: Number(i.total) || 0, txn: null })),
        ...incomeTxns.map((t) => ({ id: t.id, date: t.date, label: `${t.description || "Deposit"} · ${t.account || "Other Income"}`, amount: Number(t.amount) || 0, txn: t })),
      ].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      const expRows = [...expenseTxns].sort((a, b) => b.date.localeCompare(a.date));
      return (
        <div style={{ paddingBottom: 20 }}>
          <div style={{ padding: "8px 16px 0" }}>
            <FilterPills tabs={[{ key: "month", label: "Month" }, { key: "quarter", label: "Quarter" }, { key: "year", label: "Year" }]} active={periodType} onChange={onTypeChange} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px 0", flexWrap: "wrap" }}>
            {periodInput}
            <span style={{ fontSize: 12, color: "#64748b" }}>{divInfo.name} · {bounds.label}</span>
          </div>
          <div style={{ display: "flex", gap: 10, padding: "12px 16px 0" }}>
            <div style={{ flex: 1, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#94a3b8" }}>Income</div>
              <div style={{ marginTop: 4 }}><MoneyBig value={totalIncome} size={20} color="#059669" /></div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{incomeRows.length} item{incomeRows.length !== 1 ? "s" : ""}</div>
            </div>
            <div style={{ flex: 1, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#94a3b8" }}>Expenses</div>
              <div style={{ marginTop: 4 }}><MoneyBig value={totalExpenses} size={20} color="#ef4444" /></div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{expRows.length} expense{expRows.length !== 1 ? "s" : ""}</div>
            </div>
          </div>
          <div style={{ padding: "10px 16px 0" }}>
            <div style={{ background: net >= 0 ? "#ecfdf5" : "#fef2f2", border: `1px solid ${net >= 0 ? "#a7f3d0" : "#fecaca"}`, borderRadius: 14, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: net >= 0 ? "#065f46" : "#991b1b" }}>Net {net >= 0 ? "Profit" : "Loss"}</span>
              <MoneyBig value={Math.abs(net)} size={22} color={net >= 0 ? "#059669" : "#ef4444"} />
            </div>
          </div>
          <MobileSection title="Income">
            {incomeRows.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No income in this period</div> : incomeRows.map((r, idx) => (
              <MobileRow key={r.id} primary={r.label} secondary={fmtDate(r.date)} right={fmt(r.amount)} isLast={idx === incomeRows.length - 1} onClick={r.txn ? () => { setEditItem(r.txn); setModal("income"); } : undefined} />
            ))}
          </MobileSection>
          <MobileSection title="Expenses">
            {expRows.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No expenses in this period</div> : expRows.map((t, idx) => (
              <MobileRow key={t.id} primary={t.description} secondary={`${fmtDate(t.date)}${t.account ? " · " + t.account : ""}`} right={fmt(t.amount)} isLast={idx === expRows.length - 1} onClick={() => { setEditItem(t); setModal("expense"); }} />
            ))}
          </MobileSection>
        </div>
      );
    }
    return (
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <FilterPills tabs={[{ key: "month", label: "Month" }, { key: "quarter", label: "Quarter" }, { key: "year", label: "Year" }]} active={periodType} onChange={onTypeChange} />
          {periodInput}
          <span style={{ fontSize: 12, color: "#64748b", marginLeft: "auto" }}>{divInfo.name} · {bounds.label}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 16 }}>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Income</div><div style={{ marginTop: 8 }}><MoneyBig value={totalIncome} color="#059669" /></div><div style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>{incomeInvoices.length} paid invoice{incomeInvoices.length !== 1 ? "s" : ""}{incomeTxns.length ? ` · ${incomeTxns.length} other income` : ""}</div></div>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Expenses</div><div style={{ marginTop: 8 }}><MoneyBig value={totalExpenses} color="#ef4444" /></div><div style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>{expenseTxns.length} expense{expenseTxns.length !== 1 ? "s" : ""}</div></div>
          <div style={{ ...s.statCard(), borderColor: net >= 0 ? "#86efac" : "#fecaca" }}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Net {net >= 0 ? "Profit" : "Loss"}</div><div style={{ marginTop: 8 }}><MoneyBig value={Math.abs(net)} color={net >= 0 ? "#059669" : "#ef4444"} /></div></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={s.card}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700 }}>Income</h4>
            {incomeInvoices.length === 0 && incomeTxns.length === 0 ? <div style={{ color: "#94a3b8", fontSize: 12, padding: "12px 0" }}>No income in this period</div> : (
              <div style={{ overflowX: "auto" }}>
                <table style={s.table}><tbody>
                  {[
                    ...incomeInvoices.map((i) => ({ id: i.id, date: i.paid_date || i.date, label: `${i.number} — ${i.contact_name || i.contact_company || ""}`, amount: Number(i.total) || 0, txn: null })),
                    ...incomeTxns.map((t) => ({ id: t.id, date: t.date, label: `${t.description || "Deposit"} · ${t.account || "Other Income"}`, amount: Number(t.amount) || 0, txn: t })),
                  ].sort((a, b) => (b.date || "").localeCompare(a.date || "")).map((r) => (
                    <tr key={r.id} onClick={r.txn ? () => { setEditItem(r.txn); setModal("income"); } : undefined} style={r.txn ? { cursor: "pointer" } : undefined}><td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(r.date)}</td><td style={s.td}>{r.label}{r.txn && <span style={{ fontSize: 10, color: "#94a3b8" }}> · tap to edit</span>}</td><td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(r.amount)}</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
          </div>
          <div style={s.card}>
            <h4 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700 }}>Expenses</h4>
            {expenseTxns.length === 0 ? <div style={{ color: "#94a3b8", fontSize: 12, padding: "12px 0" }}>No expenses in this period</div> : (
              <div style={{ overflowX: "auto" }}>
                <table style={s.table}><tbody>
                  {[...expenseTxns].sort((a, b) => b.date.localeCompare(a.date)).map((t) => (
                    <tr key={t.id}><td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(t.date)}</td><td style={s.td}>{t.description}<div style={{ fontSize: 10, color: "#94a3b8" }}>{t.account || ""}</div></td><td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(t.amount)}</td></tr>
                  ))}
                </tbody></table>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const DashboardPage = () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const monthTxns = divTxns.filter((t) => (t.date || "").slice(0, 7) === thisMonth);
    const expense = monthTxns.filter((t) => t.type === "expense" && t.account !== "Internal transfer").reduce((sum, t) => sum + Number(t.amount), 0);
    const realInvoices = divInvoices.filter((i) => i.type !== "quote");
    const outstanding = realInvoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((sum, i) => sum + Number(i.total || 0), 0);
    const activeProjects = divJobs.filter((p) => (p.status || "active") === "active");
    const projectsRemaining = activeProjects.reduce((sum, p) => sum + projectTotals(p, divInvoices).remaining, 0);
    const recentExpenses = [...divTxns].filter((t) => t.type === "expense" && t.account !== "Internal transfer").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    const topProjects = activeProjects.map((p) => ({ p, t: projectTotals(p, divInvoices) })).sort((a, b) => b.t.remaining - a.t.remaining).slice(0, 6);

    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
          <div style={s.statCard()}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Expenses This Month</div>
            <div style={{ marginTop: 8 }}><MoneyBig value={expense} /></div>
            <div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{monthTxns.filter((t) => t.type === "expense" && t.account !== "Internal transfer").length} transactions</div>
          </div>
          <div style={s.statCard()}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Outstanding Invoices</div>
            <div style={{ marginTop: 8 }}><MoneyBig value={outstanding} /></div>
            <div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{realInvoices.filter((i) => i.status === "sent" || i.status === "overdue").length} unpaid</div>
          </div>
          <div style={s.statCard()}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Revenue Collected</div>
            <div style={{ marginTop: 8 }}><MoneyBig value={realInvoices.filter((i) => i.status === "paid").reduce((sum, i) => sum + Number(i.total || 0), 0)} /></div>
            <div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{realInvoices.filter((i) => i.status === "paid").length} paid invoice{realInvoices.filter((i) => i.status === "paid").length !== 1 ? "s" : ""}</div>
          </div>
          <div className="bk-card-hover" style={{ ...s.statCard(), cursor: "pointer" }} onClick={() => setPage("projects")}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Active Projects</div>
            <div style={{ marginTop: 8 }}><MoneyBig value={projectsRemaining} /></div>
            <div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{activeProjects.length} active · remaining</div>
          </div>
        </div>
        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Recent Expenses</h4>
            <button onClick={() => setPage("expenses")} style={s.btnOutline}>View All</button>
          </div>
          {recentExpenses.length === 0 ? (
            <div style={{ color: "#94a3b8", fontSize: 12, padding: "20px 0", textAlign: "center" }}>No expenses yet</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}><tbody>
                {recentExpenses.map((t) => (
                  <tr key={t.id}>
                    <td style={{ ...s.td, color: "#94a3b8", width: 70, fontSize: 11 }}>{fmtDate(t.date)}</td>
                    <td style={{ ...s.td, fontWeight: 500 }}>{t.description}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{t.account || ""}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(t.amount)}</td>
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
        {pendingReimbursements.length > 0 && (
          <div className="bk-card-hover" style={{ ...s.card, cursor: "pointer", borderColor: "#fde68a", background: "#fffef5" }} onClick={() => setPage("reimbursements")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#92400e" }}>Owed to Michel</h4>
                <div style={{ fontSize: 12, color: "#92400e", marginTop: 4 }}>{pendingReimbursements.length} pending reimbursement{pendingReimbursements.length !== 1 ? "s" : ""} — {fmt(pendingReimbTotal)}</div>
              </div>
              <span style={{ fontSize: 20, color: "#f59e0b" }}>→</span>
            </div>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginTop: 12 }}>
          <button onClick={() => setModal("receipt")} style={{ ...s.btn("#8b5cf6"), justifyContent: "center", padding: "14px" }}><Icons.Camera /> Snap Receipt</button>
          <button onClick={() => setModal("batch")} style={{ ...s.btn("#7c3aed"), justifyContent: "center", padding: "14px" }}><Icons.Camera /> Batch Receipts</button>
          <button onClick={() => setModal("expense")} style={{ ...s.btn(accent), justifyContent: "center", padding: "14px" }}><Icons.Plus /> Add Expense</button>
          <button onClick={() => setModal("invoice")} style={{ ...s.btn("#3b82f6"), justifyContent: "center", padding: "14px" }}><Icons.Plus /> New Invoice</button>
        </div>
      </div>
    );
  };

  const ExpensesPage = () => {
    const [search, setSearch] = useState("");
    const [showFilter, setShowFilter] = useState(false);
    const [dateMode, setDateMode] = useState("all"); // "all" | "month" | "custom"
    const [month, setMonth] = useState(() => today().slice(0, 7));
    const [fromDate, setFromDate] = useState("");
    const [toDate, setToDate] = useState("");
    const monthBounds = dateMode === "month" && month ? periodBounds("month", month) : null;
    const range = monthBounds
      ? { start: monthBounds.start, end: monthBounds.end }
      : dateMode === "custom"
      ? { start: fromDate || null, end: toDate || null }
      : { start: null, end: null };
    const dateActive = !!(range.start || range.end);
    const activeLabel = monthBounds
      ? monthBounds.label
      : dateMode === "custom" && dateActive
      ? `${fromDate ? fmtDate(fromDate) : "start"} – ${toDate ? fmtDate(toDate) : "now"}`
      : "";
    const sorted = [...divTxns].filter((t) => t.type === "expense").sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((t) => {
      if (search && !t.description.toLowerCase().includes(search.toLowerCase()) && !(t.account || "").toLowerCase().includes(search.toLowerCase()) && !(t.merchant || "").toLowerCase().includes(search.toLowerCase())) return false;
      if (range.start && (t.date || "") < range.start) return false;
      if (range.end && (t.date || "") > range.end) return false;
      return true;
    });
    const filteredTotal = filtered.reduce((sum, t) => sum + Number(t.amount || 0), 0);

    const paymentBadge = (t) => {
      if (t.payment_source !== "personal") return null;
      if (t.reimbursement_status === "reimbursed") return <span style={s.badge("#34d399")}>Reimbursed</span>;
      if (t.reimbursement_status === "pending") return <span style={s.badge("#f59e0b")}>Reimbursement pending</span>;
      if (t.reimbursement_status === "do_not_reimburse") return <span style={s.badge("#64748b")}>Personal</span>;
      return <span style={s.badge("#64748b")}>Personal</span>;
    };

    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search expenses..." style={{ ...s.input, maxWidth: 280, flex: "1 1 200px" }} />
          <button onClick={() => setShowFilter((v) => !v)} style={{ ...(dateActive ? s.btn(accent, true) : s.btnOutline), gap: 6, whiteSpace: "nowrap" }}><Icons.Filter /> {activeLabel || "Filter"}</button>
          {dateActive && <button onClick={() => { setDateMode("all"); setFromDate(""); setToDate(""); setShowFilter(false); }} style={{ ...s.btnOutline, color: "#ef4444", borderColor: "#ef444440", whiteSpace: "nowrap" }}>Clear</button>}
        </div>
        {showFilter && (
          <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: 12, marginBottom: 12, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div>
              <label style={s.label}>Period</label>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {[["all", "All time"], ["month", "By month"], ["custom", "Custom range"]].map(([m, lbl]) => (
                  <button key={m} onClick={() => setDateMode(m)} style={{ ...(dateMode === m ? s.btn(accent, true) : s.btnOutline), fontSize: 12, whiteSpace: "nowrap" }}>{lbl}</button>
                ))}
              </div>
            </div>
            {dateMode === "month" && (
              <div>
                <label style={s.label}>Month</label>
                <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ ...s.input, maxWidth: 180 }} />
              </div>
            )}
            {dateMode === "custom" && (
              <>
                <div><label style={s.label}>From</label><input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...s.input, maxWidth: 160 }} /></div>
                <div><label style={s.label}>To</label><input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...s.input, maxWidth: 160 }} /></div>
              </>
            )}
          </div>
        )}
        {dateActive && (
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>{filtered.length} expense{filtered.length === 1 ? "" : "s"}{activeLabel ? ` · ${activeLabel}` : ""} · <strong style={{ color: "#0f172a" }}>{fmt(filteredTotal)}</strong> total</div>
        )}
        <div style={s.card}>
          {filtered.length === 0 ? (
            <EmptyState icon={Icons.Expenses} title="No expenses found" hint={search || dateActive ? "Try adjusting your search or filter." : "Snap a receipt or add an expense to get started."} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Date</th><th style={s.th}>Merchant</th><th style={s.th}>Description</th><th style={s.th}>Category</th><th style={s.th}>Payment</th><th style={{ ...s.th, textAlign: "right" }}>Amount</th><th style={{ ...s.th, width: 60 }}></th></tr></thead>
                <tbody>{filtered.map((t) => (
                  <tr key={t.id} onClick={() => { setEditItem(t); setModal("expense"); }} style={{ cursor: "pointer" }}>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(t.date)}</td>
                    <td style={{ ...s.td, fontWeight: 600 }}>{t.merchant || "--"}</td>
                    <td style={{ ...s.td, fontWeight: 500 }}>{t.description}{isReconciled(t) && <ReconciledMark />}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{t.account || "--"}</td>
                    <td style={s.td}>{paymentBadge(t)}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(t.amount)}</td>
                    <td style={{ ...s.td, display: "flex", gap: 4 }}>
                      {t.receipt_path && <button onClick={(e) => { e.stopPropagation(); openReceipt(t); }} title="View receipt" style={{ background: "none", border: "none", color: "#8b5cf6", cursor: "pointer", padding: 2 }}><Icons.Camera /></button>}
                      {t.receipt_path && <button onClick={(e) => { e.stopPropagation(); saveToOneDrive("expense", t.id); }} title="Save receipt to OneDrive" style={{ background: "none", border: "none", color: "#0078d4", cursor: "pointer", padding: 2 }}><Icons.Cloud /></button>}
                      <button onClick={(e) => { e.stopPropagation(); deleteTransaction(t.id); }} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 2 }}><Icons.Trash /></button>
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

  const DocList = ({ docType }) => {
    const isQuoteList = docType === "quote";
    const [filter, setFilter] = useState(isQuoteList ? "all" : "outstanding");
    const [jobFilter, setJobFilter] = useState("");
    const [search, setSearch] = useState("");
    const [sortKey, setSortKey] = useState("due_date");
    const [sortDir, setSortDir] = useState("desc");
    const [selected, setSelected] = useState(() => new Set());
    const [menu, setMenu] = useState(null); // overflow "⋯" menu: { id, x, y } | null
    const statusTabs = isQuoteList ? ["all", "draft", "sent", "accepted", "declined"] : ["outstanding", "paid", "overdue", "draft"];
    const sorted = [...divInvoices].filter((i) => isQuoteList ? i.type === "quote" : i.type !== "quote").sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const filtered = sorted.filter((i) => {
      if (filter === "outstanding") { if (i.status !== "sent" && i.status !== "overdue") return false; } else if (filter !== "all" && i.status !== filter) return false;
      if (jobFilter && i.job !== jobFilter) return false;
      if (search && !(i.number || "").toLowerCase().includes(search.toLowerCase()) && !(i.contact_name || "").toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    const statusColors = { draft: "#64748b", sent: "#3b82f6", paid: "#34d399", overdue: "#ef4444", accepted: "#34d399", declined: "#64748b" };
    const sumTotals = (arr) => arr.reduce((acc, i) => acc + Number(i.total || 0), 0);
    const tabs = statusTabs.map((st) => ({ key: st, label: st.charAt(0).toUpperCase() + st.slice(1), count: st === "all" ? sorted.length : st === "outstanding" ? sorted.filter((i) => i.status === "sent" || i.status === "overdue").length : sorted.filter((i) => i.status === st).length }));
    const tiles = isQuoteList
      ? [{ label: "Total quoted", value: fmt(sumTotals(sorted)) }, { label: "Accepted", value: fmt(sumTotals(sorted.filter((i) => i.status === "accepted"))), color: "#10b981" }, { label: "Awaiting", value: fmt(sumTotals(sorted.filter((i) => i.status === "draft" || i.status === "sent"))), color: "#3b82f6" }]
      : [{ label: "Invoiced", value: fmt(sumTotals(sorted.filter((i) => i.status !== "draft"))) }, { label: "Outstanding", value: fmt(sumTotals(sorted.filter((i) => i.status === "sent" || i.status === "overdue"))), color: "#3b82f6" }, { label: "Overdue", value: fmt(sumTotals(sorted.filter((i) => i.status === "overdue"))), color: "#ef4444" }];

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
            <button onClick={async () => { if (emailConn) { const ok = await createOutlookDraft(inv); if (ok) await offerMarkSent(inv); } else sendInvoice(inv); }} disabled={outlookDraftLoading === inv.id} title={emailConn ? "Send via Outlook" : "Send via email app"} style={{ background: "none", border: "none", color: "#3b82f6", cursor: outlookDraftLoading === inv.id ? "wait" : "pointer", padding: 4 }}>{outlookDraftLoading === inv.id ? "…" : <Icons.Send />}</button>
            {!primaryDone && <button onClick={() => isQuoteList ? acceptQuote(inv) : markPaid(inv)} title={isQuoteList ? "Accept quote" : "Mark paid"} style={{ background: "none", border: "none", color: "#10b981", cursor: "pointer", padding: 4 }}><Icons.Check /></button>}
            <button onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu((m) => m?.id === inv.id ? null : { id: inv.id, x: r.right, y: r.bottom }); }} title="More actions" style={{ background: menu?.id === inv.id ? "#eef2f6" : "none", border: "none", color: "#64748b", cursor: "pointer", padding: 4, borderRadius: 6 }}><Icons.More /></button>
          </div>
        </td>
      );
    };

    return (
      <div>
        <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          {tiles.map((t) => <ListStat key={t.label} label={t.label} value={t.value} color={t.color} />)}
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
            <EmptyState icon={isQuoteList ? Icons.Quotes : Icons.Invoices} title={`No ${isQuoteList ? "quotes" : "invoices"} ${filter === "all" && !search && !jobFilter ? "yet" : "found"}`} hint={filter === "all" && !search && !jobFilter ? `New ${isQuoteList ? "quotes" : "invoices"} you create will appear here.` : "Try a different filter or search term."} />
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
                      <td style={{ ...s.td, fontWeight: 600 }}>{inv.number}{inv.status === "paid" && isReconciled(inv) && <ReconciledMark />}</td>
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
                {item(emailConn ? "Email via default app" : "Open in Outlook", emailConn ? <Icons.Send /> : <Icons.Outlook />, () => emailConn ? sendInvoice(mi) : createOutlookDraft(mi))}
                {item("Download PDF", <Icons.Download />, () => downloadPDF(mi))}
                {item("Save to OneDrive", <Icons.Cloud />, () => saveToOneDrive("invoice", mi.id))}
                {item("Edit", <Icons.Edit />, () => { setEditItem(mi); setModal("invoice"); })}
                {!isQuoteList && (mi.status === "sent" || mi.status === "overdue") && item("Send payment reminder", <Icons.Bell />, () => sendReminderViaResend(mi))}
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
    const rows = divJobs
      .filter((p) => statusFilter === "all" || (p.status || "active") === statusFilter)
      .filter((p) => !search || (p.name || "").toLowerCase().includes(search.toLowerCase()))
      .map((p) => ({ p, t: projectTotals(p, divInvoices), parties: projectConsultants(p, divInvoices) }))
      .sort((a, b) => { const va = sortVal(a), vb = sortVal(b); const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb)); return sortDir === "asc" ? cmp : -cmp; });
    const SortTh = ({ label, k, align, width }) => (
      <th onClick={() => { if (sortKey === k) setSortDir((d) => d === "asc" ? "desc" : "asc"); else { setSortKey(k); setSortDir(["contract", "invoiced", "paid", "remaining", "progress"].includes(k) ? "desc" : "asc"); } }} style={{ ...s.th, textAlign: align || "left", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap", ...(width ? { width } : {}) }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{label}<span style={{ fontSize: 9, color: sortKey === k ? "#0f172a" : "#cbd5e1" }}>{sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span></span>
      </th>
    );
    return (
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <FilterPills tabs={[{ key: "active", label: "Active" }, { key: "job_lost", label: "Job Lost" }, { key: "lead", label: "Lead" }, { key: "finalised", label: "Finalised" }, { key: "all", label: "All" }].map((st) => ({ ...st, count: st.key === "all" ? divJobs.length : divJobs.filter((p) => (p.status || "active") === st.key).length }))} active={statusFilter} onChange={setStatusFilter} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects..." style={{ ...s.input, maxWidth: 200, flex: "1 1 140px", marginLeft: "auto" }} />
        </div>
        <div style={s.card}>
          {rows.length === 0 ? (
            <EmptyState icon={Icons.Projects} title={statusFilter === "all" && !search ? "No projects yet" : "No projects found"} hint={statusFilter === "all" && !search ? "Projects build up automatically when you accept quotes." : "Try a different status or search term."} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><SortTh label="Job #" k="job_number" /><SortTh label="Project" k="project" /><SortTh label="Consultants/Clients" k="consultants" /><SortTh label="Contract" k="contract" align="right" /><SortTh label="Invoiced" k="invoiced" align="right" /><SortTh label="Paid" k="paid" align="right" /><SortTh label="Remaining" k="remaining" align="right" /><SortTh label="Progress" k="progress" width={120} /></tr></thead>
                <tbody>{rows.map(({ p, t, parties }) => {
                  const pct = t.contract > 0 ? Math.min(100, Math.round((t.paid / t.contract) * 100)) : 0;
                  return (
                    <tr key={p.id} onClick={() => { setEditItem(p); setModal("project"); }} style={{ cursor: "pointer" }}>
                      <td style={{ ...s.td, color: "#64748b", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>{p.job_number || "—"}</td>
                      <td style={{ ...s.td, fontWeight: 600 }}>{projectLabel(p)}{p.address && p.name && p.name !== projectLabel(p) ? <div style={{ fontSize: 11, fontWeight: 400, color: "#94a3b8" }}>{p.name}</div> : null}</td>
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
          <FilterPills tabs={[{ key: "all", label: "All", count: contacts.length }, { key: "client", label: "Clients", count: contacts.filter((c) => c.type === "client").length }, { key: "supplier", label: "Suppliers", count: contacts.filter((c) => c.type === "supplier").length }]} active={filter} onChange={setFilter} />
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
                    <td style={s.td}><span style={s.badge(c.type === "client" ? "#34d399" : "#f59e0b")}>{c.type}</span></td>
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

  const ReimbursementsPage = () => {
    const [filter, setFilter] = useState("pending");
    const [search, setSearch] = useState("");
    const [markingId, setMarkingId] = useState(null);
    const [markForm, setMarkForm] = useState({ date: today(), amount: "", reference: "" });
    const allPersonal = txns.filter((t) => t.payment_source === "personal");
    const pending = allPersonal.filter((t) => t.reimbursement_status === "pending");
    const reimbursed = allPersonal.filter((t) => t.reimbursement_status === "reimbursed");
    const thisMonth = new Date().toISOString().slice(0, 7);
    const [yr, mo] = thisMonth.split("-").map(Number);
    const reimbursedThisMonth = reimbursed.filter((t) => { const d = new Date(t.reimbursement_date || t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; }).reduce((sum, t) => sum + Number(t.reimbursement_amount || t.amount), 0);
    const missingReceipts = pending.filter((t) => !t.receipt_path);
    const oldestPending = pending.length ? [...pending].sort((a, b) => a.date.localeCompare(b.date))[0] : null;
    const oldestDays = oldestPending ? Math.floor((Date.now() - new Date(oldestPending.date).getTime()) / 86400000) : 0;
    const filtered = allPersonal.filter((t) => {
      if (filter === "pending" && t.reimbursement_status !== "pending") return false;
      if (filter === "reimbursed" && t.reimbursement_status !== "reimbursed") return false;
      if (filter === "no_receipt" && t.reimbursement_status !== "missing_receipt" && (t.receipt_path || t.reimbursement_status !== "pending")) return false;
      if (filter === "do_not_reimburse" && t.reimbursement_status !== "do_not_reimburse") return false;
      if (search && !t.description.toLowerCase().includes(search.toLowerCase()) && !(t.paid_by || "").toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    }).sort((a, b) => b.date.localeCompare(a.date));

    const copyAccountantSummary = () => {
      const lines = pending.map((t) => `- ${fmtDate(t.date)} | ${t.description} | ${t.account || "-"} | ${fmt(t.amount)} | Paid by ${t.paid_by || "Owner"}${t.business_purpose ? ` | Purpose: ${t.business_purpose}` : ""} | ${t.reimbursement_status} | Ref: ${t.reference || "-"}`);
      const text = `Owner Reimbursement Summary\nPending total: ${fmt(pending.reduce((sum, t) => sum + Number(t.amount), 0))}\nReimbursed this month: ${fmt(reimbursedThisMonth)}\nMissing receipts: ${missingReceipts.length}\nItems:\n${lines.join("\n")}`;
      navigator.clipboard.writeText(text);
      alert("Copied to clipboard!");
    };

    const handleMark = async (id, status) => {
      if (status === "reimbursed" && markingId !== id) { setMarkingId(id); const t = txns.find(x => x.id === id); setMarkForm({ date: today(), amount: String(t?.amount || ""), reference: "" }); return; }
      if (status === "reimbursed") { await markReimbursed(id, { status: "reimbursed", date: markForm.date, amount: markForm.amount, reference: markForm.reference }); setMarkingId(null); return; }
      await markReimbursed(id, { status, date: null, amount: null, reference: null });
    };

    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Owed to Michel</div><div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{fmt(pending.reduce((sum, t) => sum + Number(t.amount), 0))}</div><div style={{ fontSize: 12, color: "#92400e", marginTop: 6, fontWeight: 500 }}>{pending.length} reimbursement pending</div></div>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Reimbursed This Month</div><div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{fmt(reimbursedThisMonth)}</div><div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{reimbursed.filter((t) => { const d = new Date(t.reimbursement_date || t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; }).length} this month</div></div>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Missing Receipts</div><div style={{ fontSize: 28, fontWeight: 700, color: missingReceipts.length > 0 ? "#ef4444" : "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{missingReceipts.length}</div><div style={{ fontSize: 12, color: "#64748b", marginTop: 6, fontWeight: 500 }}>pending without receipt</div></div>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Oldest Pending</div><div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{oldestPending ? `${oldestDays}d` : "—"}</div><div style={{ fontSize: 12, color: "#64748b", marginTop: 6, fontWeight: 500 }}>{oldestPending ? oldestPending.description : "None pending"}</div></div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <FilterPills tabs={[{ key: "all", label: "All", count: allPersonal.length }, { key: "pending", label: "Pending", count: pending.length }, { key: "reimbursed", label: "Reimbursed", count: reimbursed.length }, { key: "no_receipt", label: "Missing Receipt", count: missingReceipts.length }, { key: "do_not_reimburse", label: "Do Not Reimburse", count: allPersonal.filter((t) => t.reimbursement_status === "do_not_reimburse").length }]} active={filter} onChange={setFilter} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." style={{ ...s.input, maxWidth: 180, flex: "1 1 140px", marginLeft: "auto" }} />
          <button onClick={copyAccountantSummary} style={s.btn("#6366f1", true)}><Icons.Download /> Copy for Accountant</button>
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? (
            <EmptyState icon={Icons.Reimburse} title="No reimbursements found" hint={filter === "all" ? "Personal-paid expenses you flag for reimbursement show up here." : "Try a different filter."} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Date</th><th style={s.th}>Description</th><th style={s.th}>Paid By</th><th style={s.th}>Purpose</th><th style={{ ...s.th, textAlign: "right" }}>Amount</th><th style={s.th}>Receipt</th><th style={s.th}>Status</th><th style={{ ...s.th, width: 160 }}>Actions</th></tr></thead>
                <tbody>{filtered.map((t) => (
                  <tr key={t.id}>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(t.date)}</td>
                    <td style={{ ...s.td, fontWeight: 500 }}>{t.description}<div style={{ fontSize: 10, color: "#94a3b8" }}>{t.account || ""}</div></td>
                    <td style={{ ...s.td, fontSize: 12 }}>{t.paid_by || "Owner"}</td>
                    <td style={{ ...s.td, fontSize: 12, color: "#64748b", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.business_purpose || "--"}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(t.amount)}</td>
                    <td style={s.td}>{t.receipt_path ? <button onClick={() => openReceipt(t)} style={{ background: "none", border: "none", color: "#8b5cf6", cursor: "pointer", padding: 2 }}><Icons.Camera /></button> : <span style={{ fontSize: 10, color: "#ef4444" }}>Missing</span>}</td>
                    <td style={s.td}><span style={s.badge(t.reimbursement_status === "reimbursed" ? "#34d399" : t.reimbursement_status === "pending" ? "#f59e0b" : "#64748b")}>{t.reimbursement_status === "reimbursed" ? "Reimbursed" : t.reimbursement_status === "pending" ? "Reimbursement pending" : t.reimbursement_status === "missing_receipt" ? "No Receipt" : "Skipped"}</span>{t.reimbursement_status === "reimbursed" && t.reimbursement_date ? <div style={{ fontSize: 10, color: "#94a3b8" }}>{fmtDate(t.reimbursement_date)}</div> : null}{t.reimbursement_reference ? <div style={{ fontSize: 10, color: "#94a3b8" }}>Ref: {t.reimbursement_reference}</div> : null}</td>
                    <td style={{ ...s.td, whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {t.reimbursement_status === "pending" && <button onClick={() => handleMark(t.id, "reimbursed")} style={{ ...s.btn("#34d399", true), fontSize: 10 }}><Icons.Check /> Reimburse</button>}
                        {t.reimbursement_status === "pending" && !t.receipt_path && <button onClick={() => handleMark(t.id, "missing_receipt")} style={{ ...s.btnOutline, fontSize: 10, color: "#ef4444", borderColor: "#ef444440" }}>No Receipt</button>}
                        {t.reimbursement_status === "pending" && <button onClick={() => handleMark(t.id, "do_not_reimburse")} style={{ ...s.btnOutline, fontSize: 10 }}>Skip</button>}
                        {t.reimbursement_status === "reimbursed" && <button onClick={() => markReimbursed(t.id, { status: "pending", date: null, amount: null, reference: null })} style={{ ...s.btnOutline, fontSize: 10, color: "#f59e0b", borderColor: "#f59e0b40" }}>Undo</button>}
                        <button onClick={() => { setEditItem(t); setModal("expense"); }} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 2 }}><Icons.Edit /></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {markingId && (
                  <tr><td colSpan="8" style={{ ...s.td, background: "#ecfdf5", padding: 12 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>Mark Reimbursed:</span>
                      <input type="date" value={markForm.date} onChange={(e) => setMarkForm({ ...markForm, date: e.target.value })} style={{ ...s.input, width: 140 }} />
                      <input type="number" step="0.01" value={markForm.amount} onChange={(e) => setMarkForm({ ...markForm, amount: e.target.value })} placeholder="Amount" style={{ ...s.input, width: 100 }} />
                      <input value={markForm.reference} onChange={(e) => setMarkForm({ ...markForm, reference: e.target.value })} placeholder="Transfer ref" style={{ ...s.input, width: 140 }} />
                      <button onClick={() => handleMark(markingId, "reimbursed")} style={s.btn("#34d399", true)}><Icons.Check /> Confirm</button>
                      <button onClick={() => setMarkingId(null)} style={s.btnOutline}>Cancel</button>
                    </div>
                  </td></tr>
                )}
                </tbody>
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
        {page === "expenses" && (
          <button onClick={() => setModal("receipt")} style={{ width: 34, height: 34, borderRadius: 17, background: "#8b5cf6", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
            <Icons.Camera />
          </button>
        )}
        {page === "reimbursements" && (
          <button onClick={() => { const lines = pendingReimbursements.map((t) => `- ${fmtDate(t.date)} | ${t.description} | ${t.account || "-"} | ${fmt(t.amount)} | Paid by ${t.paid_by || "Michel"}${t.business_purpose ? ` | Purpose: ${t.business_purpose}` : ""}`); navigator.clipboard.writeText(`Pending Reimbursements (${pendingReimbursements.length})\nOwed to Michel: ${fmt(pendingReimbTotal)}\n${lines.join("\n")}`); alert("Copied!"); }} style={{ width: 34, height: 34, borderRadius: 17, background: "#6366f1", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
            <Icons.Download />
          </button>
        )}
        {page !== "dashboard" && page !== "reimbursements" && (
          <button onClick={() => { if (page === "expenses") setModal("expense"); else if (page === "quotes") { setEditItem(null); setInvoiceSeed({ type: "quote" }); setModal("invoice"); } else if (page === "invoices") { setEditItem(null); setInvoiceSeed({ type: "invoice" }); setModal("invoice"); } else if (page === "projects") { setEditItem(null); setModal("project"); } else if (page === "contacts") setModal("contact"); }} style={{ width: 34, height: 34, borderRadius: 17, background: accent, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
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

  const MobileExpensesNav = () => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px 0" }}>
      <button onClick={() => setPage("expenses")} style={s.pill(page === "expenses")}>Expenses</button>
      <button onClick={() => setPage("reimbursements")} style={s.pill(page === "reimbursements")}>Reimburse</button>
    </div>
  );
  const MobileSalesNav = () => (
    <div style={{ display: "flex", gap: 8, padding: "8px 16px 0" }}>
      <button onClick={() => setPage("invoices")} style={s.pill(page === "invoices")}>Invoices</button>
      <button onClick={() => setPage("quotes")} style={s.pill(page === "quotes")}>Quotes</button>
    </div>
  );

  const MobileDashboard = () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const monthTxns = divTxns.filter((t) => (t.date || "").slice(0, 7) === thisMonth);
    const expense = monthTxns.filter((t) => t.type === "expense" && t.account !== "Internal transfer").reduce((sum, t) => sum + Number(t.amount), 0);
    const realInvoices = divInvoices.filter((i) => i.type !== "quote");
    const outstanding = realInvoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((sum, i) => sum + Number(i.total || 0), 0);
    const recentExpenses = [...divTxns].filter((t) => t.type === "expense" && t.account !== "Internal transfer").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ display: "flex", gap: 10, padding: "8px 16px 0" }}>
          <div style={{ flex: 1, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#94a3b8" }}>This Month</div>
            <div style={{ marginTop: 4 }}><MoneyBig value={expense} size={22} /></div>
            <div style={{ fontSize: 11, color: "#065f46", marginTop: 4, fontWeight: 500 }}>{monthTxns.filter((t) => t.type === "expense" && t.account !== "Internal transfer").length} expenses</div>
          </div>
          <div style={{ flex: 1, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#94a3b8" }}>Outstanding</div>
            <div style={{ marginTop: 4 }}><MoneyBig value={outstanding} size={22} /></div>
            <div style={{ fontSize: 11, color: "#065f46", marginTop: 4, fontWeight: 500 }}>{realInvoices.filter((i) => i.status === "sent" || i.status === "overdue").length} invoices</div>
          </div>
        </div>
        <MobileSection title="Recent Expenses" onViewAll={() => setPage("expenses")}>
          {recentExpenses.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No expenses yet</div> : recentExpenses.map((e, i) => (
            <MobileRow key={e.id} primary={e.description} secondary={fmtDate(e.date)} right={fmt(e.amount)} isLast={i === recentExpenses.length - 1} onClick={() => { setEditItem(e); setModal("expense"); }} />
          ))}
        </MobileSection>
        <MobileSection title="Recent Invoices" onViewAll={() => setPage("invoices")}>
          {realInvoices.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No invoices yet</div> : realInvoices.slice(0, 3).map((inv, i) => (
            <MobileRow key={inv.id} primary={`${inv.number} — ${inv.contact_name || inv.contact_company || ""}`} secondary={inv.job || ""} badge={statusBadge(inv.status)} right={fmt(inv.total || 0)} isLast={i === Math.min(2, realInvoices.length - 1)} onClick={() => { setEditItem(inv); setModal("invoice"); }} />
          ))}
        </MobileSection>
        {pendingReimbursements.length > 0 && (
          <div style={{ margin: "12px 16px 0", background: "#fffef5", border: "1px solid #fde68a", borderRadius: 14, padding: "14px 16px", cursor: "pointer" }} onClick={() => setPage("reimbursements")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>Owed to Michel</div>
                <div style={{ fontSize: 12, color: "#b45309", marginTop: 2 }}>{pendingReimbursements.length} pending</div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#92400e" }}>{fmt(pendingReimbTotal)}</div>
            </div>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, padding: "20px 16px 0" }}>
          <button onClick={() => setModal("receipt")} style={{ ...s.btn("#8b5cf6"), flex: 1, justifyContent: "center", padding: "12px", borderRadius: 12, fontSize: 13 }}><Icons.Camera /> Receipt</button>
          <button onClick={() => setModal("expense")} style={{ ...s.btn(accent), flex: 1, justifyContent: "center", padding: "12px", borderRadius: 12, fontSize: 13 }}><Icons.Plus /> Expense</button>
          <button onClick={() => { setEditItem(null); setModal("invoice"); }} style={{ ...s.btn("#3b82f6"), flex: 1, justifyContent: "center", padding: "12px", borderRadius: 12, fontSize: 13 }}><Icons.Plus /> Invoice</button>
        </div>
      </div>
    );
  };

  const MobileExpenses = () => {
    const [search, setSearch] = useState("");
    const [showFilter, setShowFilter] = useState(false);
    const [dateMode, setDateMode] = useState("all"); // "all" | "month" | "custom"
    const [month, setMonth] = useState(() => today().slice(0, 7));
    const [fromDate, setFromDate] = useState("");
    const [toDate, setToDate] = useState("");
    const monthBounds = dateMode === "month" && month ? periodBounds("month", month) : null;
    const range = monthBounds
      ? { start: monthBounds.start, end: monthBounds.end }
      : dateMode === "custom"
      ? { start: fromDate || null, end: toDate || null }
      : { start: null, end: null };
    const dateActive = !!(range.start || range.end);
    const activeLabel = monthBounds
      ? monthBounds.label
      : dateMode === "custom" && dateActive
      ? `${fromDate ? fmtDate(fromDate) : "start"} – ${toDate ? fmtDate(toDate) : "now"}`
      : "";
    const sorted = [...divTxns].filter((t) => t.type === "expense").sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((t) => {
      if (search && !t.description.toLowerCase().includes(search.toLowerCase()) && !(t.account || "").toLowerCase().includes(search.toLowerCase()) && !(t.merchant || "").toLowerCase().includes(search.toLowerCase())) return false;
      if (range.start && (t.date || "") < range.start) return false;
      if (range.end && (t.date || "") > range.end) return false;
      return true;
    });
    const filteredTotal = filtered.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const mInput = { width: "100%", padding: "10px 12px", fontSize: 15, border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff", color: "#0f172a", outline: "none", boxSizing: "border-box" };
    return (
      <div style={{ paddingBottom: 20 }}>
        <MobileExpensesNav />
        <div style={{ padding: "8px 16px 12px" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ position: "relative", flex: 1 }}>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search expenses..." style={{ width: "100%", padding: "10px 12px 10px 36px", fontSize: 15, border: "1px solid #e2e8f0", borderRadius: 12, background: "#ffffff", color: "#0f172a", outline: "none", boxSizing: "border-box" }} />
              <div style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "#94a3b8" }}><Icons.Expenses /></div>
            </div>
            <button onClick={() => setShowFilter((v) => !v)} aria-label="Filter expenses" style={{ flexShrink: 0, width: 46, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 12, border: dateActive ? "none" : "1px solid #e2e8f0", background: dateActive ? accent : "#ffffff", color: dateActive ? "#ffffff" : "#64748b", cursor: "pointer" }}><Icons.Filter /></button>
          </div>
          {showFilter && (
            <div style={{ marginTop: 10, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: 12 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: dateMode === "all" ? 0 : 10 }}>
                {[["all", "All time"], ["month", "By month"], ["custom", "Custom"]].map(([m, lbl]) => (
                  <button key={m} onClick={() => setDateMode(m)} style={s.pill(dateMode === m)}>{lbl}</button>
                ))}
              </div>
              {dateMode === "month" && <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={mInput} />}
              {dateMode === "custom" && (
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={mInput} />
                  <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={mInput} />
                </div>
              )}
            </div>
          )}
          {dateActive && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
              <span style={{ fontSize: 13, color: "#64748b" }}>{filtered.length} · {activeLabel} · <strong style={{ color: "#0f172a" }}>{fmt(filteredTotal)}</strong></span>
              <button onClick={() => { setDateMode("all"); setFromDate(""); setToDate(""); }} style={{ fontSize: 13, color: "#ef4444", background: "none", border: "none", cursor: "pointer", fontWeight: 500 }}>Clear</button>
            </div>
          )}
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {filtered.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No expenses found</div> : filtered.map((e, i) => (
            <MobileRow key={e.id} primary={e.description} secondary={`${fmtDate(e.date)} · ${e.account || ""}${e.payment_source === "personal" ? " · " + (e.reimbursement_status === "reimbursed" ? "Reimbursed" : e.reimbursement_status === "pending" ? "Pending reimburse" : "Paid personally") : ""}`} badge={e.payment_source === "personal" && e.reimbursement_required ? { color: e.reimbursement_status === "reimbursed" ? "#34d399" : "#f59e0b", label: e.reimbursement_status === "reimbursed" ? "Reimbursed" : "Pending" } : null} right={fmt(e.amount)} rightSub={e.job || ""} isLast={i === filtered.length - 1} onClick={() => { setEditItem(e); setModal("expense"); }} />
          ))}
        </div>
      </div>
    );
  };

  const MobileDocs = ({ docType }) => {
    const isQuoteList = docType === "quote";
    const [tab, setTab] = useState(isQuoteList ? "All" : "Outstanding");
    const tabs = isQuoteList ? ["All", "Draft", "Sent", "Accepted", "Declined"] : ["Outstanding", "Paid", "Overdue", "Draft"];
    const sorted = [...divInvoices].filter((i) => isQuoteList ? i.type === "quote" : i.type !== "quote").sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const filtered = sorted.filter((inv) => tab === "All" || (tab === "Outstanding" ? (inv.status === "sent" || inv.status === "overdue") : inv.status === tab.toLowerCase()));
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ paddingTop: 8, paddingBottom: 12 }}>
          <MobileFilterTabs tabs={tabs} active={tab} onChange={setTab} />
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {filtered.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No {isQuoteList ? "quotes" : "invoices"} found</div> : filtered.map((inv, i) => (
            <MobileRow key={inv.id} primary={`${inv.number} — ${inv.contact_name || inv.contact_company || ""}`} secondary={<>{fmtDate(inv.date)}{inv.job ? ` · ${inv.job}` : ""}{daysOverdue(inv) > 0 && <span style={{ color: "#ef4444", fontWeight: 600 }}> · {daysOverdue(inv)}{daysOverdue(inv) === 1 ? " day overdue" : " days overdue"}</span>}</>} badge={statusBadge(inv.status)} right={fmt(inv.total || 0)} isLast={i === filtered.length - 1} onClick={() => viewInvoice(inv)} action={<button onClick={(e) => { e.stopPropagation(); setEditItem(inv); setModal("invoice"); }} title="Edit" style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 6 }}><Icons.Edit /></button>} />
          ))}
        </div>
      </div>
    );
  };
  const MobileInvoices = () => <><MobileSalesNav /><MobileDocs docType="invoice" /></>;
  const MobileQuotes = () => <><MobileSalesNav /><MobileDocs docType="quote" /></>;

  const MobileProjects = () => {
    const [tab, setTab] = useState("All");
    const rows = divJobs
      .filter((p) => tab === "All" || (p.status || "active") === ({ "Active": "active", "Job Lost": "job_lost", "Lead": "lead", "Finalised": "finalised" })[tab])
      .map((p) => ({ p, t: projectTotals(p, divInvoices) }))
      .sort((a, b) => b.t.remaining - a.t.remaining);
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ paddingTop: 8, paddingBottom: 12 }}>
          <MobileFilterTabs tabs={["Active", "Job Lost", "Lead", "Finalised", "All"]} active={tab} onChange={setTab} />
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {rows.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No projects found</div> : rows.map(({ p, t }, i) => (
            <MobileRow key={p.id} primary={projectLabel(p)} secondary={`${p.job_number ? p.job_number + " · " : ""}${fmt(t.paid)} paid of ${fmt(t.contract)}`} right={fmt(t.remaining)} rightSub="remaining" isLast={i === rows.length - 1} onClick={() => { setEditItem(p); setModal("project"); }} />
          ))}
        </div>
      </div>
    );
  };

  const MobileContacts = () => {
    const [tab, setTab] = useState("All");
    const filtered = contacts.filter((c) => { if (tab === "Clients") return c.type === "client"; if (tab === "Suppliers") return c.type === "supplier"; return true; });
    const typeBadge = (type) => ({ color: type === "client" ? "#34d399" : "#f59e0b", label: type === "client" ? "Client" : "Supplier" });
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ paddingTop: 8, paddingBottom: 12 }}>
          <MobileFilterTabs tabs={["All", "Clients", "Suppliers"]} active={tab} onChange={setTab} />
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {filtered.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No contacts found</div> : filtered.map((c, i) => (
            <MobileRow key={c.id} primary={c.name} secondary={c.email || ""} badge={typeBadge(c.type)} isLast={i === filtered.length - 1} onClick={() => { setEditItem(c); setModal("contact"); }} />
          ))}
        </div>
      </div>
    );
  };

  const MobileReimbursements = () => {
    const [tab, setTab] = useState("Pending");
    const [actionId, setActionId] = useState(null);
    const allPersonal = txns.filter((t) => t.payment_source === "personal");
    const filtered = allPersonal.filter((t) => { if (tab === "Pending") return t.reimbursement_status === "pending"; if (tab === "Reimbursed") return t.reimbursement_status === "reimbursed"; return true; }).sort((a, b) => b.date.localeCompare(a.date));
    const pendingTotal = allPersonal.filter((t) => t.reimbursement_status === "pending").reduce((sum, t) => sum + Number(t.amount), 0);
    const reimbBadge = (status) => ({ color: status === "reimbursed" ? "#34d399" : status === "pending" ? "#f59e0b" : "#64748b", label: status === "reimbursed" ? "Reimbursed" : status === "pending" ? "Pending" : status === "do_not_reimburse" ? "Skipped" : "N/A" });
    return (
      <div style={{ paddingBottom: 20 }}>
        <MobileExpensesNav />
        <div style={{ padding: "8px 16px 0" }}>
          <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#94a3b8" }}>Pending Reimbursement</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", marginTop: 4, letterSpacing: -0.3 }}>{fmt(pendingTotal)}</div>
            <div style={{ fontSize: 11, color: "#92400e", marginTop: 4, fontWeight: 500 }}>{allPersonal.filter((t) => t.reimbursement_status === "pending").length} expenses</div>
          </div>
        </div>
        <div style={{ paddingTop: 12, paddingBottom: 12 }}>
          <MobileFilterTabs tabs={["All", "Pending", "Reimbursed"]} active={tab} onChange={setTab} />
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {filtered.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No reimbursements found</div> : filtered.map((e, i) => (
            <div key={e.id}>
              <MobileRow primary={e.description} secondary={`${fmtDate(e.date)} · ${e.paid_by || "Owner"} · ${e.business_purpose || ""}`} badge={reimbBadge(e.reimbursement_status)} right={fmt(e.amount)} isLast={actionId !== e.id && i === filtered.length - 1} onClick={() => setActionId(actionId === e.id ? null : e.id)} />
              {actionId === e.id && (
                <div style={{ display: "flex", gap: 6, padding: "8px 16px 12px", borderBottom: i === filtered.length - 1 ? "none" : "0.5px solid #f1f5f9", flexWrap: "wrap" }}>
                  {e.reimbursement_status === "pending" && <button onClick={async () => { await markReimbursed(e.id, { status: "reimbursed", date: today(), amount: String(e.amount), reference: "" }); setActionId(null); }} style={{ ...s.btn("#34d399", true), borderRadius: 12, fontSize: 12 }}><Icons.Check /> Reimburse</button>}
                  {e.reimbursement_status === "pending" && <button onClick={async () => { await markReimbursed(e.id, { status: "do_not_reimburse", date: null, amount: null, reference: null }); setActionId(null); }} style={{ ...s.btnOutline, borderRadius: 12, fontSize: 12 }}>Skip</button>}
                  {e.reimbursement_status === "reimbursed" && <button onClick={async () => { await markReimbursed(e.id, { status: "pending", date: null, amount: null, reference: null }); setActionId(null); }} style={{ ...s.btnOutline, borderRadius: 12, fontSize: 12, color: "#f59e0b", borderColor: "#f59e0b40" }}>Undo Reimburse</button>}
                  <button onClick={() => { setEditItem(e); setModal("expense"); setActionId(null); }} style={{ ...s.btnOutline, borderRadius: 12, fontSize: 12 }}><Icons.Edit /> Edit</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const ReconcilePage = () => {
    const [phase, setPhase] = useState("setup");
    const [statementDate, setStatementDate] = useState(today());
    const [closingBalance, setClosingBalance] = useState("");
    const [checked, setChecked] = useState({});
    const [busy, setBusy] = useState(false);
    const [doneMeta, setDoneMeta] = useState(null);
    const [importItems, setImportItems] = useState(null);
    const [importInclude, setImportInclude] = useState({});
    const [importCat, setImportCat] = useState({});
    const [depositChoice, setDepositChoice] = useState({});
    const [parsing, setParsing] = useState(false);
    const fileRef = useRef(null);

    const openingBalance = Number(lastReconciliation?.closing_balance) || 0;
    const periodStart = lastReconciliation?.statement_date
      ? (() => { const d = new Date(`${lastReconciliation.statement_date}T12:00:00`); d.setDate(d.getDate() + 1); return d.toISOString().split("T")[0]; })()
      : null;

    const inPeriod = (d) => {
      if (!d || d > statementDate) return false;
      if (periodStart && d < periodStart) return false;
      return true;
    };

    // One ABN, one bank account — the account is shared across divisions, so reconcile the whole business, not just the active division.
    const unreconciledExpenses = txns
      .filter((t) => t.type === "expense" && !isReconciled(t) && inPeriod(t.date))
      .map((t) => ({ kind: "expense", id: t.id, date: t.date, label: t.description, sub: t.account || "Expense", amount: -(Number(t.amount) || 0) }));

    const unreconciledIncome = invoices
      .filter((i) => i.type === "invoice" && i.status === "paid" && !isReconciled(i) && inPeriod(i.paid_date || i.date))
      .map((i) => ({ kind: "invoice", id: i.id, date: i.paid_date || i.date, label: `Invoice ${i.number}`, sub: i.contact_name || i.contact_company || "Payment received", amount: Number(i.total) || 0 }));

    const items = [...unreconciledExpenses, ...unreconciledIncome].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    // Invoices a statement deposit could be tied to: open (→ mark paid) or already-paid-but-unreconciled (→ just reconcile). Account-wide.
    const matchableInvoices = invoices.filter((i) => i.type === "invoice" && !isReconciled(i) && (i.status === "sent" || i.status === "overdue" || i.status === "paid"));
    const invoiceLabel = (i) => `${i.number} — ${i.contact_name || i.contact_company || "—"} · ${fmt(Number(i.total) || 0)}${i.status === "paid" ? " (paid)" : ""}`;
    const findInvoiceForDeposit = (it) => {
      const amt = Math.abs(Number(it.amount));
      const desc = (it.description || "").toLowerCase();
      const byNum = matchableInvoices.find((i) => i.number && desc.includes(String(i.number).toLowerCase()) && Math.abs((Number(i.total) || 0) - amt) < 0.01);
      if (byNum) return byNum.id;
      const byAmt = matchableInvoices.filter((i) => Math.abs((Number(i.total) || 0) - amt) < 0.01);
      return byAmt.length === 1 ? byAmt[0].id : null;
    };

    const tickedItems = items.filter((it) => checked[`${it.kind}:${it.id}`]);
    const tickedSum = tickedItems.reduce((s, it) => s + it.amount, 0);
    const runningTotal = openingBalance + tickedSum;
    const targetClosing = Number(closingBalance) || 0;
    const balanced = phase === "match" && Math.abs(runningTotal - targetClosing) < 0.01;

    const toggle = (it) => {
      const k = `${it.kind}:${it.id}`;
      setChecked((prev) => ({ ...prev, [k]: !prev[k] }));
    };

    const startMatching = () => {
      if (!statementDate) { alert("Enter the statement date."); return; }
      if (closingBalance === "" || Number.isNaN(Number(closingBalance))) { alert("Enter the closing balance from your bank statement."); return; }
      setChecked({});
      setPhase("match");
    };

    const resetReconcile = () => {
      setPhase("setup");
      setChecked({});
      setDoneMeta(null);
      setImportItems(null);
      setImportInclude({});
      setImportCat({});
      setDepositChoice({});
    };

    // Money-out lines we can book as an expense (real expenses + any transfer the user opts to include).
    const isBookableExpense = (it) => it.status === "expense" || (it.status === "review" && it.amount < 0);

    const handleStatementFile = async (e) => {
      const file = e.target.files?.[0];
      if (e.target) e.target.value = "";
      if (!file) return;
      setParsing(true);
      try {
        const text = await file.text();
        const result = processBankFile(text, file.name, { invoices, existingTxns: txns });
        if (result.error) { alert(result.error); return; }
        const items = result.items || [];
        if (!items.length) { alert("No transactions found in that file."); return; }
        const inc = {}, cat = {}, dep = {};
        items.forEach((it) => {
          if (it.amount > 0) {
            // Money in: tie to an invoice if we can, otherwise record as Other Income.
            if (it.status === "invoice" && it.invoice?.id) { dep[it._k] = it.invoice.id; inc[it._k] = true; }
            else { const m = findInvoiceForDeposit(it); dep[it._k] = m || "income"; inc[it._k] = !!m; }
          } else {
            inc[it._k] = it.status === "expense" || it.status === "duplicate";
            if (isBookableExpense(it)) cat[it._k] = learnedCategoryFor(it.description) || it.account || (it.status === "review" ? "Internal transfer" : "Office Supplies & Stationery");
          }
        });
        setImportItems(items);
        setImportInclude(inc);
        setImportCat(cat);
        setDepositChoice(dep);
        if (!statementDate) setStatementDate(items.reduce((mx, it) => (it.date && it.date > mx ? it.date : mx), items[0]?.date || today()));
        setPhase("import-review");
      } catch {
        alert("Could not read that file. Please upload a CSV or OFX export.");
      } finally { setParsing(false); }
    };

    const applyBankStatement = async () => {
      if (!importItems) return;
      const chosen = importItems.filter((it) => importInclude[it._k]);
      if (!chosen.length) { alert("Tick at least one transaction to apply."); return; }
      setBusy(true);
      try {
        const recRow = { user_id: session.user.id, business_id: biz, statement_date: statementDate, opening_balance: openingBalance, closing_balance: closingBalance === "" ? null : Number(closingBalance) };
        const { data: rec, error: recErr } = await supabase.from("bk_reconciliations").insert(recRow).select().single();
        if (recErr || !rec) { alert(recErr?.code === "42P01" ? "Bank reconciliation needs migration 0009 applied in Supabase first." : `Couldn't save the reconciliation: ${recErr?.message || "unknown error"}`); setBusy(false); return; }
        const stamp = new Date().toISOString();
        const patch = { reconciled_at: stamp, reconciliation_id: rec.id };
        const batchId = (crypto?.randomUUID && crypto.randomUUID()) || `imp_${Date.now()}`;
        const baseRow = (it, type, account) => ({
          user_id: session.user.id, business_id: biz, division: insertDivision,
          date: it.date, type, description: it.description, amount: Math.abs(Number(it.amount)) || 0, account,
          contact: null, merchant: null, reference: null, job: null,
          payment_source: "business", paid_by: null, reimbursement_required: false, reimbursement_status: "not_required",
          source: "bank", bank_ref: it.bank_ref || null, import_batch_id: batchId, dedupe_key: it.dedupe_key, imported_at: stamp,
          reconciled_at: stamp, reconciliation_id: rec.id,
        });
        // Money out → new expenses; deposits marked "Other income" → income entries.
        const expenseRows = chosen.filter((it) => it.amount < 0 && isBookableExpense(it)).map((it) => baseRow(it, "expense", importCat[it._k] || it.account || "Office Supplies & Stationery"));
        const incomeRows = chosen.filter((it) => it.amount > 0 && depositChoice[it._k] === "income").map((it) => baseRow(it, "income", "Other Income"));
        const newRows = [...expenseRows, ...incomeRows];
        let insertedTxns = [];
        if (newRows.length) {
          const { ok, data } = await sbWrite(supabase.from("bk_transactions").insert(newRows).select(), "import transactions");
          if (!ok) { setBusy(false); return; }
          insertedTxns = data || [];
        }
        for (const r of expenseRows) learnCategory(null, r.description, r.account);
        // Deposits tied to an invoice → mark it paid (if still open) and reconcile.
        const invItems = chosen.filter((it) => it.amount > 0 && depositChoice[it._k] && depositChoice[it._k] !== "income");
        const invUpdates = [];
        for (const it of invItems) {
          const inv = invoices.find((i) => i.id === depositChoice[it._k]);
          if (!inv) continue;
          const upd = inv.status === "paid" ? { ...patch } : { status: "paid", paid_date: it.date || statementDate, ...patch };
          const r = await sbWrite(supabase.from("bk_invoices").update(upd).eq("id", inv.id), "reconcile invoice");
          if (r.ok) invUpdates.push({ id: inv.id, upd });
        }
        // Money out already in the books → reconcile the existing entry (no duplicate created).
        const dupIds = chosen.filter((it) => it.amount < 0 && it.status === "duplicate" && it.duplicateOf).map((it) => it.duplicateOf);
        if (dupIds.length) await sbWrite(supabase.from("bk_transactions").update(patch).in("id", dupIds), "reconcile matched");
        if (insertedTxns.length) setTxns((prev) => [...insertedTxns, ...prev]);
        const dupSet = new Set(dupIds);
        if (dupSet.size) setTxns((prev) => prev.map((t) => dupSet.has(t.id) ? { ...t, ...patch } : t));
        if (invUpdates.length) setInvoices((prev) => prev.map((i) => { const u = invUpdates.find((x) => x.id === i.id); return u ? { ...i, ...u.upd } : i; }));
        setLastReconciliation(rec);
        setDoneMeta({ count: chosen.length, statementDate, closingBalance: Number(closingBalance) || 0, created: insertedTxns.length, matchedInv: invUpdates.length, matchedExp: dupSet.size });
        setPhase("done");
      } finally { setBusy(false); }
    };

    const finish = async () => {
      if (!balanced) return;
      setBusy(true);
      const txnIds = tickedItems.filter((it) => it.kind === "expense").map((it) => it.id);
      const invoiceIds = tickedItems.filter((it) => it.kind === "invoice").map((it) => it.id);
      const ok = await completeReconciliation({ statementDate, closingBalance: targetClosing, openingBalance, txnIds, invoiceIds });
      setBusy(false);
      if (ok) {
        setDoneMeta({ count: tickedItems.length, statementDate, closingBalance: targetClosing });
        setPhase("done");
      }
    };

    if (phase === "done") {
      return (
        <div style={{ ...s.card, textAlign: "center", padding: "40px 20px" }}>
          <div style={{ width: 54, height: 54, borderRadius: 27, background: "#ecfdf5", color: "#059669", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icons.Check /></div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a", marginTop: 12 }}>Reconciliation complete</div>
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
            {doneMeta?.count || 0} transaction{(doneMeta?.count || 0) === 1 ? "" : "s"} matched to statement ending {fmtDate(doneMeta?.statementDate)} ({fmt(doneMeta?.closingBalance || 0)}).
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 18 }}>
            <button onClick={resetReconcile} style={s.btnOutline}>Reconcile again</button>
            <button onClick={() => setPage("expenses")} style={s.btn(accent)}>View expenses</button>
          </div>
        </div>
      );
    }

    if (phase === "setup") {
      return (
        <div style={s.card}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 20 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: "#ecfdf5", color: accent, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><Icons.Reconcile /></div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>Match your bank statement</div>
              <div style={{ fontSize: 12, color: "#64748b", marginTop: 4, lineHeight: 1.5, maxWidth: 520 }}>
                Enter the closing balance and date from your bank statement, then tick off each transaction that appears on it. Personal card expenses are included — they are real business transactions on your books.
              </div>
            </div>
          </div>
          <div style={{ ...s.grid2, maxWidth: 480 }}>
            <div>
              <label style={s.label}>Statement date</label>
              <input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} style={s.input} />
            </div>
            <div>
              <label style={s.label}>Closing balance ($)</label>
              <input type="number" step="0.01" value={closingBalance} onChange={(e) => setClosingBalance(e.target.value)} placeholder="e.g. 12450.00" style={s.input} />
            </div>
          </div>
          {reconciliations.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Recent reconciliations</div>
              <div style={{ border: "1px solid #e2e8f0", borderRadius: 9, overflow: "hidden" }}>
                {reconciliations.slice(0, 8).map((rec, idx) => (
                  <div key={rec.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "9px 12px", borderTop: idx ? "1px solid #f1f5f9" : "none" }}>
                    <div style={{ fontSize: 12, color: "#334155" }}>
                      <span style={{ fontWeight: 600 }}>{fmtDate(rec.statement_date)}</span>
                      <span style={{ color: "#94a3b8" }}> · closing {rec.closing_balance == null ? "—" : fmt(rec.closing_balance)}</span>
                    </div>
                    <button onClick={() => undoReconciliation(rec.id)} style={{ ...s.btnOutline, color: "#ef4444", borderColor: "#ef444440", padding: "4px 10px", fontSize: 12 }}>Undo</button>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, lineHeight: 1.5 }}>Undo deletes the expenses/income an import created and clears its reconciled marks (invoices it paid stay paid). Opening balance for a new reconcile: {fmt(openingBalance)}.</div>
            </div>
          )}
          <button onClick={startMatching} style={{ ...s.btn(accent), marginTop: 18 }}><Icons.Reconcile /> Start matching</button>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "22px 0 14px", color: "#94a3b8", fontSize: 11, fontWeight: 600, letterSpacing: "0.05em" }}>
            <div style={{ flex: 1, height: 1, background: "#e2e8f0" }} /> OR IMPORT A STATEMENT <div style={{ flex: 1, height: 1, background: "#e2e8f0" }} />
          </div>
          <div style={{ fontSize: 12, color: "#64748b", lineHeight: 1.5, maxWidth: 520 }}>Upload a CSV or OFX/QFX export from your bank. We'll match deposits to your invoices, auto-categorise expenses, skip duplicates, and create anything new — then reconcile against the closing balance above.</div>
          <input ref={fileRef} type="file" accept=".csv,.ofx,.qfx,text/csv,text/plain,application/x-ofx" onChange={handleStatementFile} style={{ display: "none" }} />
          <button onClick={() => fileRef.current?.click()} disabled={parsing} style={{ ...s.btnOutline, marginTop: 12, color: "#3b82f6", borderColor: "#3b82f640", gap: 6, opacity: parsing ? 0.5 : 1 }}><Icons.Cloud /> {parsing ? "Reading…" : "Upload CSV / OFX"}</button>
        </div>
      );
    }

    if (phase === "import-review" && importItems) {
      const chosen = importItems.filter((it) => importInclude[it._k]);
      const moneyIn = chosen.filter((it) => it.amount > 0).reduce((sum, it) => sum + it.amount, 0);
      const moneyOut = chosen.filter((it) => it.amount < 0).reduce((sum, it) => sum + Math.abs(it.amount), 0);
      const net = moneyIn - moneyOut;
      const target = closingBalance === "" ? null : Number(closingBalance);
      const diff = target == null ? 0 : openingBalance + net - target;
      const reconBalanced = target != null && Math.abs(diff) < 0.01;
      const chip = (it) => {
        const map = { invoice: ["#3b82f6", `Match invoice ${it.invoice?.number || ""}`.trim()], expense: ["#10b981", "New expense"], duplicate: ["#64748b", "Already booked"], review: ["#f59e0b", it.amount > 0 ? "Unmatched deposit" : (it.reviewReason || "Review")] };
        const [c, label] = map[it.status] || ["#64748b", it.status];
        return <span style={s.badge(c)}>{label}</span>;
      };
      return (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: 12, color: "#64748b" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "5px 10px", fontWeight: 600, color: "#0f172a" }}><Icons.Reconcile /> {importItems.length} line{importItems.length === 1 ? "" : "s"} imported</span>
            <button onClick={resetReconcile} style={{ ...s.btnOutline, marginLeft: "auto" }}>Start over</button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <ListStat label="Money in" value={fmt(moneyIn)} color="#059669" />
            <ListStat label="Money out" value={fmt(moneyOut)} color="#0f172a" />
            <ListStat label="Selected" value={`${chosen.length}/${importItems.length}`} color="#059669" />
            {target != null && <ListStat label={reconBalanced ? "Balanced ✓" : "Difference"} value={reconBalanced ? fmt(target) : fmt(diff)} color={reconBalanced ? "#059669" : "#92400e"} />}
          </div>
          {target != null && !reconBalanced && (
            <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 12px", fontSize: 12, color: "#92400e", marginBottom: 12 }}>Selected lines net to {fmt(net)}. Opening {fmt(openingBalance)} + selected ≠ closing {fmt(target)} (off by {fmt(diff)}). Tick the remaining lines — match each deposit to an invoice or mark it Other Income — to close the gap.</div>
          )}
          <div style={s.card}>
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr>
                  <th style={{ ...s.th, width: 36 }}></th>
                  <th style={s.th}>Transaction</th>
                  <th style={s.th}>Action</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Amount</th>
                </tr></thead>
                <tbody>
                  {importItems.map((it) => {
                    const inflow = it.amount > 0;
                    const choice = depositChoice[it._k] || "income";
                    return (
                      <tr key={it._k} style={importInclude[it._k] ? undefined : { opacity: 0.55 }}>
                        <td style={{ ...s.td, textAlign: "center" }}>
                          <input type="checkbox" checked={!!importInclude[it._k]} onChange={() => setImportInclude((p) => ({ ...p, [it._k]: !p[it._k] }))} style={{ width: 16, height: 16, accentColor: accent, cursor: "pointer" }} />
                        </td>
                        <td style={s.td}>
                          <div style={{ fontWeight: 500 }}>{it.description}</div>
                          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{fmtDate(it.date)}</div>
                        </td>
                        <td style={s.td}>
                          {inflow ? (
                            <>
                              <span style={s.badge(choice === "income" ? "#8b5cf6" : "#3b82f6")}>{choice === "income" ? "Other income" : "Match invoice"}</span>
                              <select value={choice} onChange={(e) => setDepositChoice((p) => ({ ...p, [it._k]: e.target.value }))} style={{ ...s.select, marginTop: 6, padding: "4px 8px", fontSize: 11, maxWidth: 280 }}>
                                <option value="income">Other income (record deposit)</option>
                                {matchableInvoices.map((i) => <option key={i.id} value={i.id}>{invoiceLabel(i)}</option>)}
                              </select>
                            </>
                          ) : (
                            <>
                              {chip(it)}
                              {isBookableExpense(it) && (
                                <select value={importCat[it._k] || it.account || ""} onChange={(e) => setImportCat((p) => ({ ...p, [it._k]: e.target.value }))} style={{ ...s.select, marginTop: 6, padding: "4px 8px", fontSize: 11, maxWidth: 220 }}>
                                  {EXPENSE_CATEGORY_GROUPS.map((g) => <optgroup key={g.label} label={g.label}>{g.categories.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>)}
                                </select>
                              )}
                            </>
                          )}
                        </td>
                        <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap", color: it.amount >= 0 ? "#059669" : "#0f172a" }}>{it.amount >= 0 ? "+" : "-"}{fmt(Math.abs(it.amount))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 12, ...s.card, marginBottom: 0 }}>
            <div style={{ fontSize: 12, color: "#64748b" }}>{chosen.length} of {importItems.length} will be applied{target != null ? (reconBalanced ? " · Balanced ✓" : ` · off by ${fmt(diff)}`) : ""}</div>
            <button disabled={busy || !chosen.length} onClick={applyBankStatement} style={{ ...s.btn(accent), opacity: busy || !chosen.length ? 0.5 : 1 }}>{busy ? "Applying…" : "Apply & reconcile"}</button>
          </div>
        </div>
      );
    }

    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12, fontSize: 12, color: "#64748b" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "5px 10px", fontWeight: 600, color: "#0f172a" }}>
            <Icons.Reconcile /> Statement {fmtDate(statementDate)}
          </span>
          <span>Target {fmt(targetClosing)} · Opening {fmt(openingBalance)}</span>
          <button onClick={resetReconcile} style={{ ...s.btnOutline, marginLeft: "auto" }}>Change details</button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <ListStat label="Unreconciled" value={items.length} />
          <ListStat label="Selected" value={tickedItems.length} color="#059669" />
          <ListStat label="Running total" value={fmt(runningTotal)} color={balanced ? "#059669" : "#0f172a"} />
          <ListStat label="Statement balance" value={fmt(targetClosing)} />
        </div>
        {balanced && (
          <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, color: "#059669", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <Icons.Check /> Balanced — running total matches your bank statement
          </div>
        )}
        {!balanced && tickedItems.length > 0 && (
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 12px", fontSize: 12, color: "#92400e", marginBottom: 12 }}>
            Difference {fmt(runningTotal - targetClosing)} — keep ticking transactions until the running total matches {fmt(targetClosing)}.
          </div>
        )}
        <div style={s.card}>
          {items.length === 0 ? (
            <EmptyState icon={Icons.Reconcile} title="Nothing to reconcile" hint={periodStart ? `No unreconciled transactions between ${fmtDate(periodStart)} and ${fmtDate(statementDate)}.` : `No unreconciled transactions on or before ${fmtDate(statementDate)}.`} />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={{ ...s.th, width: 36 }}></th>
                    <th style={s.th}>Transaction</th>
                    <th style={{ ...s.th, textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={`${it.kind}:${it.id}`}>
                      <td style={{ ...s.td, textAlign: "center" }}>
                        <input type="checkbox" checked={!!checked[`${it.kind}:${it.id}`]} onChange={() => toggle(it)} style={{ width: 16, height: 16, accentColor: accent, cursor: "pointer" }} />
                      </td>
                      <td style={s.td}>
                        <div style={{ fontWeight: 500 }}>{it.label}</div>
                        <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 1 }}>{fmtDate(it.date)} · {it.sub}</div>
                      </td>
                      <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap", color: it.amount >= 0 ? "#059669" : "#0f172a" }}>
                        {it.amount >= 0 ? "+" : "-"}{fmt(Math.abs(it.amount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 12, ...s.card, marginBottom: 0 }}>
          <div style={{ fontSize: 12, color: "#64748b" }}>
            {tickedItems.length} selected · running total {fmt(runningTotal)}
            {balanced && " · Balanced ✓"}
          </div>
          <button disabled={!balanced || busy || !tickedItems.length} onClick={finish} style={{ ...s.btn(accent), opacity: !balanced || busy || !tickedItems.length ? 0.5 : 1 }}>
            {busy ? "Saving…" : "Mark reconciliation complete"}
          </button>
        </div>
      </div>
    );
  };

  const MobileLayout = () => (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: "#f7f9f8", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <MobileHeader />
      <div style={{ flex: 1, overflow: "auto" }}>
        {page === "dashboard" && <MobileDashboard />}
        {page === "expenses" && <MobileExpenses />}
        {page === "reconcile" && <div style={{ padding: 16 }}><ReconcilePage /></div>}
        {page === "reimbursements" && <MobileReimbursements />}
        {page === "quotes" && <MobileQuotes />}
        {page === "invoices" && <MobileInvoices />}
        {page === "projects" && <MobileProjects />}
        {page === "contacts" && <MobileContacts />}
        {page === "pnl" && <PnlPage />}
      </div>
      <MobileTabBar />
    </div>
  );

  const pageMap = { dashboard: DashboardPage, expenses: ExpensesPage, reconcile: ReconcilePage, reimbursements: ReimbursementsPage, quotes: QuotesPage, invoices: InvoicesPage, pnl: PnlPage, projects: ProjectsPage, contacts: ContactsPage };
  const PageComponent = pageMap[page] || DashboardPage;

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
          <button key={item.id} onMouseEnter={item.submenu ? (e) => openNavMenu(e, item.submenu) : undefined} onMouseLeave={item.submenu ? closeNavMenuSoon : undefined} onClick={(e) => { if (item.submenu) openNavMenu(e, item.submenu); else setPage(item.id); }} title={navCollapsed ? item.label : undefined} style={{ ...s.navBtn(activeNav === item.id), justifyContent: navCollapsed ? "center" : "flex-start", padding: navCollapsed ? "10px 0" : "9px 12px", gap: navCollapsed ? 0 : 10 }}>
            <item.icon />{!navCollapsed && <span>{item.label}</span>}{!navCollapsed && item.submenu && <span style={{ marginLeft: "auto", display: "inline-flex", opacity: 0.5 }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg></span>}
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

  if (isMobile) {
    return (
      <>
        <MobileLayout />
        {modal && (
          <div className="bk-overlay" style={s.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) requestCloseModal(true); }}>
            <div className="bk-modal" style={{ ...s.modalContent, maxWidth: "100%", borderRadius: "16px 16px 0 0", position: "fixed", bottom: 0, left: 0, right: 0, maxHeight: "90vh", overflowY: "auto" }}>
              {modal === "expense" && <ExpenseForm existing={editItem} />}
              {modal === "income" && <IncomeForm existing={editItem} />}
              {modal === "batch" && <BatchReceipts />}
              {modal === "contact" && <ContactForm existing={editItem} />}
              {modal === "invoice" && <InvoiceForm existing={editItem} />}
              {modal === "project" && <ProjectForm existing={editItem} />}
              {modal === "receipt" && <ReceiptCapture />}
              {modal === "settings" && <BusinessSettings />}
            </div>
          </div>
        )}
        {viewDoc && <DocViewer inv={viewDoc} profile={profile} accent={accent} isMobile={isMobile} pdfLoading={pdfLoading} onClose={() => setViewDoc(null)} onDownload={downloadPDF} fetchLogoBase64={fetchLogoBase64} />}
        {viewReceipt && <ReceiptViewer receipt={viewReceipt} onClose={() => setViewReceipt(null)} />}
      </>
    );
  }

  return (
    <>
      <div style={s.app}>
        <div style={{ ...s.sidebar, width: navCollapsed ? 72 : 220, transition: "width .15s ease" }}><SidebarContent /></div>
        {navMenu && (
          <div onMouseEnter={holdNavMenu} onMouseLeave={closeNavMenuSoon} style={{ position: "fixed", top: navMenu.y, left: navMenu.x + 8, width: 190, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 11, boxShadow: "0 14px 32px -10px rgba(16,24,40,0.30)", padding: 5, zIndex: 61 }}>
            {navMenu.items.map((opt) => (
              <button key={opt.id} className="bk-menuitem" onClick={() => { setPage(opt.id); setNavMenu(null); }} style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "9px 11px", background: page === opt.id ? "#ecfdf5" : "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: page === opt.id ? 600 : 400, color: page === opt.id ? "#059669" : "#334155", textAlign: "left", borderRadius: 7 }}>
                <span style={{ display: "inline-flex", width: 16, justifyContent: "center", color: page === opt.id ? "#059669" : "#64748b" }}><opt.icon /></span>{opt.label}
              </button>
            ))}
          </div>
        )}
        <div style={s.main}>
          <div style={s.header}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{PAGE_TITLES[page] || ""}</div>
              <div style={{ fontSize: 10, color: accent, fontWeight: 600, marginTop: 2 }}>{divInfo.name}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={() => setModal("receipt")} style={s.btn("#8b5cf6", true)}><Icons.Camera /> Receipt</button>
              {(page === "expenses" || page === "dashboard" || page === "reimbursements") && <button onClick={() => setModal("expense")} style={s.btn(accent, true)}><Icons.Plus /> Expense</button>}
              {page === "quotes" && <button onClick={() => { setEditItem(null); setInvoiceSeed({ type: "quote" }); setModal("invoice"); }} style={s.btn(accent, true)}><Icons.Plus /> Quote</button>}
              {page === "invoices" && <button onClick={() => { setEditItem(null); setInvoiceSeed({ type: "invoice" }); setModal("invoice"); }} style={s.btn(accent, true)}><Icons.Plus /> Invoice</button>}
              {page === "projects" && <button onClick={() => { setEditItem(null); setModal("project"); }} style={s.btn(accent, true)}><Icons.Plus /> Project</button>}
              {page === "contacts" && <button onClick={() => setModal("contact")} style={s.btn(accent, true)}><Icons.Plus /> Contact</button>}
            </div>
          </div>
          <div style={s.content}><PageComponent /></div>
        </div>
        {modal && (
          <div className="bk-overlay" style={s.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) requestCloseModal(true); }}>
            <div className="bk-modal" style={s.modalContent}>
              {modal === "expense" && <ExpenseForm existing={editItem} />}
              {modal === "income" && <IncomeForm existing={editItem} />}
              {modal === "batch" && <BatchReceipts />}
              {modal === "contact" && <ContactForm existing={editItem} />}
              {modal === "invoice" && <InvoiceForm existing={editItem} />}
              {modal === "project" && <ProjectForm existing={editItem} />}
              {modal === "receipt" && <ReceiptCapture />}
              {modal === "settings" && <BusinessSettings />}
            </div>
          </div>
        )}
      </div>
      {viewDoc && <DocViewer inv={viewDoc} profile={profile} accent={accent} isMobile={isMobile} pdfLoading={pdfLoading} onClose={() => setViewDoc(null)} onDownload={downloadPDF} fetchLogoBase64={fetchLogoBase64} />}
      {viewReceipt && <ReceiptViewer receipt={viewReceipt} onClose={() => setViewReceipt(null)} />}
    </>
  );
}
