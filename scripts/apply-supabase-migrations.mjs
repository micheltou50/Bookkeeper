#!/usr/bin/env node
/**
 * Apply BookKeeper Supabase migrations (0007 + 0008 + 0009 + 0010) to the live project.
 *
 * Requires SUPABASE_SERVICE_KEY (service_role) in .env or environment.
 * Project ref: yzndkdlzgegrcotfeqlp
 *
 * Usage: node scripts/apply-supabase-migrations.mjs [--check-only]
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadEnv() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

loadEnv();

const PROJECT_REF = "yzndkdlzgegrcotfeqlp";
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || `https://${PROJECT_REF}.supabase.co`;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const checkOnly = process.argv.includes("--check-only");

async function checkDivisionColumn() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bk_transactions?select=division&limit=1`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (res.ok) return { applied: true, detail: "division column exists on bk_transactions" };
  const body = await res.text();
  if (body.includes("division") && body.includes("does not exist")) {
    return { applied: false, detail: "division column missing" };
  }
  return { applied: false, detail: body.slice(0, 200) };
}

async function runSql(sql, label) {
  // Supabase exposes DDL via the postgres meta API only with a DB password or
  // management token. The service role can call rpc if a helper exists; we use
  // the SQL editor workflow as fallback and print the SQL when no DB URL is set.
  const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log(`\n--- ${label} (paste into Supabase SQL editor) ---\n${sql}\n`);
    return { ok: false, manual: true };
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(sql);
    return { ok: true };
  } finally {
    await client.end();
  }
}

async function main() {
  if (!SERVICE_KEY && checkOnly) {
    console.error("Set SUPABASE_SERVICE_KEY in .env to check migration status.");
    process.exit(1);
  }

  if (SERVICE_KEY) {
    const status = await checkDivisionColumn();
    console.log(`Migration 0007 status: ${status.applied ? "APPLIED" : "NOT APPLIED"} (${status.detail})`);
    if (checkOnly) process.exit(status.applied ? 0 : 1);
  } else if (checkOnly) {
    console.error("SUPABASE_SERVICE_KEY required for --check-only");
    process.exit(1);
  }

  const m0007 = readFileSync(join(root, "supabase/migrations/0007_divisions.sql"), "utf8");
  const m0008 = readFileSync(join(root, "supabase/migrations/0008_standardise_division_slug.sql"), "utf8");
  const m0009 = readFileSync(join(root, "supabase/migrations/0009_bank_reconciliation.sql"), "utf8");
  const m0010 = readFileSync(join(root, "supabase/migrations/0010_onedrive_receipts_folder.sql"), "utf8");

  const r7 = await runSql(m0007, "0007_divisions.sql");
  const r8 = await runSql(m0008, "0008_standardise_division_slug.sql");
  const r9 = await runSql(m0009, "0009_bank_reconciliation.sql");
  const r10 = await runSql(m0010, "0010_onedrive_receipts_folder.sql");

  if (r7.manual || r8.manual || r9.manual || r10.manual) {
    console.log("\nNo SUPABASE_DB_URL set — copy the SQL above into:");
    console.log(`https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new`);
    process.exit(0);
  }

  if (SERVICE_KEY) {
    const after = await checkDivisionColumn();
    console.log(`After apply: ${after.applied ? "OK" : "FAILED"} — ${after.detail}`);
    process.exit(after.applied ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
