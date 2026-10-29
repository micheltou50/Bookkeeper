// In-process stand-in for the Supabase REST surface the app talks to, for
// browser regression runs against an isolated fixture set. It answers the
// GoTrue password login, PostgREST reads / writes / RPC with the filters the
// app uses (eq, neq, in, is, lt, gt, not, order, limit, single), and the
// Netlify functions the UI calls — recording every request so a run can be
// compared with another build. Nothing here touches the real project: the
// bundle under test is built with VITE_SUPABASE_URL=https://mock-supabase.test.
import crypto from "node:crypto";

export const MOCK_HOST = "mock-supabase.test";
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const USER_EMAIL = "tester@example.test";
export const PASSWORD = "correct horse battery staple";

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function makeSession() {
  const now = Math.floor(Date.now() / 1000);
  const jwt = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: USER_ID, email: USER_EMAIL, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, session_id: "mock-session" })}.${b64url({ sig: "mock" })}`;
  const user = { id: USER_ID, aud: "authenticated", role: "authenticated", email: USER_EMAIL, email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
  return { access_token: jwt, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "mock-refresh-token", user };
}

export const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// --- filters -------------------------------------------------------------
function parseValue(v) {
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  return v;
}
function splitList(s) {
  // in.(a,b,"c d")
  const inner = s.replace(/^\(/, "").replace(/\)$/, "");
  return inner.split(",").map((x) => x.trim().replace(/^"(.*)"$/, "$1"));
}
function matches(row, col, expr) {
  let negate = false;
  if (expr.startsWith("not.")) { negate = true; expr = expr.slice(4); }
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  const val = row[col];
  let ok;
  switch (op) {
    case "eq": ok = String(val) === raw && val !== null && val !== undefined; break;
    case "neq": ok = String(val) !== raw; break;
    case "gt": ok = val != null && String(val) > raw; break;
    case "gte": ok = val != null && String(val) >= raw; break;
    case "lt": ok = val != null && String(val) < raw; break;
    case "lte": ok = val != null && String(val) <= raw; break;
    case "is": ok = raw === "null" ? (val === null || val === undefined) : val === parseValue(raw); break;
    case "in": ok = splitList(raw).includes(String(val)); break;
    case "like": ok = new RegExp("^" + raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/\*/g, ".*") + "$").test(String(val ?? "")); break;
    case "ilike": ok = new RegExp("^" + raw.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/\*/g, ".*") + "$", "i").test(String(val ?? "")); break;
    default: throw new Error(`mock-supabase: unsupported operator ${op} on ${col}`);
  }
  return negate ? !ok : ok;
}
function applyFilters(rows, params) {
  const reserved = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
  const filters = [];
  for (const [k, v] of params) if (!reserved.has(k)) filters.push([k, v]);
  let out = rows.filter((r) => filters.every(([c, e]) => matches(r, c, e)));
  const order = params.get("order");
  if (order) {
    const keys = order.split(",").map((o) => { const [col, dir, nulls] = o.split("."); return { col, desc: dir === "desc", nullsFirst: nulls === "nullsfirst" }; });
    out = [...out].sort((a, b) => {
      for (const k of keys) {
        const x = a[k.col], y = b[k.col];
        if (x == null && y == null) continue;
        if (x == null) return k.nullsFirst ? -1 : 1;
        if (y == null) return k.nullsFirst ? 1 : -1;
        if (x < y) return k.desc ? 1 : -1;
        if (x > y) return k.desc ? -1 : 1;
      }
      return 0;
    });
  }
  const offset = Number(params.get("offset") || 0);
  const limit = params.get("limit");
  out = out.slice(offset, limit != null ? offset + Number(limit) : undefined);
  return { rows: out, filters };
}
function project(rows, select) {
  if (!select || select === "*") return rows;
  const cols = select.split(",").map((c) => c.trim()).filter((c) => c && !c.includes("("));
  if (cols.includes("*")) return rows;
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
}

// --- the database -------------------------------------------------------
export class MockDb {
  constructor(fixtures) {
    this.tables = {};
    for (const [t, rows] of Object.entries(fixtures)) this.tables[t] = rows.map((r) => ({ ...r }));
    this.log = [];
    this.functions = [];
    this.alerts = [];
  }
  table(name) { return (this.tables[name] ||= []); }
  // Server-side rules the live project applies, so the browser sees what
  // production would. Keep these to the rules that exist on the live database.
  beforeInsert(table, row) {
    if (!row.id) row.id = uuid();
    if (!row.created_at) row.created_at = nowIso();
    if (table === "bk_jobs") {
      // bk_jobs_number_guard (migration 0034): fill a missing number, correct a
      // purely numeric number of the wrong length, refuse a duplicate.
      const energy = row.division === "mworx_energy";
      const digits = energy ? 6 : 5;
      const num = String(row.job_number || "").trim();
      const taken = this.table("bk_jobs").some((j) => j.business_id === row.business_id && String(j.job_number) === num);
      if (!num || (/^\d+$/.test(num) && num.length !== digits)) row.job_number = this.nextJobNumber(row.business_id, row.division);
      else if (taken) throw { status: 409, body: { code: "23505", message: `Job number ${num} is already used by another project`, details: null, hint: null } };
      if (!row.status) row.status = "active";
      if (!row.last_used_at) row.last_used_at = nowIso();
      const lname = (row.name || "").trim().toLowerCase();
      if (this.table("bk_jobs").some((j) => j.business_id === row.business_id && (j.name || "").trim().toLowerCase() === lname))
        throw { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "bk_jobs_business_lower_name_idx"', details: `Key (business_id, lower(name))=(${row.business_id}, ${lname}) already exists.`, hint: null } };
    }
    if (table === "bk_invoices") {
      if (this.table("bk_invoices").some((i) => i.business_id === row.business_id && i.number === row.number))
        throw { status: 409, body: { code: "23505", message: 'duplicate key value violates unique constraint "bk_invoices_business_number_idx"', details: `Key (business_id, number)=(${row.business_id}, ${row.number}) already exists.`, hint: null } };
      if (!row.status) row.status = "draft";
    }
    if (table === "bk_contacts" && !row.type) row.type = "client";
    return row;
  }
  nextJobNumber(business, division) {
    const yy = String(new Date().getFullYear()).slice(-2);
    const energy = division === "mworx_energy";
    const digits = energy ? 6 : 5;
    const nums = this.table("bk_jobs").filter((j) => j.business_id === business && ((j.division === "mworx_energy") === energy))
      .map((j) => String(j.job_number || "")).filter((n) => /^\d+$/.test(n) && n.startsWith(yy) && n.length === digits).map(Number);
    return String(nums.length ? Math.max(...nums) + 1 : Number(energy ? `${yy}1001` : `${yy}101`));
  }
  afterUpdate(table, before, after) {
    if (table === "bk_invoices") {
      // bk_inbox_follow_invoice (migration 0030): a paid / sent invoice closes
      // its open money item; a sent / accepted quote closes its proposal item.
      for (const it of this.table("bk_inbox_items")) {
        if (it.invoice_id !== after.id || it.status !== "open") continue;
        if (it.kind === "money" && ["sent", "paid"].includes(after.status) && after.status !== before.status) { it.status = "done"; it.done_at = nowIso(); }
        if (it.kind === "proposal" && ["sent", "accepted"].includes(after.status) && after.status !== before.status) { it.status = "done"; it.done_at = nowIso(); }
      }
    }
  }
}

// --- request handling ---------------------------------------------------
function json(route, status, body, extra = {}) {
  return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", ...extra }, body: body === undefined ? "" : JSON.stringify(body) });
}

export async function handleSupabase(route, db) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  const headers = req.headers();
  const entry = { at: Date.now(), method, path: url.pathname, query: Object.fromEntries(url.searchParams), prefer: headers.prefer || null, accept: headers.accept || null, body: null, status: null };
  const post = req.postData();
  if (post) { try { entry.body = JSON.parse(post); } catch { entry.body = post; } }
  db.log.push(entry);
  if (method === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  try {
    // GoTrue
    if (url.pathname.startsWith("/auth/v1/")) {
      const p = url.pathname.slice("/auth/v1/".length);
      if (p === "token") {
        const grant = url.searchParams.get("grant_type");
        if (grant === "password") {
          if (entry.body?.email === USER_EMAIL && entry.body?.password === PASSWORD) { entry.status = 200; return json(route, 200, makeSession()); }
          entry.status = 400; return json(route, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        }
        if (grant === "refresh_token") { entry.status = 200; return json(route, 200, makeSession()); }
      }
      if (p === "user" && method === "GET") { entry.status = 200; return json(route, 200, makeSession().user); }
      if (p === "logout") { entry.status = 204; return json(route, 204, undefined); }
      entry.status = 404; return json(route, 404, { msg: `mock: no auth route ${p}` });
    }
    // PostgREST
    if (url.pathname.startsWith("/rest/v1/")) {
      const name = url.pathname.slice("/rest/v1/".length);
      const wantObject = /vnd\.pgrst\.object/.test(headers.accept || "");
      const prefer = headers.prefer || "";
      const representation = /return=representation/.test(prefer);
      if (name.startsWith("rpc/")) {
        const fn = name.slice(4);
        entry.rpc = fn;
        db.functions.push({ fn, args: entry.body });
        const res = db.rpc?.[fn] ? db.rpc[fn](entry.body, db) : null;
        if (res && res.error) { entry.status = 400; return json(route, 400, res.error); }
        entry.status = 200; return json(route, 200, res ?? null);
      }
      const rows = db.table(name);
      const respond = (out) => {
        if (wantObject) {
          if (out.length !== 1) { entry.status = 406; return json(route, 406, { code: "PGRST116", message: `JSON object requested, multiple (or no) rows returned`, details: `The result contains ${out.length} rows`, hint: null }); }
          entry.status = 200; return json(route, 200, project(out, url.searchParams.get("select"))[0], { "content-range": "0-0/*" });
        }
        entry.status = 200; return json(route, 200, project(out, url.searchParams.get("select")), { "content-range": `0-${Math.max(out.length - 1, 0)}/*` });
      };
      if (method === "GET" || method === "HEAD") {
        const { rows: out } = applyFilters(rows, url.searchParams);
        return respond(out);
      }
      if (method === "POST") {
        const list = Array.isArray(entry.body) ? entry.body : [entry.body];
        const upsert = /resolution=merge-duplicates/.test(prefer);
        const inserted = [];
        for (const r of list) {
          const row = { ...r };
          if (upsert) {
            const key = url.searchParams.get("on_conflict") || "id";
            const keys = key.split(",");
            const idx = rows.findIndex((x) => keys.every((k) => String(x[k]) === String(row[k])));
            if (idx >= 0) { rows[idx] = { ...rows[idx], ...row, updated_at: nowIso() }; inserted.push(rows[idx]); continue; }
          }
          db.beforeInsert(name, row);
          rows.push(row);
          inserted.push(row);
        }
        entry.written = inserted.map((r) => r.id);
        if (!representation) { entry.status = 201; return json(route, 201, undefined); }
        return respond(inserted);
      }
      if (method === "PATCH") {
        const { rows: targets, filters } = applyFilters(rows, url.searchParams);
        if (!filters.length) throw { status: 400, body: { code: "21000", message: "mock: PATCH without a filter is refused" } };
        const out = [];
        for (const t of targets) {
          const before = { ...t };
          Object.assign(t, entry.body, { updated_at: nowIso() });
          db.afterUpdate(name, before, t);
          out.push(t);
        }
        entry.written = out.map((r) => r.id);
        if (!representation) { entry.status = 204; return json(route, 204, undefined); }
        return respond(out);
      }
      if (method === "DELETE") {
        const { rows: targets, filters } = applyFilters(rows, url.searchParams);
        if (!filters.length) throw { status: 400, body: { code: "21000", message: "mock: DELETE without a filter is refused" } };
        const ids = new Set(targets.map((t) => t.id));
        db.tables[name] = rows.filter((r) => !ids.has(r.id));
        entry.written = [...ids];
        if (!representation) { entry.status = 204; return json(route, 204, undefined); }
        return respond(targets);
      }
    }
    if (url.pathname.startsWith("/storage/v1/")) { entry.status = 404; return json(route, 404, { error: "mock: no storage" }); }
    entry.status = 404; return json(route, 404, { error: `mock: no route ${url.pathname}` });
  } catch (e) {
    if (e && e.status) { entry.status = e.status; entry.error = e.body; return json(route, e.status, e.body); }
    entry.status = 500; entry.error = String(e && e.stack || e);
    return json(route, 500, { message: String(e && e.message || e) });
  }
}

// Netlify functions the UI calls: answer the way the real ones do on success and
// record the call. The PDF "signed URL" points back at the app origin.
export async function handleFunction(route, db, appOrigin) {
  const req = route.request();
  const url = new URL(req.url());
  const fn = url.pathname.slice("/.netlify/functions/".length);
  let body = null; try { body = JSON.parse(req.postData() || "null"); } catch { body = req.postData(); }
  const hasBearer = /^Bearer /.test(req.headers().authorization || "");
  db.functions.push({ fn, method: req.method(), query: Object.fromEntries(url.searchParams), body, bearer: hasBearer });
  switch (fn) {
    case "generate-invoice-pdf": return json(route, 200, { signed_url: `${appOrigin}/__mock/pdf/${body?.invoice_id || "x"}.pdf`, path: `invoices/${body?.invoice_id}.pdf` });
    case "onedrive-upload": return json(route, 200, { ok: true, savedTo: `Mock Company/Admin/${body?.kind === "quote" ? "Quotes" : "Invoices"}/mock.pdf` });
    case "send-invoice-outlook": {
      // The live function flips draft → sent and stamps sent_at in the database.
      const inv = db.table("bk_invoices").find((i) => i.id === body?.invoice_id);
      if (inv) { const before = { ...inv }; if (inv.status === "draft") inv.status = "sent"; inv.sent_at = inv.sent_at || nowIso(); db.afterUpdate("bk_invoices", before, inv); }
      return json(route, 200, { ok: true, sent_to: inv?.contact_email || body?.to_override || "", message_id: "mock-message" });
    }
    case "send-reminders": return json(route, 200, { ok: true, dryRun: url.searchParams.get("dryRun") === "1", would_send: [], sent: [] });
    case "outlook-oauth-start": return json(route, 200, { url: "https://login.microsoftonline.com/mock" });
    default: return json(route, 404, { error: `mock: no function ${fn}` });
  }
}

export async function installMock(context, db, { appOrigin }) {
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === MOCK_HOST) return handleSupabase(route, db);
    if (u.origin === appOrigin) {
      if (u.pathname.startsWith("/.netlify/functions/")) return handleFunction(route, db, appOrigin);
      if (u.pathname.startsWith("/__mock/pdf/")) return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4\n%mock\n" });
      return route.continue();
    }
    // Nothing else may leave the sandbox: fonts, analytics, the real project.
    db.log.push({ at: Date.now(), method: route.request().method(), path: u.href, blocked: true });
    return route.abort("blockedbyclient");
  });
}
