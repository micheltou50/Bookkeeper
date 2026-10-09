// Which company a quote, invoice or project belongs to, and that company's
// profile (logo, ABN, bank details, templates, OneDrive folder) and mailbox.
//
// Rows carry business_id = the tenant ('mworx') and division = the company
// slug; bk_profiles and bk_email_connections are keyed by business_id = that
// slug (see supabase/migrations/0025_companies.sql). Callers pass the
// service-role client — RLS is bypassed there, so user_id is always explicit.

export function companyOf(row) {
  const d = row?.division;
  if (!d || d === "mworx") return "mworx";
  if (d === "mtmgmt" || d === "MT Management") return "mt_management";
  return String(d);
}

/** The profile row for the row's company; falls back to the tenant's row for
 *  data saved before 0025 (when there was only one profile). */
export async function loadCompanyProfile(supabase, userId, row) {
  const slug = companyOf(row);
  const q = (bid) => supabase.from("bk_profiles").select("*").eq("user_id", userId).eq("business_id", bid).maybeSingle();
  let { data } = await q(slug);
  if (!data && row?.business_id && row.business_id !== slug) ({ data } = await q(row.business_id));
  return data || null;
}

/** The Outlook/Microsoft connection for the row's company. With fallbackToAny
 *  (OneDrive filing, where any connected drive will do) the most recently
 *  updated connection of the user is returned when the company has none. */
export async function loadCompanyConnection(supabase, userId, row, { provider = "outlook", fallbackToAny = false } = {}) {
  const slug = companyOf(row);
  const base = () => supabase.from("bk_email_connections").select("*").eq("user_id", userId).eq("provider", provider);
  let { data } = await base().eq("business_id", slug).maybeSingle();
  if (!data && fallbackToAny) {
    const { data: any } = await base().order("updated_at", { ascending: false }).limit(1);
    data = any?.[0] || null;
  }
  return data || null;
}
