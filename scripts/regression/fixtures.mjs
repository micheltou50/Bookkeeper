// Isolated test data for the browser regression. Invented names, numbers and
// addresses — nothing here is a real client, document or job.
import { USER_ID } from "./mock-supabase.mjs";

const BIZ = "mworx";
const yy = String(new Date().getFullYear()).slice(-2);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const u = USER_ID;
const common = { user_id: u, business_id: BIZ, created_at: "2026-09-01T00:00:00Z" };

export const CONTACTS = [
  { ...common, id: id(101), name: "Alex Rivers", company: "Rivers Design Studio", email: "alex@rivers.test", phone: "0400 000 001", type: "consultant", abn: "11 111 111 111", address: "1 Harbour St, Testville NSW", notes: "" },
  { ...common, id: id(102), name: "Priya Nair", company: "", email: "priya@example.test", phone: "0400 000 002", type: "client", abn: "", address: "2 Lake Rd, Testville NSW", notes: "" },
  { ...common, id: id(103), name: "Sam Okafor", company: "Okafor Builders", email: "sam@okafor.test", phone: "0400 000 003", type: "client", abn: "22 222 222 222", address: "3 Ridge Ave, Testville NSW", notes: "" },
];

export const JOBS = [
  { ...common, id: id(201), division: "mworx", name: "4 Sample Street Testville", address: "4 Sample Street, Testville NSW", job_number: `${yy}118`, status: "active", application_type: "DA", contract_value: 12000, notes: "", contact_id: id(103), last_used_at: "2026-10-20T00:00:00Z", accepted_quote_id: null },
  { ...common, id: id(202), division: "mworx", name: "9 Example Road Testville", address: "9 Example Road, Testville NSW", job_number: `${yy}117`, status: "active", application_type: "CDC", contract_value: 8000, notes: "", contact_id: id(102), last_used_at: "2026-10-10T00:00:00Z", accepted_quote_id: null },
  { ...common, id: id(203), division: "mworx_energy", name: "15 Fixture Lane Testville", address: "15 Fixture Lane, Testville NSW", job_number: `${yy}1003`, status: "active", application_type: "BASIX", contract_value: 900, notes: "", contact_id: id(101), last_used_at: "2026-10-22T00:00:00Z", accepted_quote_id: null },
  { ...common, id: id(204), division: "mt_management", name: "Unit 7 Mock Apartments", address: "7/20 Mock Street, Testville NSW", job_number: `${yy}105`, status: "active", application_type: "", contract_value: 0, notes: "", contact_id: null, last_used_at: "2026-09-15T00:00:00Z", accepted_quote_id: null },
];

export const JOB_PARTIES = [
  { id: id(301), job_id: id(201), contact_id: id(103), role: "client", created_at: "2026-09-01T00:00:00Z" },
  { id: id(302), job_id: id(203), contact_id: id(101), role: "consultant", created_at: "2026-09-01T00:00:00Z" },
];

const inv = (n, o) => ({ ...common, id: id(400 + n), contact_id: null, contact_email: "", contact_company: "", contact_abn: "", contact_address: "", contact_phone: "", notes: "", terms: "", total: 0, paid_date: null, sent_at: null, pricing_mode: "itemised", lump_amount: null, payment_plan: null, project_id: null, job: "", ...o });
export const INVOICES = [
  inv(1, { division: "mworx", number: `QMWX${yy}017`, type: "quote", status: "sent", date: "2026-10-01", due_date: "2026-10-31", contact_name: "Sam Okafor", contact_email: "sam@okafor.test", contact_company: "Okafor Builders", job: "4 Sample Street Testville", project_id: id(201), total: 5500, pricing_mode: "lump_sum", lump_amount: 5000, sent_at: "2026-10-01T03:00:00Z" }),
  inv(2, { division: "mworx", number: `QMWX${yy}016`, type: "quote", status: "accepted", date: "2026-09-20", due_date: "2026-10-20", contact_name: "Priya Nair", contact_email: "priya@example.test", job: "9 Example Road Testville", project_id: id(202), total: 8800, pricing_mode: "lump_sum", lump_amount: 8000 }),
  inv(3, { division: "mworx", number: `MWX${yy}019`, type: "invoice", status: "sent", date: "2026-10-15", due_date: "2026-10-22", contact_name: "Sam Okafor", contact_email: "sam@okafor.test", contact_company: "Okafor Builders", job: "4 Sample Street Testville", project_id: id(201), total: 2750, sent_at: "2026-10-15T03:00:00Z" }),
  inv(9, { division: "mworx", number: `MWX${yy}018`, type: "invoice", status: "sent", date: "2026-10-18", due_date: "2026-10-25", contact_name: "Priya Nair", contact_email: "priya@example.test", job: "9 Example Road Testville", project_id: id(202), total: 1100, sent_at: "2026-10-18T03:00:00Z" }),
  inv(4, { division: "mworx", number: `MWX${yy}017`, type: "invoice", status: "paid", date: "2026-09-25", due_date: "2026-10-02", paid_date: "2026-10-01", contact_name: "Priya Nair", contact_email: "priya@example.test", job: "9 Example Road Testville", project_id: id(202), total: 4400 }),
  inv(5, { division: "mworx_energy", number: `QME${yy}001`, type: "quote", status: "draft", date: "2026-10-24", due_date: "2026-11-23", contact_name: "Alex Rivers", contact_email: "alex@rivers.test", contact_company: "Rivers Design Studio", job: "15 Fixture Lane Testville", project_id: id(203), total: 0, pricing_mode: "lump_sum", lump_amount: 0 }),
  inv(6, { division: "mt_management", number: `QMTM${yy}002`, type: "quote", status: "sent", date: "2026-10-05", due_date: "2026-11-04", contact_name: "Priya Nair", contact_email: "priya@example.test", job: "Unit 7 Mock Apartments", project_id: id(204), total: 1100, pricing_mode: "lump_sum", lump_amount: 1000, sent_at: "2026-10-05T03:00:00Z" }),
  inv(7, { division: "mt_management", number: `MTM${yy}001`, type: "invoice", status: "sent", date: "2026-10-10", due_date: "2026-10-17", contact_name: "Priya Nair", contact_email: "priya@example.test", job: "Unit 7 Mock Apartments", project_id: id(204), total: 660, sent_at: "2026-10-10T03:00:00Z" }),
  inv(8, { division: "mworx", number: `QMWX25009`, type: "quote", status: "declined", date: "2025-11-01", due_date: "2025-12-01", contact_name: "Sam Okafor", total: 3300 }),
];

export const INVOICE_ITEMS = [
  { id: id(501), invoice_id: id(401), description: "Development application drawings", note: "", qty: 1, rate: 5000, sort_order: 0 },
  { id: id(502), invoice_id: id(402), description: "CDC drawings", note: "", qty: 1, rate: 8000, sort_order: 0 },
  { id: id(503), invoice_id: id(403), description: "Progress claim 1", note: "", qty: 1, rate: 2500, sort_order: 0 },
  { id: id(504), invoice_id: id(404), description: "Progress claim 1", note: "", qty: 1, rate: 4000, sort_order: 0 },
  { id: id(505), invoice_id: id(405), description: "BASIX Certificate for [proposed works] at [address]", note: "", qty: 1, rate: 0, sort_order: 0 },
  { id: id(506), invoice_id: id(406), description: "Property management set-up", note: "", qty: 1, rate: 1000, sort_order: 0 },
  { id: id(507), invoice_id: id(407), description: "Management fee October", note: "", qty: 1, rate: 600, sort_order: 0 },
  { id: id(508), invoice_id: id(408), description: "Concept drawings", note: "", qty: 1, rate: 3000, sort_order: 0 },
  { id: id(509), invoice_id: id(409), description: "Progress claim 2", note: "", qty: 1, rate: 1000, sort_order: 0 },
];

const profile = (o) => ({ user_id: u, abn: "00 000 000 000", address: "Test Address", email: "info@example.test", phone: "0400 000 000", bank_name: "Test Bank", account_name: "Test", bsb: "000-000", account_number: "00000000", logo_url: "", email_template_invoice: "", email_template_quote: "", email_signature: "", onedrive_folder: o.name, gst_not_registered: false, subtitle: "", archived: false, ...o });
export const PROFILES = [
  profile({ id: id(601), business_id: "mworx", name: "Mworx Group", short_name: "Mworx", invoice_prefix: "MWX", quote_prefix: "QMWX", accent: "#0d9488", tagline: "Design · Consultancy · Project Management", sort_order: 0 }),
  profile({ id: id(602), business_id: "mworx_energy", name: "Mworx Energy", short_name: "Energy", invoice_prefix: "ME", quote_prefix: "QME", accent: "#16a34a", tagline: "BASIX · NatHERS", sort_order: 1 }),
  profile({ id: id(603), business_id: "mt_management", name: "MT Management", short_name: "MT Mgmt", invoice_prefix: "MTM", quote_prefix: "QMTM", accent: "#2563eb", tagline: "Short-Term Rental Property Management", sort_order: 2 }),
];

export const QUOTE_TEMPLATES = [
  { ...common, id: id(701), name: "DA — Standard", application_type: "DA", items: [{ description: "Development application drawings", note: "", qty: 1, rate: 0 }], payment_plan: "50% on engagement, 50% on lodgement", notes: "", terms: "", lump_amount: null, pricing_mode: "lump_sum" },
  { ...common, id: id(702), name: "BASIX — Certificate", application_type: "BASIX", items: [
    { description: "BASIX Certificate for [proposed works] at [address]", note: "", qty: 1, rate: 0 },
    { description: "Review of the architectural drawings", note: "", qty: 1, rate: 0 },
    { description: "Assessment against the water, thermal and energy targets", note: "", qty: 1, rate: 0 },
    { description: "Thermal comfort assessment", note: "", qty: 1, rate: 0 },
    { description: "Schedule of commitments", note: "", qty: 1, rate: 0 },
    { description: "Preparation and issue of the certificate", note: "", qty: 1, rate: 0 },
  ], payment_plan: null, notes: null, terms: null, lump_amount: null, pricing_mode: "lump_sum" },
];

export const SCOPE_LINES = [
  { ...common, id: id(801), text: "Site measure and survey", category: "Drafting", archived: false, sort_order: 0 },
];

export const EMAIL_CONNECTIONS = [
  { id: id(901), user_id: u, business_id: "mworx", provider: "outlook", email: "info@example.test", account_email: "info@example.test", scopes: "offline_access User.Read Mail.Send Mail.ReadWrite Files.ReadWrite", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
];

const item = (n, o) => ({ ...common, id: id(1000 + n), status: "open", focus: null, due_date: null, job_id: null, job_address: null, invoice_id: null, detail: "", source_ref: null, run_id: null, file_link: null, done_at: null, division: "mworx", updated_at: "2026-10-27T21:00:00Z", created_at: "2026-10-27T21:00:00Z", ...o });
export const INBOX_ITEMS = [
  item(1, { kind: "money", title: `Record payment — MWX${yy}019 Okafor Builders`, invoice_id: id(403), job_id: id(201), job_address: "4 Sample Street, Testville NSW", detail: "Remittance received 27 Oct" }),
  item(2, { kind: "proposal", title: "Fee proposal — 22 Mockingbird Way (DA)", detail: "Asked 27 Oct for a fee to prepare DA drawings", focus: true }),
  item(3, { kind: "reply", title: "Reply — Alex Rivers re BASIX timing", job_id: id(203), job_address: "15 Fixture Lane, Testville NSW", division: "mworx_energy", detail: "Holding reply drafted" }),
  item(4, { kind: "deadline", title: "Council RFI due 3 Nov — 4 Sample Street", due_date: "2026-11-03", job_id: id(201), job_address: "4 Sample Street, Testville NSW", detail: "" }),
  item(5, { kind: "file", title: "Filed — Survey.pdf → 26118 Sample Street", job_id: id(201), job_address: "4 Sample Street, Testville NSW", status: "done", done_at: "2026-10-27T21:05:00Z", file_link: "https://onedrive.live.test/mock/Survey.pdf" }),
];
export const INBOX_RUNS = [
  { ...common, id: id(1101), ran_at: "2026-10-27T21:00:00Z", status: "ok", summary: "4 items, 1 filed", counts: { items: 4 }, qa: [{ action: "file", result: "completed" }] },
];

export function fixtures() {
  return {
    bk_contacts: CONTACTS, bk_jobs: JOBS, bk_job_parties: JOB_PARTIES, bk_invoices: INVOICES, bk_invoice_items: INVOICE_ITEMS,
    bk_profiles: PROFILES, bk_quote_templates: QUOTE_TEMPLATES, bk_scope_lines: SCOPE_LINES, bk_email_connections: EMAIL_CONNECTIONS,
    bk_inbox_items: INBOX_ITEMS, bk_inbox_runs: INBOX_RUNS, bk_vaults: [], bk_vault_items: [],
  };
}
export { yy, id as fixtureId };
