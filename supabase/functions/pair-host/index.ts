// Exchanges a one-time pairing code for a dedicated host login.
//
// Runs server-side in the user's Supabase project; the secret key never
// leaves this function. Called by the local connector with only the
// publishable key (verify_jwt = false in config.toml), so the pairing code is
// the credential. Codes are single-use, expire after 10 minutes, and only
// their SHA-256 is stored.
import { createClient } from "npm:@supabase/supabase-js@2";

// Mirrors PairingTicket.code in packages/contracts/src/host.ts.
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function secretKey(): string {
  const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<string, string>;
  const key = keys["default"] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("secret key not configured");
  return key;
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(36));
  return btoa(String.fromCharCode(...bytes)).replace(/[^A-Za-z0-9]/g, "").padEnd(40, "x");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  let body: { code?: unknown; platform?: unknown; connector_version?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!CODE_RE.test(code)) return json(400, { error: "invalid_code" });
  const platform = typeof body.platform === "string" ? body.platform.slice(0, 50) : "unknown";
  const connectorVersion = typeof body.connector_version === "string" ? body.connector_version.slice(0, 50) : "unknown";

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: hostId, error: peekError } = await admin.rpc("peek_host_pairing", { p_code: code });
  if (peekError) return json(500, { error: "pairing_failed" });
  // Same response for unknown, used and expired codes.
  if (!hostId) return json(400, { error: "invalid_or_expired_code" });

  const email = `host-${hostId}@hosts.tavro.invalid`;
  const password = randomPassword();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { mc_role: "host", host_id: hostId },
  });
  if (createError || !created.user) return json(409, { error: "pairing_failed" });

  const { data: claimed, error: claimError } = await admin.rpc("claim_host_pairing", {
    p_code: code,
    p_auth_user_id: created.user.id,
    p_platform: platform,
    p_connector_version: connectorVersion,
  });
  if (claimError || claimed !== true) {
    // Lost a race (code used/expired/revoked meanwhile): remove the orphan login.
    await admin.auth.admin.deleteUser(created.user.id);
    return json(400, { error: "invalid_or_expired_code" });
  }

  return json(200, { host_id: hostId, email, password });
});
