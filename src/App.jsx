import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { supabase } from "./supabaseClient";

const STORAGE_KEY = "bookkeeper-app-data";

const DEFAULT_ACCOUNTS = [
  { code: "1000", name: "Cash at Bank", type: "Asset" },
  { code: "1100", name: "Accounts Receivable", type: "Asset" },
  { code: "1200", name: "Prepaid Expenses", type: "Asset" },
  { code: "1500", name: "Equipment", type: "Asset" },
  { code: "2000", name: "Accounts Payable", type: "Liability" },
  { code: "2100", name: "GST Collected", type: "Liability" },
  { code: "2200", name: "GST Paid", type: "Liability" },
  { code: "2300", name: "PAYG Withholding", type: "Liability" },
  { code: "2400", name: "Credit Card", type: "Liability" },
  { code: "3000", name: "Owner's Equity", type: "Equity" },
  { code: "3100", name: "Retained Earnings", type: "Equity" },
  { code: "4000", name: "Sales Revenue", type: "Revenue" },
  { code: "4100", name: "Rental Income", type: "Revenue" },
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

const DEFAULT_DATA = {
  businesses: [
    { id: "mt", name: "MT Management", accent: "#0d9488" },
    { id: "mworx", name: "Mworx Group", accent: "#b45309" },
  ],
  accounts: { mt: [...DEFAULT_ACCOUNTS], mworx: [...DEFAULT_ACCOUNTS] },
  transactions: { mt: [], mworx: [] },
  contacts: { mt: [], mworx: [] },
  invoices: { mt: [], mworx: [] },
  activeBusiness: "mt",
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmt = (n) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n);
const fmtDate = (d) => new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
const today = () => new Date().toISOString().split("T")[0];

const Icons = {
  Dashboard: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  Transactions: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>,
  Contacts: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
  Invoices: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>,
  Accounts: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>,
  Reports: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>,
  Plus: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>,
  X: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>,
  Trash: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>,
  Edit: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Check: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>,
  Send: () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>,
  Camera: () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  Menu: () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>,
  Logout: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>,
};

// ——— AUTH SCREEN ———
function LoginScreen() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    setLoading(true);
    setError("");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setLoading(false);
    if (error) setError(error.message);
    else setSent(true);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", background: "#0f1117", fontFamily: "'IBM Plex Sans', system-ui, sans-serif", padding: 20 }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ background: "#161822", borderRadius: 16, border: "1px solid #1e2130", padding: 40, width: "100%", maxWidth: 400, textAlign: "center" }}>
        <div style={{ fontSize: 28, fontWeight: 800, color: "#f1f5f9", letterSpacing: "-0.03em", marginBottom: 4 }}>BookKeeper</div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 32, textTransform: "uppercase", letterSpacing: "0.08em" }}>MT Management</div>
        {sent ? (
          <div>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📬</div>
            <div style={{ color: "#e2e8f0", fontSize: 15, marginBottom: 8 }}>Check your email</div>
            <div style={{ color: "#64748b", fontSize: 13 }}>We sent a login link to <strong style={{ color: "#94a3b8" }}>{email}</strong></div>
          </div>
        ) : (
          <div>
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              onKeyDown={(e) => e.key === "Enter" && email && handleLogin()}
              style={{ width: "100%", padding: "12px 16px", background: "#0f1117", border: "1px solid #2a2d3e", borderRadius: 8, color: "#e2e8f0", fontSize: 15, outline: "none", boxSizing: "border-box", marginBottom: 12 }}
            />
            {error && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>{error}</div>}
            <button
              disabled={!email || loading} onClick={handleLogin}
              style={{ width: "100%", padding: "12px", background: "#0d9488", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: !email || loading ? 0.5 : 1 }}
            >
              {loading ? "Sending..." : "Send Login Link"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ——— MAIN APP ———
export default function BookkeeperApp() {
  const [session, setSession] = useState(undefined); // undefined=loading, null=logged out
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [editItem, setEditItem] = useState(null);
  const [previewInvoice, setPreviewInvoice] = useState(null);
  const [reportType, setReportType] = useState("pnl");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [reportPeriod, setReportPeriod] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  // Auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => setSession(session));
    return () => subscription.unsubscribe();
  }, []);

  // Load data from Supabase
  useEffect(() => {
    if (!session) { setLoading(false); return; }
    (async () => {
      const { data: row } = await supabase.from("bk_app_data").select("data").eq("user_id", session.user.id).single();
      if (row?.data) {
        setData(row.data);
      } else {
        // First login — seed with defaults
        const defaults = { ...DEFAULT_DATA };
        await supabase.from("bk_app_data").upsert({ user_id: session.user.id, data: defaults, updated_at: new Date().toISOString() });
        setData(defaults);
      }
      setLoading(false);
    })();
  }, [session]);

  // Save to Supabase
  const save = useCallback(async (newData) => {
    setData(newData);
    if (session) {
      await supabase.from("bk_app_data").upsert({ user_id: session.user.id, data: newData, updated_at: new Date().toISOString() });
    }
  }, [session]);

  const logout = async () => { await supabase.auth.signOut(); setSession(null); setData(null); };

  // Show login if not authenticated
  if (session === undefined) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0f1117", color: "#94a3b8" }}>Loading...</div>;
  if (!session) return <LoginScreen />;

  const biz = data?.activeBusiness || "mt";
  const bizInfo = data?.businesses?.find((b) => b.id === biz);
  const accent = bizInfo?.accent || "#0d9488";
  const switchBiz = (id) => save({ ...data, activeBusiness: id });

  const txns = data?.transactions?.[biz] || [];
  const contacts = data?.contacts?.[biz] || [];
  const accounts = data?.accounts?.[biz] || [];
  const invoices = data?.invoices?.[biz] || [];

  const addTransaction = (t) => { save({ ...data, transactions: { ...data.transactions, [biz]: [...txns, { ...t, id: uid() }] } }); setModal(null); };
  const deleteTransaction = (id) => save({ ...data, transactions: { ...data.transactions, [biz]: txns.filter((t) => t.id !== id) } });
  const addContact = (c) => { save({ ...data, contacts: { ...data.contacts, [biz]: [...contacts, { ...c, id: uid() }] } }); setModal(null); };
  const deleteContact = (id) => save({ ...data, contacts: { ...data.contacts, [biz]: contacts.filter((c) => c.id !== id) } });
  const addAccount = (a) => { save({ ...data, accounts: { ...data.accounts, [biz]: [...accounts, a] } }); setModal(null); };
  const deleteAccount = (code) => save({ ...data, accounts: { ...data.accounts, [biz]: accounts.filter((a) => a.code !== code) } });
  const addInvoice = (inv) => { save({ ...data, invoices: { ...data.invoices, [biz]: [...invoices, { ...inv, id: uid() }] } }); setModal(null); setEditItem(null); };
  const updateInvoice = (id, updates) => { save({ ...data, invoices: { ...data.invoices, [biz]: invoices.map((i) => (i.id === id ? { ...i, ...updates } : i)) } }); setModal(null); setEditItem(null); };
  const deleteInvoice = (id) => save({ ...data, invoices: { ...data.invoices, [biz]: invoices.filter((i) => i.id !== id) } });
  const resetData = async () => { if (confirm("Reset ALL data? This cannot be undone.")) { await save({ ...DEFAULT_DATA }); setPage("dashboard"); } };

  const reportCalcs = (() => {
    const [yr, mo] = reportPeriod.split("-").map(Number);
    const startDate = new Date(yr, mo - 1, 1);
    const endDate = new Date(yr, mo, 0);
    const periodTxns = txns.filter((t) => { const d = new Date(t.date); return d >= startDate && d <= endDate; });
    const revenue = periodTxns.filter((t) => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
    const expenses = periodTxns.filter((t) => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
    const gstCollected = periodTxns.filter((t) => t.type === "income" && t.gst).reduce((s, t) => s + Number(t.amount) / 11, 0);
    const gstPaid = periodTxns.filter((t) => t.type === "expense" && t.gst).reduce((s, t) => s + Number(t.amount) / 11, 0);
    const byAccount = {};
    periodTxns.forEach((t) => { const key = t.account || "Uncategorised"; if (!byAccount[key]) byAccount[key] = { income: 0, expense: 0 }; byAccount[key][t.type] += Number(t.amount); });
    const allRevenue = txns.filter((t) => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
    const allExpenses = txns.filter((t) => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
    const allGstCollected = txns.filter((t) => t.type === "income" && t.gst).reduce((s, t) => s + Number(t.amount) / 11, 0);
    const allGstPaid = txns.filter((t) => t.type === "expense" && t.gst).reduce((s, t) => s + Number(t.amount) / 11, 0);
    const unpaidInvoices = invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((s, i) => s + Number(i.total || 0), 0);
    return { revenue, expenses, gstCollected, gstPaid, byAccount, allRevenue, allExpenses, allGstCollected, allGstPaid, unpaidInvoices, periodTxns };
  })();

  if (loading || !data) return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0f1117", color: "#94a3b8", fontFamily: "'IBM Plex Sans', sans-serif" }}>Loading...</div>;

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: Icons.Dashboard },
    { id: "transactions", label: "Transactions", icon: Icons.Transactions },
    { id: "invoices", label: "Invoices", icon: Icons.Invoices },
    { id: "contacts", label: "Contacts", icon: Icons.Contacts },
    { id: "accounts", label: "Accounts", icon: Icons.Accounts },
    { id: "reports", label: "Reports", icon: Icons.Reports },
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

  // ——— RECEIPT CAPTURE ———
  const ReceiptCapture = () => {
    const [processing, setProcessing] = useState(false);
    const [preview, setPreview] = useState(null);
    const [extracted, setExtracted] = useState(null);
    const [error, setError] = useState("");
    const fileRef = useRef(null);

    const handleFile = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setError("");
      setPreview(URL.createObjectURL(file));
      setProcessing(true);

      try {
        // Convert to base64
        const base64 = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result.split(",")[1]);
          r.onerror = rej;
          r.readAsDataURL(file);
        });

        // Upload to Supabase Storage
        const filePath = `${session.user.id}/${Date.now()}_${file.name}`;
        await supabase.storage.from("receipts").upload(filePath, file);

        // Send to Netlify function for AI extraction
        const resp = await fetch("/.netlify/functions/extract-receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: base64, mediaType: file.type }),
        });

        if (!resp.ok) throw new Error("Failed to process receipt");
        const result = await resp.json();
        setExtracted({ ...result, receiptPath: filePath });
      } catch (err) {
        setError(err.message || "Failed to process receipt");
      }
      setProcessing(false);
    };

    const confirmReceipt = () => {
      if (!extracted) return;
      const acct = accounts.find((a) => a.name === extracted.category && a.type === "Expense");
      addTransaction({
        date: extracted.date || today(),
        type: "expense",
        description: extracted.description || extracted.vendor || "Receipt",
        amount: String(extracted.total || 0),
        account: acct?.name || extracted.category || "",
        contact: extracted.vendor || "",
        gst: extracted.gst_included !== false,
        reference: "",
        receiptPath: extracted.receiptPath || "",
      });
    };

    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>📸 Snap Receipt</h3>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>

        {!preview && !processing && (
          <div>
            <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleFile} style={{ display: "none" }} />
            <button onClick={() => fileRef.current?.click()} style={{ ...s.btn(accent), width: "100%", justifyContent: "center", padding: "20px", fontSize: 15 }}>
              <Icons.Camera /> Take Photo of Receipt
            </button>
            <div style={{ textAlign: "center", color: "#64748b", fontSize: 12, marginTop: 12 }}>or choose from gallery</div>
            <input type="file" accept="image/*" onChange={handleFile} style={{ display: "block", margin: "8px auto 0", color: "#64748b", fontSize: 12 }} />
          </div>
        )}

        {processing && (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12, animation: "spin 1s linear infinite" }}>⏳</div>
            <div style={{ color: "#94a3b8" }}>Reading receipt with AI...</div>
            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {error && <div style={{ color: "#f87171", fontSize: 13, padding: 12, background: "#f8717110", borderRadius: 8, marginTop: 12 }}>{error}</div>}

        {preview && extracted && !processing && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <img src={preview} alt="Receipt" style={{ width: "100%", borderRadius: 8, border: "1px solid #2a2d3e" }} />
              <div style={{ background: "#0f1117", borderRadius: 8, padding: 12, fontSize: 12 }}>
                <div style={{ fontWeight: 700, color: "#f1f5f9", marginBottom: 8, fontSize: 14 }}>Extracted</div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>Vendor:</span> {extracted.vendor}</div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>Date:</span> {extracted.date}</div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>Total:</span> <span style={{ color: "#f87171", fontWeight: 700 }}>{fmt(extracted.total)}</span></div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>GST:</span> {extracted.gst_included ? "Yes" : "No"}</div>
                <div style={{ marginBottom: 4 }}><span style={{ color: "#64748b" }}>Category:</span> {extracted.category}</div>
                {extracted.items?.length > 0 && (
                  <div style={{ marginTop: 8, borderTop: "1px solid #1e2130", paddingTop: 8 }}>
                    {extracted.items.map((item, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", color: "#94a3b8", marginBottom: 2 }}>
                        <span>{item.name}</span><span>{fmt(item.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={confirmReceipt} style={{ ...s.btn(accent), flex: 1, justifyContent: "center" }}>
                <Icons.Check /> Add as Transaction
              </button>
              <button onClick={() => { setPreview(null); setExtracted(null); setError(""); }} style={{ ...s.btnOutline, flex: 0 }}>Retake</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ——— FORMS ———
  const TransactionForm = () => {
    const [f, setF] = useState({ date: today(), type: "expense", description: "", amount: "", account: accounts.find(a => a.type === "Expense")?.name || "", contact: "", gst: true, reference: "" });
    const filteredAccounts = accounts.filter((a) => f.type === "income" ? a.type === "Revenue" : a.type === "Expense");
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>New Transaction</h3>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Date</label><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Type</label><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, account: "" })} style={s.select}><option value="income">Income</option><option value="expense">Expense</option></select></div>
        </div>
        <div style={{ marginBottom: 12 }}><label style={s.label}>Description</label><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Booking revenue — Glenhaven" style={s.input} /></div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Amount (AUD)</label><input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0.00" style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Account</label><select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })} style={s.select}><option value="">Select...</option>{filteredAccounts.map((a) => <option key={a.code} value={a.name}>{a.code} — {a.name}</option>)}</select></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Contact</label><select value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} style={s.select}><option value="">None</option>{contacts.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}</select></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Reference</label><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="INV-001, etc." style={s.input} /></div>
        </div>
        <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={f.gst} onChange={(e) => setF({ ...f, gst: e.target.checked })} id="gst" style={{ accentColor: accent }} />
          <label htmlFor="gst" style={{ fontSize: 12, color: "#94a3b8" }}>Includes GST (10%)</label>
        </div>
        <button disabled={!f.description || !f.amount} onClick={() => addTransaction(f)} style={{ ...s.btn(accent), opacity: !f.description || !f.amount ? 0.4 : 1, width: "100%", justifyContent: "center" }}>Add Transaction</button>
      </div>
    );
  };

  const ContactForm = () => {
    const [f, setF] = useState({ name: "", email: "", phone: "", type: "client", company: "", abn: "", notes: "" });
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
        <div style={{ marginBottom: 12 }}><label style={s.label}>Company</label><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} style={s.input} /></div>
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

  const AccountForm = () => {
    const [f, setF] = useState({ code: "", name: "", type: "Expense" });
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>New Account</h3>
          <button onClick={() => setModal(null)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer" }}><Icons.X /></button>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Code</label><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="e.g. 6050" style={s.input} /></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Type</label><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} style={s.select}>{["Asset", "Liability", "Equity", "Revenue", "Expense"].map((t) => <option key={t}>{t}</option>)}</select></div>
        </div>
        <div style={{ marginBottom: 16 }}><label style={s.label}>Account Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Hosting & Domains" style={s.input} /></div>
        <button disabled={!f.code || !f.name} onClick={() => addAccount(f)} style={{ ...s.btn(accent), opacity: !f.code || !f.name ? 0.4 : 1, width: "100%", justifyContent: "center" }}>Add Account</button>
      </div>
    );
  };

  const InvoiceForm = ({ existing }) => {
    const init = existing || { number: `INV-${String(invoices.length + 1).padStart(3, "0")}`, type: "invoice", date: today(), dueDate: "", contact: "", contactEmail: "", items: [{ description: "", qty: 1, rate: "", gst: true }], notes: "", status: "draft" };
    const [f, setF] = useState(init);
    const updateItem = (idx, field, val) => { const items = [...f.items]; items[idx] = { ...items[idx], [field]: val }; setF({ ...f, items }); };
    const addItem = () => setF({ ...f, items: [...f.items, { description: "", qty: 1, rate: "", gst: true }] });
    const removeItem = (idx) => setF({ ...f, items: f.items.filter((_, i) => i !== idx) });
    const subtotal = f.items.reduce((sum, i) => sum + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0);
    const gstTotal = f.items.reduce((sum, i) => sum + (i.gst ? (Number(i.qty) || 0) * (Number(i.rate) || 0) * 0.1 : 0), 0);
    const total = subtotal + gstTotal;

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
          <div style={{ marginBottom: 12 }}><label style={s.label}>Due Date</label><input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} style={s.input} /></div>
        </div>
        <div style={s.grid2}>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Contact</label><select value={f.contact} onChange={(e) => { const c = contacts.find(c => c.name === e.target.value); setF({ ...f, contact: e.target.value, contactEmail: c?.email || f.contactEmail }); }} style={s.select}><option value="">Select...</option>{contacts.filter((c) => c.type === "client").map((c) => <option key={c.id}>{c.name}</option>)}</select></div>
          <div style={{ marginBottom: 12 }}><label style={s.label}>Status</label><select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} style={s.select}><option value="draft">Draft</option><option value="sent">Sent</option><option value="paid">Paid</option><option value="overdue">Overdue</option></select></div>
        </div>
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <label style={s.label}>Line Items</label>
          {f.items.map((item, idx) => (
            <div key={idx} style={{ display: "grid", gridTemplateColumns: "2fr 50px 80px 30px 24px", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <input value={item.description} onChange={(e) => updateItem(idx, "description", e.target.value)} placeholder="Description" style={{ ...s.input, fontSize: 12 }} />
              <input type="number" value={item.qty} onChange={(e) => updateItem(idx, "qty", e.target.value)} placeholder="Qty" style={{ ...s.input, fontSize: 12 }} />
              <input type="number" step="0.01" value={item.rate} onChange={(e) => updateItem(idx, "rate", e.target.value)} placeholder="Rate" style={{ ...s.input, fontSize: 12 }} />
              <input type="checkbox" checked={item.gst} onChange={(e) => updateItem(idx, "gst", e.target.checked)} style={{ accentColor: accent }} />
              {f.items.length > 1 && <button onClick={() => removeItem(idx)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", padding: 0 }}><Icons.Trash /></button>}
            </div>
          ))}
          <button onClick={addItem} style={{ ...s.btnOutline, marginTop: 4 }}>+ Add Line</button>
        </div>
        <div style={{ marginTop: 12, marginBottom: 16, background: "#0f1117", borderRadius: 8, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12, color: "#94a3b8" }}><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 12, color: "#94a3b8" }}><span>GST</span><span>{fmt(gstTotal)}</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, color: "#f1f5f9", borderTop: "1px solid #1e2130", paddingTop: 8, marginTop: 4 }}><span>Total</span><span>{fmt(total)}</span></div>
        </div>
        <div style={{ marginBottom: 16 }}><label style={s.label}>Notes</label><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Payment terms, bank details, etc." style={s.input} /></div>
        <button onClick={() => { const inv = { ...f, subtotal, gst: gstTotal, total }; existing ? updateInvoice(existing.id, inv) : addInvoice(inv); }} style={{ ...s.btn(accent), width: "100%", justifyContent: "center" }}>{existing ? "Update" : "Create"} {f.type === "quote" ? "Quote" : "Invoice"}</button>
      </div>
    );
  };

  // ——— PAGES ———
  const DashboardPage = () => {
    const thisMonth = new Date().toISOString().slice(0, 7);
    const [yr, mo] = thisMonth.split("-").map(Number);
    const monthTxns = txns.filter((t) => { const d = new Date(t.date); return d.getFullYear() === yr && d.getMonth() + 1 === mo; });
    const income = monthTxns.filter((t) => t.type === "income").reduce((sum, t) => sum + Number(t.amount), 0);
    const expense = monthTxns.filter((t) => t.type === "expense").reduce((sum, t) => sum + Number(t.amount), 0);
    const outstanding = invoices.filter((i) => i.status === "sent" || i.status === "overdue").reduce((sum, i) => sum + Number(i.total || 0), 0);
    const overdue = invoices.filter((i) => i.status === "overdue").length;
    const recentTxns = [...txns].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);

    return (
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
          <div style={s.statCard(accent)}>
            <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Income MTD</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#34d399", marginTop: 4 }}>{fmt(income)}</div>
          </div>
          <div style={s.statCard("#ef4444")}>
            <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Expenses MTD</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f87171", marginTop: 4 }}>{fmt(expense)}</div>
          </div>
          <div style={s.statCard("#3b82f6")}>
            <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Net Profit</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: income - expense >= 0 ? "#34d399" : "#f87171", marginTop: 4 }}>{fmt(income - expense)}</div>
          </div>
          <div style={s.statCard("#f59e0b")}>
            <div style={{ fontSize: 9, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em" }}>Outstanding</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fbbf24", marginTop: 4 }}>{fmt(outstanding)}</div>
            {overdue > 0 && <div style={{ fontSize: 10, color: "#ef4444", marginTop: 2 }}>{overdue} overdue</div>}
          </div>
        </div>

        <div style={s.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Recent Transactions</h4>
            <button onClick={() => setPage("transactions")} style={s.btnOutline}>View All</button>
          </div>
          {recentTxns.length === 0 ? (
            <div style={{ color: "#64748b", fontSize: 12, padding: "20px 0", textAlign: "center" }}>No transactions yet</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}><tbody>
                {recentTxns.map((t) => (
                  <tr key={t.id}>
                    <td style={{ ...s.td, color: "#64748b", width: 70, fontSize: 11 }}>{fmtDate(t.date)}</td>
                    <td style={s.td}>{t.description}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, color: t.type === "income" ? "#34d399" : "#f87171", whiteSpace: "nowrap" }}>{t.type === "income" ? "+" : "−"}{fmt(t.amount)}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8, marginTop: 12 }}>
          <button onClick={() => setModal("receipt")} style={{ ...s.btn("#8b5cf6"), justifyContent: "center", padding: "14px" }}><Icons.Camera /> Snap Receipt</button>
          <button onClick={() => setModal("transaction")} style={{ ...s.btn(accent), justifyContent: "center", padding: "14px" }}><Icons.Plus /> Transaction</button>
          <button onClick={() => setModal("invoice")} style={{ ...s.btn("#3b82f6"), justifyContent: "center", padding: "14px" }}><Icons.Plus /> Invoice</button>
        </div>
      </div>
    );
  };

  const TransactionsPage = () => {
    const [filter, setFilter] = useState("all");
    const [search, setSearch] = useState("");
    const sorted = [...txns].sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((t) => {
      if (filter !== "all" && t.type !== filter) return false;
      if (search && !t.description.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." style={{ ...s.input, maxWidth: 200, flex: "1 1 140px" }} />
          {["all", "income", "expense"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...s.btnOutline, background: filter === f ? accent + "20" : "transparent", color: filter === f ? accent : "#94a3b8", borderColor: filter === f ? accent : "#2a2d3e" }}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? (
            <div style={{ color: "#64748b", padding: "30px 0", textAlign: "center" }}>No transactions found</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr>
                  <th style={s.th}>Date</th><th style={s.th}>Description</th><th style={s.th}>Account</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Amount</th><th style={{ ...s.th, width: 40 }}></th>
                </tr></thead>
                <tbody>{filtered.map((t) => (
                  <tr key={t.id}>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11, whiteSpace: "nowrap" }}>{fmtDate(t.date)}</td>
                    <td style={s.td}>{t.description}{t.receiptPath && <span title="Has receipt" style={{ marginLeft: 4 }}>📎</span>}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{t.account || "—"}</td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600, color: t.type === "income" ? "#34d399" : "#f87171", whiteSpace: "nowrap" }}>{t.type === "income" ? "+" : "−"}{fmt(t.amount)}</td>
                    <td style={s.td}><button onClick={() => deleteTransaction(t.id)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 2 }}><Icons.Trash /></button></td>
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
    const sendInvoice = (inv) => {
      const contact = contacts.find((c) => c.name === inv.contact);
      const dt = inv.type === "quote" ? "Quote" : "Invoice";
      const to = contact?.email || inv.contactEmail || "";
      const lines = inv.items?.map((item) => `  ${item.description} — ${item.qty} × ${fmt(Number(item.rate))} = ${fmt((Number(item.qty) || 0) * (Number(item.rate) || 0))}`).join("\n") || "";
      const body = `Hi${inv.contact ? " " + inv.contact : ""},\n\nPlease find ${dt} ${inv.number} from ${bizInfo?.name || "us"} below.\n\nDate: ${fmtDate(inv.date)}${inv.dueDate ? "\nDue: " + fmtDate(inv.dueDate) : ""}\n\nItems:\n${lines}\n\nSubtotal: ${fmt(inv.subtotal || 0)}\nGST: ${fmt(inv.gst || 0)}\nTotal: ${fmt(inv.total || 0)}${inv.notes ? "\n\nNotes: " + inv.notes : ""}\n\nKind regards,\n${bizInfo?.name || "MT Management"}`;
      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(`${dt} ${inv.number} from ${bizInfo?.name || "MT Management"}`)}&body=${encodeURIComponent(body)}`;
      window.open(gmailUrl, "_blank");
      if (inv.status === "draft") updateInvoice(inv.id, { status: "sent" });
    };

    const [filter, setFilter] = useState("all");
    const sorted = [...invoices].sort((a, b) => b.date.localeCompare(a.date));
    const filtered = sorted.filter((i) => filter === "all" || i.status === filter);
    const statusColors = { draft: "#64748b", sent: "#3b82f6", paid: "#34d399", overdue: "#ef4444" };
    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {["all", "draft", "sent", "paid", "overdue"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} style={{ ...s.btnOutline, background: filter === f ? accent + "20" : "transparent", color: filter === f ? accent : "#94a3b8", borderColor: filter === f ? accent : "#2a2d3e" }}>{f.charAt(0).toUpperCase() + f.slice(1)}</button>
          ))}
        </div>
        <div style={s.card}>
          {filtered.length === 0 ? (
            <div style={{ color: "#64748b", padding: "30px 0", textAlign: "center" }}>No invoices yet</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={s.table}>
                <thead><tr>
                  <th style={s.th}>Number</th><th style={s.th}>Date</th><th style={s.th}>Contact</th><th style={s.th}>Status</th>
                  <th style={{ ...s.th, textAlign: "right" }}>Total</th><th style={{ ...s.th, width: 80 }}></th>
                </tr></thead>
                <tbody>{filtered.map((inv) => (
                  <tr key={inv.id}>
                    <td style={{ ...s.td, fontWeight: 600 }}>{inv.number}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{fmtDate(inv.date)}</td>
                    <td style={s.td}>{inv.contact || "—"}</td>
                    <td style={s.td}><span style={s.badge(statusColors[inv.status] || "#64748b")}>{inv.status}</span></td>
                    <td style={{ ...s.td, textAlign: "right", fontWeight: 600 }}>{fmt(inv.total || 0)}</td>
                    <td style={{ ...s.td, display: "flex", gap: 4 }}>
                      <button onClick={() => sendInvoice(inv)} title="Send" style={{ background: "none", border: "none", color: accent, cursor: "pointer", padding: 2 }}><Icons.Send /></button>
                      <button onClick={() => { setEditItem(inv); setModal("invoice"); }} title="Edit" style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 2 }}><Icons.Edit /></button>
                      {inv.status !== "paid" && <button onClick={() => updateInvoice(inv.id, { status: "paid" })} title="Mark Paid" style={{ background: "none", border: "none", color: "#34d399", cursor: "pointer", padding: 2 }}><Icons.Check /></button>}
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
                    <td style={{ ...s.td, color: "#94a3b8" }}>{c.company || "—"}</td>
                    <td style={{ ...s.td, color: "#94a3b8", fontSize: 11 }}>{c.email || "—"}</td>
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

  const AccountsPage = () => {
    const grouped = {};
    ["Asset", "Liability", "Equity", "Revenue", "Expense"].forEach((t) => { grouped[t] = accounts.filter((a) => a.type === t).sort((a, b) => a.code.localeCompare(b.code)); });
    const typeColors = { Asset: "#3b82f6", Liability: "#ef4444", Equity: "#8b5cf6", Revenue: "#34d399", Expense: "#f59e0b" };
    return (
      <div>
        {Object.entries(grouped).map(([type, accs]) => (
          <div key={type} style={{ ...s.card, marginBottom: 10 }}>
            <h4 style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 700, color: typeColors[type] }}>{type} Accounts</h4>
            <table style={s.table}><tbody>
              {accs.map((a) => (
                <tr key={a.code}>
                  <td style={{ ...s.td, fontFamily: "monospace", fontSize: 11, color: "#94a3b8", width: 60 }}>{a.code}</td>
                  <td style={s.td}>{a.name}</td>
                  <td style={{ ...s.td, width: 30 }}><button onClick={() => deleteAccount(a.code)} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", padding: 2 }}><Icons.Trash /></button></td>
                </tr>
              ))}
            </tbody></table>
          </div>
        ))}
      </div>
    );
  };

  const ReportsPage = () => {
    const { revenue, expenses, gstCollected, gstPaid, byAccount, allRevenue, allExpenses, allGstCollected, allGstPaid, unpaidInvoices, periodTxns } = reportCalcs;
    const [ryr, rmo] = reportPeriod.split("-").map(Number);
    const periodLabel = new Date(ryr, rmo - 1).toLocaleDateString("en-AU", { month: "long", year: "numeric" });

    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          {[{ id: "pnl", label: "P&L" }, { id: "balance", label: "Balance Sheet" }, { id: "gst", label: "GST" }].map((r) => (
            <button key={r.id} onClick={() => setReportType(r.id)} style={{ ...s.btnOutline, background: reportType === r.id ? accent + "20" : "transparent", color: reportType === r.id ? accent : "#94a3b8" }}>{r.label}</button>
          ))}
          <input type="month" value={reportPeriod} onChange={(e) => setReportPeriod(e.target.value)} style={{ ...s.input, width: "auto", marginLeft: "auto" }} />
        </div>

        {reportType === "pnl" && (
          <div style={s.card}>
            <h4 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700 }}>Profit & Loss — {periodLabel}</h4>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#34d399", textTransform: "uppercase", marginBottom: 6 }}>Revenue</div>
              {Object.entries(byAccount).filter(([_, v]) => v.income > 0).map(([acct, v]) => (
                <div key={acct} style={{ display: "flex", justifyContent: "space-between", padding: "3px 10px", fontSize: 13 }}><span style={{ color: "#94a3b8" }}>{acct}</span><span>{fmt(v.income)}</span></div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderTop: "1px solid #1e2130", marginTop: 4, fontWeight: 700, color: "#34d399" }}><span>Total Revenue</span><span>{fmt(revenue)}</span></div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#f87171", textTransform: "uppercase", marginBottom: 6 }}>Expenses</div>
              {Object.entries(byAccount).filter(([_, v]) => v.expense > 0).map(([acct, v]) => (
                <div key={acct} style={{ display: "flex", justifyContent: "space-between", padding: "3px 10px", fontSize: 13 }}><span style={{ color: "#94a3b8" }}>{acct}</span><span>{fmt(v.expense)}</span></div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderTop: "1px solid #1e2130", marginTop: 4, fontWeight: 700, color: "#f87171" }}><span>Total Expenses</span><span>{fmt(expenses)}</span></div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: 12, background: "#0f1117", borderRadius: 8, fontSize: 16, fontWeight: 700 }}>
              <span>Net Profit</span><span style={{ color: revenue - expenses >= 0 ? "#34d399" : "#f87171" }}>{fmt(revenue - expenses)}</span>
            </div>
          </div>
        )}

        {reportType === "balance" && (
          <div style={s.card}>
            <h4 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700 }}>Balance Sheet — {periodLabel}</h4>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#3b82f6", textTransform: "uppercase", marginBottom: 6 }}>Assets</div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 10px", fontSize: 13 }}><span style={{ color: "#94a3b8" }}>Cash at Bank (net)</span><span>{fmt(allRevenue - allExpenses)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 10px", fontSize: 13 }}><span style={{ color: "#94a3b8" }}>Accounts Receivable</span><span>{fmt(unpaidInvoices)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", borderTop: "1px solid #1e2130", marginTop: 4, fontWeight: 700, color: "#3b82f6" }}><span>Total Assets</span><span>{fmt(allRevenue - allExpenses + unpaidInvoices)}</span></div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#ef4444", textTransform: "uppercase", marginBottom: 6 }}>Liabilities</div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 10px", fontSize: 13 }}><span style={{ color: "#94a3b8" }}>GST Payable</span><span>{fmt(allGstCollected - allGstPaid)}</span></div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#8b5cf6", textTransform: "uppercase", marginBottom: 6 }}>Equity</div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 10px", fontSize: 13 }}><span style={{ color: "#94a3b8" }}>Retained Earnings</span><span>{fmt(allRevenue - allExpenses - (allGstCollected - allGstPaid))}</span></div>
            </div>
          </div>
        )}

        {reportType === "gst" && (
          <div style={s.card}>
            <h4 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 700 }}>GST Summary — {periodLabel}</h4>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", fontSize: 13 }}><span style={{ color: "#94a3b8" }}>GST Collected on Sales</span><span>{fmt(gstCollected)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", fontSize: 13 }}><span style={{ color: "#94a3b8" }}>GST Paid on Purchases</span><span>{fmt(gstPaid)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", padding: 12, background: "#0f1117", borderRadius: 8, marginTop: 8, fontSize: 16, fontWeight: 700 }}>
              <span>{gstCollected - gstPaid >= 0 ? "GST Payable to ATO" : "GST Refund from ATO"}</span>
              <span style={{ color: gstCollected - gstPaid >= 0 ? "#f87171" : "#34d399" }}>{fmt(Math.abs(gstCollected - gstPaid))}</span>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: "#64748b" }}>{periodTxns.filter((t) => t.gst).length} GST-inclusive transactions. Amounts = 1/11th of totals.</div>
          </div>
        )}
      </div>
    );
  };

  const pageMap = { dashboard: DashboardPage, transactions: TransactionsPage, invoices: InvoicesPage, contacts: ContactsPage, accounts: AccountsPage, reports: ReportsPage };
  const PageComponent = pageMap[page] || DashboardPage;

  const SidebarContent = () => (
    <>
      <div style={s.logo}>
        <div style={{ fontSize: 17, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em" }}>BookKeeper</div>
        <div style={{ fontSize: 10, color: "#64748b", marginTop: 2, textTransform: "uppercase", letterSpacing: "0.08em" }}>MT Management</div>
      </div>
      <div style={s.bizSwitcher}>
        {data.businesses.map((b) => (
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
      <div style={{ padding: 12, borderTop: "1px solid #1e2130", display: "flex", flexDirection: "column", gap: 4 }}>
        <button onClick={logout} style={{ ...s.btnOutline, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11 }}><Icons.Logout /> Sign Out</button>
        <button onClick={resetData} style={{ ...s.btnOutline, width: "100%", fontSize: 10, color: "#475569" }}>Reset Data</button>
      </div>
    </>
  );

  return (
    <>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <style>{`@media(max-width:768px){.bk-sidebar-desktop{display:none!important}.bk-hamburger{display:flex!important}} @media(min-width:769px){.bk-sidebar-mobile{display:none!important}.bk-hamburger{display:none!important}}`}</style>
      <div style={s.app}>
        {/* Desktop sidebar */}
        <div className="bk-sidebar-desktop" style={s.sidebar}><SidebarContent /></div>

        {/* Mobile sidebar overlay */}
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
              {(page === "transactions" || page === "dashboard") && <button onClick={() => setModal("transaction")} style={s.btn(accent, true)}><Icons.Plus /> Transaction</button>}
              {page === "invoices" && <button onClick={() => { setEditItem(null); setModal("invoice"); }} style={s.btn(accent, true)}><Icons.Plus /> Invoice</button>}
              {page === "contacts" && <button onClick={() => setModal("contact")} style={s.btn(accent, true)}><Icons.Plus /> Contact</button>}
              {page === "accounts" && <button onClick={() => setModal("account")} style={s.btn(accent, true)}><Icons.Plus /> Account</button>}
            </div>
          </div>
          <div style={s.content}><PageComponent /></div>
        </div>

        {modal && (
          <div style={s.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) { setModal(null); setEditItem(null); } }}>
            <div style={s.modalContent}>
              {modal === "transaction" && <TransactionForm />}
              {modal === "contact" && <ContactForm />}
              {modal === "account" && <AccountForm />}
              {modal === "invoice" && <InvoiceForm existing={editItem} />}
              {modal === "receipt" && <ReceiptCapture />}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
