// Backend error classification shared by every client and the connector. Pure:
// callers pass the few fields they read from a Supabase error, never its type.

/**
 * PostgREST JWT failures: invalid or expired token (301), anonymous access
 * refused (302), claims failed validation, e.g. `exp` in the past (303).
 */
export const POSTGREST_JWT_ERROR_CODES: ReadonlySet<string> = new Set(["PGRST301", "PGRST302", "PGRST303"]);

/** The fields isKeyRejection reads; a PostgREST or Auth error satisfies it. */
export interface BackendErrorFields {
  message?: string;
  code?: string;
  hint?: string | null;
}

/**
 * Whether a 401 came from the API gateway refusing the `apikey` (rotated,
 * revoked or mistyped publishable key) rather than from an expired sign-in.
 * The gateway answers e.g. `{"message":"Invalid API key","hint":"…"}`; PostgREST
 * and Auth never mention an API key for a bad user token, and a PostgREST JWT
 * code wins over any text. Only matched, never shown or logged.
 */
export function isKeyRejection(e: BackendErrorFields | null, status?: number): boolean {
  if (status !== 401 || (e?.code !== undefined && POSTGREST_JWT_ERROR_CODES.has(e.code))) return false;
  return /\bapi key\b/i.test(`${e?.message ?? ""} ${e?.hint ?? ""}`);
}
