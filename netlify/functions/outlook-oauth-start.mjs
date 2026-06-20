import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI;

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY
);

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  if (!CLIENT_ID || !REDIRECT_URI) {
    return new Response(JSON.stringify({ error: "Microsoft OAuth not configured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  const businessId = body.business_id || "mworx";

  const userClient = createClient(
    process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  );
  const { data: { user } } = await userClient.auth.getUser(token);
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const nonce = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await supabase.from("bk_oauth_states").delete().lt("expires_at", new Date().toISOString());

  const { error: dbErr } = await supabase.from("bk_oauth_states").insert({
    nonce,
    user_id: user.id,
    business_id: businessId,
    expires_at: expiresAt,
  });

  if (dbErr) {
    console.error("Failed to save OAuth state:", dbErr);
    return new Response(JSON.stringify({ error: "Internal error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", "offline_access User.Read Mail.Send Mail.ReadWrite Files.ReadWrite");
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("state", nonce);
  authUrl.searchParams.set("prompt", "consent");

  return new Response(JSON.stringify({ url: authUrl.toString() }), { status: 200, headers: { "Content-Type": "application/json" } });
};
