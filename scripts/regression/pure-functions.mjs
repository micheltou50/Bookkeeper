#!/usr/bin/env node
// Pure-function regression: the numbering, date and division helpers that the
// original app's quote, invoice and project flows depend on, extracted from
// src/App.jsx as it stands and from the same file on main, and run on the same
// fixtures. Any helper that is not meant to change must give identical answers.
//   node scripts/regression/pure-functions.mjs [path/to/main/App.jsx]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const branchSrc = fs.readFileSync(path.join(here, "../../src/App.jsx"), "utf8");
const mainPath = process.argv[2];
const mainSrc = mainPath ? fs.readFileSync(mainPath, "utf8") : null;

// The registry the helpers read (module-level in App.jsx), then the helpers.
const DEPS = ["ALL_DIVISIONS", "DEFAULT_COMPANIES", "DIVISIONS", "KNOWN_COMPANIES", "prefixFromName", "companyFromProfile", "setCompanyRegistry", "divisionInfo"];
const NAMES = ["today", "addDays", "fmtDate", "getDefaultDueDate", "recordDivision", "getDocumentPrefix", "getNextDocumentNumber", "getNextJobNumber", "firstName", "lastName"];
// Take exactly one definition: "function name(" with its balanced braces, or
// "const name = " up to the end of the statement, braces and parens balanced.
function extract(src, name) {
  const starts = [`\nfunction ${name}(`, `\nconst ${name} = `, `\nlet ${name} = `];
  for (const start of starts) {
    const at = src.indexOf(start);
    if (at < 0) continue;
    let i = at + 1, depth = 0, seen = false, inStr = null;
    for (; i < src.length; i++) {
      const ch = src[i], prev = src[i - 1];
      if (inStr) { if (ch === inStr && prev !== "\\") inStr = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
      if (ch === "/" && src[i + 1] === "/") { if (depth === 0) break; i = src.indexOf("\n", i) - 1; continue; }
      if (ch === "{" || ch === "(" || ch === "[") { depth++; seen = true; }
      else if (ch === "}" || ch === ")" || ch === "]") { depth--; if (ch === "}" && depth === 0 && seen && start.startsWith("\nfunction")) { i++; break; } }
      else if (ch === "\n" && depth === 0 && (seen || /;\s*$/.test(src.slice(at, i)))) break;
    }
    return src.slice(at + 1, i).trim();
  }
  return null;
}
function load(src) {
  const parts = [...DEPS, ...NAMES].map((n) => extract(src, n)).filter(Boolean);
  const body = parts.join("\n") + `\nsetCompanyRegistry(PROFILES);\nreturn { ${NAMES.filter((n) => parts.some((p) => p.includes(n))).join(", ")} };`;
  return new Function("PROFILES", body)(load.PROFILES);
}
// The registry as the live bk_profiles rows set it (three companies, these prefixes).
load.PROFILES = [
  { business_id: "mworx", name: "Mworx Group", invoice_prefix: "MWX", quote_prefix: "QMWX" },
  { business_id: "mworx_energy", name: "Mworx Energy", invoice_prefix: "ME", quote_prefix: "QME" },
  { business_id: "mt_management", name: "MT Management", invoice_prefix: "MTM", quote_prefix: "QMTM" },
];

const invoices = [
  { number: "QMWX26017", type: "quote", division: "mworx" },
  { number: "QMWX26016", type: "quote", division: "mworx" },
  { number: "MWX26019", type: "invoice", division: "mworx" },
  { number: "MWX26017", type: "invoice", division: "mworx" },
  { number: "QME26001", type: "quote", division: "mworx_energy" },
  { number: "QMTM26002", type: "quote", division: "mt_management" },
  { number: "MTM26001", type: "invoice", division: "mt_management" },
  { number: "QMWX25009", type: "quote", division: "mworx" },
];
const jobs = [
  { job_number: "26118", division: "mworx" }, { job_number: "26117", division: "mworx" }, { job_number: "25100", division: "mworx" },
  { job_number: "261003", division: "mworx_energy" }, { job_number: "261001", division: "mworx_energy" },
  { job_number: "26105", division: "mt_management" },
];
const yy = String(new Date().getFullYear()).slice(-2);

const cases = (f) => ({
  "quote number, Mworx Group": f.getNextDocumentNumber?.(invoices, "mworx", "quote"),
  "invoice number, Mworx Group": f.getNextDocumentNumber?.(invoices, "mworx", "invoice"),
  "quote number, Mworx Energy": f.getNextDocumentNumber?.(invoices, "mworx_energy", "quote"),
  "invoice number, Mworx Energy (none yet)": f.getNextDocumentNumber?.(invoices, "mworx_energy", "invoice"),
  "quote number, MT Management": f.getNextDocumentNumber?.(invoices, "mt_management", "quote"),
  "invoice number, MT Management": f.getNextDocumentNumber?.(invoices, "mt_management", "invoice"),
  "prefix quote mworx": f.getDocumentPrefix?.("mworx", "quote"),
  "prefix invoice mworx_energy": f.getDocumentPrefix?.("mworx_energy", "invoice"),
  "division of a legacy row with no division": f.recordDivision?.({}),
  "division of an mworx_energy row": f.recordDivision?.({ division: "mworx_energy" }),
  "default due date, invoice from 2026-10-28": f.getDefaultDueDate?.("invoice", "2026-10-28"),
  "default due date, quote from 2026-10-28": f.getDefaultDueDate?.("quote", "2026-10-28"),
  "addDays 2026-12-30 + 5": f.addDays?.("2026-12-30", 5),
  "first name": f.firstName?.("Cameron Mawson"),
  "last name": f.lastName?.("Mary Jane Watson"),
  "job number, Mworx Group": f.getNextJobNumber?.length >= 2 ? f.getNextJobNumber(jobs, "mworx") : f.getNextJobNumber?.(jobs),
  "job number, Mworx Energy": f.getNextJobNumber?.length >= 2 ? f.getNextJobNumber(jobs, "mworx_energy") : f.getNextJobNumber?.(jobs),
  "job number, MT Management": f.getNextJobNumber?.length >= 2 ? f.getNextJobNumber(jobs, "mt_management") : f.getNextJobNumber?.(jobs),
});

const expectBranch = {
  "quote number, Mworx Group": `QMWX${yy}018`, "invoice number, Mworx Group": `MWX${yy}020`,
  "quote number, Mworx Energy": `QME${yy}002`, "invoice number, Mworx Energy (none yet)": `ME${yy}001`,
  "quote number, MT Management": `QMTM${yy}003`, "invoice number, MT Management": `MTM${yy}002`,
  "job number, Mworx Group": `${yy}119`, "job number, Mworx Energy": `${yy}1004`, "job number, MT Management": `${yy}119`,
  "default due date, invoice from 2026-10-28": "2026-11-04", "default due date, quote from 2026-10-28": "2026-11-27",
};
const INTENDED_DIFF = new Set(["job number, Mworx Group", "job number, Mworx Energy", "job number, MT Management"]);

const b = cases(load(branchSrc));
let failed = 0;
for (const [k, v] of Object.entries(b)) {
  const want = expectBranch[k];
  const ok = want === undefined ? v !== undefined : v === want;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} branch  ${k} → ${JSON.stringify(v)}${want !== undefined && v !== want ? ` (expected ${want})` : ""}`);
}
if (mainSrc) {
  const m = cases(load(mainSrc));
  console.log("--- against main");
  for (const k of Object.keys(b)) {
    const same = JSON.stringify(m[k]) === JSON.stringify(b[k]);
    if (!same && !INTENDED_DIFF.has(k)) failed++;
    console.log(`${same ? "= same " : INTENDED_DIFF.has(k) ? "≠ intended" : "✗ CHANGED"}  ${k}: main ${JSON.stringify(m[k])} | branch ${JSON.stringify(b[k])}`);
  }
}
console.log(failed ? `${failed} FAILED` : "all pass");
process.exitCode = failed ? 1 : 0;
