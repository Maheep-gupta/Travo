import { z } from "zod";

/** What a client needs to connect to a user's Supabase project. Never a secret. */
export const ConnectionConfig = z.object({
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(u), {
      message: "Use https:// (http:// is allowed only for a local Supabase on this machine).",
    }),
  publishableKey: z
    .string()
    .trim()
    .min(20, "That does not look like a Supabase key.")
    .refine((k) => !isPrivilegedKey(k), {
      message: "This is a secret / service-role key. Never paste it into a browser or app — use the publishable key.",
    }),
});
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

// atob exists in browsers, Node >= 16 and Hermes (React Native), but is not in the ES lib typings.
const atob = (globalThis as { atob?: (s: string) => string }).atob;

function base64UrlDecode(part: string): string | null {
  if (!atob) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return atob(b64);
  } catch {
    return null;
  }
}

/** Detects new-style secret keys and legacy JWT keys whose role is service_role. */
export function isPrivilegedKey(key: string): boolean {
  const k = key.trim();
  if (k.startsWith("sb_secret_")) return true;
  const parts = k.split(".");
  if (parts.length === 3 && parts[1]) {
    const payload = base64UrlDecode(parts[1]);
    if (payload) {
      try {
        const role = (JSON.parse(payload) as { role?: unknown }).role;
        return role === "service_role" || role === "supabase_admin";
      } catch {
        return false;
      }
    }
  }
  return false;
}
