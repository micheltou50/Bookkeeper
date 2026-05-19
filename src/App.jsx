import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "./supabaseClient";
import html2pdf from "html2pdf.js";

const DEFAULT_ACCOUNTS = [
  { code: "4000", name: "Sales Revenue", type: "Revenue" },
  { code: "4200", name: "Service Revenue", type: "Revenue" },
  { code: "4300", name: "Other Income", type: "Revenue" },
  { code: "5000", name: "Cost of Sales", type: "Expense" },
  { code: "6000", name: "Advertising & Marketing", type: "Expense" },
  { code: "6100", name: "Bank Fees & Charges", type: "Expense" },
  { code: "6200", name: "Cleaning", type: "Expense" },
  { code: "6300", name: "Insurance", type: "Expense" },
  { code: "6400", name: "Office Supplies", type: "Expense" },
  { code: "6500", name: "Professional Fees", type: "Expense" },
  { code: "6600", name: "Rent & Lease", type: "Expense" },
  { code: "6700", name: "Repairs & Maintenance", type: "Expense" },
  { code: "6800", name: "Telephone & Internet", type: "Expense" },
  { code: "6900", name: "Travel & Transport", type: "Expense" },
  { code: "7000", name: "Utilities", type: "Expense" },
  { code: "7100", name: "Depreciation", type: "Expense" },
  { code: "7200", name: "Motor Vehicle", type: "Expense" },
  { code: "7300", name: "Subscriptions & Software", type: "Expense" },
  { code: "7400", name: "Linen & Amenities", type: "Expense" },
  { code: "7500", name: "Platform Commissions", type: "Expense" },
];

const DEFAULT_PROFILE = { name: "", abn: "", address: "", email: "", phone: "", bank_name: "", bsb: "", account_number: "", logo_url: "" };

const BUSINESSES = [
  { id: "mt", name: "MT Management", accent: "#0d9488" },
  { id: "mworx", name: "Mworx Group", accent: "#b45309" },
];

const fmt = (n) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
const fmtDate = (d) => new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
const today = () => new Date().toISOString().split("T")[0];

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

  const inputStyle = { width: "100%", padding: "12px 16px", background: "#0f1117", border: "1px solid #2a2d3e", borderRadius: 8, color: "#e2e8f0", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 12 };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#0f1117", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", padding: 20 }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ background: "#161822", borderRadius: 16, border: "1px solid #1e2130", padding: 40, width: "100%", maxWidth: 400, textAlign: "center" }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: "#f1f5f9", letterSpacing: "-0.03em", marginBottom: 4 }}>BookKeeper</div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 32, textTransform: "uppercase", letterSpacing: "0.08em" }}>MT Management</div>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" style={inputStyle} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" onKeyDown={(e) => e.key === "Enter" && email && password && handleSubmit()} style={inputStyle} />
        {error && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>{error}</div>}
        <button disabled={!email || !password || loading} onClick={handleSubmit} style={{ width: "100%", padding: "12px", background: "#0d9488", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: !email || !password || loading ? 0.5 : 1, marginBottom: 12 }}>
          {loading ? "..." : isSignUp ? "Sign Up" : "Sign In"}
        </button>
        <button onClick={() => { setIsSignUp(!isSignUp); setError(""); }} style={{ background: "none", border: "none", color: "#64748b", fontSize: 12, cursor: "pointer" }}>
          {isSignUp ? "Already have an account? Sign In" : "Need an account? Sign Up"}
        </button>
      </div>
    </div>
  );
}

function buildInvoiceHTML(inv, profile, accent) {
  const items = (inv.items || []).map((item) => {
    const amount = (Number(item.qty) || 0) * (Number(item.rate) || 0);
    return `<div style="padding:14px 0;border-bottom:1px dashed #e2e8f0;display:flex;justify-content:space-between;align-items:flex-start">
      <div><div style="font-size:13px;font-weight:600;color:#1e293b;margin-bottom:1px">${item.description || ""}</div>${item.note ? `<div style="font-size:11px;color:#94a3b8">${item.note}</div>` : ""}</div>
      <div style="font-size:13px;font-weight:500;color:#1e293b;white-space:nowrap;padding-left:20px">${fmt(amount)}</div>
    </div>`;
  }).join("");

  const subtotal = (inv.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
  const docType = inv.type === "quote" ? "Quote" : "Invoice";
  const logoHTML = profile.logo_url
    ? `<img src="${profile.logo_url}" style="height:56px;border-radius:6px" crossorigin="anonymous" />`
    : `<div style="background:#1a1a2e;color:#fff;padding:12px 24px;border-radius:6px;font-size:18px;font-weight:800">${profile.name || "Company"}</div>`;

  const bankHTML = (profile.bsb || profile.account_number) ? `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-bottom:16px">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:${accent};margin-bottom:8px">Payment Details</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px 28px;font-size:11px;color:#64748b">
        ${profile.bank_name ? `<div>Account Name: <span style="color:#1e293b;font-weight:600">${profile.bank_name}</span></div>` : ""}
        ${profile.bsb ? `<div>BSB: <span style="color:#1e293b;font-weight:600">${profile.bsb}</span></div>` : ""}
        ${profile.account_number ? `<div>Account Number: <span style="color:#1e293b;font-weight:600">${profile.account_number}</span></div>` : ""}
        <div>Reference: <span style="color:#1e293b;font-weight:600">${inv.number || ""}</span></div>
      </div>
    </div>` : "";

  return `<div style="width:595px;min-height:842px;background:#fff;padding:48px;font-family:Helvetica Neue,Arial,sans-serif;position:relative">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>${logoHTML}</div>
      <div style="text-align:right;font-size:11px;color:#64748b;line-height:1.7">
        ${profile.abn ? `ABN ${profile.abn}<br>` : ""}${profile.address ? `${profile.address}<br>` : ""}${profile.email ? `${profile.email}<br>` : ""}${profile.phone || ""}
      </div>
    </div>
    <div style="height:3px;background:${accent};margin:22px 0 36px"></div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:28px">
      <div style="font-size:34px;font-weight:300;color:#d1d5db;letter-spacing:0.1em;text-transform:uppercase">${docType}</div>
      <div style="font-size:17px;font-weight:700;color:#1e293b">${inv.number || ""}</div>
    </div>
    <div style="display:flex;gap:44px;margin-bottom:36px">
      <div><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin-bottom:3px">Issued</div><div style="font-size:12px;color:#1e293b">${inv.date ? fmtDate(inv.date) : ""}</div></div>
      ${inv.due_date ? `<div><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin-bottom:3px">Due</div><div style="font-size:12px;color:#1e293b">${fmtDate(inv.due_date)}</div></div>` : ""}
      <div><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin-bottom:3px">Bill To</div><div style="font-size:12px;color:#1e293b;line-height:1.5"><strong>${inv.contact_name || ""}</strong>${inv.contact_company ? `<br><span style="color:#64748b;font-size:11px">${inv.contact_company}</span>` : ""}${inv.contact_abn ? `<br><span style="color:#64748b;font-size:10px">ABN ${inv.contact_abn}</span>` : ""}${inv.contact_address ? `<br><span style="color:#64748b;font-size:10px">${inv.contact_address}</span>` : ""}${inv.contact_email ? `<br><span style="color:#64748b;font-size:10px">${inv.contact_email}</span>` : ""}${inv.contact_phone ? `<br><span style="color:#64748b;font-size:10px">${inv.contact_phone}</span>` : ""}</div></div>
      ${inv.job ? `<div><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin-bottom:3px">Job</div><div style="font-size:12px;color:#1e293b">${inv.job}</div></div>` : ""}
    </div>
    <div style="border-top:1px dashed #e2e8f0;margin-bottom:28px">${items}</div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:36px">
      <div style="width:220px">
        <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:12px;color:#64748b"><span>Subtotal</span><span>${fmt(subtotal)}</span></div>
        <div style="display:flex;justify-content:space-between;padding-top:10px;margin-top:4px"><span style="font-size:15px;font-weight:700;color:#1e293b">Total AUD</span><span style="font-size:17px;font-weight:800;color:${accent}">${fmt(subtotal)}</span></div>
        <div style="font-size:9px;color:#94a3b8;text-align:right;margin-top:6px">Not registered for GST</div>
      </div>
    </div>
    ${bankHTML}
    ${inv.notes ? `<div style="font-size:10px;color:#94a3b8;line-height:1.6">${inv.notes}</div>` : ""}
    <div style="position:absolute;bottom:24px;left:48px;right:48px;text-align:center;font-size:9px;color:#cbd5e1;border-top:1px solid #f1f5f9;padding-top:10px">
      ${profile.name || ""}${profile.abn ? ` &middot; ABN ${profile.abn}` : ""}${profile.email ? ` &middot; ${profile.email}` : ""}${profile.phone ? ` &middot; ${profile.phone}` : ""}
    </div>
  </div>`;
}

export default function BookkeeperApp() {
  const [session, setSession] = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [editItem, setEditItem] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const [biz, setBiz] = useState(() => localStorage.getItem("bk_activeBusiness") || "mt");
  const [contacts, setContacts] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [txns, setTxns] = useState([]);
  const [profile, setProfile] = useState({ ...DEFAULT_PROFILE });

  const bizInfo = BUSINESSES.find((b) => b.id === biz);
  const accent = bizInfo?.accent || "#0d9488";
  const accounts = DEFAULT_ACCOUNTS;

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => setSession(session));
    return () => subscription.unsubscribe();
  }, []);

  const loadData = useCallback(async (businessId) => {
    if (!session) return;
    setLoading(true);
    const [cRes, iRes, tRes, pRes] = await Promise.all([
      supabase.from("bk_contacts").select("*").eq("business_id", businessId).order("name"),
      supabase.from("bk_invoices").select("*").eq("business_id", businessId).order("date", { ascending: false }),
      supabase.from("bk_transactions").select("*").eq("business_id", businessId).order("date", { ascending: false }),
      supabase.from("bk_profiles").select("*").eq("business_id", businessId).maybeSingle(),
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
    setProfile(pRes.data || { ...DEFAULT_PROFILE, name: bizInfo?.name || "" });
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
    setProfile({ ...DEFAULT_PROFILE });
  };

  const jobNames = [...new Set([...invoices.map((i) => i.job), ...txns.map((t) => t.job)].filter(Boolean))].sort();

  // --- Mutation functions: each writes directly to its table ---

  const addTransaction = async (t) => {
    const row = { user_id: session.user.id, business_id: biz, date: t.date, type: t.type, description: t.description, amount: Number(t.amount) || 0, account: t.account, contact: t.contact, reference: t.reference, receipt_path: t.receipt_path || t.receiptPath || "", job: t.job };
    const { data: inserted } = await supabase.from("bk_transactions").insert(row).select().single();
    if (inserted) setTxns((prev) => [inserted, ...prev]);
    setModal(null);
  };

  const deleteTransaction = async (id) => {
    await supabase.from("bk_transactions").delete().eq("id", id);
    setTxns((prev) => prev.filter((t) => t.id !== id));
  };

  const addContact = async (c, keepModal) => {
    const row = { user_id: session.user.id, business_id: biz, name: c.name, email: c.email, phone: c.phone, type: c.type, company: c.company, abn: c.abn, address: c.address, notes: c.notes };
    const { data: inserted } = await supabase.from("bk_contacts").insert(row).select().single();
    if (inserted) setContacts((prev) => [...prev, inserted].sort((a, b) => a.name.localeCompare(b.name)));
    if (!keepModal) setModal(null);
    return inserted;
  };

  const deleteContact = async (id) => {
    await supabase.from("bk_contacts").delete().eq("id", id);
    setContacts((prev) => prev.filter((c) => c.id !== id));
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
    await supabase.from("bk_invoices").delete().eq("id", id);
    setInvoices((prev) => prev.filter((i) => i.id !== id));
  };

  const saveProfile = async (p) => {
    const row = { user_id: session.user.id, business_id: biz, name: p.name, abn: p.abn, address: p.address, email: p.email, phone: p.phone, bank_name: p.bank_name, bsb: p.bsb, account_number: p.account_number, logo_url: p.logo_url };
    const { data: saved } = await supabase.from("bk_profiles").upsert(row, { onConflict: "user_id,business_id" }).select().single();
    if (saved) setProfile(saved);
    setModal(null);
  };

  const downloadPDF = (inv) => {
    const html = buildInvoiceHTML(inv, profile, accent);
    const el = document.createElement("div");
    el.innerHTML = html;
    document.body.appendChild(el);
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    html2pdf().set({ margin: 0, filename: `${docType}-${inv.number || "draft"}.pdf`, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: "mm", format: "a4" } }).from(el.firstChild).save().then(() => document.body.removeChild(el));
  };

  const sendInvoice = (inv) => {
    downloadPDF(inv);
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    const bName = profile.name || "our company";
    const subject = `${docType} ${inv.number} from ${bName}`;
    const body = `Hi ${inv.contact_name || ""},\n\nPlease find attached ${docType.toLowerCase()} ${inv.number} for ${fmt(inv.total || 0)}.\n\n${inv.due_date ? `Payment is due by ${fmtDate(inv.due_date)}.\n\n` : ""}${profile.bsb ? `Bank details:\nAccount: ${profile.bank_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}\n\n` : ""}Kind regards,\n${bName}`;
    window.open(`mailto:${inv.contact_email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    if (inv.status === "draft") updateInvoice(inv.id, { status: "sent" });
  };

  const sendReminder = (inv) => {
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    const bName = profile.name || "our company";
    const subject = `Reminder: ${docType} ${inv.number} from ${bName}`;
    const overdueDays = inv.due_date ? Math.max(0, Math.floor((Date.now() - new Date(inv.due_date)) / 86400000)) : 0;
    const body = `Hi ${inv.contact_name || ""},\n\nThis is a friendly reminder that ${docType.toLowerCase()} ${inv.number} for ${fmt(inv.total || 0)} ${overdueDays > 0 ? `was due ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago` : "is due for payment"}.\n\n${profile.bsb ? `Bank details:\nAccount: ${profile.bank_name || bName}\nBSB: ${profile.bsb}\nAccount #: ${profile.account_number}\nReference: ${inv.number}\n\n` : ""}Please let us know if you have any questions.\n\nKind regards,\n${bName}`;
    window.open(`mailto:${inv.contact_email || ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    if (inv.due_date && new Date(inv.due_date) < new Date() && inv.status === "sent") updateInvoice(inv.id, { status: "overdue" });
  };

  const markPaid = (inv) => {
    updateInvoice(inv.id, { status: "paid", paid_date: today() });
  };

  if (session === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0f1117", color: "#94a3b8" }}>Loading...</div>;
  if (!session) return <LoginScreen />;
  if (loading) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0f1117", color: "#94a3b8", fontFamily: "'IBM Plex Sans', sans-serif" }}>Loading...</div>;

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Icons.Dashboard },
    { id: "expenses", label: "Expenses", icon: Icons.Expenses },
    { id: "invoices", label: "Invoices", icon: Icons.Invoices },
    { id: "contacts", label: "Contacts", icon: Icons.Contacts },
  ];

  const s = {
    app: { display: "flex", height: "100vh", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", background: "#0f1117", color: "#e2e8f0", fontSize: "13px", overflow: "hidden" },
    sidebar: { width: 220, background: "#161822", borderRight: "1px solid #1e2130", display: "flex", flexDirection: "column", flexShrink: 0, position: "relative", zIndex: 40 },
    sidebarMobile: { position: "fixed", inset: 0, zIndex: 40 },
    logo: { padding: "20px 16px 12px", borderBottom: "1px solid #1e2130" },
    bizSwitcher: { padding: "12px", borderBottom: "1px solid #1e2130" },
    bizBtn: (active, color) => ({ width: "100%", padding: "8px 10px", border: "none", borderRadius: 6, cursor: "pointer", textAlign: "left", fontSize: 12, fontWeight: 600, background: active ? color + "18" : "transparent", color: active ? color : "#94a3b8", borderLeft: active ? `3px solid ${color}` : "3px solid transparent", marginBottom: 2 }),
    nav: { flex: 1, padding: "8px", overflowY: "auto" },
    navBtn: (active) => ({ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: "none", borderRadius: 6, cursor: "pointer", background: active ? accent + "15" : "transparent", color: active ? accent : "#94a3b8", fontSize: 13, fontWeight: active ? 600 : 400, marginBottom: 1, textAlign: "left" }),
    main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 },
    header: { padding: "12px 16px", borderBottom: "1px solid #1e2130", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#12141e", gap: 8, flexWrap: "wrap" },
    content: { flex: 1, padding: "16px", overflowY: "auto" },
    card: { background: "#161822", borderRadius: 10, border: "1px solid #1e2130", padding: "16px", marginBottom: 12 },
    statCard: (color) => ({ background: "#161822", borderRadius: 10, border: "1px solid #1e2130", padding: "12px 16px", borderTop: `3px solid ${color}`, minWidth: 0 }),
    btn: (bg, small) => ({ padding: small ? "6px 12px" : "8px 16px", background: bg || accent, color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: small ? 11 : 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }),
    btnOutline: { padding: "6px 12px", background: "transparent", color: "#94a3b8", border: "1px solid #2a2d3e", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 500 },
    table: { width: "100%", borderCollapse: "collapse" },
    th: { textAlign: "left", padding: "8px 10px", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748b", borderBottom: "1px solid #1e2130" },
    td: { padding: "8px 10px", borderBottom: "1px solid #1e2130", fontSize: 13 },
    input: { width: "100%", padding: "8px 12px", background: "#0f1117", border: "1px solid #2a2d3e", borderRadius: 6, color: "#e2e8f0", fontSize: 13, outline: "none", boxSizing: "border-box" },
    select: { width: "100%", padding: "8px 12px", background: "#0f1117", border: "1px solid #2a2d3e", borderRadius: 6, color: "#e2e8f0", fontSize: 13, outline: "none", boxSizing: "border-box" },
    label: { display: "block", fontSize: 11, fontWeight: 600, color: "#94a3b8", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.04em" },
    modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 },
    modalContent: { background: "#161822", borderRadius: 12, border: "1px solid #2a2d3e", width: "100%", maxWidth: 560, maxHeight: "85vh", overflow: "auto", padding: "20px" },
    badge: (color) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600, background: color + "20", color }),
    grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  };

  const ReceiptCapture = () => {
    const [phase, setPhase] = useState("capture");
    const [rawUrl, setRawUrl] = useState(null);
    const [scannedUrl, setScannedUrl] = useState(null);
    const [extracted, setExtracted] = useState(null);
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
        setExtracted({ ...result, receiptPath: filePath });
        setPhase("confirm");
      } catch (err) { setError(err.message || "Failed to process receipt"); setPhase("scan"); }
    };

    const [receiptJob, setReceiptJob] = useState("");
    const confirmReceipt = () => {
      if (!extracted) return;
      const acct = accounts.find((a) => a.name === extracted.category && a.type === "Expense");
      addTransaction({ date: extracted.date || today(), type: "expense", description: extracted.description || extracted.vendor || "Receipt", amount: String(extracted.total || 0), account: acct?.name || extracted.category || "", contact: extracted.vendor || "", reference: "", receipt_path: extracted.receiptPath || "", job: receiptJob });
    };

    const reset = () => { setPhase("capture"); setRawUrl(null); setScannedUrl(null); setExtracted(null); setCorners(null); setError(""); };

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
              <img ref={imgRef} src={rawUrl} onLoad={onImgLoad} alt="Receipt" style={{ width: "100%", display: "block", borderRadius: 8, border: "1px solid #2a2d3e" }} />
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
            {scannedUrl && <img src={scannedUrl} alt="Scanned" style={{ width: "60%", borderRadius: 8, border: "1px solid #2a2d3e", marginBottom: 12 }} />}
            <div style={{ color: "#94a3b8" }}>{phase === "scanning" ? "Scanning receipt..." : "Reading receipt with AI..."}</div>
          </div>
        )}

        {error && <div style={{ color: "#f87171", fontSize: 13, padding: 12, background: "#f8717110", borderRadius: 8, marginTop: 12 }}>{error}</div>}

        {phase === "confirm" && scannedUrl && extracted && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <img src={scannedUrl} alt="Scanned receipt" style={{ width: "100%", borderRadius: 8, border: "1px solid #2a2d3e" }} />
              <div style={{ background: "#0f1117", borderRadius: 8, padding: 12, fontSize: 12 }}>
                <div style={{ fontWeight: 700, color: "#f1f5f9", marginBottom: 8, fontSize: 14 }}>Extracted</div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>Vendor:</span> {extracted.vendor}</div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>Date:</span> {extracted.date}</div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>Total:</span> <span style={{ color: "#f87171", fontWeight: 700 }}>{fmt(extracted.total)}</span></div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>Category:</span> {extracted.category}</div>
              </div>
            </div>
            <div style={{ marginBottom: 10 }}><label style={s.label}>Job</label><input list="job-list-rcpt" value={receiptJob} onChange={(e) => setReceiptJob(e.target.value)} placeholder="e.g. 5 Midelton Ave" style={s.input} /><datalist id="job-list-rcpt">{jobNames.map(j => <option key={j} value={j} />)}</datalist></div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={confirmReceipt} style={{ ...s.btn(accent), flex: 1, justifyContent: "center" }}><Icons.Check /> Add as Expense</button>
              <button onClick={reset} style={{ ...s.btnOutline, flex: 0 }}>Retake</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const ExpenseForm = () => {
    const [f, setF] = useState({ date: today(), type: "expense", description: "", amount: "", account: accounts.find(a => a.type === "Expense")?.name || "", contact: "", reference: "", job: "" });
    const expenseAccounts = accounts.filter((a) => a.type === "Expense");
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>New Expense</h3>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Date</label><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Amount (AUD)</label><input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" style={s.input} /></div>
        </div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Description</label><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Office supplies from Officeworks" style={s.input} /></div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Category</label><select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} style={s.select}><option value="">Select...</option>{expenseAccounts.map((a) => <option key={a.code} value={a.name}>{a.name}</option>)}</select></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Contact</label><select value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} style={s.select}><option value="">None</option>{contacts.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Reference</label><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="Receipt #, PO number, etc." style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Job</label><input list="job-list" value={f.job} onChange={(e) => setF({ ...f, job: e.target.value })} placeholder="e.g. 5 Midelton Ave" style={s.input} /><datalist id="job-list">{jobNames.map(j => <option key={j} value={j} />)}</datalist></div>
        </div>
        <button disabled={!f.description || !f.amount} onClick={() => addTransaction(f)} style={{ ...s.btn(accent), opacity: !f.description || !f.amount ? 0.4 : 1, width: "100%", justifyContent: "center" }}>Add Expense</button>
      </div>
    );
  };

  const ContactForm = () => {
    const [f, setF] = useState({ name: "", email: "", phone: "", type: "client", company: "", abn: "", address: "", notes: "" });
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>New Contact</h3>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
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
        <button disabled={!f.name} onClick={() => addContact(f)} style={{ ...s.btn(accent), opacity: !f.name ? 0.4 : 1, width: "100%", justifyContent: "center" }}>Add Contact</button>
      </div>
    );
  };

  const InvoiceForm = ({ existing }) => {
    const init = existing || { number: `INV-${String(invoices.length + 1).padStart(3, "0")}`, type: "invoice", date: today(), due_date: "", contact_name: "", contact_email: "", contact_company: "", contact_abn: "", contact_address: "", contact_phone: "", job: "", items: [{ description: "", note: "", qty: 1, rate: "" }], notes: "", status: "draft" };
    const [f, setF] = useState(init);
    const [quickAdd, setQuickAdd] = useState(false);
    const [qa, setQa] = useState({ name: "", email: "", company: "", phone: "", abn: "", address: "" });
    const updateItem = (idx, field, val) => { const items = [...f.items]; items[idx] = { ...items[idx], [field]: val }; setF({ ...f, items }); };
    const addItem = () => setF({ ...f, items: [...f.items, { description: "", note: "", qty: 1, rate: "" }] });
    const removeItem = (idx) => setF({ ...f, items: f.items.filter((_, i) => i !== idx) });
    const total = f.items.reduce((sum, i) => sum + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{existing ? "Edit" : "New"} {f.type === "quote" ? "Quote" : "Invoice"}</h3>
          <button onClick={() => { setModal(null); setEditItem(null); }} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Type</label><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} style={s.select}><option value="invoice">Invoice</option><option value="quote">Quote</option></select></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Number</label><input value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} style={s.input} /></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Date</label><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Due Date</label><input type="date" value={f.due_date || ""} onChange={(e) => setF({ ...f, due_date: e.target.value })} style={s.input} /></div>
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
          <div style={{ background: "#0f1117", borderRadius: 8, padding: 12, marginBottom: 12, border: `1px solid ${accent}30` }}>
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
        <div style={{ marginBottom: 12 }}><label style={s.label}>Job</label><input list="job-list-inv" value={f.job || ""} onChange={(e) => setF({ ...f, job: e.target.value })} placeholder="e.g. 5 Midelton Ave" style={s.input} /><datalist id="job-list-inv">{jobNames.map(j => <option key={j} value={j} />)}</datalist></div>
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <label style={s.label}>Line Items</label>
          {f.items.map((item, idx) => (
            <div key={idx} style={{ marginBottom: 8, padding: 10, background: "#0f1117", borderRadius: 6 }}>
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
        <div style={{ marginTop: 12, marginBottom: 16, background: "#0f1117", borderRadius: 8, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, color: "#f1f5f9" }}><span>Total</span><span>{fmt(total)}</span></div>
        </div>
        <div style={{ marginBottom: 16 }}><label style={s.label}>Notes</label><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Payment terms, notes, etc." style={s.input} /></div>
        <button onClick={() => { const inv = { ...f, total }; existing ? updateInvoice(existing.id, inv) : addInvoice(inv); }} style={{ ...s.btn(accent), width: "100%", justifyContent: "center" }}>{existing ? "Update" : "Create"} {f.type === "quote" ? "Quote" : "Invoice"}</button>
      </div>
    );
  };

  const BusinessSettings = () => {
    const [f, setF] = useState({ ...profile });
    const fileRef = useRef(null);

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
            {f.logo_url ? <img src={f.logo_url} alt="Logo" style={{ height: 48, borderRadius: 6, border: "1px solid #2a2d3e" }} /> : <div style={{ width: 48, height: 48, background: "#0f1117", borderRadius: 6, border: "1px dashed #2a2d3e" }} />}
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
        <div style={{ borderTop: "1px solid #1e2130", paddingTop: 16, marginTop: 8, marginBottom: 8 }}>
          <label style={{ ...s.label, marginBottom: 12 }}>Bank Details (shown on invoices)</label>
        </div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Account Name</label><input value={f.bank_name || ""} onChange={(e) => setF({ ...f, bank_name: e.target.value })} placeholder="Mworx Group Pty Ltd" style={s.input} /></div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>BSB</label><input value={f.bsb || ""} onChange={(e) => setF({ ...f, bsb: e.target.value })} placeholder="062-000" style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Account Number</label><input value={f.account_number || ""} onChange={(e) => setF({ ...f, account_number: e.target.value })} placeholder="1234 5678" style={s.input} /></div>
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
          <div style={s.statCard("#ef4444")}>
            <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Expenses This Month</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f87171", marginTop: 4 }}>{fmt(expense)}</div>
          </div>
          <div style={s.statCard(accent)}>
            <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Total Expenses</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f87171", marginTop: 4 }}>{fmt(totalExpenses)}</div>
          </div>
          <div style={s.statCard("#f59e0b")}>
            <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Outstanding Invoices</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fbbf24", marginTop: 4 }}>{fmt(outstanding)}</div>
            {overdue > 0 && <div style={{ fontSize: 10, color: "#ef4444", marginTop: 2 }}>{overdue} overdue</div>}
          </div>
        </div>
        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Recent Expenses</h4>
            <button onClick={() => setPage("expenses")} style={s.btnOutline}>View All</button>
          </div>
          {recentExpenses.length === 0 ? (
            <div style={{ color: "#64748b", fontSize: 12, padding: "20px 0", textAlign: "center" }}>No expenses yet</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}><tbody>
                {recentExpenses.map((t) => (
                  <tr key={t.id}>
                    <td style={{ ...s.td, color: "#64748b", width: 70, fontSize: 11 }}>{fmtDate(t.date)}</td>
                    <td style={s.td}>{t.description}</td>
                    <td style={{ ...s.td, color: "#64748b", fontSize: 11 }}>{t.account || ""}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, color: "#f87171", whiteSpace: "nowrap" }}>{fmt(t.amount)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </div>
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
    const [viewReceipt, setViewReceipt] = useState(null);
    const sorted = [...txns].filter((t) => t.type === "expense").sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((t) => {
      if (search && !t.description.toLowerCase().includes(search.toLowerCase()) && !(t.account || "").toLowerCase().includes(search.toLowerCase())) return false;
      if (jobFilter && t.job !== jobFilter) return false;
      return true;
    });

    const openReceipt = async (path) => {
      const { data } = supabase.storage.from("receipts").getPublicUrl(path);
      if (data?.publicUrl) setViewReceipt(data.publicUrl);
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
            <div style={{ color: "#64748b", padding: "30px 0", textAlign: "center" }}>No expenses found</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Date</th><th style={s.th}>Description</th><th style={s.th}>Category</th><th style={s.th}>Job</th><th style={{ ...s.th, textAlign: "right" }}>Amount</th><th style={{ ...s.th, width: 60 }}></th></tr></thead>
                <tbody>{filtered.map((t) => (
                  <tr key={t.id}>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(t.date)}</td>
                    <td style={s.td}>{t.description}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{t.account || "--"}</td>
                    <td style={{ ...s.td, color: "#64748b", fontSize: 11 }}>{t.job || ""}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, color: "#f87171", whiteSpace: "nowrap" }}>{fmt(t.amount)}</td>
                    <td style={{ ...s.td, display: "flex", gap: 4 }}>
                      {t.receipt_path && <button onClick={() => openReceipt(t.receipt_path)} title="View receipt" style={{ background: "none", border: "none", color: "#8b5cf6", cursor: "pointer", padding: 2 }}><Icons.Camera /></button>}
                      <button onClick={() => deleteTransaction(t.id)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 2 }}><Icons.Trash /></button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
        {viewReceipt && (
          <div style={s.modalOverlay} onClick={() => setViewReceipt(null)}>
            <div style={{ maxWidth: 500, maxHeight: "80vh", position: "relative" }}>
              <button onClick={() => setViewReceipt(null)} style={{ position: "absolute", top: -12, right: -12, background: "#161822", border: "1px solid #2a2d3e", borderRadius: "50%", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "#94a3b8", zIndex: 1 }}><Icons.X /></button>
              <img src={viewReceipt} alt="Receipt" style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 8, display: "block" }} />
            </div>
          </div>
        )}
      </div>
    );
  };

  const InvoicesPage = () => {
    const [filter, setFilter] = useState("all");
    const [jobFilter, setJobFilter] = useState("");
    const sorted = [...invoices].sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((i) => (filter === "all" || i.status === filter) && (!jobFilter || i.job === jobFilter));
    const statusColors = { draft: "#64748b", sent: "#3b82f6", paid: "#34d399", overdue: "#ef4444" };
    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {["all", "draft", "sent", "paid", "overdue"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...s.btnOutline, background: filter === f ? accent + "20" : "transparent", color: filter === f ? accent : "#94a3b8", borderColor: filter === f ? accent : "#2a2d3e" }}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
          ))}
          <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} style={{ ...s.select, maxWidth: 180, marginLeft: "auto" }}>
            <option value="">All Jobs</option>
            {jobNames.map(j => <option key={j} value={j}>{j}</option>)}
          </select>
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? (
            <div style={{ color: "#64748b", padding: "30px 0", textAlign: "center" }}>No invoices yet</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Number</th><th style={s.th}>Date</th><th style={s.th}>Contact</th><th style={s.th}>Job</th><th style={s.th}>Status</th><th style={{ ...s.th, textAlign: "right" }}>Total</th><th style={{ ...s.th, width: 100 }}></th></tr></thead>
                <tbody>{filtered.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{inv.number}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{fmtDate(inv.date)}</td>
                    <td style={s.td}>{inv.contact_name || "--"}</td>
                    <td style={{ ...s.td, color: "#64748b", fontSize: 11 }}>{inv.job || ""}</td>
                    <td style={s.td}><span style={s.badge(statusColors[inv.status] || "#64748b")}>{inv.status}</span></td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmt(inv.total || 0)}</td>
                    <td style={{ ...s.td, display: "flex", gap: 4 }}>
                      {inv.status !== "paid" && <button onClick={() => sendInvoice(inv)} title="Send Invoice" style={{ background: "none", border: "none", color: "#3b82f6", cursor: "pointer", padding: 2 }}><Icons.Send /></button>}
                      {(inv.status === "sent" || inv.status === "overdue") && <button onClick={() => sendReminder(inv)} title="Send Reminder" style={{ background: "none", border: "none", color: "#f59e0b", cursor: "pointer", padding: 2, fontSize: 13 }}>!</button>}
                      <button onClick={() => downloadPDF(inv)} title="Download PDF" style={{ background: "none", border: "none", color: "#8b5cf6", cursor: "pointer", padding: 2 }}><Icons.Download /></button>
                      <button onClick={() => { setEditItem(inv); setModal("invoice"); }} title="Edit" style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 2 }}><Icons.Edit /></button>
                      {inv.status !== "paid" && <button onClick={() => markPaid(inv)} title="Mark Paid" style={{ background: "none", border: "none", color: "#34d399", cursor: "pointer", padding: 2 }}><Icons.Check /></button>}
                      <button onClick={() => deleteInvoice(inv.id)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 2 }}><Icons.Trash /></button>
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
            <button key={f} onClick={() => setFilter(f)} style={{ ...s.btnOutline, background: filter === f ? accent + "20" : "transparent", color: filter === f ? accent : "#94a3b8" }}>{f.charAt(0).toUpperCase() + f.slice(1)}s</button>
          ))}
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? <div style={{ color: "#64748b", padding: "30px 0", textAlign: "center" }}>No contacts yet</div> : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr><th style={s.th}>Name</th><th style={s.th}>Company</th><th style={s.th}>Email</th><th style={s.th}>Type</th><th style={{ ...s.th, width: 40 }}></th></tr></thead>
                <tbody>{filtered.map((c) => (
                  <tr key={c.id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{c.name}</td>
                    <td style={{ ...s.td, color: "#94a3b8" }}>{c.company || "--"}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{c.email || "--"}</td>
                    <td style={s.td}><span style={s.badge(c.type === "client" ? "#3b82f6" : "#f59e0b")}>{c.type}</span></td>
                    <td style={s.td}><button onClick={() => deleteContact(c.id)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 2 }}><Icons.Trash /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    );
  };

  const pageMap = { dashboard: DashboardPage, expenses: ExpensesPage, invoices: InvoicesPage, contacts: ContactsPage };
  const PageComponent = pageMap[page] || DashboardPage;

  const SidebarContent = () => (
    <>
      <div style={s.logo}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em" }}>BookKeeper</div>
        <div style={{ fontSize: 10, color: "#64748b", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.08em" }}>MT Management</div>
      </div>
      <div style={s.bizSwitcher}>
        {BUSINESSES.map((b) => (
          <button key={b.id} onClick={() => { switchBiz(b.id); setSidebarOpen(false); }} style={s.bizBtn(biz === b.id, b.accent)}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: b.accent, marginRight: 6 }} />{b.name}
          </button>
        ))}
      </div>
      <div style={s.nav}>
        {navItems.map((item) => (
          <button key={item.id} onClick={() => { setPage(item.id); setSidebarOpen(false); }} style={s.navBtn(page === item.id)}>
            <item.icon /> {item.label}
          </button>
        ))}
      </div>
      <div style={{ padding: 12, borderTop: "1px solid #1e2130", display: "flex", gap: 6 }}>
        <button onClick={() => setModal("settings")} style={{ ...s.btnOutline, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11 }}><Icons.Settings /> Settings</button>
        <button onClick={logout} style={{ ...s.btnOutline, flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11 }}><Icons.Logout /> Sign Out</button>
      </div>
    </>
  );

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <style>{`@media(max-width:768px){.bk-sidebar-desktop{display:none!important}.bk-hamburger{display:flex!important}} @media(min-width:769px){.bk-sidebar-mobile{display:none!important}.bk-hamburger{display:none!important}}`}</style>
      <div style={s.app}>
        <div className="bk-sidebar-desktop" style={s.sidebar}><SidebarContent /></div>
        {sidebarOpen && (
          <div className="bk-sidebar-mobile" style={s.sidebarMobile} onClick={(e) => { if (e.target === e.currentTarget) setSidebarOpen(false); }}>
            <div style={{ ...s.sidebar, height: "100%", width: 260, position: "absolute", left: 0, top: 0 }}><SidebarContent /></div>
          </div>
        )}
        <div style={s.main}>
          <div style={s.header}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button className="bk-hamburger" onClick={() => setSidebarOpen(true)} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", display: "none", alignItems: "center" }}><Icons.Menu /></button>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#f1f5f9" }}>{navItems.find((n) => n.id === page)?.label}</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>{bizInfo?.name}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={() => setModal("receipt")} style={s.btn("#8b5cf6", true)}><Icons.Camera /> Receipt</button>
              {(page === "expenses" || page === "dashboard") && <button onClick={() => setModal("expense")} style={s.btn(accent, true)}><Icons.Plus /> Expense</button>}
              {page === "invoices" && <button onClick={() => { setEditItem(null); setModal("invoice"); }} style={s.btn(accent, true)}><Icons.Plus /> Invoice</button>}
              {page === "contacts" && <button onClick={() => setModal("contact")} style={s.btn(accent, true)}><Icons.Plus /> Contact</button>}
            </div>
          </div>
          <div style={s.content}><PageComponent /></div>
        </div>
        {modal && (
          <div style={s.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) { setModal(null); setEditItem(null); } }}>
            <div style={s.modalContent}>
              {modal === "expense" && <ExpenseForm />}
              {modal === "contact" && <ContactForm />}
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
