import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface LocalEnv {
  url: string;
  publishableKey: string;
  secretKey: string;
}

/** Reads keys from the running local stack. Test-only: the secret key never leaves Node. */
export function localEnv(): LocalEnv {
  let out: string;
  try {
    out = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("Local Supabase is not running. Start it with `npm run db:start`.");
  }
  const vars = Object.fromEntries(
    out
      .split(/\r?\n/)
      .map((l) => /^([A-Z_]+)="?(.*?)"?$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
  const url = vars["API_URL"];
  const publishableKey = vars["PUBLISHABLE_KEY"] ?? vars["ANON_KEY"];
  const secretKey = vars["SECRET_KEY"] ?? vars["SERVICE_ROLE_KEY"];
  if (!url || !publishableKey || !secretKey) throw new Error("Could not read local Supabase keys from `supabase status`.");
  return { url, publishableKey, secretKey };
}

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } };

export function anonClient(env: LocalEnv): SupabaseClient {
  return createClient(env.url, env.publishableKey, noPersist);
}

export function adminClient(env: LocalEnv): SupabaseClient {
  return createClient(env.url, env.secretKey, noPersist);
}

export async function signedIn(env: LocalEnv, email: string, password: string): Promise<SupabaseClient> {
  const c = anonClient(env);
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return c;
}

export interface Owner {
  id: string;
  email: string;
  client: SupabaseClient;
}

export async function createOwner(env: LocalEnv): Promise<Owner> {
  const email = `owner-${randomUUID()}@test.local`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await adminClient(env).auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  return { id: data.user.id, email, client: await signedIn(env, email, password) };
}

export async function startPairing(owner: Owner, name = "Test laptop"): Promise<{ host_id: string; code: string }> {
  const { data, error } = await owner.client.rpc("create_host_pairing", { p_name: name });
  if (error) throw error;
  const row = (data as { host_id: string; code: string }[])[0];
  if (!row) throw new Error("no pairing row");
  return row;
}

export async function redeem(env: LocalEnv, code: string): Promise<Response> {
  return fetch(`${env.url}/functions/v1/pair-host`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: env.publishableKey },
    body: JSON.stringify({ code, platform: "test", connector_version: "0.0.0-test" }),
  });
}

export interface Host {
  id: string;
  client: SupabaseClient;
}

export async function pairHost(env: LocalEnv, owner: Owner): Promise<Host> {
  const { code } = await startPairing(owner);
  const res = await redeem(env, code);
  if (!res.ok) throw new Error(`pair-host failed: ${res.status} ${await res.text()}`);
  const creds = (await res.json()) as { host_id: string; email: string; password: string };
  return { id: creds.host_id, client: await signedIn(env, creds.email, creds.password) };
}

export function sessionRow(externalId: string = randomUUID()) {
  return {
    provider: "mock",
    external_id: externalId,
    title: "Test session",
    project_label: "proj",
    status: "running",
    status_reason: null,
    status_source: "mock",
    last_activity_at: new Date().toISOString(),
    last_event_summary: null,
    capabilities: ["discover"],
    is_demo: true,
    started_at: null,
    ended_at: null,
  };
}
