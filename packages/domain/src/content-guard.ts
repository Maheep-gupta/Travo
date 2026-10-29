const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Parsed by hand: this package must run on React Native, whose URL polyfill
// does not reliably implement `hostname`.
const AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::\d*)?(?:[/?#]|$)/i;

export function isLoopbackUrl(url: string): boolean {
  const host = AUTHORITY.exec(url.trim())?.[1]?.toLowerCase();
  if (!host) return false;
  return LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export type ContentDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Transcript content may only be written to a database running on this
 * machine, and only when the user has opted in. There is deliberately no
 * override for remote URLs in this release.
 */
export function transcriptContentDecision(backendUrl: string, optedIn: boolean): ContentDecision {
  if (!optedIn) return { allowed: false, reason: "Transcript sync is not enabled (MC_SYNC_TRANSCRIPTS)." };
  if (!isLoopbackUrl(backendUrl)) {
    return { allowed: false, reason: "Transcript content is only stored in a local (loopback) database." };
  }
  return { allowed: true };
}
