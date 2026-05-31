// Local test harness for the reminder system — NO deploy, NO Netlify login.
// Runs the EXACT logic from netlify/functions/send-reminders.mjs against your
// real Supabase + Outlook.
//
// SETUP (once):
//   1. Open the .env file in this folder
//   2. Paste the values from Netlify -> Site settings -> Environment variables
//
// RUN (from the project root):
//   Preview (sends NOTHING):
//     node --env-file=.env local-test-reminders.mjs
//   Actually send the due reminders via Outlook:
//     node --env-file=.env local-test-reminders.mjs --send
//
// .env is gitignored and never committed.

const send = process.argv.includes("--send");
const dryRun = !send;

// Validate env BEFORE importing the function: the function module builds its
// Supabase client at import time and would throw on an undefined URL.
const missing = [];
if (!process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL) missing.push("SUPABASE_URL");
if (!process.env.SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");
if (send) {
  if (!process.env.MICROSOFT_CLIENT_ID) missing.push("MICROSOFT_CLIENT_ID (needed for --send)");
  if (!process.env.MICROSOFT_CLIENT_SECRET) missing.push("MICROSOFT_CLIENT_SECRET (needed for --send)");
  if (!process.env.TOKEN_ENCRYPTION_KEY) missing.push("TOKEN_ENCRYPTION_KEY (needed for --send)");
}

if (missing.length) {
  console.error("Missing env vars:\n  - " + missing.join("\n  - "));
  console.error("\nEdit the .env file and paste the values from");
  console.error("Netlify -> Site settings -> Environment variables.");
  process.exit(1);
}

console.log(send ? "MODE: SEND (real emails WILL go out via Outlook)\n" : "MODE: PREVIEW (dry run — nothing is sent)\n");

try {
  const { runReminders } = await import("./netlify/functions/send-reminders.mjs");
  const result = await runReminders({ dryRun });
  console.log(JSON.stringify(result, null, 2));
  if (dryRun) {
    console.log(`\n${result.preview.length} reminder(s) would be sent.`);
  } else {
    console.log(`\nDone. sent=${result.sent} skipped=${result.skipped} failed=${result.failed}`);
  }
} catch (err) {
  console.error("\nFATAL:", err);
  process.exit(1);
}
