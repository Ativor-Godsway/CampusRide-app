import { compactPhoneInput, normalizeGhanaPhone } from "@rida/shared";

/**
 * The number to sign in with, from what was typed in the login form, or
 * null ("Enter a Ghana number").
 *
 * Any Ghana number the shared parser accepts: exactly the rule everywhere
 * else. Plus, only when the server says it is the STAGING server (STAGING.md),
 * a staging test number typed the way STAGING.md lists it for the apps,
 * without +233 or 0: "99 000 0021" -> "+233990000021". The server is asked
 * only for that one shape of input, so a production login is unchanged.
 */
export async function loginPhone(input: string, serverIsStaging: () => Promise<boolean>): Promise<string | null> {
  const canonical = normalizeGhanaPhone(input);
  if (canonical) return canonical;
  const compact = compactPhoneInput(input);
  if (!/^99\d{7}$/.test(compact)) return null;
  return (await serverIsStaging()) ? `+233${compact}` : null;
}
