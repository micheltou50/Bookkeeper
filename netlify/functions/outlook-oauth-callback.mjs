import { createClient } from "@supabase/supabase-js";
import { encryptToken } from "./lib/token-crypto.mjs";

const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI;
const APP_URL = process.env.URL || "https://bkeeper.netlify.app";

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE_KEY
);

export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const nonce = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    console.error("OAuth error:", error, url.searchParams.get("error_description"));
    return Response.redirect(`${APP_URL}?outlook=error&reason=${encodeURIComponent(error)}`, 302);
  }

  if (!code || !nonce) {
    return Response.redirect(`${APP_URL}?outlook=error&reason=missing_params`, 302);
  }

  const { data: stateRow, error: stateErr } = await supabase
    .from("bk_oauth_states")
    .select("*")
    .eq("nonce", nonce)
    .single();

  if (stateErr || !stateRow) {
    return Response.redirect(`${APP_URL}?outlook=error&reason=invalid_state`, 302);
  }

  await supabase.from("bk_oauth_states").delete().eq("id", stateRow.id);

  if (new Date(stateRow.expires_at) < new Date()) {
    return Response.redirect(`${APP_URL}?outlook=error&reason=state_expired`, 302);
  }

  const { user_id, business_id } = stateRow;

  try {
    const tokenResp = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        scope: "offline_access User.Read Mail.Send Mail.ReadWrite",
      }),
    });

    if (!tokenResp.ok) {
      console.error("Token exchange failed:", tokenResp.status);
      return Response.redirect(`${APP_URL}?outlook=error&reason=token_exchange`, 302);
    }

    const tokens = await tokenResp.json();

    const meResp = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const me = meResp.ok ? await meResp.json() : {};
    const email = me.mail || me.userPrincipalName || "";

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

    const { error: dbErr } = await supabase.from("bk_email_connections").upsert({
      user_id,
      business_id,
      provider: "outlook",
      email,
      access_token: encryptToken(tokens.access_token),
      refresh_token: encryptToken(tokens.refresh_token) || null,
      expires_at: expiresAt,
      scopes: tokens.scope || "offline_access User.Read Mail.Send Mail.ReadWrite",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,business_id,provider" });

    if (dbErr) {
      console.error("DB save error:", dbErr);
      return Response.redirect(`${APP_URL}?outlook=error&reason=db_save`, 302);
    }

    return Response.redirect(`${APP_URL}?outlook=connected&email=${encodeURIComponent(email)}`, 302);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return Response.redirect(`${APP_URL}?outlook=error&reason=exception`, 302);
  }
};
