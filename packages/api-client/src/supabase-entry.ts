// Supabase backend entry. Loaded on demand by clients that connect to a
// user's project; includes supabase-js and the zod connection validation.
export { createSupabaseApi } from "./supabase-api.js";
export { ConnectionConfig, isPrivilegedKey } from "./connection.js";
