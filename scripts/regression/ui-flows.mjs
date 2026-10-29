#!/usr/bin/env node
// Browser regression of the original flows (login, dashboard, contacts,
// projects, quotes, invoices, mark paid, send, OneDrive filing, Inbox) against
// a built bundle, with the Supabase and Netlify surfaces replaced by the
// in-process mock and isolated fixtures. Every write the UI makes is recorded
// so two builds can be compared.
//   node scripts/regression/ui-flows.mjs <distDir> <label> [--mobile] [--out dir] [--discover]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { MockDb, installMock, USER_EMAIL, PASSWORD } from "./mock-supabase.mjs";
// Playwright is resolved the CommonJS way so a globally installed copy works too.
const { chromium } = createRequire(import.meta.url)("playwright");
import { fixtures, yy, fixtureId } from "./fixtures.mjs";

const [distDir, label = "build", ...flags] = process.argv.slice(2);
if (!distDir) { console.error("usage: ui-flows.mjs <distDir> <label> [--mobile] [--out dir] [--discover]"); process.exit(2); }
const mobile = flags.includes("--mobile");
const discover = flags.includes("--discover");
const outDir = flags.includes("--out") ? flags[flags.indexOf("--out") + 1] : path.join(process.cwd(), "regression-out");
fs.mkdirSync(outDir, { recursive: true });
const tag = `${label}-${mobile ? "mobile" : "desktop"}`;

// --- static server for the bundle ----------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/" || !fs.existsSync(path.join(distDir, p))) p = "/index.html";
  const file = path.join(distDir, p);
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const db = new MockDb(fixtures());
db.rpc = {
  // The live function makes the draft quote and the lead; the mock does the same
  // shape of work so the page can show the result.
  bk_draft_quote_from_proposal(args) {
    const it = db.table("bk_inbox_items").find((x) => x.id === args.item_id || x.id === args.p_item_id);
    if (!it) return { error: { code: "P0001", message: "no such item" } };
    const number = `QMWX${yy}018`;
    const row = { id: fixtureId(499), user_id: it.user_id, business_id: "mworx", division: "mworx", number, type: "quote", status: "draft", date: "2026-10-28", due_date: "2026-11-27", contact_name: "", total: 0, items: [] };
    db.table("bk_invoices").push(row);
    it.invoice_id = row.id;
    return { invoice_id: row.id, number, job_id: null };
  },
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
  deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
  userAgent: mobile ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" : undefined,
});
await installMock(context, db, { appOrigin: origin });
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
const dialogs = [];
let dialogAnswer = true, promptAnswer = "30";
page.on("dialog", async (d) => { dialogs.push({ type: d.type(), message: d.message() }); if (d.type() === "prompt") await (dialogAnswer ? d.accept(promptAnswer) : d.dismiss()); else if (d.type() === "confirm") await (dialogAnswer ? d.accept() : d.dismiss()); else await d.dismiss(); });

const results = [];
let shot = 0;
async function snap(name) { shot++; const f = path.join(outDir, `${tag}-${String(shot).padStart(2, "0")}-${name}.png`); await page.screenshot({ path: f, fullPage: !mobile }); return path.basename(f); }
async function step(name, fn) {
  const logStart = db.log.length, fnStart = db.functions.length, dlgStart = dialogs.length, errStart = consoleErrors.length;
  const r = { name, ok: false };
  try {
    const info = await fn();
    r.ok = true; r.info = info ?? null;
  } catch (e) {
    r.error = String(e && e.message || e).split("\n")[0].slice(0, 400);
    try { r.shot = await snap("FAIL-" + name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)); } catch { /* ignore */ }
    try { r.text = (await page.locator("body").innerText()).slice(0, 1500); } catch { /* ignore */ }
    // Leave whatever was open behind so the next step starts clean.
    try { await page.keyboard.press("Escape"); await page.reload(); await page.getByText(/Outstanding/).first().waitFor({ timeout: 15000 }); await sleep(400); } catch { /* ignore */ }
  }
  r.writes = db.log.slice(logStart).filter((l) => !l.blocked && l.method !== "GET" && l.method !== "OPTIONS" && l.method !== "HEAD").map((l) => ({ method: l.method, path: l.path, query: l.query, body: l.body, status: l.status, error: l.error }));
  r.reads = db.log.slice(logStart).filter((l) => l.method === "GET" && !l.blocked).map((l) => `${l.path}?${new URLSearchParams(l.query)}`);
  r.functions = db.functions.slice(fnStart);
  r.dialogs = dialogs.slice(dlgStart);
  r.consoleErrors = consoleErrors.slice(errStart);
  results.push(r);
  console.log(`${r.ok ? "✓" : "✗"} ${name}${r.error ? " — " + r.error : ""}`);
  return r;
}

// --- helpers -------------------------------------------------------------
const byText = (text, opts = {}) => page.getByRole("button", { name: text, exact: opts.exact ?? false }).first();
async function click(text, opts = {}) { const b = byText(text, opts); await b.waitFor({ state: "visible", timeout: opts.timeout || 8000 }); await b.click(); }
async function fieldAfterLabel(labelText, scope = page) {
  // <label>Name</label><input/> — the control right after the label.
  const lab = scope.locator("label", { hasText: new RegExp(`^\\s*${labelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") }).first();
  await lab.waitFor({ state: "visible", timeout: 8000 });
  return lab.locator("xpath=following-sibling::*[self::input or self::select or self::textarea][1] | following-sibling::*[1]//*[self::input or self::select or self::textarea][1]").first();
}
async function fill(labelText, value, scope = page) { const f = await fieldAfterLabel(labelText, scope); await f.fill(value); return f; }
async function select(labelText, value, scope = page) { const f = await fieldAfterLabel(labelText, scope); await f.selectOption(value); return f; }
const modal = () => page.locator("div.bk-modal, div[class*=modal], div[style*='z-index: 1000'], div[style*='z-index: 100 ']").last();
async function gotoPage(name) {
  // Desktop: the sidebar; phone: the bottom tabs or the "More" sheet.
  // The badge may sit in the name ("Inbox 1" / "Inbox1"); the page title in the
  // phone header carries the same word inside the company-menu button, so the
  // fallback takes the last match (the bottom tab), never the first.
  const btn = page.getByRole("button", { name: new RegExp(`^\\s*${name}\\s*\\d*\\s*$`, "i") }).last();
  if (await btn.count() && await btn.isVisible()) { await btn.click(); return "nav"; }
  const link = page.getByText(new RegExp(`^\\s*${name}\\s*$`, "i")).last();
  await link.click();
  return "text";
}
async function dump(heading) {
  // Everything a tester would need to drive the open form: its labels, controls and buttons.
  return page.evaluate((heading) => {
    const h = [...document.querySelectorAll("h3,h2,div")].find((e) => e.children.length === 0 && e.textContent.trim() === heading);
    let root = h; for (let i = 0; i < 8 && root && root.querySelectorAll("input,select,textarea").length < 2; i++) root = root.parentElement;
    if (!root) return { missing: heading };
    const controls = [...root.querySelectorAll("input,select,textarea")].map((c) => {
      let lab = c.previousElementSibling; while (lab && lab.tagName !== "LABEL" && lab.tagName !== "SPAN" && lab.tagName !== "DIV") lab = lab.previousElementSibling;
      const l2 = c.closest("div")?.querySelector("label");
      return { tag: c.tagName.toLowerCase(), type: c.type, placeholder: c.placeholder || "", label: (lab?.textContent || l2?.textContent || "").trim().slice(0, 50), value: (c.value || "").slice(0, 60), options: c.tagName === "SELECT" ? [...c.options].map((o) => o.textContent.trim()).slice(0, 14) : undefined };
    });
    const buttons = [...root.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean);
    return { controls, buttons };
  }, heading);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastWrite = (r, method, table) => [...r.writes].reverse().find((w) => w.method === method && w.path === `/rest/v1/${table}`);
function expect(cond, msg) { if (!cond) throw new Error(msg); }

// --- scenarios -----------------------------------------------------------
await step("login screen renders and rejects a wrong password", async () => {
  await page.goto(origin + "/");
  await page.getByText("BookKeeper").first().waitFor({ timeout: 15000 });
  await page.getByPlaceholder("your@email.com").fill(USER_EMAIL);
  await page.getByPlaceholder("Password").fill("wrong password");
  await page.getByPlaceholder("Password").press("Enter");
  await page.getByText(/invalid login credentials/i).waitFor({ timeout: 8000 });
  return "error shown";
});
await step("login with the test account reaches the dashboard", async () => {
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByPlaceholder("Password").press("Enter");
  await page.getByText(/Outstanding/).first().waitFor({ timeout: 15000 });
  await sleep(600);
  await snap("dashboard");
  const text = await page.locator("body").innerText();
  expect(/Active Projects|Projects/.test(text), "no projects tile");
  return { blockedExternal: db.log.filter((l) => l.blocked).map((l) => l.path).slice(0, 5) };
});

if (discover) {
  const found = {};
  found.body = (await page.locator("body").innerText()).slice(0, 3000);
  found.buttons = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 80));
  const fresh = async (pageName) => { await page.reload(); await page.getByText(/Outstanding/).first().waitFor({ timeout: 15000 }); await sleep(400); if (pageName) { await gotoPage(pageName); await sleep(400); } found["nav:" + pageName] = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 60)); };
  for (const [pageName, open, heading, then] of [["Contacts", /^\+?\s*(New )?Contact$/i, "New Contact"], ["Projects", /^\+?\s*(New )?Project$/i, "New Project"], ["Quotes", /^\+?\s*(New )?Quote$/i, "New Quote", true], ["Invoices", /^\+?\s*(New )?Invoice$/i, "New Invoice"]]) {
    try {
      await fresh(pageName);
      const b = page.getByRole("button", { name: open }).first();
      await b.waitFor({ timeout: 6000 }); await b.click(); await sleep(600);
      found[heading] = await dump(heading);
      await snap("discover-" + heading.replace(/\s/g, "_"));
      if (then) {
        // The quote start step: pick the first project, press the go button, dump the quote form.
        const sel = page.locator("select").first(); await sel.selectOption({ index: 1 }); await sleep(200);
        const btns = found[heading].buttons.filter((t) => !/✕|×/.test(t));
        await page.getByRole("button", { name: btns[btns.length - 1] }).last().click(); await sleep(800);
        found["Quote form"] = await page.evaluate(() => {
          const controls = [...document.querySelectorAll("input,select,textarea")].map((c) => ({ tag: c.tagName.toLowerCase(), type: c.type, placeholder: c.placeholder || "", label: (c.closest("div")?.querySelector("label")?.textContent || "").trim().slice(0, 50), value: (c.value || "").slice(0, 60) }));
          const buttons = [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean);
          const h3 = [...document.querySelectorAll("h3,h2")].map((h) => h.textContent.trim());
          return { h3, controls: controls.slice(0, 40), buttons };
        });
        await snap("discover-Quote_form");
      }
    } catch (e) { found[heading] = { error: String(e.message).split("\n")[0] }; }
  }
  fs.writeFileSync(path.join(outDir, `${tag}-discover.json`), JSON.stringify(found, null, 2));
  console.log(JSON.stringify(found, null, 2).slice(0, 12000));
  await browser.close(); server.close(); process.exit(0);
}

// Contacts
const hasInbox = (await page.locator("button", { hasText: /Inbox/ }).count()) > 0;
const fresh = async () => { await page.keyboard.press("Escape").catch(() => {}); await page.reload(); await page.getByText(/Outstanding/).first().waitFor({ timeout: 15000 }); await sleep(400); };
async function openNew(kind) {
  // Desktop: the header "+ Contact / Project / Quote / Invoice" button on that page.
  // Phone: the dashboard's Invoice / Quote / Project buttons, or the icon-only "+" in the page header.
  if (!mobile) { await click(new RegExp(`^\\+?\\s*(New )?${kind}$`, "i")); return; }
  if (kind === "Contact") { await gotoPage("Contacts"); await sleep(300); await page.locator("button:has(svg)").filter({ hasText: /^$/ }).first().click(); return; }
  await gotoPage("Dashboard"); await sleep(300);
  await page.getByRole("button", { name: new RegExp(`^${kind}$`) }).first().click();
}
async function openRow(text) { const r = page.getByText(text, { exact: false }).first(); await r.waitFor({ timeout: 8000 }); await r.click(); await sleep(500); }

await step("contacts: create a client", async () => {
  await gotoPage("Contacts"); await sleep(400);
  await openNew("Contact");
  const m = page.locator("h3", { hasText: "New Contact" }); await m.waitFor({ timeout: 8000 });
  await fill("Name", "Test Client One");
  await fill("Company", "Client One Pty Ltd");
  await fill("Email", "client.one@example.test");
  await fill("Phone", "0400 111 222");
  await snap("contact-form");
  await click(/^(Add|Save|Create) Contact$/i);
  await m.waitFor({ state: "hidden", timeout: 8000 });
  await gotoPage("Contacts"); await sleep(300);
  await page.getByText("Test Client One").first().waitFor({ timeout: 8000 });
  const row = db.table("bk_contacts").find((c) => c.name === "Test Client One");
  expect(row && row.email === "client.one@example.test" && row.business_id === "mworx", "contact row missing or wrong");
  return { inserted: { name: row.name, email: row.email, type: row.type, business_id: row.business_id, company: row.company } };
});
await step("contacts: edit the client", async () => {
  if (mobile) await openRow("Test Client One");
  else { await page.locator("tr").filter({ hasText: "Test Client One" }).first().locator("button[title='Edit']").click(); await sleep(400); }
  const m = page.locator("h3", { hasText: /Edit Contact/ }); await m.waitFor({ timeout: 8000 });
  await fill("Phone", "0400 999 888");
  await click(/^(Save|Update)( Contact| changes)?$/i);
  await m.waitFor({ state: "hidden", timeout: 8000 });
  const row = db.table("bk_contacts").find((c) => c.name === "Test Client One");
  expect(row.phone === "0400 999 888", "phone not updated: " + row.phone);
  return { phone: row.phone };
});

// Projects
async function newProject(name, address, expectNumber) {
  await gotoPage("Projects"); await sleep(400);
  await openNew("Project");
  const m = page.locator("h3", { hasText: "New Project" }); await m.waitFor({ timeout: 8000 });
  const shown = await page.locator("span", { hasText: /^Project #$/ }).first().locator("xpath=following-sibling::input[1]").inputValue().catch(() => null);
  await fill("Address (shown as the project label)", address);
  await fill("Name / Description", name);
  await snap("project-form-" + expectNumber);
  const mark = db.log.length;
  await click(/^Create Project$/i);
  await m.waitFor({ state: "hidden", timeout: 8000 });
  const row = db.table("bk_jobs").find((j) => j.name === name);
  expect(row, "project row not inserted");
  const sent = db.log.slice(mark).find((l) => l.method === "POST" && l.path === "/rest/v1/bk_jobs")?.body?.job_number ?? null;
  return { shownNumber: shown, sentNumber: sent, savedNumber: row.job_number, division: row.division, business_id: row.business_id, expected: expectNumber };
}
await step(`projects: new Mworx Group project gets ${yy}119`, async () => {
  const r = await newProject("Regression Project A", "11 Test Street, Testville", `${yy}119`);
  expect(r.savedNumber === `${yy}119`, `saved ${r.savedNumber}`);
  return r;
});
async function switchCompany(name) {
  const opener = page.getByRole("button", { name: /Mworx Group|Mworx Energy|MT Management|All companies/ }).first();
  await opener.click(); await sleep(300);
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).last().click(); await sleep(600);
}
await step(`projects: new Mworx Energy project (form number, sent number, saved number)`, async () => {
  await switchCompany("Mworx Energy");
  return newProject("Regression Energy Project", "12 Test Street, Testville", `${yy}1004`);
});
await step(`projects: new MT Management project (form number, sent number, saved number)`, async () => {
  await switchCompany("MT Management");
  return newProject("Regression MT Project", "13 Test Street, Testville", `${yy}120`);
});
await step("projects: edit a project's address", async () => {
  await switchCompany("Mworx Group");
  await gotoPage("Projects"); await sleep(400);
  await openRow("11 Test Street, Testville");
  await click(/^Edit$/i);
  await fill("Address (shown as the project label)", "11 Test Street, Testville NSW 2000");
  await click(/^(Save|Update|Save changes|Save Project)$/i);
  await sleep(600);
  const row = db.table("bk_jobs").find((j) => j.name === "Regression Project A");
  expect(/NSW 2000$/.test(row.address || ""), "address not updated: " + row.address);
  return { address: row.address };
});

// Quotes
await step(`quotes: new quote for project ${yy}118 is numbered QMWX${yy}018, starts from the DA quote type, saves as a draft`, async () => {
  await gotoPage("Quotes"); await sleep(400);
  await openNew("Quote");
  const m = page.locator("h3", { hasText: "New Quote" }); await m.waitFor({ timeout: 8000 });
  await (await fieldAfterLabel("Project")).selectOption({ label: `${yy}118 — 4 Sample Street, Testville NSW` });
  await click(/^Continue to quote$/i);
  await sleep(700);
  const shown = await (await fieldAfterLabel("Number")).inputValue();
  const template = await page.locator("label", { hasText: /Started from/ }).first().textContent().catch(() => null);
  await snap("quote-form");
  await click(/^Save & preview$/i);
  await sleep(1000);
  const row = db.table("bk_invoices").find((i) => i.type === "quote" && i.number === `QMWX${yy}018`);
  expect(row, `quote QMWX${yy}018 not inserted (form showed ${shown})`);
  await page.keyboard.press("Escape").catch(() => {});
  return { shown, template, status: row.status, division: row.division, project_id: row.project_id, contact: row.contact_name, items: db.table("bk_invoice_items").filter((x) => x.invoice_id === row.id).map((x) => x.description), total: row.total };
});
await step(`quotes: accept the sent quote QMWX${yy}017 (and the deposit invoice it offers)`, async () => {
  await fresh();
  await gotoPage("Quotes"); await sleep(400);
  await page.getByText(`QMWX${yy}017`).first().waitFor({ timeout: 8000 });
  await click(/^Accept$/i);
  await sleep(1500);
  const q = db.table("bk_invoices").find((i) => i.number === `QMWX${yy}017`);
  const job = db.table("bk_jobs").find((j) => j.id === fixtureId(201));
  const deposit = db.table("bk_invoices").filter((i) => i.type === "invoice" && i.created_at > new Date(Date.now() - 60000).toISOString());
  return { status: q.status, job_accepted_quote_id: job.accepted_quote_id === q.id, job_contract_value: job.contract_value, depositInvoices: deposit.map((d) => ({ number: d.number, total: d.total, status: d.status, items: db.table("bk_invoice_items").filter((x) => x.invoice_id === d.id).map((x) => [x.description, x.rate]) })) };
});

// Invoices
const nextNumber = (prefix, type) => { const tag = `${prefix}${yy}`; const seqs = db.table("bk_invoices").filter((i) => i.type === type && i.number.startsWith(tag)).map((i) => Number(i.number.slice(tag.length)) || 0); return `${tag}${String((seqs.length ? Math.max(...seqs) : 0) + 1).padStart(3, "0")}`; };
const expectedInvoice = nextNumber("MWX", "invoice");
await step(`invoices: new invoice is numbered ${expectedInvoice} (next after the fixtures and the deposit), due in 7 days, saved as a draft with its line`, async () => {
  await fresh();
  await gotoPage("Invoices"); await sleep(400);
  await openNew("Invoice");
  const m = page.locator("h3", { hasText: "New Invoice" }); await m.waitFor({ timeout: 8000 });
  const shown = await (await fieldAfterLabel("Number")).inputValue();
  await page.locator("select").filter({ has: page.locator("option", { hasText: "Sam Okafor" }) }).first().selectOption({ label: "Sam Okafor" });
  await page.locator("textarea[placeholder^='Description']").first().fill("Regression line item");
  await page.locator("input[placeholder='Rate']").first().fill("1500");
  await snap("invoice-form");
  await click(/^Save & preview$/i);
  await sleep(1000);
  const row = db.table("bk_invoices").find((i) => i.type === "invoice" && i.number === expectedInvoice);
  expect(row, `invoice ${expectedInvoice} not inserted (form showed ${shown})`);
  await page.keyboard.press("Escape").catch(() => {});
  return { shown, status: row.status, division: row.division, date: row.date, due_date: row.due_date, contact_id: row.contact_id, total: row.total, items: db.table("bk_invoice_items").filter((x) => x.invoice_id === row.id).map((x) => [x.description, x.qty, x.rate]) };
});
await step(`invoices: Mark paid on the sent invoice MWX${yy}018 (row action)`, async () => {
  await fresh();
  await gotoPage("Invoices"); await sleep(400);
  const rowEl = page.locator(mobile ? "div" : "tr").filter({ hasText: `MWX${yy}018` }).filter({ has: page.getByRole("button", { name: /^Mark paid$/ }) }).last();
  await rowEl.getByRole("button", { name: /^Mark paid$/ }).first().click();
  await sleep(900);
  const row = db.table("bk_invoices").find((i) => i.number === `MWX${yy}018`);
  expect(row.status === "paid" && row.paid_date, "not paid: " + JSON.stringify({ status: row.status, paid_date: row.paid_date }));
  return { status: row.status, paid_date: row.paid_date };
});
await step(`invoices: Send the new draft through Outlook (PDF, send, OneDrive refile)`, async () => {
  await fresh();
  await gotoPage("Invoices"); await sleep(400);
  const rowEl = page.locator(mobile ? "div" : "tr").filter({ hasText: expectedInvoice }).filter({ has: page.getByRole("button", { name: /^Send$/ }) }).last();
  await rowEl.getByRole("button", { name: /^Send$/ }).first().click();
  await sleep(1200);
  await snap("compose");
  const composeButtons = await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => /send/i.test(t)));
  const sendNow = page.getByRole("button", { name: /^Send( now| email| invoice)?…?$/i }).last();
  if (await sendNow.isVisible().catch(() => false)) { await sendNow.click(); await sleep(1500); }
  const row = db.table("bk_invoices").find((i) => i.number === expectedInvoice);
  return { number: row.number, composeButtons, status: row.status, sent_at: !!row.sent_at };
});

// Inbox (branch only — main has no page)
if (hasInbox) {
  await step("inbox: page lists the open items, Focus and the filed row", async () => {
    await fresh();
    await gotoPage("Inbox"); await sleep(800);
    await snap("inbox");
    const text = await page.locator("body").innerText();
    expect(/Record payment/.test(text) && /Fee proposal/.test(text), "items not shown");
    return { focus: /Focus/.test(text), filedVisible: /Filed|Survey\.pdf/.test(text), checked: /Checked|QA|verified/i.test(text) };
  });
  await step(`inbox: Mark paid on the money row (confirm names client and amount, PATCH, read-back, item closes)`, async () => {
    await gotoPage("Inbox"); await sleep(500);
    // Rows expand on a tap; the actions sit inside the expanded row.
    await page.getByText(`Record payment — MWX${yy}019`, { exact: false }).first().click(); await sleep(400);
    await snap("inbox-money-row-open");
    const mark = db.log.length;
    await page.getByRole("button", { name: /^Mark paid$/ }).first().click();
    await sleep(1500);
    const readBack = db.log.slice(mark).filter((l) => l.method === "GET" && l.path === "/rest/v1/bk_invoices").map((l) => l.query.select);
    const inv = db.table("bk_invoices").find((i) => i.number === `MWX${yy}019`);
    const item = db.table("bk_inbox_items").find((it) => it.invoice_id === inv.id);
    expect(inv.status === "paid", "invoice not paid: " + inv.status);
    return { confirm: dialogs.at(-1)?.message, status: inv.status, paid_date: inv.paid_date, itemStatus: item.status, readBackSelects: readBack, rowGone: (await page.getByText(`Record payment — MWX${yy}019`).count()) === 0 };
  });
  await step("inbox: Draft quote on the proposal item calls the database function once and links the draft", async () => {
    await gotoPage("Inbox"); await sleep(500);
    await page.getByText("Fee proposal — 22 Mockingbird Way", { exact: false }).first().click(); await sleep(400);
    await page.getByRole("button", { name: /^Draft quote$/ }).first().click();
    await sleep(1500);
    await snap("inbox-after-draft-quote");
    const item = db.table("bk_inbox_items").find((it) => it.id === fixtureId(1002));
    return { rpcCalls: db.functions.filter((f) => f.fn === "bk_draft_quote_from_proposal").map((f) => f.args), itemInvoiceId: item.invoice_id, openQuoteButton: await page.getByRole("button", { name: /^Open quote$/ }).count() };
  });
} else {
  results.push({ name: "inbox: (no Inbox on this build)", ok: true, skipped: true, writes: [], functions: [], dialogs: [], consoleErrors: [] });
}

await step("sign out", async () => {
  await page.reload(); await page.getByText(/Outstanding/).first().waitFor({ timeout: 15000 }); await sleep(400);
  if (mobile) { await page.locator("button:has(svg)").filter({ hasText: /^$/ }).nth(1).click(); } else { await click(/^Sign Out$/i); }
  await page.getByPlaceholder("your@email.com").waitFor({ timeout: 8000 });
});

const summary = { tag, origin, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results, blockedExternal: [...new Set(db.log.filter((l) => l.blocked).map((l) => l.path))], functionCalls: db.functions, rpcCalls: db.functions.filter((f) => f.args !== undefined) };
fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify(summary, null, 2));
console.log(`${summary.passed} passed, ${summary.failed} failed → ${path.join(outDir, `${tag}.json`)}`);
await browser.close();
server.close();
