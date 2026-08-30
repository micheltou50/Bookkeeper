import { createClient } from "@supabase/supabase-js";
import { encryptToken, decryptToken } from "./lib/token-crypto.mjs";
import { wrapCors } from './lib/cors.mjs';

// File an invoice/quote PDF into its project folder in the user's OneDrive, or
// create the project folder itself. Receipt filing lived here too until MYOB
// took over expenses.

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const SCOPES = "offline_access User.Read Mail.Send Mail.ReadWrite Files.ReadWrite";
const APP_URL = process.env.URL || "https://bkeeper.netlify.app";
const GRAPH = "https://graph.microsoft.com/v1.0";

// The folder a new project is modelled on. Copying it (rather than creating
// folders from a hard-coded list) means the structure is maintained in OneDrive,
// not here: add a subfolder or drop a template document into the master and every
// project created afterwards inherits it, with no code change and no deploy.
const MASTER_FOLDER_NAME = "00000 - Master Folder";

// Fallback skeleton, used only when the master folder is missing or the copy
// fails. Keep in step with the master's top level.
const PROJECT_SUBFOLDERS = [
  "01 - Admin", "02 - Originals", "03 - Drawings",
  "04 - Consultants", "05 - Submission", "06 - Approvals",
];

// Quotes and invoices live under the admin folder of the project.
const ADMIN_FOLDER_NAME = "01 - Admin";


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
  let url = seg ? `${GRAPH}/me/drive/root:/${seg}:/children?$select=id,name,folder,webUrl&$top=200`
               : `${GRAPH}/me/drive/root/children?$select=id,name,folder,webUrl&$top=200`;
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
  return { id: j.id, name: j.name, webUrl: j.webUrl };
}

// Find a project's folder under basePath, creating it if absent.
//
// A folder created here is a COPY of the master folder, so it arrives with the
// full numbered structure (01 - Admin … 06 - Approvals) and anything the master
// holds. Both callers go through here — project creation and the on-the-fly
// creation when an issued invoice is filed against a project that has no folder
// yet — so a project can never end up with a bare folder just because its
// documents were filed before anyone opened it.
async function resolveFolder(token, basePath, jobNumber, jobLabel, fallbackName) {
  const { items, status } = await listChildren(token, basePath);
  if (status) return { status };

  const wanted = jobNumber
    ? sanitize(jobLabel ? `${jobNumber} - ${jobLabel}` : String(jobNumber))
    : fallbackName;

  // Match on the job number prefix so a folder the user has renamed
  // ("26114 - Smith St (ON HOLD)") is still recognised as that project's.
  const match = jobNumber
    ? items.find((c) => c.folder && String(c.name).startsWith(String(jobNumber)))
    : items.find((c) => c.folder && c.name === fallbackName);
  if (match) return { id: match.id, name: match.name, webUrl: match.webUrl };

  // Never copy the master onto itself, and never treat it as a project folder.
  const master = items.find((c) => c.folder && String(c.name).toLowerCase() === MASTER_FOLDER_NAME.toLowerCase());
  const parent = await getItemByPath(token, basePath);
  if (master && parent.id) {
    const copied = await copyMasterFolder(token, basePath, master.id, parent.id, wanted);
    if (copied.status === 401) return { status: 401 };
    if (copied.id) return copied;
    if (copied.pending) {
      // The copy is still running server-side. Report the folder as created —
      // it will appear shortly — rather than racing it with a second create,
      // which would leave two folders for one project.
      return { id: null, name: wanted, webUrl: parent.webUrl, pending: true };
    }
    // Copy failed outright: fall through and build the skeleton by hand.
  }

  const made = await createFolder(token, basePath, wanted);
  if (made.status || !made.id) return made;
  const seeded = await seedProjectSkeleton(token, made.id);
  if (seeded.auth) return { status: 401 };
  return made;
}

// Find-or-create a folder directly under a parent ITEM ID. Case-insensitive
// match (OneDrive names are case-insensitive; a === check would duplicate a
// user-made "admin" as "Admin 1" thanks to conflictBehavior "rename").
async function ensureChildFolder(token, parentId, name) {
  let url = `${GRAPH}/me/drive/items/${parentId}/children?$select=id,name,folder,webUrl&$top=200`;
  const items = [];
  while (url) {
    const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { status: r.status };
    const j = await r.json();
    items.push(...(j.value || []));
    url = j["@odata.nextLink"] || null;
  }
  const existing = items.find((c) => c.folder && String(c.name).toLowerCase() === String(name).toLowerCase());
  if (existing) return { id: existing.id, name: existing.name, webUrl: existing.webUrl };
  const r = await fetchWithTimeout(`${GRAPH}/me/drive/items/${parentId}/children`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
  });
  if (!r.ok) return { status: r.status };
  const j = await r.json();
  return { id: j.id, name: j.name, webUrl: j.webUrl };
}

// Resolve a folder path to its drive item (for its id). Returns { id } or { status }.
async function getItemByPath(token, path) {
  const seg = encPath(path);
  const url = seg ? `${GRAPH}/me/drive/root:/${seg}` : `${GRAPH}/me/drive/root`;
  const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { status: r.status };
  const j = await r.json();
  return { id: j.id, name: j.name, webUrl: j.webUrl };
}

// Best-effort delete of a named file directly under a parent folder id. Used to
// remove the central "pending" copy once a document is filed into its project.
// Never throws; a missing file (already moved/renamed) is a no-op.
async function deleteChildByName(token, parentId, name) {
  let url = `${GRAPH}/me/drive/items/${parentId}/children?$select=id,name&$top=200`;
  const items = [];
  while (url) {
    const r = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return; // can't list — give up quietly
    const j = await r.json();
    items.push(...(j.value || []));
    url = j["@odata.nextLink"] || null;
  }
  const hit = items.find((c) => String(c.name).toLowerCase() === String(name).toLowerCase());
  if (!hit) return;
  await fetchWithTimeout(`${GRAPH}/me/drive/items/${hit.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}

// Copy the master folder into `parentPath` under a new name.
//
// Graph's copy is ASYNCHRONOUS: it answers 202 with a Location header pointing at
// a monitor URL, and the folder does not exist yet. We poll that monitor briefly
// so the caller can return a real folder id and webUrl. The wait is deliberately
// bounded — a Netlify function has ~10s, and project creation must not hang on
// OneDrive. If it is still running when we give up, the copy still completes on
// Microsoft's side; we just report it as pending.
async function copyMasterFolder(token, parentPath, masterId, parentId, newName) {
  const r = await fetchWithTimeout(`${GRAPH}/me/drive/items/${masterId}/copy`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ parentReference: { id: parentId }, name: newName }),
  });
  if (r.status === 401) return { status: 401 };
  if (r.status !== 202 && !r.ok) return { status: r.status };

  const monitor = r.headers.get("location");
  if (!monitor) return { pending: true };

  // ~6s ceiling: 12 polls, 500ms apart.
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, 500));
    // The monitor URL is pre-authenticated and rejects an Authorization header.
    const m = await fetchWithTimeout(monitor, {}, 8000).catch(() => null);
    if (!m || !m.ok) continue;
    const j = await m.json().catch(() => null);
    if (!j) continue;
    if (j.status === "completed" && j.resourceId) {
      const item = await fetchWithTimeout(`${GRAPH}/me/drive/items/${j.resourceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!item.ok) return { pending: true };
      const it = await item.json();
      return { id: it.id, name: it.name, webUrl: it.webUrl };
    }
    if (j.status === "failed") return { status: 500 };
  }
  return { pending: true };
}

// Give a project folder its standard subfolders. Used when there is no master to
// copy, so a project is never left as a bare folder.
async function seedProjectSkeleton(token, folderId) {
  for (const name of PROJECT_SUBFOLDERS) {
    const made = await ensureChildFolder(token, folderId, name);
    if (made.status === 401) return { auth: true };
  }
  return { ok: true };
}

// Ensure an "<parent>/<admin folder>/<Quotes|Invoices>" chain exists; returns the
// leaf folder. Propagates {auth:true} on 401 so run()'s token-refresh retry works.
//
// adminName is a parameter because there are TWO admin folders and they are not
// the same thing: a PROJECT's is "01 - Admin" (part of the numbered structure
// copied from the master), while the central holding area for unsent drafts keeps
// its plain "Admin" — it sits beside the project folders, not inside one, and
// renaming it would strand every document already filed there.
async function ensureAdminSubfolder(token, jobFolderId, leafName, adminName = ADMIN_FOLDER_NAME) {
  const admin = await ensureChildFolder(token, jobFolderId, adminName);
  if (admin.status === 401) return { auth: true };
  if (admin.status || !admin.id) return { status: admin.status || 500 };
  const leaf = await ensureChildFolder(token, admin.id, leafName);
  if (leaf.status === 401) return { auth: true };
  if (leaf.status || !leaf.id) return { status: leaf.status || 500 };
  return leaf;
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

const handler = async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const authHeader = req.headers.get("authorization");
  const authToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  // prev_name/prev_subfolder: when a draft was renamed (or its type changed), the
  // client passes the previously-filed name so its stale central copy is removed.
  const { kind, id, prev_name, prev_subfolder } = body;
  if (!authToken || !kind || !id) return json({ error: "kind, id and Authorization required" }, 400);

  const userClient = createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  );
  const { data: { user } } = await userClient.auth.getUser(authToken);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let businessId, fileBuffer, fileName, contentType, jobNumber, jobLabel, fallbackName;
  let docSubfolder = null; // "Quotes" | "Invoices" — Admin subfolder for kind "invoice"
  let docIsSent = false;   // sent docs file into the project folder; drafts stay central

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
    docSubfolder = inv.type === "quote" ? "Quotes" : "Invoices";
    // "Sent" = anything past draft (sent/overdue/paid for invoices; sent/accepted
    // for quotes). Drafts live in the central pending area; sent docs move into
    // the project folder.
    docIsSent = !!inv.status && inv.status !== "draft";
    const { data: jobsList } = await supabase.from("bk_jobs").select("id,job_number,name,address").eq("business_id", businessId);
    let job = inv.project_id ? (jobsList || []).find((j) => j.id === inv.project_id) : null;
    if (!job && inv.job) job = (jobsList || []).find((j) => j.address === inv.job || j.name === inv.job);
    if (job) { jobNumber = job.job_number; jobLabel = job.address || job.name; }
  } else if (kind === "project") {
    // Folder-only: create the OneDrive project folder, no file to upload.
    const { data: job } = await supabase.from("bk_jobs").select("*").eq("id", id).single();
    if (!job || job.user_id !== user.id) return json({ error: "Project not found" }, 404);
    businessId = job.business_id;
    jobNumber = job.job_number;
    jobLabel = job.address || job.name;
    fallbackName = sanitize(job.name || `Project ${id}`);
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

  const { data: profile } = await supabase.from("bk_profiles").select("onedrive_folder").eq("user_id", user.id).eq("business_id", businessId).maybeSingle();
  const projectsBase = (profile?.onedrive_folder || "Mworx Group").trim();

  const run = async (tok) => {
    if (kind === "project") {
      const ensured = await ensureFolderPath(tok, projectsBase);
      if (ensured.auth) return { auth: true };
      if (ensured.status) return { error: `OneDrive folder error (${ensured.status})` };
      const folder = await resolveFolder(tok, projectsBase, jobNumber, jobLabel, fallbackName);
      if (folder.status === 401) return { auth: true };
      // A copy still running on Microsoft's side is a success, not a failure —
      // the folder appears on its own. Don't create a second one chasing it.
      if (folder.pending) return { ok: true, savedTo: folder.name, pending: true };
      if (folder.status || !folder.id) return { error: `OneDrive folder error (${folder.status || "unknown"})` };
      // Give "01 - Admin" its Quotes and Invoices subfolders so documents have a
      // home from day one. Best-effort: a hiccup here shouldn't fail the project.
      for (const leaf of ["Quotes", "Invoices"]) {
        const seeded = await ensureAdminSubfolder(tok, folder.id, leaf);
        if (seeded.auth) return { auth: true };
      }
      return { ok: true, webUrl: folder.webUrl, savedTo: folder.name };
    }

    // kind === "invoice"/"quote": two-stage filing.
    //   Draft (or sent-with-no-project) → central pending "<centralBase>/Admin/<Quotes|Invoices>".
    //   Sent + has a project           → "<project>/Admin/<Quotes|Invoices>", pending copy removed.
    // The central pending Admin sits at the PARENT of the projects base, e.g.
    // projectsBase "Mworx Group/Projects" → central "Mworx Group/Admin/..." (a
    // sibling of Projects, reusing any existing Admin). Falls back to projectsBase
    // itself when it has no parent segment.
    const ensuredBase = await ensureFolderPath(tok, projectsBase);
    if (ensuredBase.auth) return { auth: true };
    if (ensuredBase.status) return { error: `OneDrive folder error (${ensuredBase.status})` };

    const centralBase = projectsBase.includes("/") ? projectsBase.split("/").slice(0, -1).join("/") : projectsBase;
    const ensuredCentral = await ensureFolderPath(tok, centralBase);
    if (ensuredCentral.auth) return { auth: true };
    if (ensuredCentral.status) return { error: `OneDrive folder error (${ensuredCentral.status})` };
    const centralBaseItem = await getItemByPath(tok, centralBase);
    if (centralBaseItem.status === 401) return { auth: true };
    if (centralBaseItem.status || !centralBaseItem.id) return { error: `OneDrive folder error (${centralBaseItem.status || "unknown"})` };

    const isMove = docIsSent && jobNumber && docSubfolder; // sent + project → project folder

    // Resolve the central "<centralBase>/Admin/<sub>" folder. For a MOVE it's only
    // used to clean up the pending copy (best-effort — a hiccup here must NOT block
    // the project upload). For a draft / sent-no-project it IS the upload target.
    let central = null;
    if (docSubfolder) {
      const c = await ensureAdminSubfolder(tok, centralBaseItem.id, docSubfolder, "Admin");
      if (c.auth) return { auth: true };
      if (!isMove && (c.status || !c.id)) return { error: `OneDrive folder error (${c.status || "unknown"})` };
      central = (c.status || !c.id) ? null : c;
    }
    // Remove a stale central copy left by a rename/type-change before this filing.
    const cleanupPrev = async () => {
      if (!prev_name) return;
      if (prev_subfolder && central && prev_subfolder === docSubfolder) { await deleteChildByName(tok, central.id, prev_name); return; }
      // Different subfolder (type changed): locate that central subfolder without creating.
      const admin = await ensureChildFolder(tok, centralBaseItem.id, "Admin"); // central, not a project — plain "Admin"
      if (admin.id) { const alt = await ensureChildFolder(tok, admin.id, prev_subfolder || docSubfolder); if (alt.id) await deleteChildByName(tok, alt.id, prev_name); }
    };

    if (isMove) {
      // File into the project's Admin/<sub>, then remove central pending copies.
      const folder = await resolveFolder(tok, projectsBase, jobNumber, jobLabel, fallbackName);
      if (folder.status === 401) return { auth: true };
      // The project folder is still being copied, so there is nowhere to put the
      // file yet. Report it rather than uploading somewhere improvised — the
      // document stays in the central pending folder and moves on the next send.
      if (folder.pending) return { error: "The project folder is still being created in OneDrive. Try again in a moment." };
      if (folder.status || !folder.id) return { error: `OneDrive folder error (${folder.status || "unknown"})` };
      const sub = await ensureAdminSubfolder(tok, folder.id, docSubfolder);
      if (sub.auth) return { auth: true };
      if (sub.status || !sub.id) return { error: `OneDrive folder error (${sub.status || "unknown"})` };
      const up = await uploadToFolder(tok, sub.id, fileName, fileBuffer, contentType);
      if (up.status === 401) return { auth: true };
      if (!up.ok) {
        let e = ""; try { e = JSON.stringify(await up.json()); } catch { /* ignore */ }
        return { error: `OneDrive upload failed (${up.status})`, detail: e };
      }
      const item = await up.json();
      if (central?.id) await deleteChildByName(tok, central.id, fileName); // current-name pending copy
      await cleanupPrev();                                                  // renamed pending copy
      return { ok: true, webUrl: item.webUrl, savedTo: `${folder.name}/Admin/${docSubfolder}/${fileName}` };
    }

    // Draft, or sent with no matched project → central pending area.
    const destId = central ? central.id : centralBaseItem.id;
    const savedPrefix = central ? `${centralBase}/Admin/${docSubfolder}` : centralBase;
    const up = await uploadToFolder(tok, destId, fileName, fileBuffer, contentType);
    if (up.status === 401) return { auth: true };
    if (!up.ok) {
      let e = "";
      try { e = JSON.stringify(await up.json()); } catch { /* ignore */ }
      return { error: `OneDrive upload failed (${up.status})`, detail: e };
    }
    const item = await up.json();
    await cleanupPrev(); // drop the pre-rename central copy
    return { ok: true, webUrl: item.webUrl, savedTo: `${savedPrefix}/${fileName}` };
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
