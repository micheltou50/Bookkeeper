// Local sanity test for src/bankImport.js — run: node local-test-bankimport.mjs
// Covers the common Australian bank export shapes + the matching logic.
import { parseBankFile, processBankFile, summarise } from "./src/bankImport.js";

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
};

// Stand-in app data for matching.
const invoices = [
  { id: "i1", type: "invoice", status: "sent", number: "MWX26042", total: 1650.00, contact_name: "Acme Fitouts", contact_company: "Acme Fitouts Pty Ltd" },
  { id: "i2", type: "invoice", status: "overdue", number: "MWX26039", total: 2200.00, contact_name: "J Nguyen", contact_company: "Nguyen Reno" },
  { id: "i3", type: "invoice", status: "paid", number: "MWX26010", total: 990.00, contact_name: "Paid Co" },
  { id: "i4", type: "invoice", status: "sent", number: "MWX26050", total: 500.00, contact_name: "Beta Co" },
  { id: "i5", type: "invoice", status: "sent", number: "MWX26051", total: 500.00, contact_name: "Gamma Co" },
];
const existingTxns = [
  { id: "t1", date: "2026-07-21", amount: 85.00, description: "Telstra bill", contact: "Telstra" },
];
const ctx = { invoices, existingTxns };

console.log("\n1) CommBank-style headerless CSV (Date, Amount, Description, Balance; DD/MM/YYYY)");
const commbank = `02/07/2026,+1650.00,STRIPE PAYMENTS AUS PTY,12650.00
05/07/2026,-59.00,ADOBE SYSTEMS SOFTWARE,12591.00
09/07/2026,-148.30,OFFICEWORKS NTH MELB,12442.70
14/07/2026,+2200.00,PAYMENT NGUYEN RENO,14642.70
18/07/2026,-1000.00,TRANSFER TO SAVINGS,13642.70
22/07/2026,-85.00,TELSTRA CORPORATION,13557.70
26/07/2026,-24.50,UBER *TRIP HELP.UBER.COM,13533.20`;
{
  const r = processBankFile(commbank, "commbank_july.csv", ctx);
  check("parsed 7 rows", r.rows?.length === 7, `got ${r.rows?.length}`);
  check("detected headerless", r.columnMap?.headerless === true);
  check("first row date normalised to ISO", r.rows?.[0]?.date === "2026-07-02", r.rows?.[0]?.date);
  check("first row amount +1650", r.rows?.[0]?.amount === 1650, String(r.rows?.[0]?.amount));
  const s = summarise(r.items);
  check("2 invoice matches", s.invoice === 2, JSON.stringify(s));
  check("Stripe -> INV MWX26042 (name overlap)", r.items[0].invoice?.number === "MWX26042", r.items[0].invoice?.number);
  check("Adobe -> Software & Subscriptions", r.items[1].account === "Software & Subscriptions", r.items[1].account);
  check("Officeworks -> Office & Supplies", r.items[2].account === "Office & Supplies", r.items[2].account);
  check("transfer flagged review", r.items[4].status === "review", r.items[4].status);
  check("Telstra flagged duplicate (existing 21 Jul)", r.items[5].status === "duplicate", r.items[5].status);
  check("Uber -> Travel", r.items[6].account === "Travel", r.items[6].account);
  check("default selection excludes dup + review", r.items.filter((i) => i.include).length === 5, String(r.items.filter((i) => i.include).length));
}

console.log("\n2) NAB-style CSV with header + separate Debit/Credit columns");
const nab = `Date,Description,Debit,Credit,Balance
"01/07/2026","ADOBE SYSTEMS","59.00","","5000.00"
"03/07/2026","INVOICE PAYMENT ACME FITOUTS","","1650.00","6650.00"
"04/07/2026","BP CONNECT SOUTHBANK","92.10","","6557.90"`;
{
  const r = processBankFile(nab, "nab.csv", ctx);
  check("parsed 3 rows", r.rows?.length === 3, `got ${r.rows?.length}`);
  check("debit becomes negative", r.rows?.[0]?.amount === -59, String(r.rows?.[0]?.amount));
  check("credit becomes positive", r.rows?.[1]?.amount === 1650, String(r.rows?.[1]?.amount));
  check("Acme credit -> invoice match", r.items[1].status === "invoice" && r.items[1].invoice?.number === "MWX26042", r.items[1].invoice?.number);
  check("BP -> Motor Vehicle", r.items[2].account === "Motor Vehicle", r.items[2].account);
}

console.log("\n3) Header + single signed Amount, dates as 02-Jul-2026, $ and commas");
const generic = `Transaction Date,Narrative,Amount
02-Jul-2026,"GOOGLE ADS",-"$1,234.56"
03-Jul-2026,"Beta Co payment",$500.00
04-Jul-2026,"ONLINE DEPOSIT",$500.00`;
{
  const r = processBankFile(generic, "generic.csv", ctx);
  check("parsed 3 rows", r.rows?.length === 3, `got ${r.rows?.length}`);
  check("month-name date parsed", r.rows?.[0]?.date === "2026-07-02", r.rows?.[0]?.date);
  check("$ and comma stripped (-1234.56)", r.rows?.[0]?.amount === -1234.56, String(r.rows?.[0]?.amount));
  check("Google Ads -> Advertising & Marketing", r.items[0].account === "Advertising & Marketing", r.items[0].account);
  check("name disambiguates two $500 invoices -> Beta Co", r.items[1].status === "invoice" && r.items[1].invoice?.number === "MWX26050", r.items[1].invoice?.number);
  check("nameless $500 deposit (two candidates) -> review", r.items[2].status === "review", r.items[2].status);
}

console.log("\n4) OFX file");
const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260705120000<TRNAMT>-59.00<FITID>ABC123<NAME>ADOBE SYSTEMS</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260714<TRNAMT>2200.00<FITID>XYZ789<NAME>NGUYEN RENO PAYMENT</STMTTRN>
</BANKTRANLIST></STMTTRNRS></BANKMSGSRSV1></OFX>`;
{
  const r = processBankFile(ofx, "statement.ofx", ctx);
  check("detected ofx format", r.format === "ofx", r.format);
  check("parsed 2 transactions", r.rows?.length === 2, `got ${r.rows?.length}`);
  check("OFX date parsed", r.rows?.[0]?.date === "2026-07-05", r.rows?.[0]?.date);
  check("FITID captured as bank_ref", r.rows?.[0]?.bank_ref === "ABC123", r.rows?.[0]?.bank_ref);
  check("Nguyen credit -> invoice MWX26039", r.items[1].invoice?.number === "MWX26039", r.items[1].invoice?.number);
}

console.log("\n5) Error handling");
check("empty file -> error", !!parseBankFile("", "x.csv").error);
check("garbage -> error or zero rows", (() => { const r = parseBankFile("just some text\nmore text", "x.csv"); return r.error || r.rows.length === 0; })());

console.log(`\n${fail === 0 ? "ALL GREEN" : "SOME FAILURES"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
