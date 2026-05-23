import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import html2pdf from "html2pdf.js";

const DEFAULT_ACCOUNTS = [
  { code: "4000", name: "Sales Revenue", type: "Revenue" },
  { code: "4200", name: "Service Revenue", type: "Revenue" },
  { code: "4300", name: "Other Income", type: "Revenue" },
  { code: "6000", name: "Advertising & Marketing", type: "Expense" },
  { code: "6100", name: "Accounting & Professional Fees", type: "Expense" },
  { code: "6200", name: "Bank Fees & Interest", type: "Expense" },
  { code: "6300", name: "Contractors & Subcontractors", type: "Expense" },
  { code: "6400", name: "Software & Subscriptions", type: "Expense" },
  { code: "6500", name: "Office & Supplies", type: "Expense" },
  { code: "6600", name: "Equipment & Assets", type: "Expense" },
  { code: "6700", name: "Motor Vehicle", type: "Expense" },
  { code: "6800", name: "Travel", type: "Expense" },
  { code: "6900", name: "Phone & Internet", type: "Expense" },
  { code: "7000", name: "Insurance", type: "Expense" },
  { code: "7100", name: "Tax & Government Fees", type: "Expense" },
  { code: "7200", name: "Other", type: "Expense" },
];

const DEFAULT_EMAIL_TEMPLATE_INVOICE = `Hi {contact_name},

Please find attached invoice {number} for {amount}.

{due_date_line}

{payment_details}

Kind regards,
{signature}`;

const DEFAULT_EMAIL_TEMPLATE_QUOTE = `Hi {contact_name},

Please find attached quote {number} for {amount}.

This quote is valid until {due_date}. Payment details will be provided upon acceptance.

Kind regards,
{signature}`;

const DEFAULT_PROFILE = { name: "", abn: "", address: "", email: "", phone: "", bank_name: "", account_name: "", bsb: "", account_number: "", logo_url: "", email_template_invoice: "", email_template_quote: "", email_signature: "" };

const BUSINESSES = [
  { id: "mworx", name: "Mworx Group", accent: "#10b981" },
];

const fmt = (n) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
const fmtDate = (d) => new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
const today = () => new Date().toISOString().split("T")[0];

const PAYMENT_SOURCES = [
  { value: "business", label: "Business account" },
  { value: "personal_reimburse", label: "Personal account — reimburse owner" },
  { value: "personal_no_reimburse", label: "Personal account — do not reimburse" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

const GST_TREATMENTS = ["GST included", "No GST", "GST free", "BAS excluded", "Input taxed", "Unsure"];

const sanitizeFilePart = (s) => (s || "").replace(/[/\\:*?"<>|&#%]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
const safeFileName = (parts, ext) => parts.map(p => sanitizeFilePart(String(p))).filter(Boolean).join("_") + "." + ext;
const fmtAmtFile = (n) => Number(n).toFixed(2).replace(".", "-");

function getDocumentPrefix(profile, type) {
  const bid = (profile?.business_id || "").toLowerCase();
  const bname = (profile?.name || "").toLowerCase();
  const isMworx = bid.includes("mworx") || bname.includes("mworx");
  if (isMworx) return type === "quote" ? "QMWX" : "MWX";
  return type === "quote" ? "QUO" : "INV";
}

function getNextDocumentNumber(invoices, profile, type) {
  const prefix = getDocumentPrefix(profile, type);
  const yy = String(new Date().getFullYear()).slice(-2);
  const tag = `${prefix}${yy}`;
  const seqs = (invoices || [])
    .filter((i) => i.business_id === profile?.business_id && i.type === type)
    .map((i) => { const n = i.number; if (!n || !n.startsWith(tag)) return 0; const s = Number(n.slice(tag.length)); return Number.isFinite(s) ? s : 0; })
    .filter((s) => s > 0);
  const next = seqs.length ? Math.max(...seqs) + 1 : 1;
  return `${tag}${String(next).padStart(3, "0")}`;
}

function addDays(dateStr, days) { const d = new Date(dateStr); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function getDefaultDueDate(type, date) { return addDays(date || today(), type === "quote" ? 30 : 7); }
function getDefaultTerms(type) { return type === "quote" ? "This quote is valid for 30 days from the quote date. Pricing may be subject to change after this period." : "Payment is due within 7 days from the invoice date. Please use the invoice number as the payment reference."; }

const Icons = {
  Dashboard: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  Expenses: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
  Contacts: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Invoices: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
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
  Reimburse: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
};

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    const { error } = isSignUp
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) setError(error.message);
  };

  const inputStyle = { width: "100%", padding: "12px 16px", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8, color: "#0f172a", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 12 };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#f7f9f8", fontFamily: "'DM Sans', system-ui, sans-serif", padding: 20 }}>
      <div style={{ background: "#ffffff", borderRadius: 16, border: "1px solid #e2e8f0", padding: 40, width: "100%", maxWidth: 400, textAlign: "center", boxShadow: "0 4px 6px -1px rgba(0,0,0,0.06)" }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.03em", marginBottom: 4 }}>BookKeeper</div>
        <div style={{ fontSize: 12, color: "#10b981", marginBottom: 32, textTransform: "uppercase", letterSpacing: "0.08em" }}>Mworx Group</div>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" style={inputStyle} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" onKeyDown={(e) => e.key === "Enter" && email && password && handleSubmit()} style={inputStyle} />
        {error && <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>{error}</div>}
        <button disabled={!email || !password || loading} onClick={handleSubmit} style={{ width: "100%", padding: "12px", background: "#10b981", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: !email || !password || loading ? 0.5 : 1, marginBottom: 12 }}>
          {loading ? "..." : isSignUp ? "Sign Up" : "Sign In"}
        </button>
        <button onClick={() => { setIsSignUp(!isSignUp); setError(""); }} style={{ background: "none", border: "none", color: "#64748b", fontSize: 12, cursor: "pointer" }}>
          {isSignUp ? "Already have an account? Sign In" : "Need an account? Sign Up"}
        </button>
      </div>
    </div>
  );
}

function buildInvoiceHTML(inv, profile, accent, logoDataUrl) {
  const isQuote = inv.type === "quote";
  const docType = isQuote ? "QUOTE" : "INVOICE";
  const bName = profile.name || "Company";
  const tagline = profile.business_id === "mworx" ? "Design · Consultancy · Project Management" : "";
  const accountName = profile.account_name || profile.name || bName;

  const logoHTML = logoDataUrl
    ? `<img src="${logoDataUrl}" style="max-height:70px;max-width:200px;object-fit:contain;display:block" />`
    : `<div style="font-size:24px;font-weight:800;color:#1e293b;letter-spacing:-0.02em">${bName}</div>`;

  const items = (inv.items || []).map((item) => {
    const amount = (Number(item.qty) || 0) * (Number(item.rate) || 0);
    return `<tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#1e293b;vertical-align:top">
        <div style="font-weight:600">${item.description || ""}</div>
        ${item.note ? `<div style="font-size:10px;color:#6b7280;margin-top:2px">${item.note}</div>` : ""}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:center;vertical-align:top">${Number(item.qty) || 1}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#374151;text-align:right;vertical-align:top">${fmt(item.rate || 0)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:11px;font-weight:600;color:#1e293b;text-align:right;vertical-align:top">${fmt(amount)}</td>
    </tr>`;
  }).join("");

  const subtotal = (inv.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);

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

  return `<div style="width:595px;min-height:842px;background:#fff;padding:40px 44px;font-family:Helvetica Neue,Arial,sans-serif;position:relative;box-sizing:border-box">

    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
      <div>
        ${logoHTML}
        <div style="margin-top:10px">
          ${profile.abn ? `<div style="font-size:10px;color:#475569;font-weight:600;margin-bottom:3px">ABN ${profile.abn}</div>` : ""}
          <div style="font-size:10px;color:#6b7280;line-height:1.6">
            ${profile.address ? `${profile.address}<br>` : ""}${profile.email || ""}${profile.phone ? ` · ${profile.phone}` : ""}
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

    <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
      <thead>
        <tr style="background:#f8fafc">
          <th style="text-align:left;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b">Description</th>
          <th style="text-align:center;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:50px">Qty</th>
          <th style="text-align:right;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:90px">Rate</th>
          <th style="text-align:right;padding:9px 12px;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #1e293b;width:100px">Amount</th>
        </tr>
      </thead>
      <tbody>${items}</tbody>
    </table>

    <div style="display:flex;justify-content:flex-end">
      <div style="width:240px">
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:11px;color:#6b7280"><span>Subtotal</span><span>${fmt(subtotal)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:11px;color:#94a3b8"><span>GST</span><span>$0.00</span></div>
        <div style="display:flex;justify-content:space-between;padding:10px 0 4px;margin-top:4px;border-top:2px solid #1e293b">
          <span style="font-size:14px;font-weight:700;color:#1e293b">Total AUD</span>
          <span style="font-size:16px;font-weight:800;color:${accent}">${fmt(subtotal)}</span>
        </div>
        <div style="font-size:10px;color:#6b7280;text-align:right;margin-top:2px">Not registered for GST. No GST has been charged.</div>
      </div>
    </div>

    ${paymentSection}

    ${inv.notes ? `<div style="font-size:10px;color:#6b7280;line-height:1.6;margin-top:20px;padding-top:10px;border-top:1px solid #e5e7eb">${inv.notes}</div>` : ""}

    <div style="position:absolute;bottom:24px;left:44px;right:44px;text-align:center;border-top:1px solid #e2e8f0;padding-top:12px">
      <div style="font-size:10px;color:#64748b;margin-bottom:2px">Thank you for your business.</div>
      <div style="font-size:9px;color:#94a3b8">${bName}${profile.abn ? ` · ABN ${profile.abn}` : ""}${profile.email ? ` · ${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}</div>
      ${tagline ? `<div style="font-size:8px;color:#94a3b8;margin-top:2px">${tagline}</div>` : ""}
    </div>
  </div>`;
}

export default function BookkeeperApp() {
  const [session, setSession] = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [editItem, setEditItem] = useState(null);
  const [aiData, setAiData] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);

  const [biz, setBiz] = useState(() => localStorage.getItem("bk_activeBusiness") || "mworx");
  const [contacts, setContacts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [txns, setTxns] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [profile, setProfile] = useState({ ...DEFAULT_PROFILE });
  const [emailConn, setEmailConn] = useState(null);

  const bizInfo = BUSINESSES.find((b) => b.id === biz);
  const accent = bizInfo?.accent || "#10b981";
  const accounts = DEFAULT_ACCOUNTS;

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => setSession(session));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const loadData = useCallback(async (businessId) => {
    if (!session) return;
    setLoading(true);
    const [cRes, iRes, tRes, pRes, jRes, eRes] = await Promise.all([
      supabase.from("bk_contacts").select("*").eq("business_id", businessId).order("name"),
      supabase.from("bk_invoices").select("*").eq("business_id", businessId).order("date", { ascending: false }),
      supabase.from("bk_transactions").select("*").eq("business_id", businessId).order("date", { ascending: false }),
      supabase.from("bk_profiles").select("*").eq("business_id", businessId).maybeSingle(),
      supabase.from("bk_jobs").select("*").eq("business_id", businessId).order("last_used_at", { ascending: false }),
      supabase.from("bk_email_connections").select("*").eq("business_id", businessId).eq("provider", "outlook").maybeSingle(),
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
    setProfile(pRes.data || { ...DEFAULT_PROFILE, name: bizInfo?.name || "" });
    setEmailConn(eRes.data || null);
    setLoading(false);

    // Mark overdue invoices server-side
    await supabase.from("bk_invoices")
      .update({ status: "overdue" })
      .eq("business_id", businessId)
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
  }, [session]);

  useEffect(() => {
    if (session) loadData(biz);
  }, [session, biz, loadData]);

  const switchBiz = (id) => {
    setBiz(id);
    localStorage.setItem("bk_activeBusiness", id);
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setContacts([]);
    setInvoices([]);
    setTxns([]);
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

  const jobNames = [...new Set([...invoices.map((i) => i.job), ...txns.map((t) => t.job)].filter(Boolean))].sort();

  // --- Mutation functions: each writes directly to its table ---

  const openReceipt = async (t) => {
    if (!t?.receipt_path) { alert("No receipt attached to this expense."); return; }
    const { data, error } = await supabase.storage.from("receipts").createSignedUrl(t.receipt_path, 600);
    if (error || !data?.signedUrl) { alert("Could not load receipt. Please try again."); return; }
    window.open(data.signedUrl, "_blank");
  };

  const addTransaction = async (t) => {
    const ps = t.payment_source || "business";
    const isReimburse = ps === "personal_reimburse";
    const isPersonalNoReimburse = ps === "personal_no_reimburse";
    const isPersonal = isReimburse || isPersonalNoReimburse;
    const row = { user_id: session.user.id, business_id: biz, date: t.date, type: t.type, description: t.description, amount: Number(t.amount) || 0, account: t.account, contact: t.contact, reference: t.reference, receipt_path: t.receipt_path || t.receiptPath || "", job: t.job, payment_source: isPersonal ? "personal" : ps, paid_by: isPersonal ? (t.paid_by || null) : null, reimbursement_required: isReimburse, reimbursement_status: isReimburse ? "pending" : isPersonalNoReimburse ? "do_not_reimburse" : "not_required", reimbursement_date: null, reimbursement_amount: isReimburse ? (Number(t.amount) || 0) : null, reimbursement_reference: null, business_purpose: isPersonal ? (t.business_purpose || null) : null, gst_amount: t.gst_amount != null && t.gst_amount !== "" ? Number(t.gst_amount) : null, gst_treatment: t.gst_treatment || "Unsure", ai_category_confidence: t.ai_category_confidence != null ? Number(t.ai_category_confidence) : null, ai_extraction_confidence: t.ai_extraction_confidence != null ? Number(t.ai_extraction_confidence) : null, ai_warnings: t.ai_warnings?.length ? t.ai_warnings : null };
    const { data: inserted } = await supabase.from("bk_transactions").insert(row).select().single();
    if (inserted) {
      if (inserted.receipt_path) {
        const ext = (inserted.receipt_path.split(".").pop() || "jpg").toLowerCase();
        const newName = safeFileName([inserted.date, inserted.contact || "Unknown-Supplier", inserted.account || "Uncategorised", fmtAmtFile(inserted.amount), inserted.id], ext);
        const newPath = `${session.user.id}/${newName}`;
        const { error: moveErr } = await supabase.storage.from("receipts").move(inserted.receipt_path, newPath);
        if (!moveErr) {
          await supabase.from("bk_transactions").update({ receipt_path: newPath }).eq("id", inserted.id);
          inserted.receipt_path = newPath;
        }
      }
      setTxns((prev) => [inserted, ...prev]);
    }
    setModal(null);
    setAiData(null);
  };

  const updateTransaction = async (id, t) => {
    const ps = t.payment_source || "business";
    const isReimburse = ps === "personal_reimburse";
    const isPersonalNoReimburse = ps === "personal_no_reimburse";
    const isPersonal = isReimburse || isPersonalNoReimburse;
    const row = { date: t.date, type: t.type, description: t.description, amount: Number(t.amount) || 0, account: t.account, contact: t.contact, reference: t.reference, job: t.job, payment_source: isPersonal ? "personal" : ps, paid_by: isPersonal ? (t.paid_by || null) : null, reimbursement_required: isReimburse, reimbursement_status: isReimburse ? (t.reimbursement_status || "pending") : isPersonalNoReimburse ? "do_not_reimburse" : "not_required", reimbursement_date: isReimburse ? (t.reimbursement_date || null) : null, reimbursement_amount: isReimburse ? (t.reimbursement_amount != null ? Number(t.reimbursement_amount) : (Number(t.amount) || 0)) : null, reimbursement_reference: isReimburse ? (t.reimbursement_reference || null) : null, business_purpose: isPersonal ? (t.business_purpose || null) : null, gst_amount: t.gst_amount != null && t.gst_amount !== "" ? Number(t.gst_amount) : null, gst_treatment: t.gst_treatment || "Unsure" };
    const { data: updated } = await supabase.from("bk_transactions").update(row).eq("id", id).select().single();
    if (updated) setTxns((prev) => prev.map((x) => (x.id === id ? updated : x)));
    setModal(null);
    setEditItem(null);
  };

  const deleteTransaction = async (id) => {
    if (!window.confirm("Delete this expense? This cannot be undone.")) return;
    await supabase.from("bk_transactions").delete().eq("id", id);
    setTxns((prev) => prev.filter((t) => t.id !== id));
    setModal(null);
    setEditItem(null);
  };

  const markReimbursed = async (id, { status, date, amount, reference }) => {
    const row = { reimbursement_status: status, reimbursement_date: date || null, reimbursement_amount: amount != null ? Number(amount) : null, reimbursement_reference: reference || null };
    const { data: updated } = await supabase.from("bk_transactions").update(row).eq("id", id).select().single();
    if (updated) setTxns((prev) => prev.map((x) => (x.id === id ? updated : x)));
  };

  const addContact = async (c, keepModal) => {
    const row = { user_id: session.user.id, business_id: biz, name: c.name, email: c.email, phone: c.phone, type: c.type, company: c.company, abn: c.abn, address: c.address, notes: c.notes };
    const { data: inserted } = await supabase.from("bk_contacts").insert(row).select().single();
    if (inserted) setContacts((prev) => [...prev, inserted].sort((a, b) => a.name.localeCompare(b.name)));
    if (!keepModal) setModal(null);
    return inserted;
  };

  const updateContact = async (id, c) => {
    const row = { name: c.name, email: c.email, phone: c.phone, type: c.type, company: c.company, abn: c.abn, address: c.address, notes: c.notes };
    const { data: updated } = await supabase.from("bk_contacts").update(row).eq("id", id).select().single();
    if (updated) setContacts((prev) => prev.map((x) => (x.id === id ? updated : x)).sort((a, b) => a.name.localeCompare(b.name)));
    setModal(null);
    setEditItem(null);
  };

  const deleteContact = async (id) => {
    if (!window.confirm("Delete this contact? This cannot be undone.")) return;
    await supabase.from("bk_contacts").delete().eq("id", id);
    setContacts((prev) => prev.filter((c) => c.id !== id));
    setModal(null);
    setEditItem(null);
  };

  const addInvoice = async (inv) => {
    const items = inv.items || [];
    const row = { user_id: session.user.id, business_id: biz, number: inv.number, type: inv.type, date: inv.date || null, due_date: inv.due_date || null, contact_name: inv.contact_name, contact_email: inv.contact_email, contact_company: inv.contact_company, contact_abn: inv.contact_abn, contact_address: inv.contact_address, contact_phone: inv.contact_phone, job: inv.job, notes: inv.notes, status: inv.status, total: inv.total };
    const { data: inserted } = await supabase.from("bk_invoices").insert(row).select().single();
    if (inserted) {
      if (items.length) {
        const itemRows = items.map((it, idx) => ({ invoice_id: inserted.id, description: it.description, note: it.note, qty: Number(it.qty) || 1, rate: Number(it.rate) || 0, sort_order: idx }));
        const { data: insertedItems } = await supabase.from("bk_invoice_items").insert(itemRows).select();
        inserted.items = insertedItems || [];
      } else {
        inserted.items = [];
      }
      setInvoices((prev) => [inserted, ...prev]);
    }
    setModal(null);
    setEditItem(null);
  };

  const updateInvoice = async (id, updates) => {
    const dbUpdates = { ...updates };
    const items = dbUpdates.items;
    delete dbUpdates.items;
    await supabase.from("bk_invoices").update(dbUpdates).eq("id", id);
    if (items) {
      await supabase.from("bk_invoice_items").delete().eq("invoice_id", id);
      const itemRows = items.map((it, idx) => ({ invoice_id: id, description: it.description, note: it.note, qty: Number(it.qty) || 1, rate: Number(it.rate) || 0, sort_order: idx }));
      const { data: newItems } = await supabase.from("bk_invoice_items").insert(itemRows).select();
      setInvoices((prev) => prev.map((i) => (i.id === id ? { ...i, ...dbUpdates, items: newItems || [] } : i)));
    } else {
      setInvoices((prev) => prev.map((i) => (i.id === id ? { ...i, ...dbUpdates } : i)));
    }
    setModal(null);
    setEditItem(null);
  };

  const deleteInvoice = async (id) => {
    if (!window.confirm("Delete this invoice? This cannot be undone.")) return;
    await supabase.from("bk_invoices").delete().eq("id", id);
    setInvoices((prev) => prev.filter((i) => i.id !== id));
    setModal(null);
    setEditItem(null);
  };

  const upsertJob = async (jobName, contactName) => {
    const trimmed = (jobName || "").trim();
    if (!trimmed) return;
    const norm = trimmed.toLowerCase();
    const existing = jobs.find((j) => j.name.trim().toLowerCase() === norm);
    if (existing) {
      const upd = { last_used_at: new Date().toISOString() };
      const contact = contactName ? contacts.find((c) => c.name === contactName) : null;
      if (contact && !existing.contact_id) upd.contact_id = contact.id;
      await supabase.from("bk_jobs").update(upd).eq("id", existing.id);
      setJobs((prev) => prev.map((j) => j.id === existing.id ? { ...j, ...upd } : j));
    } else {
      const contact = contactName ? contacts.find((c) => c.name === contactName) : null;
      const row = { user_id: session.user.id, business_id: biz, name: trimmed, contact_id: contact?.id || null };
      const { data: inserted } = await supabase.from("bk_jobs").insert(row).select().single();
      if (inserted) setJobs((prev) => [inserted, ...prev]);
    }
  };

  const saveProfile = async (p) => {
    const row = { user_id: session.user.id, business_id: biz, name: p.name, abn: p.abn, address: p.address, email: p.email, phone: p.phone, bank_name: p.bank_name, account_name: p.account_name, bsb: p.bsb, account_number: p.account_number, logo_url: p.logo_url, email_template_invoice: p.email_template_invoice || "", email_template_quote: p.email_template_quote || "", email_signature: p.email_signature || "" };
    const { data: saved } = await supabase.from("bk_profiles").upsert(row, { onConflict: "user_id,business_id" }).select().single();
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

  const downloadPDF = async (inv) => {
    const pdfName = safeFileName([inv.number || "draft", inv.contact_name || "Client", inv.job, inv.date].filter(Boolean), "pdf");
    setPdfLoading(inv.id);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const resp = await fetch("/.netlify/functions/generate-invoice-pdf", {
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
      console.error("Server PDF failed, falling back to client-side:", err);
      const logoDataUrl = await fetchLogoBase64();
      const html = buildInvoiceHTML(inv, profile, accent, logoDataUrl);
      const el = document.createElement("div");
      el.innerHTML = html;
      document.body.appendChild(el);
      await html2pdf().set({ margin: 0, filename: pdfName, html2canvas: { scale: 3 }, jsPDF: { unit: "mm", format: "a4" } }).from(el.firstChild).save();
      document.body.removeChild(el);
    } finally {
      setPdfLoading(null);
    }
  };

  const buildEmailBody = (inv) => {
    const isQuote = inv.type === "quote";
    const bName = profile.name || "our company";
    const template = isQuote
      ? (profile.email_template_quote || DEFAULT_EMAIL_TEMPLATE_QUOTE)
      : (profile.email_template_invoice || DEFAULT_EMAIL_TEMPLATE_INVOICE);
    const sig = profile.email_signature || `${bName}${profile.email ? `\n${profile.email}` : ""}${profile.phone ? ` · ${profile.phone}` : ""}`;
    const dueDateLine = inv.due_date ? `Payment is due by ${fmtDate(inv.due_date)}.` : "";
    const paymentDetails = profile.bsb ? `Bank details:\n${profile.bank_name ? `Bank: ${profile.bank_name}\n` : ""}Account: ${profile.account_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}` : "";
    return template
      .replace(/\{contact_name\}/g, inv.contact_name || "")
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
    window.location.href = `ms-outlook://compose?to=${encodeURIComponent(inv.contact_email || "")}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    downloadPDF(inv);
    if (inv.status === "draft") updateInvoice(inv.id, { status: "sent" });
  };

  const sendReminder = (inv) => {
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    const bName = profile.name || "our company";
    const subject = `Reminder: ${docType} ${inv.number} from ${bName}`;
    const overdueDays = inv.due_date ? Math.max(0, Math.floor((Date.now() - new Date(inv.due_date)) / 86400000)) : 0;
    const body = `Hi ${inv.contact_name || ""},\n\nThis is a friendly reminder that ${docType.toLowerCase()} ${inv.number} for ${fmt(inv.total || 0)} ${overdueDays > 0 ? `was due ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago` : "is due for payment"}.\n\n${profile.bsb ? `Bank details:\n${profile.bank_name ? `Bank: ${profile.bank_name}\n` : ""}Account: ${profile.account_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}\n\n` : ""}Please let us know if you have any questions.\n\nKind regards,\n${bName}`;
    window.location.href = `ms-outlook://compose?to=${encodeURIComponent(inv.contact_email || "")}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (inv.due_date && new Date(inv.due_date) < new Date() && inv.status === "sent") updateInvoice(inv.id, { status: "overdue" });
  };

  const markPaid = (inv) => {
    updateInvoice(inv.id, { status: "paid", paid_date: today() });
  };

  const connectOutlook = async () => {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    if (!token) return;
    try {
      const resp = await fetch("/.netlify/functions/outlook-oauth-start", {
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
    await supabase.from("bk_email_connections").delete().eq("id", emailConn.id);
    setEmailConn(null);
  };


  if (session === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#f7f9f8", color: "#64748b" }}>Loading...</div>;
  if (!session) return <LoginScreen />;
  if (loading) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#f7f9f8", color: "#64748b", fontFamily: "'DM Sans', sans-serif" }}>Loading...</div>;

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Icons.Dashboard },
    { id: "expenses", label: "Expenses", icon: Icons.Expenses },
    { id: "reimbursements", label: "Reimburse", icon: Icons.Reimburse },
    { id: "invoices", label: "Invoices", icon: Icons.Invoices },
    { id: "contacts", label: "Contacts", icon: Icons.Contacts },
  ];

  const badgeBg = { "#34d399": "#ecfdf5", "#3b82f6": "#eff6ff", "#64748b": "#f1f5f9", "#ef4444": "#fef2f2", "#f59e0b": "#fffbeb" };
  const badgeTx = { "#34d399": "#065f46", "#3b82f6": "#1e40af", "#64748b": "#475569", "#ef4444": "#991b1b", "#f59e0b": "#92400e" };
  const s = {
    app: { display: "flex", height: "100vh", fontFamily: "'DM Sans', system-ui, sans-serif", background: "#f7f9f8", color: "#0f172a", fontSize: "13px", overflow: "hidden" },
    sidebar: { width: 220, background: "#ffffff", borderRight: "1px solid #e2e8f0", display: "flex", flexDirection: "column", flexShrink: 0, position: "relative", zIndex: 40 },
    sidebarMobile: { position: "fixed", inset: 0, zIndex: 40 },
    logo: { padding: "20px 16px 12px", borderBottom: "1px solid #e2e8f0" },
    bizSwitcher: { padding: "12px", borderBottom: "1px solid #e2e8f0" },
    bizBtn: (active, color) => ({ width: "100%", padding: "8px 10px", border: "none", borderRadius: 6, cursor: "pointer", textAlign: "left", fontSize: 12, fontWeight: 600, background: active ? color + "18" : "transparent", color: active ? color : "#64748b", borderLeft: active ? `3px solid ${color}` : "3px solid transparent", marginBottom: 2 }),
    nav: { flex: 1, padding: "8px", overflowY: "auto" },
    navBtn: (active) => ({ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "none", borderRadius: 6, cursor: "pointer", background: active ? "#ecfdf5" : "transparent", color: active ? "#059669" : "#64748b", fontSize: 13, fontWeight: active ? 600 : 400, marginBottom: 1, textAlign: "left", borderLeft: active ? `3px solid ${accent}` : "3px solid transparent" }),
    main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 },
    header: { padding: "12px 16px", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#ffffff", gap: 8, flexWrap: "wrap" },
    content: { flex: 1, padding: "16px", overflowY: "auto" },
    card: { background: "#ffffff", borderRadius: 10, border: "1px solid #e2e8f0", padding: "16px", marginBottom: 12, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
    statCard: () => ({ background: "#ffffff", borderRadius: 10, border: "1px solid #e2e8f0", padding: "20px 24px", minWidth: 0, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }),
    btn: (bg, small) => ({ padding: small ? "6px 12px" : "8px 16px", background: bg || accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: small ? 11 : 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }),
    btnOutline: { padding: "6px 12px", background: "transparent", color: "#64748b", border: "1px solid #e2e8f0", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 500 },
    table: { width: "100%", borderCollapse: "collapse" },
    th: { textAlign: "left", padding: "8px 10px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#94a3b8", borderBottom: "1px solid #e2e8f0" },
    td: { padding: "8px 10px", borderBottom: "1px solid #f1f5f9", fontSize: 13 },
    input: { width: "100%", padding: "8px 12px", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 6, color: "#0f172a", fontSize: 13, outline: "none", boxSizing: "border-box" },
    select: { width: "100%", padding: "8px 12px", background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 6, color: "#0f172a", fontSize: 13, outline: "none", boxSizing: "border-box" },
    label: { display: "block", fontSize: 11, fontWeight: 600, color: "#64748b", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" },
    modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 },
    modalContent: { background: "#ffffff", borderRadius: 12, border: "1px solid #e2e8f0", width: "100%", maxWidth: 560, maxHeight: "85vh", overflow: "auto", padding: "20px" },
    badge: (color) => ({ display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 10, fontWeight: 600, background: badgeBg[color] || color + "15", color: badgeTx[color] || color }),
    grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  };

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
      try {
        const base64 = dataUrl.split(",")[1];
        const blob = await (await fetch(dataUrl)).blob();
        const filePath = `${session.user.id}/${Date.now()}_receipt.jpg`;
        await supabase.storage.from("receipts").upload(filePath, blob, { contentType: "image/jpeg" });
        const resp = await fetch("/.netlify/functions/extract-receipt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image: base64, mediaType: "image/jpeg" }) });
        if (!resp.ok) throw new Error("Failed to process receipt");
        const result = await resp.json();
        const fromReimbursements = page === "reimbursements";
        setAiData({ ...result, receiptPath: filePath, scannedUrl: dataUrl, fromReimbursements });
        setModal("expense");
      } catch (err) { setError(err.message || "Failed to process receipt"); setPhase("scan"); }
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
    const derivePaymentSource = (e) => {
      if (!e) return "business";
      if (e.payment_source === "personal") return e.reimbursement_required ? "personal_reimburse" : "personal_no_reimburse";
      return e.payment_source || "business";
    };
    const ai = !existing ? aiData : null;
    const fromReimbursements = ai?.fromReimbursements;
    const init = existing ? { ...existing, payment_source: derivePaymentSource(existing), paid_by: existing.paid_by || "", business_purpose: existing.business_purpose || "", gst_amount: existing.gst_amount != null ? String(existing.gst_amount) : "", gst_treatment: existing.gst_treatment || "Unsure", reimbursement_status: existing.reimbursement_status || "not_required" } : ai ? { date: ai.date || today(), type: "expense", description: ai.description || ai.vendor || "", amount: ai.total != null ? String(ai.total) : "", account: accounts.find(a => a.name === ai.category && a.type === "Expense")?.name || ai.category || "", contact: ai.vendor || "", reference: "", job: "", receipt_path: ai.receiptPath || "", payment_source: fromReimbursements ? "personal_reimburse" : "business", paid_by: fromReimbursements ? "Michel" : "", business_purpose: ai.businessPurpose || "", gst_amount: ai.gstAmount != null ? String(ai.gstAmount) : "", gst_treatment: ai.gstTreatment || "Unsure", reimbursement_status: "not_required", ai_category_confidence: ai.categoryConfidence || null, ai_extraction_confidence: ai.confidence || null, ai_warnings: ai.warnings || null } : { date: today(), type: "expense", description: "", amount: "", account: accounts.find(a => a.type === "Expense")?.name || "", contact: "", reference: "", job: "", payment_source: "business", paid_by: "", business_purpose: "", gst_amount: "", gst_treatment: "Unsure", reimbursement_status: "not_required" };
    const [f, setF] = useState({ ...init, amount: String(init.amount || "") });
    const [saving, setSaving] = useState(false);
    const expenseAccounts = accounts.filter((a) => a.type === "Expense");
    const hasWarnings = ai && (ai.confidence < 0.7 || ai.warnings?.length > 0);
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{existing ? "Edit" : "New"} Expense</h3>
          <button onClick={() => { setModal(null); setEditItem(null); setAiData(null); }} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
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
        <div style={{ marginBottom: 12 }}><label style={s.label}>Description</label><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Office supplies from Officeworks" style={s.input} /></div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Category</label><select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} style={s.select}><option value="">Select...</option>{expenseAccounts.map((a) => <option key={a.code} value={a.name}>{a.name}</option>)}</select></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Contact</label><select value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} style={s.select}><option value="">None</option>{f.contact && !contacts.find(c => c.name === f.contact) && <option value={f.contact}>{f.contact}</option>}{contacts.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Reference</label><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="Receipt #, PO number, etc." style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Job</label><select value={f.job} onChange={(e) => setF({ ...f, job: e.target.value })} style={s.select}><option value="">Select job...</option>{jobNames.map(j => <option key={j} value={j}>{j}</option>)}</select></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>GST Amount</label><input type="number" step="0.01" value={f.gst_amount} onChange={(e) => setF({ ...f, gst_amount: e.target.value })} placeholder="0.00" style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>GST Treatment</label><select value={f.gst_treatment} onChange={(e) => setF({ ...f, gst_treatment: e.target.value })} style={s.select}>{GST_TREATMENTS.map(g => <option key={g} value={g}>{g}</option>)}</select></div>
        </div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Payment Source</label><select value={f.payment_source} onChange={(e) => { const v = e.target.value; const clear = v !== "personal_reimburse" && v !== "personal_no_reimburse"; setF({ ...f, payment_source: v, ...(clear ? { paid_by: "", business_purpose: "" } : {}) }); }} style={s.select}>{PAYMENT_SOURCES.map(ps => <option key={ps.value} value={ps.value}>{ps.label}</option>)}</select></div>
        {(f.payment_source === "personal_reimburse" || f.payment_source === "personal_no_reimburse") && (
          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Personal Payment Details</div>
            <div style={{ marginBottom: 12 }}><label style={s.label}>Paid By</label><input value={f.paid_by} onChange={(e) => setF({ ...f, paid_by: e.target.value })} placeholder="Michel" style={s.input} /></div>
            <div style={{ marginBottom: 12 }}><label style={s.label}>Business Purpose</label><input value={f.business_purpose} onChange={(e) => setF({ ...f, business_purpose: e.target.value })} placeholder="Why was this purchased?" style={s.input} /></div>
          </div>
        )}
        <button disabled={!f.description || !f.amount || saving} onClick={async () => { setSaving(true); existing ? await updateTransaction(existing.id, f) : await addTransaction(f); setSaving(false); }} style={{ ...s.btn(accent), opacity: !f.description || !f.amount || saving ? 0.4 : 1, width: "100%", justifyContent: "center" }}>{saving ? "Saving…" : existing ? "Save Changes" : "Add Expense"}</button>
        {existing && existing.receipt_path && (
          <button onClick={() => openReceipt(existing)} style={{ ...s.btnOutline, width: "100%", justifyContent: "center", marginTop: 8, color: "#8b5cf6", borderColor: "#8b5cf640", gap: 6 }}>
            <Icons.Camera /> View Receipt
          </button>
        )}
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
        <button disabled={!f.name || saving} onClick={async () => { setSaving(true); existing ? await updateContact(existing.id, f) : await addContact(f); setSaving(false); }} style={{ ...s.btn(accent), opacity: !f.name || saving ? 0.4 : 1, width: "100%", justifyContent: "center" }}>{saving ? "Saving…" : existing ? "Save Changes" : "Add Contact"}</button>
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
    const init = existing || { number: getNextDocumentNumber(invoices, profile, defaultType), type: defaultType, date: today(), due_date: getDefaultDueDate(defaultType, today()), contact_name: "", contact_email: "", contact_company: "", contact_abn: "", contact_address: "", contact_phone: "", job: "", items: [{ description: "", note: "", qty: 1, rate: "" }], notes: getDefaultTerms(defaultType), status: "draft" };
    const [f, setF] = useState(init);
    const [dueDateEdited, setDueDateEdited] = useState(!!existing);
    const [notesEdited, setNotesEdited] = useState(!!existing);
    const updateType = (newType) => {
      const autoNum = !existing && !f._numberEdited;
      const updates = { ...f, type: newType, number: autoNum ? getNextDocumentNumber(invoices, profile, newType) : f.number };
      if (!dueDateEdited) updates.due_date = getDefaultDueDate(newType, f.date);
      if (!notesEdited) updates.notes = getDefaultTerms(newType);
      setF(updates);
    };
    const updateDate = (newDate) => {
      const updates = { ...f, date: newDate };
      if (!dueDateEdited) updates.due_date = getDefaultDueDate(f.type, newDate);
      setF(updates);
    };
    const [quickAdd, setQuickAdd] = useState(false);
    const [qa, setQa] = useState({ name: "", email: "", company: "", phone: "", abn: "", address: "" });
    const [jobDropOpen, setJobDropOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const updateItem = (idx, field, val) => { const items = [...f.items]; items[idx] = { ...items[idx], [field]: val }; setF({ ...f, items }); };
    const addItem = () => setF({ ...f, items: [...f.items, { description: "", note: "", qty: 1, rate: "" }] });
    const removeItem = (idx) => setF({ ...f, items: f.items.filter((_, i) => i !== idx) });
    const total = f.items.reduce((sum, i) => sum + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
    const selectedContact = contacts.find((c) => c.name === f.contact_name);
    const sortedJobs = [...jobs].sort((a, b) => { const aMatch = selectedContact && a.contact_id === selectedContact.id ? 0 : 1; const bMatch = selectedContact && b.contact_id === selectedContact.id ? 0 : 1; return aMatch - bMatch || new Date(b.last_used_at) - new Date(a.last_used_at); });
    const saveInv = async () => { const inv = { ...f, total }; if (existing) { await updateInvoice(existing.id, inv); } else { await addInvoice(inv); } upsertJob(inv.job, inv.contact_name); };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{existing ? "Edit" : "New"} {f.type === "quote" ? "Quote" : "Invoice"}</h3>
          <button onClick={() => { setModal(null); setEditItem(null); }} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Type</label><select value={f.type} onChange={(e) => updateType(e.target.value)} style={s.select}><option value="invoice">Invoice</option><option value="quote">Quote</option></select></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Number</label><input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value, _numberEdited: true })} style={s.input} /></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Date</label><input type="date" value={f.date} onChange={(e) => updateDate(e.target.value)} style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>{f.type === "quote" ? "Valid Until" : "Due Date"}</label><input type="date" value={f.due_date || ""} onChange={(e) => { setDueDateEdited(true); setF({ ...f, due_date: e.target.value }); }} style={s.input} /></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}>
            <label style={s.label}>Contact</label>
            <div style={{ display: "flex", gap: 4 }}>
              <select value={f.contact_name || ""} onChange={(e) => { const c = contacts.find(c => c.name === e.target.value); setF({ ...f, contact_name: e.target.value, contact_email: c?.email || "", contact_company: c?.company || "", contact_abn: c?.abn || "", contact_address: c?.address || "", contact_phone: c?.phone || "" }); }} style={{ ...s.select, flex: 1 }}><option value="">Select...</option>{contacts.filter((c) => c.type === "client").map((c) => <option key={c.id}>{c.name}</option>)}</select>
              <button type="button" onClick={() => setQuickAdd(qa => !qa)} style={{ background: accent, border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "0 10px", fontSize: 16, fontWeight: 700, lineHeight: 1 }} title="Quick add contact">+</button>
            </div>
          </div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Status</label><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={s.select}><option value="draft">Draft</option><option value="sent">Sent</option><option value="paid">Paid</option><option value="overdue">Overdue</option></select></div>
        </div>
        {quickAdd && (
          <div style={{ background: "#f1f5f9", borderRadius: 8, padding: 12, marginBottom: 12, border: `1px solid ${accent}30` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: accent, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.06em" }}>Quick Add Client</div>
            <div style={s.grid2}>
              <div style={{ marginBottom: 8 }}><input value={qa.name} onChange={(e) => setQa({ ...qa, name: e.target.value })} placeholder="Name *" style={{ ...s.input, fontSize: 12 }} /></div>
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
              <button disabled={!qa.name} onClick={async () => { const inserted = await addContact({ ...qa, type: "client", notes: "" }, true); if (inserted) setF({ ...f, contact_name: inserted.name, contact_email: inserted.email || "", contact_company: inserted.company || "", contact_abn: inserted.abn || "", contact_address: inserted.address || "", contact_phone: inserted.phone || "" }); setQa({ name: "", email: "", company: "", phone: "", abn: "", address: "" }); setQuickAdd(false); }} style={{ ...s.btn(accent), fontSize: 12, opacity: !qa.name ? 0.4 : 1 }}>Add & Select</button>
              <button onClick={() => { setQuickAdd(false); setQa({ name: "", email: "", company: "", phone: "", abn: "", address: "" }); }} style={{ ...s.btnOutline, fontSize: 12 }}>Cancel</button>
            </div>
          </div>
        )}
        <div style={{ marginBottom: 12, position: "relative" }}>
          <label style={s.label}>Job / Project</label>
          <div style={{ position: "relative" }}>
            <input value={f.job || ""} onChange={(e) => { setF({ ...f, job: e.target.value }); setJobDropOpen(true); }} onFocus={() => setJobDropOpen(true)} onBlur={() => setTimeout(() => setJobDropOpen(false), 150)} placeholder="e.g. 5 Midleton Ave Bexley North" style={s.input} />
            <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "#94a3b8", fontSize: 10 }}>&#9660;</span>
          </div>
          {jobDropOpen && sortedJobs.filter(j => !f.job || j.name.toLowerCase().includes((f.job || "").toLowerCase())).length > 0 && (
            <div style={{ position: "absolute", left: 0, right: 0, top: "100%", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", zIndex: 60, maxHeight: 160, overflow: "auto" }}>
              {sortedJobs.filter(j => !f.job || j.name.toLowerCase().includes((f.job || "").toLowerCase())).map(j => (
                <div key={j.id} onMouseDown={() => { setF({ ...f, job: j.name }); setJobDropOpen(false); }} style={{ padding: "10px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid #f1f5f9" }}>{j.name}</div>
              ))}
            </div>
          )}
        </div>
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <label style={s.label}>Line Items</label>
          {f.items.map((item, idx) => (
            <div key={idx} style={{ marginBottom: 8, padding: 10, background: "#f7f9f8", borderRadius: 6 }}>
              <div style={{ display: "grid", gridTemplateColumns: "2fr 50px 80px 24px", gap: 6, alignItems: "center" }}>
                <input value={item.description} onChange={(e) => updateItem(idx, "description", e.target.value)} placeholder="Description" style={{ ...s.input, fontSize: 12 }} />
                <input type="number" value={item.qty} onChange={(e) => updateItem(idx, "qty", e.target.value)} placeholder="Qty" style={{ ...s.input, fontSize: 12 }} />
                <input type="number" step="0.01" value={item.rate} onChange={(e) => updateItem(idx, "rate", e.target.value)} placeholder="Rate" style={{ ...s.input, fontSize: 12 }} />
                {f.items.length > 1 && <button onClick={() => removeItem(idx)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: 0 }}><Icons.Trash /></button>}
              </div>
              <input value={item.note || ""} onChange={(e) => updateItem(idx, "note", e.target.value)} placeholder="Note (optional — shown on PDF)" style={{ ...s.input, fontSize: 11, marginTop: 4, color: "#94a3b8" }} />
            </div>
          ))}
          <button onClick={addItem} style={{ ...s.btnOutline, marginTop: 4 }}>+ Add Line</button>
        </div>
        <div style={{ marginTop: 12, marginBottom: 16, background: "#f1f5f9", borderRadius: 8, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, color: "#0f172a" }}><span>Total</span><span>{fmt(total)}</span></div>
        </div>
        <div style={{ marginBottom: 16 }}><label style={s.label}>Notes / Payment Terms</label><textarea value={f.notes} onChange={(e) => { setNotesEdited(true); setF({ ...f, notes: e.target.value }); }} placeholder="Payment terms, notes, etc." style={{ ...s.input, minHeight: 60, resize: "vertical" }} /></div>
        <button disabled={saving} onClick={async () => { setSaving(true); await saveInv(); setSaving(false); }} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", opacity: saving ? 0.5 : 1 }}>{saving ? "Saving…" : `${existing ? "Update" : "Create"} ${f.type === "quote" ? "Quote" : "Invoice"}`}</button>
        {existing && (<>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={async () => { const inv = { ...f, total }; if (existing) { await updateInvoice(existing.id, inv); } upsertJob(inv.job, inv.contact_name); sendInvoice({ ...existing, ...inv }); }} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#3b82f6", borderColor: "#3b82f640", gap: 6 }}>
              <Icons.Send /> Send via Email
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button onClick={() => downloadPDF(existing)} disabled={pdfLoading === existing.id} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: pdfLoading === existing.id ? "#94a3b8" : "#8b5cf6", borderColor: "#8b5cf640", gap: 6, opacity: pdfLoading === existing.id ? 0.5 : 1 }}>
              <Icons.Download /> {pdfLoading === existing.id ? "Generating…" : "Download PDF"}
            </button>
            {(existing.status === "sent" || existing.status === "overdue") && (
              <button onClick={() => sendReminder(existing)} style={{ ...s.btnOutline, flex: 1, justifyContent: "center", color: "#f59e0b", borderColor: "#f59e0b40", gap: 6 }}>
                ! Send Reminder
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {existing.status !== "paid" && (
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

  const BusinessSettings = () => {
    const [f, setF] = useState({ ...profile });
    const [logoPreview, setLogoPreview] = useState(null);
    const fileRef = useRef(null);

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
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, marginTop: 8, marginBottom: 8 }}>
          <label style={{ ...s.label, marginBottom: 12 }}>Bank Details (shown on invoices)</label>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Bank Name</label><input value={f.bank_name || ""} onChange={(e) => setF({ ...f, bank_name: e.target.value })} placeholder="Commonwealth Bank" style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Account Name</label><input value={f.account_name || ""} onChange={(e) => setF({ ...f, account_name: e.target.value })} placeholder="Mworx Group Pty Ltd" style={s.input} /></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>BSB</label><input value={f.bsb || ""} onChange={(e) => setF({ ...f, bsb: e.target.value })} placeholder="062-000" style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Account Number</label><input value={f.account_number || ""} onChange={(e) => setF({ ...f, account_number: e.target.value })} placeholder="1234 5678" style={s.input} /></div>
        </div>
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, marginTop: 8, marginBottom: 12 }}>
          <label style={{ ...s.label, marginBottom: 12 }}>Email Integration</label>
          {emailConn ? (
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
          )}
        </div>
        <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, marginTop: 8, marginBottom: 12 }}>
          <label style={{ ...s.label, marginBottom: 12 }}>Email Templates</label>
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
        </div>
        <button onClick={() => saveProfile(f)} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", marginTop: 4 }}>Save Settings</button>
      </div>
    );
  };

  const DashboardPage = () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const [yr, mo] = thisMonth.split("-").map(Number);
    const monthTxns = txns.filter((t) => { const d = new Date(t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; });
    const expense = monthTxns.filter((t) => t.type === "expense").reduce((sum, t) => sum + Number(t.amount), 0);
    const outstanding = invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((sum, i) => sum + Number(i.total || 0), 0);
    const overdue = invoices.filter((i) => i.status === "overdue").length;
    const totalExpenses = txns.filter((t) => t.type === "expense").reduce((sum, t) => sum + Number(t.amount), 0);
    const recentExpenses = [...txns].filter((t) => t.type === "expense").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);

    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
          <div style={s.statCard()}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Expenses This Month</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{fmt(expense)}</div>
            <div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{monthTxns.filter((t) => t.type === "expense").length} transactions</div>
          </div>
          <div style={s.statCard()}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Outstanding Invoices</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{fmt(outstanding)}</div>
            <div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{invoices.filter((i) => i.status === "sent" || i.status === "overdue").length} unpaid</div>
          </div>
          <div style={s.statCard()}>
            <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Revenue Collected</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{fmt(invoices.filter((i) => i.status === "paid").reduce((sum, i) => sum + Number(i.total || 0), 0))}</div>
            <div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{invoices.filter((i) => i.status === "paid").length} paid invoice{invoices.filter((i) => i.status === "paid").length !== 1 ? "s" : ""}</div>
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
        {txns.some(t => t.payment_source === "personal" && t.reimbursement_required && t.reimbursement_status === "pending") && (
          <div style={{ ...s.card, cursor: "pointer", borderColor: "#fde68a", background: "#fffef5" }} onClick={() => setPage("reimbursements")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#92400e" }}>Owner Reimbursements</h4>
                <div style={{ fontSize: 12, color: "#92400e", marginTop: 4 }}>{txns.filter(t => t.payment_source === "personal" && t.reimbursement_required && t.reimbursement_status === "pending").length} pending — {fmt(txns.filter(t => t.payment_source === "personal" && t.reimbursement_required && t.reimbursement_status === "pending").reduce((sum, t) => sum + Number(t.amount), 0))}</div>
              </div>
              <span style={{ fontSize: 20, color: "#f59e0b" }}>→</span>
            </div>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginTop: 12 }}>
          <button onClick={() => setModal("receipt")} style={{ ...s.btn("#8b5cf6"), justifyContent: "center", padding: "14px" }}><Icons.Camera /> Snap Receipt</button>
          <button onClick={() => setModal("expense")} style={{ ...s.btn(accent), justifyContent: "center", padding: "14px" }}><Icons.Plus /> Add Expense</button>
          <button onClick={() => setModal("invoice")} style={{ ...s.btn("#3b82f6"), justifyContent: "center", padding: "14px" }}><Icons.Plus /> New Invoice</button>
        </div>
      </div>
    );
  };

  const ExpensesPage = () => {
    const [search, setSearch] = useState("");
    const [jobFilter, setJobFilter] = useState("");
    const sorted = [...txns].filter((t) => t.type === "expense").sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((t) => {
      if (search && !t.description.toLowerCase().includes(search.toLowerCase()) && !(t.account || "").toLowerCase().includes(search.toLowerCase())) return false;
      if (jobFilter && t.job !== jobFilter) return false;
      return true;
    });

    const paymentBadge = (t) => {
      if (t.payment_source !== "personal") return null;
      if (t.reimbursement_status === "reimbursed") return <span style={s.badge("#34d399")}>Reimbursed</span>;
      if (t.reimbursement_status === "pending") return <span style={s.badge("#f59e0b")}>Pending</span>;
      if (t.reimbursement_status === "do_not_reimburse") return <span style={s.badge("#64748b")}>Personal</span>;
      return <span style={s.badge("#64748b")}>Personal</span>;
    };

    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search expenses..." style={{ ...s.input, maxWidth: 220, flex: "1 1 160px" }} />
          <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} style={{ ...s.select, maxWidth: 180, flex: "0 1 160px" }}>
            <option value="">All Jobs</option>
            {jobNames.map(j => <option key={j} value={j}>{j}</option>)}
          </select>
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? (
            <div style={{ color: "#94a3b8", padding: "30px 0", textAlign: "center" }}>No expenses found</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Date</th><th style={s.th}>Description</th><th style={s.th}>Category</th><th style={s.th}>Job</th><th style={s.th}>Payment</th><th style={{ ...s.th, textAlign: "right" }}>Amount</th><th style={{ ...s.th, width: 60 }}></th></tr></thead>
                <tbody>{filtered.map((t) => (
                  <tr key={t.id} onClick={() => { setEditItem(t); setModal("expense"); }} style={{ cursor: "pointer" }}>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(t.date)}</td>
                    <td style={{ ...s.td, fontWeight: 500 }}>{t.description}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{t.account || "--"}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{t.job || ""}</td>
                    <td style={s.td}>{paymentBadge(t)}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(t.amount)}</td>
                    <td style={{ ...s.td, display: "flex", gap: 4 }}>
                      {t.receipt_path && <button onClick={(e) => { e.stopPropagation(); openReceipt(t); }} title="View receipt" style={{ background: "none", border: "none", color: "#8b5cf6", cursor: "pointer", padding: 2 }}><Icons.Camera /></button>}
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

  const InvoicesPage = () => {
    const [filter, setFilter] = useState("all");
    const [jobFilter, setJobFilter] = useState("");
    const [search, setSearch] = useState("");
    const sorted = [...invoices].sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((i) => {
      if (filter !== "all" && i.status !== filter) return false;
      if (jobFilter && i.job !== jobFilter) return false;
      if (search && !(i.number || "").toLowerCase().includes(search.toLowerCase()) && !(i.contact_name || "").toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    const statusColors = { draft: "#64748b", sent: "#3b82f6", paid: "#34d399", overdue: "#ef4444" };
    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {["all", "draft", "sent", "paid", "overdue"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...s.btnOutline, background: filter === f ? accent + "20" : "transparent", color: filter === f ? accent : "#64748b", borderColor: filter === f ? accent : "#e2e8f0" }}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
          ))}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search invoices..." style={{ ...s.input, maxWidth: 180, flex: "1 1 140px", marginLeft: "auto" }} />
          <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} style={{ ...s.select, maxWidth: 180 }}>
            <option value="">All Jobs</option>
            {jobNames.map(j => <option key={j} value={j}>{j}</option>)}
          </select>
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? (
            <div style={{ color: "#94a3b8", padding: "30px 0", textAlign: "center" }}>No invoices yet</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Number</th><th style={s.th}>Date</th><th style={s.th}>Contact</th><th style={s.th}>Job</th><th style={s.th}>Status</th><th style={{ ...s.th, textAlign: "right" }}>Total</th><th style={{ ...s.th, width: 100 }}></th></tr></thead>
                <tbody>{filtered.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{inv.number}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{fmtDate(inv.date)}</td>
                    <td style={s.td}>{inv.contact_name || "--"}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{inv.job || ""}</td>
                    <td style={s.td}><span style={s.badge(statusColors[inv.status] || "#64748b")}>{inv.status}</span></td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmt(inv.total || 0)}</td>
                    <td style={{ ...s.td, display: "flex", gap: 4 }}>
                      <button onClick={() => sendInvoice(inv)} title="Send via Email" style={{ background: "none", border: "none", color: "#3b82f6", cursor: "pointer", padding: 2 }}><Icons.Send /></button>
                      {(inv.status === "sent" || inv.status === "overdue") && <button onClick={() => sendReminder(inv)} title="Send Reminder" style={{ background: "none", border: "none", color: "#f59e0b", cursor: "pointer", padding: 2, fontSize: 13 }}>!</button>}
                      <button onClick={() => downloadPDF(inv)} title="Download PDF" disabled={pdfLoading === inv.id} style={{ background: "none", border: "none", color: pdfLoading === inv.id ? "#94a3b8" : "#8b5cf6", cursor: pdfLoading === inv.id ? "wait" : "pointer", padding: 2, opacity: pdfLoading === inv.id ? 0.5 : 1 }}>{pdfLoading === inv.id ? "…" : <Icons.Download />}</button>
                      <button onClick={() => { setEditItem(inv); setModal("invoice"); }} title="Edit" style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 2 }}><Icons.Edit /></button>
                      {inv.status !== "paid" && <button onClick={() => markPaid(inv)} title="Mark Paid" style={{ background: "none", border: "none", color: "#34d399", cursor: "pointer", padding: 2 }}><Icons.Check /></button>}
                      <button onClick={() => deleteInvoice(inv.id)} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", padding: 2 }}><Icons.Trash /></button>
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

  const ContactsPage = () => {
    const [filter, setFilter] = useState("all");
    const filtered = contacts.filter((c) => filter === "all" || c.type === filter);
    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          {["all", "client", "supplier"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...s.btnOutline, background: filter === f ? accent + "20" : "transparent", color: filter === f ? accent : "#64748b", borderColor: filter === f ? accent : "#e2e8f0" }}>{f.charAt(0).toUpperCase() + f.slice(1)}s</button>
          ))}
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? <div style={{ color: "#94a3b8", padding: "30px 0", textAlign: "center" }}>No contacts yet</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Name</th><th style={s.th}>Company</th><th style={s.th}>Email</th><th style={s.th}>Type</th><th style={{ ...s.th, width: 70 }}></th></tr></thead>
                <tbody>{filtered.map((c) => (
                  <tr key={c.id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{c.name}</td>
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
      const lines = pending.map((t) => `- ${fmtDate(t.date)} | ${t.description} | ${t.account || "-"} | ${fmt(t.amount)}${t.gst_amount ? ` (GST: ${fmt(t.gst_amount)})` : ""} | ${t.gst_treatment || "Unsure"} | Paid by ${t.paid_by || "Owner"}${t.business_purpose ? ` | Purpose: ${t.business_purpose}` : ""} | ${t.reimbursement_status} | Ref: ${t.reference || "-"}`);
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
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Pending Reimbursement</div><div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{fmt(pending.reduce((sum, t) => sum + Number(t.amount), 0))}</div><div style={{ fontSize: 12, color: "#92400e", marginTop: 6, fontWeight: 500 }}>{pending.length} expense{pending.length !== 1 ? "s" : ""}</div></div>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Reimbursed This Month</div><div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{fmt(reimbursedThisMonth)}</div><div style={{ fontSize: 12, color: "#065f46", marginTop: 6, fontWeight: 500 }}>{reimbursed.filter((t) => { const d = new Date(t.reimbursement_date || t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; }).length} this month</div></div>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Missing Receipts</div><div style={{ fontSize: 28, fontWeight: 700, color: missingReceipts.length > 0 ? "#ef4444" : "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{missingReceipts.length}</div><div style={{ fontSize: 12, color: "#64748b", marginTop: 6, fontWeight: 500 }}>pending without receipt</div></div>
          <div style={s.statCard()}><div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Oldest Pending</div><div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", marginTop: 8, letterSpacing: "-0.02em" }}>{oldestPending ? `${oldestDays}d` : "—"}</div><div style={{ fontSize: 12, color: "#64748b", marginTop: 6, fontWeight: 500 }}>{oldestPending ? oldestPending.description : "None pending"}</div></div>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {["all", "pending", "reimbursed", "no_receipt", "do_not_reimburse"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...s.btnOutline, background: filter === f ? accent + "20" : "transparent", color: filter === f ? accent : "#64748b", borderColor: filter === f ? accent : "#e2e8f0" }}>{f === "no_receipt" ? "Missing Receipt" : f === "do_not_reimburse" ? "Do Not Reimburse" : f.charAt(0).toUpperCase() + f.slice(1)}</button>
          ))}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." style={{ ...s.input, maxWidth: 180, flex: "1 1 140px", marginLeft: "auto" }} />
          <button onClick={copyAccountantSummary} style={s.btn("#6366f1", true)}><Icons.Download /> Copy for Accountant</button>
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? (
            <div style={{ color: "#94a3b8", padding: "30px 0", textAlign: "center" }}>No reimbursements found</div>
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
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>{fmt(t.amount)}{t.gst_amount ? <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 400 }}>GST: {fmt(t.gst_amount)}</div> : null}</td>
                    <td style={s.td}>{t.receipt_path ? <button onClick={() => openReceipt(t)} style={{ background: "none", border: "none", color: "#8b5cf6", cursor: "pointer", padding: 2 }}><Icons.Camera /></button> : <span style={{ fontSize: 10, color: "#ef4444" }}>Missing</span>}</td>
                    <td style={s.td}><span style={s.badge(t.reimbursement_status === "reimbursed" ? "#34d399" : t.reimbursement_status === "pending" ? "#f59e0b" : "#64748b")}>{t.reimbursement_status === "reimbursed" ? "Reimbursed" : t.reimbursement_status === "pending" ? "Pending" : t.reimbursement_status === "missing_receipt" ? "No Receipt" : "Skipped"}</span>{t.reimbursement_status === "reimbursed" && t.reimbursement_date ? <div style={{ fontSize: 10, color: "#94a3b8" }}>{fmtDate(t.reimbursement_date)}</div> : null}{t.reimbursement_reference ? <div style={{ fontSize: 10, color: "#94a3b8" }}>Ref: {t.reimbursement_reference}</div> : null}</td>
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
    <div style={{ display: "flex", justifyContent: "space-around", alignItems: "center", padding: "8px 0 28px", borderTop: "0.5px solid #e2e8f0", background: "#ffffff", flexShrink: 0 }}>
      {navItems.filter(n => n.id !== "reimbursements").map(({ id, label, icon: Icon }) => (
        <button key={id} onClick={() => setPage(id)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none", border: "none", cursor: "pointer", padding: "4px 12px" }}>
          <Icon style={{ color: page === id ? accent : "#94a3b8" }} />
          <span style={{ fontSize: 10, fontWeight: 500, color: page === id ? accent : "#94a3b8" }}>{label}</span>
        </button>
      ))}
    </div>
  );

  const MobileHeader = () => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", padding: "52px 20px 12px", background: "#ffffff" }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: accent, textTransform: "uppercase" }}>{bizInfo?.name}</div>
        <div style={{ fontSize: 28, fontWeight: 700, color: "#0f172a", letterSpacing: -0.5, marginTop: 2 }}>{navItems.find((n) => n.id === page)?.label}</div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        {page === "expenses" && (
          <button onClick={() => setModal("receipt")} style={{ width: 34, height: 34, borderRadius: 17, background: "#8b5cf6", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
            <Icons.Camera />
          </button>
        )}
        {page === "reimbursements" && (
          <button onClick={() => { const pend = txns.filter((t) => t.payment_source === "personal" && t.reimbursement_required && t.reimbursement_status === "pending"); const lines = pend.map((t) => `- ${fmtDate(t.date)} | ${t.description} | ${t.account || "-"} | ${fmt(t.amount)}${t.gst_amount ? ` (GST: ${fmt(t.gst_amount)})` : ""} | ${t.gst_treatment || "Unsure"} | Paid by ${t.paid_by || "Owner"}${t.business_purpose ? ` | Purpose: ${t.business_purpose}` : ""}`); navigator.clipboard.writeText(`Pending Reimbursements (${pend.length})\n${lines.join("\n")}`); alert("Copied!"); }} style={{ width: 34, height: 34, borderRadius: 17, background: "#6366f1", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
            <Icons.Download />
          </button>
        )}
        {page !== "dashboard" && page !== "reimbursements" && (
          <button onClick={() => { if (page === "expenses") setModal("expense"); else if (page === "invoices") { setEditItem(null); setModal("invoice"); } else if (page === "contacts") setModal("contact"); }} style={{ width: 34, height: 34, borderRadius: 17, background: accent, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>
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
  );

  const MobileRow = ({ primary, secondary, right, rightSub, badge, isLast, onClick }) => (
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
    const map = { paid: { color: "#34d399", label: "Paid" }, sent: { color: "#3b82f6", label: "Sent" }, draft: { color: "#64748b", label: "Draft" }, overdue: { color: "#ef4444", label: "Overdue" } };
    return map[status] || map.draft;
  };

  const MobileDashboard = () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const [yr, mo] = thisMonth.split("-").map(Number);
    const monthTxns = txns.filter((t) => { const d = new Date(t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; });
    const expense = monthTxns.filter((t) => t.type === "expense").reduce((sum, t) => sum + Number(t.amount), 0);
    const outstanding = invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((sum, i) => sum + Number(i.total || 0), 0);
    const recentExpenses = [...txns].filter((t) => t.type === "expense").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ display: "flex", gap: 10, padding: "8px 16px 0" }}>
          <div style={{ flex: 1, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#94a3b8" }}>This Month</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", marginTop: 4, letterSpacing: -0.3 }}>{fmt(expense)}</div>
            <div style={{ fontSize: 11, color: "#065f46", marginTop: 4, fontWeight: 500 }}>{monthTxns.filter((t) => t.type === "expense").length} expenses</div>
          </div>
          <div style={{ flex: 1, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 14, padding: "14px 16px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "#94a3b8" }}>Outstanding</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", marginTop: 4, letterSpacing: -0.3 }}>{fmt(outstanding)}</div>
            <div style={{ fontSize: 11, color: "#065f46", marginTop: 4, fontWeight: 500 }}>{invoices.filter((i) => i.status === "sent" || i.status === "overdue").length} invoices</div>
          </div>
        </div>
        <MobileSection title="Recent Expenses" onViewAll={() => setPage("expenses")}>
          {recentExpenses.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No expenses yet</div> : recentExpenses.map((e, i) => (
            <MobileRow key={e.id} primary={e.description} secondary={fmtDate(e.date)} right={fmt(e.amount)} isLast={i === recentExpenses.length - 1} onClick={() => { setEditItem(e); setModal("expense"); }} />
          ))}
        </MobileSection>
        <MobileSection title="Recent Invoices" onViewAll={() => setPage("invoices")}>
          {invoices.length === 0 ? <div style={{ padding: 24, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No invoices yet</div> : invoices.slice(0, 3).map((inv, i) => (
            <MobileRow key={inv.id} primary={`${inv.number} — ${inv.contact_name || ""}`} secondary={inv.job || ""} badge={statusBadge(inv.status)} right={fmt(inv.total || 0)} isLast={i === Math.min(2, invoices.length - 1)} onClick={() => { setEditItem(inv); setModal("invoice"); }} />
          ))}
        </MobileSection>
        {txns.some(t => t.payment_source === "personal" && t.reimbursement_required && t.reimbursement_status === "pending") && (
          <div style={{ margin: "12px 16px 0", background: "#fffef5", border: "1px solid #fde68a", borderRadius: 14, padding: "14px 16px", cursor: "pointer" }} onClick={() => setPage("reimbursements")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>Owner Reimbursements</div>
                <div style={{ fontSize: 12, color: "#b45309", marginTop: 2 }}>{txns.filter(t => t.payment_source === "personal" && t.reimbursement_required && t.reimbursement_status === "pending").length} pending</div>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#92400e" }}>{fmt(txns.filter(t => t.payment_source === "personal" && t.reimbursement_required && t.reimbursement_status === "pending").reduce((sum, t) => sum + Number(t.amount), 0))}</div>
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
    const sorted = [...txns].filter((t) => t.type === "expense").sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((t) => !search || t.description.toLowerCase().includes(search.toLowerCase()));
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ padding: "8px 16px 12px" }}>
          <div style={{ position: "relative" }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search expenses..." style={{ width: "100%", padding: "10px 12px 10px 36px", fontSize: 15, border: "1px solid #e2e8f0", borderRadius: 12, background: "#ffffff", color: "#0f172a", outline: "none", boxSizing: "border-box" }} />
            <div style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "#94a3b8" }}><Icons.Expenses /></div>
          </div>
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {filtered.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No expenses found</div> : filtered.map((e, i) => (
            <MobileRow key={e.id} primary={e.description} secondary={`${fmtDate(e.date)} · ${e.account || ""}${e.payment_source === "personal" ? " · " + (e.reimbursement_status === "reimbursed" ? "Reimbursed" : e.reimbursement_status === "pending" ? "Pending reimburse" : "Paid personally") : ""}`} badge={e.payment_source === "personal" && e.reimbursement_required ? { color: e.reimbursement_status === "reimbursed" ? "#34d399" : "#f59e0b", label: e.reimbursement_status === "reimbursed" ? "Reimbursed" : "Pending" } : null} right={fmt(e.amount)} rightSub={e.job || ""} isLast={i === filtered.length - 1} onClick={() => { setEditItem(e); setModal("expense"); }} />
          ))}
        </div>
      </div>
    );
  };

  const MobileInvoices = () => {
    const [tab, setTab] = useState("All");
    const sorted = [...invoices].sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((inv) => tab === "All" || inv.status === tab.toLowerCase());
    return (
      <div style={{ paddingBottom: 20 }}>
        <div style={{ paddingTop: 8, paddingBottom: 12 }}>
          <MobileFilterTabs tabs={["All", "Draft", "Sent", "Paid", "Overdue"]} active={tab} onChange={setTab} />
        </div>
        <div style={{ margin: "0 16px", background: "#ffffff", borderRadius: 14, border: "1px solid #e2e8f0", overflow: "hidden" }}>
          {filtered.length === 0 ? <div style={{ padding: 32, textAlign: "center", color: "#94a3b8", fontSize: 14 }}>No invoices found</div> : filtered.map((inv, i) => (
            <MobileRow key={inv.id} primary={`${inv.number} — ${inv.contact_name || ""}`} secondary={`${fmtDate(inv.date)} · ${inv.job || ""}`} badge={statusBadge(inv.status)} right={fmt(inv.total || 0)} isLast={i === filtered.length - 1} onClick={() => { setEditItem(inv); setModal("invoice"); }} />
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
              <MobileRow primary={e.description} secondary={`${fmtDate(e.date)} · ${e.paid_by || "Owner"} · ${e.business_purpose || ""}`} badge={reimbBadge(e.reimbursement_status)} right={fmt(e.amount)} rightSub={e.gst_amount ? `GST: ${fmt(e.gst_amount)}` : ""} isLast={actionId !== e.id && i === filtered.length - 1} onClick={() => setActionId(actionId === e.id ? null : e.id)} />
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

  const MobileLayout = () => (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#f7f9f8", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <MobileHeader />
      <div style={{ flex: 1, overflow: "auto" }}>
        {page === "dashboard" && <MobileDashboard />}
        {page === "expenses" && <MobileExpenses />}
        {page === "reimbursements" && <MobileReimbursements />}
        {page === "invoices" && <MobileInvoices />}
        {page === "contacts" && <MobileContacts />}
      </div>
      <MobileTabBar />
    </div>
  );

  const pageMap = { dashboard: DashboardPage, expenses: ExpensesPage, reimbursements: ReimbursementsPage, invoices: InvoicesPage, contacts: ContactsPage };
  const PageComponent = pageMap[page] || DashboardPage;

  const SidebarContent = () => (
    <>
      <div style={s.logo}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#0f172a", letterSpacing: "-0.02em" }}>BookKeeper</div>
        <div style={{ fontSize: 10, color: "#10b981", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.08em" }}>{bizInfo?.name}</div>
      </div>
      <div style={s.nav}>
        {navItems.map((item) => (
          <button key={item.id} onClick={() => { setPage(item.id); setSidebarOpen(false); }} style={s.navBtn(page === item.id)}>
            <item.icon /> {item.label}
          </button>
        ))}
      </div>
      <div style={{ padding: 12, borderTop: "1px solid #e2e8f0", display: "flex", gap: 6 }}>
        <button onClick={() => setModal("settings")} style={{ ...s.btnOutline, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11 }}><Icons.Settings /> Settings</button>
        <button onClick={logout} style={{ ...s.btnOutline, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11 }}><Icons.Logout /> Sign Out</button>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <>
        <MobileLayout />
        {modal && (
          <div style={s.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) { setModal(null); setEditItem(null); setAiData(null); } }}>
            <div style={{ ...s.modalContent, maxWidth: "100%", borderRadius: "16px 16px 0 0", position: "fixed", bottom: 0, left: 0, right: 0, maxHeight: "90vh" }}>
              {modal === "expense" && <ExpenseForm existing={editItem} />}
              {modal === "contact" && <ContactForm existing={editItem} />}
              {modal === "invoice" && <InvoiceForm existing={editItem} />}
              {modal === "receipt" && <ReceiptCapture />}
              {modal === "settings" && <BusinessSettings />}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div style={s.app}>
        <div style={s.sidebar}><SidebarContent /></div>
        <div style={s.main}>
          <div style={s.header}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{navItems.find((n) => n.id === page)?.label}</div>
                <div style={{ fontSize: 10, color: "#10b981", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600 }}>{bizInfo?.name}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={() => setModal("receipt")} style={s.btn("#8b5cf6", true)}><Icons.Camera /> Receipt</button>
              {(page === "expenses" || page === "dashboard" || page === "reimbursements") && <button onClick={() => setModal("expense")} style={s.btn(accent, true)}><Icons.Plus /> Expense</button>}
              {page === "invoices" && <button onClick={() => { setEditItem(null); setModal("invoice"); }} style={s.btn(accent, true)}><Icons.Plus /> Invoice</button>}
              {page === "contacts" && <button onClick={() => setModal("contact")} style={s.btn(accent, true)}><Icons.Plus /> Contact</button>}
            </div>
          </div>
          <div style={s.content}><PageComponent /></div>
        </div>
        {modal && (
          <div style={s.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) { setModal(null); setEditItem(null); setAiData(null); } }}>
            <div style={s.modalContent}>
              {modal === "expense" && <ExpenseForm existing={editItem} />}
              {modal === "contact" && <ContactForm existing={editItem} />}
              {modal === "invoice" && <InvoiceForm existing={editItem} />}
              {modal === "receipt" && <ReceiptCapture />}
              {modal === "settings" && <BusinessSettings />}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
