/** What the owner has to do about a refusal; picks the connector's advice. */
export type HostAuthRemedy = "pair_again" | "check_publishable_key";

/**
 * The backend answered and refused this host: its login was rejected, the
 * host was revoked (remedy "pair_again"), or the project rejected the
 * publishable key itself (remedy "check_publishable_key": re-pairing can't
 * fix a rotated or mistyped key in .env). Retrying soon can't fix either.
 * Kept apart from network failures (which stay "offline" with normal backoff)
 * so a revoked host neither hammers the backend nor looks merely offline.
 * Messages are fixed text plus a status or code: never credentials.
 */
export class HostAuthError extends Error {
  constructor(
    message: string,
    readonly remedy: HostAuthRemedy = "pair_again",
  ) {
    super(message);
    this.name = "HostAuthError";
  }
}

/**
 * The database refused transcript rows: transcript storage is off for this
 * project (`app_meta.transcripts_enabled`, migration 20261105000001). That is
 * the safe default everywhere except a seeded local stack, so it is a setting,
 * not an outage: the connector stops sending transcripts and carries on.
 */
export class TranscriptsRefusedError extends Error {
  constructor() {
    super("transcript storage is disabled in this database (42501)");
    this.name = "TranscriptsRefusedError";
  }
}
