import { PROVIDER_ERROR_KINDS } from "@mc/contracts/constants";
import type { ProviderErrorKind } from "@mc/contracts";

/** What to tell the user about a failing session source, and what they can do. */
export interface SourceFailureText {
  /** null when the category is missing (pre-v4 connector) or unknown to this release. */
  kind: ProviderErrorKind | null;
  /**
   * Lead-in: what the failure means for the host's sessions, as a sentence
   * about "the host" (no full stop). Reading failures and refused updates
   * read differently, so the effect is never misstated.
   */
  summary: string;
  /** The reported cause. */
  title: string;
  guidance: string;
}

const CANT_READ = "The host can't read its sessions";
const NOT_SAVED = "The host's session updates aren't being saved";

// Plain text, no markup: commands are named in prose so every client can show them as is.
const DOCTOR = "Run npm run connector -- doctor on the host for details.";

const TEXT: Record<ProviderErrorKind, Omit<SourceFailureText, "kind">> = {
  cli_missing: {
    summary: CANT_READ,
    title: "Claude Code CLI not found on this computer",
    guidance:
      "Install Claude Code on the host, or make sure the claude command is on the PATH of the account the connector runs as, then restart the connector. On Windows, a .cmd or .bat shim isn't run: point the connector at claude.exe instead.",
  },
  auth_required: {
    summary: CANT_READ,
    title: "Claude Code isn't signed in on this computer",
    guidance: "Open a terminal on the host and run claude to sign in. Tavro reads the sessions again on its next check.",
  },
  // timeout, interrupted and failed are worded for any session source: the
  // demo simulates a timeout, and a future provider may report them too.
  timeout: {
    summary: CANT_READ,
    title: "Reading sessions timed out",
    guidance: `The host may be busy or just woke from sleep, and the connector keeps retrying. If this lasts: ${DOCTOR}`,
  },
  invalid_output: {
    summary: CANT_READ,
    title: "Claude Code's session list couldn't be understood",
    guidance: "Its output format may have changed after an update. Check for a newer Tavro connector. Nothing was marked ended because of this.",
  },
  incompatible_version: {
    summary: CANT_READ,
    title: "This Claude Code version isn't supported",
    guidance: `Update the Tavro connector, or use a Claude Code version it supports. ${DOCTOR}`,
  },
  interrupted: {
    summary: CANT_READ,
    title: "Reading sessions was interrupted",
    guidance: "This usually happens while the host is shutting down or going to sleep. The connector retries on its own.",
  },
  failed: {
    summary: CANT_READ,
    title: "The session source reported an error",
    guidance: `The connector keeps retrying. ${DOCTOR}`,
  },
  writes_not_applied: {
    summary: NOT_SAVED,
    title: "The backend keeps refusing or skipping its updates",
    guidance: "Check that this computer's clock is right and that only one connector runs for this host.",
  },
};

const GENERIC: Omit<SourceFailureText, "kind"> = {
  summary: CANT_READ,
  title: "The connector didn't report why",
  guidance: `Its session source isn't responding. ${DOCTOR}`,
};

const KNOWN: ReadonlySet<string> = new Set(PROVIDER_ERROR_KINDS);

/**
 * User-facing text for a failing session source (schema v4
 * hosts.provider_error_kind). Call it only while the source is failing
 * (provider_error_since set). A missing or unrecognised category gets the
 * generic text: the raw value is never shown.
 *
 * provider_error_since marks when the failure started, and stays put if the
 * category changes while it lasts: word any "since" so it doesn't claim the
 * current category lasted the whole time.
 */
export function sourceFailureText(kind: string | null | undefined): SourceFailureText {
  if (typeof kind === "string" && KNOWN.has(kind)) {
    const k = kind as ProviderErrorKind;
    return { kind: k, ...TEXT[k] };
  }
  return { kind: null, ...GENERIC };
}
