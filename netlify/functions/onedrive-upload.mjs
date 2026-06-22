import { createClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import { encryptToken, decryptToken } from "./lib/token-crypto.mjs";
import { wrapCors } from './lib/cors.mjs';

// Save an invoice PDF or expense receipt into the user's OneDrive. Invoices go
// into the matching job folder under onedrive_folder. Receipts are converted to
// PDF and saved flat in onedrive_receipts_folder (falling back to onedrive_folder).

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const SCOPES = "offline_access User.Read Mail.Send Mail.ReadWrite Files.ReadWrite";
const APP_URL = process.env.URL || "https://bkeeper.netlify.app";
const GRAPH = "https://graph.microsoft.com/v1.0";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY
);

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

async function fetchWithTimeout(url, options, ms = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(t); }
}

async function refreshAccessToken(connId, refreshTok) {
  if (!refreshTok) return null;
  const resp = await fetchWithTimeout("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshTok, grant_type: "refresh_token", scope: SCOPES }),
  });
  if (!resp.ok) { console.error("Token refresh failed:", resp.status); return null; }
  const tokens = await resp.json();
  await supabase.from("bk_email_connections").update({
    access_token: encryptToken(tokens.access_token),
    refresh_token: encryptToken(tokens.refresh_token || refreshTok),
    expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", connId);
  return tokens.access_token;
}

const encPath = (p) => String(p || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
const sanitize = (s) => String(s || "").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
const sanitizePart = (s) => String(s || "").replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();

async function listChildren(token, basePath) {
  const seg = encPath(basePath);
  let url = seg ? `${GRAPH}/me/drive/root:/${seg}:/children?$select=id,name,folder&$top=200`
               : `${GRAPH}/me/drive/root/children?$select=id,name,folder&$top=200`;
  const items = [];
  while (url) {
    const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { status: r.status, items };
    const j = await r.json();
    items.push(...(j.value || []));
    url = j["@odata.nextLink"] || null;
  }
  return { items };
}

async function createFolder(token, basePath, name) {
  const seg = encPath(basePath);
  const url = seg ? `${GRAPH}/me/drive/root:/${seg}:/children` : `${GRAPH}/me/drive/root/children`;
  const r = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
  });
  if (!r.ok) return { status: r.status };
  const j = await r.json();
  return { id: j.id, name: j.name };
}

async function resolveFolder(token, basePath, jobNumber, jobLabel, fallbackName) {
  const { items, status } = await listChildren(token, basePath);
  if (status) return { status };
  if (jobNumber) {
    const match = items.find((c) => c.folder && String(c.name).startsWith(String(jobNumber)));
    if (match) return { id: match.id, name: match.name };
    return createFolder(token, basePath, sanitize(jobLabel ? `${jobNumber} - ${jobLabel}` : String(jobNumber)));
  }
  const fb = items.find((c) => c.folder && c.name === fallbackName);
  if (fb) return { id: fb.id, name: fb.name };
  return createFolder(token, basePath, fallbackName);
}

async function ensureFolderPath(token, fullPath) {
  const parts = String(fullPath || "").split("/").filter(Boolean);
  if (!parts.length) return { status: 400 };
  let currentPath = "";
  for (const name of parts) {
    const parentPath = currentPath;
    currentPath = currentPath ? `${currentPath}/${name}` : name;
    const { items, status } = await listChildren(token, parentPath);
    if (status === 401) return { auth: true };
    if (status) return { status };
    const existing = items.find((c) => c.folder && c.name === name);
    if (existing) continue;
    const created = await createFolder(token, parentPath, name);
    if (created.status === 401) return { auth: true };
    if (created.status) return { status: created.status };
  }
  return { path: fullPath };
}

async function uploadToFolder(token, folderId, fileName, buffer, contentType) {
  const url = `${GRAPH}/me/drive/items/${folderId}:/${encodeURIComponent(fileName)}:/content`;
  return fetchWithTimeout(url, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType }, body: buffer }, 30000);
}

async function uploadToDrivePath(token, folderPath, fileName, buffer, contentType) {
  const seg = encPath(folderPath);
  const url = `${GRAPH}/me/drive/root:/${seg}/${encodeURIComponent(fileName)}:/content`;
  return fetchWithTimeout(url, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType }, body: buffer }, 30000);
}

async function imageToPdf(imageBuffer, ext) {
  const pdfDoc = await PDFDocument.create();
  const image = ext === "png"
    ? await pdfDoc.embedPng(imageBuffer)
    : await pdfDoc.embedJpg(imageBuffer);
  const { width, height } = image.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(image, { x: 0, y: 0, width, height });
  return Buffer.from(await pdfDoc.save());
}

function receiptPdfName(tx) {
  const date = tx.date || "undated";
  const vendor = sanitizePart(tx.merchant || tx.contact || tx.description || "receipt") || "receipt";
  const amount = Number(tx.amount || 0).toFixed(2);
  const category = sanitizePart(tx.account || "Uncategorised") || "Uncategorised";
  return `${date}_${vendor}_${amount}_${category}.pdf`.slice(0, 200);
}

const handler = async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const authHeader = req.headers.get("authorization");
  const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { kind, id } = body;
  if (!authToken || !kind || !id) return json({ error: "kind, id and Authorization required" }, 400);

  const userClient = createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  );
  const { data: { user } } = await userClient.auth.getUser(authToken);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let businessId, fileBuffer, fileName, contentType, jobNumber, jobLabel, fallbackName;
  let receiptFolderPath = null;

  if (kind === "invoice") {
    let { data: inv } = await supabase.from("bk_invoices").select("*").eq("id", id).single();
    if (!inv || inv.user_id !== user.id) return json({ error: "Invoice not found" }, 404);
    businessId = inv.business_id;
    if (!inv.pdf_path) {
      const gen = await fetchWithTimeout(`${APP_URL}/.netlify/functions/generate-invoice-pdf`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoice_id: id, auth_token: authToken }),
      }, 60000);
      if (!gen.ok) return json({ error: "Could not generate the invoice PDF" }, 502);
      const g = await gen.json();
      inv.pdf_path = g.pdf_path;
    }
    const { data: pdfData, error: pErr } = await supabase.storage.from("invoices").download(inv.pdf_path);
    if (pErr || !pdfData) return json({ error: "Could not load the invoice PDF" }, 500);
    fileBuffer = Buffer.from(await pdfData.arrayBuffer());
    contentType = "application/pdf";
    const docType = inv.type === "quote" ? "Quote" : "Invoice";
    fileName = sanitize(`${docType} ${inv.number || id}`) + ".pdf";
    fallbackName = "Unfiled Invoices";
    const { data: jobsList } = await supabase.from("bk_jobs").select("id,job_number,name,address").eq("business_id", businessId);
    let job = inv.project_id ? (jobsList || []).find((j) => j.id === inv.project_id) : null;
    if (!job && inv.job) job = (jobsList || []).find((j) => j.address === inv.job || j.name === inv.job);
    if (job) { jobNumber = job.job_number; jobLabel = job.address || job.name; }
  } else if (kind === "expense") {
    const { data: tx } = await supabase.from("bk_transactions").select("*").eq("id", id).single();
    if (!tx || tx.user_id !== user.id) return json({ error: "Expense not found" }, 404);
    if (!tx.receipt_path) return json({ error: "This expense has no receipt to save" }, 400);
    businessId = tx.business_id;
    const { data: rData, error: rErr } = await supabase.storage.from("receipts").download(tx.receipt_path);
    if (rErr || !rData) return json({ error: "Could not load the receipt" }, 500);
    const rawBuffer = Buffer.from(await rData.arrayBuffer());
    const ext = (tx.receipt_path.split(".").pop() || "jpg").toLowerCase();
    if (ext === "pdf") {
      fileBuffer = rawBuffer;
    } else if (ext === "png" || ext === "jpg" || ext === "jpeg") {
      try {
        fileBuffer = await imageToPdf(rawBuffer, ext === "png" ? "png" : "jpg");
      } catch (err) {
        console.error("Receipt PDF conversion failed:", err);
        return json({ error: "Could not convert receipt to PDF" }, 500);
      }
    } else {
      return json({ error: "Unsupported receipt format" }, 400);
    }
    contentType = "application/pdf";
    fileName = receiptPdfName(tx);
  } else {
    return json({ error: "Unknown kind" }, 400);
  }

  const { data: conn } = await supabase.from("bk_email_connections")
    .select("*").eq("user_id", user.id).eq("business_id", businessId).eq("provider", "outlook").single();
  if (!conn) return json({ error: "Connect Microsoft in Settings first" }, 400);

  let accessToken, refreshTok;
  try {
    accessToken = decryptToken(conn.access_token);
    refreshTok = conn.refresh_token ? decryptToken(conn.refresh_token) : null;
  } catch { return json({ error: "Microsoft connection needs reconnecting" }, 401); }

  if (new Date(conn.expires_at) < new Date()) {
    accessToken = await refreshAccessToken(conn.id, refreshTok);
    if (!accessToken) return json({ error: "Reconnect Microsoft in Settings" }, 401);
  }

  const { data: profile } = await supabase.from("bk_profiles").select("onedrive_folder, onedrive_receipts_folder").eq("user_id", user.id).eq("business_id", businessId).maybeSingle();
  const projectsBase = (profile?.onedrive_folder || "Mworx Group").trim();
  const receiptsBase = (profile?.onedrive_receipts_folder || "").trim();

  if (kind === "expense") {
    receiptFolderPath = receiptsBase || projectsBase;
  }

  const run = async (tok) => {
    if (kind === "expense") {
      const ensured = await ensureFolderPath(tok, receiptFolderPath);
      if (ensured.auth) return { auth: true };
      if (ensured.status) {
        if (ensured.status === 404) {
          return { error: `OneDrive receipts folder not found — check "${receiptFolderPath}" exists in Settings` };
        }
        return { error: `OneDrive folder error (${ensured.status})` };
      }
      const up = await uploadToDrivePath(tok, receiptFolderPath, fileName, fileBuffer, contentType);
      if (up.status === 401) return { auth: true };
      if (up.status === 404) {
        return { error: `OneDrive receipts folder not found — check "${receiptFolderPath}" exists in Settings` };
      }
      if (!up.ok) {
        let e = "";
        try { e = JSON.stringify(await up.json()); } catch { /* ignore */ }
        return { error: `OneDrive upload failed (${up.status})`, detail: e };
      }
      const item = await up.json();
      return { ok: true, webUrl: item.webUrl, savedTo: `${receiptFolderPath}/${fileName}` };
    }

    const folder = await resolveFolder(tok, projectsBase, jobNumber, jobLabel, fallbackName);
    if (folder.status === 401) return { auth: true };
    if (folder.status || !folder.id) return { error: `OneDrive folder error (${folder.status || "unknown"})` };
    const up = await uploadToFolder(tok, folder.id, fileName, fileBuffer, contentType);
    if (up.status === 401) return { auth: true };
    if (!up.ok) {
      let e = "";
      try { e = JSON.stringify(await up.json()); } catch { /* ignore */ }
      return { error: `OneDrive upload failed (${up.status})`, detail: e };
    }
    const item = await up.json();
    return { ok: true, webUrl: item.webUrl, savedTo: `${folder.name}/${fileName}` };
  };

  let res = await run(accessToken);
  if (res.auth && refreshTok) {
    const nt = await refreshAccessToken(conn.id, refreshTok);
    if (nt) res = await run(nt);
  }
  if (res.auth) return json({ error: "OneDrive permission not granted — reconnect Microsoft in Settings to enable it" }, 401);
  if (res.error) { console.error("OneDrive save failed:", res.error, res.detail || ""); return json({ error: res.error }, 502); }
  return json({ success: true, webUrl: res.webUrl, savedTo: res.savedTo }, 200);
};

export default wrapCors(handler);
