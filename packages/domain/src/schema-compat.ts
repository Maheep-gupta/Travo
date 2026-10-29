import { MAX_SCHEMA_VERSION, MIN_SCHEMA_VERSION } from "@mc/contracts/constants";

export type SchemaCompat =
  | { ok: true }
  | { ok: false; reason: "not_installed" | "too_old" | "too_new"; message: string };

export function checkSchemaCompat(installed: number | null): SchemaCompat {
  if (installed === null) {
    return { ok: false, reason: "not_installed", message: "The Tavro schema is not installed in this Supabase project." };
  }
  if (installed < MIN_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "too_old",
      message: `This project has schema v${installed}; this app needs v${MIN_SCHEMA_VERSION}–v${MAX_SCHEMA_VERSION}. Apply the pending migrations.`,
    };
  }
  if (installed > MAX_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "too_new",
      message: `This project has schema v${installed}, newer than this app supports (v${MAX_SCHEMA_VERSION}). Update the app.`,
    };
  }
  return { ok: true };
}
