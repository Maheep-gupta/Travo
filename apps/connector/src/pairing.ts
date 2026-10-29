import { PairHostRequest, PairHostResponse } from "@mc/contracts";
import { saveCredentials } from "./credentials.js";

/**
 * Redeems a one-time pairing code (shown in the web app) for this host's
 * login and stores it locally. The password is never printed.
 */
export async function pairHost(opts: {
  url: string;
  publishableKey: string;
  code: string;
  platform: string;
  version: string;
  dataDir: string;
  fetchImpl?: typeof fetch;
}): Promise<{ hostId: string; file: string }> {
  const body = PairHostRequest.parse({ code: opts.code.trim().toUpperCase(), platform: opts.platform, connector_version: opts.version });
  const res = await (opts.fetchImpl ?? fetch)(`${opts.url.replace(/\/$/, "")}/functions/v1/pair-host`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: opts.publishableKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(`Pairing failed: ${err}. Create a new code in the web app and try again.`);
  }
  const creds = PairHostResponse.parse(await res.json());
  const file = await saveCredentials(opts.dataDir, creds);
  return { hostId: creds.host_id, file };
}
