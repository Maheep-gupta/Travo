// Shell banner for offline, unreachable, paused and stale data (spec 3.5, 14.2,
// Part 16). Reads the browser's online flag and the existing query cache; it
// never fetches anything itself. A laptop that stopped reporting is shown on
// its host card, not here: the banner only judges this client's own fetches.
// Refetching on reconnect is TanStack Query's own (onlineManager resumes paused
// queries and refetchOnReconnect refreshes stale ones), so it isn't repeated here.
import { connectionMessage, formatDataTime } from "./connectivity.js";
import { useConnection, useNow } from "./hooks.js";
import { IconAlert } from "./icons.js";

/**
 * Announced politely and never focused: it informs without interrupting, and
 * sits in the page flow so it covers nothing. The live region is always
 * present so screen readers notice when text appears in it.
 */
export function OfflineBanner() {
  // Re-evaluated every 5 s so crossing the stale threshold shows up promptly.
  const now = useNow(5_000);
  const state = useConnection(now);
  const message = connectionMessage(state, (at) => formatDataTime(at, now.getTime()));

  return (
    <div role="status" aria-live="polite" className="offline-region">
      {message && (
        <div className={`offline-banner ${state.kind}${state.kind === "unreachable" ? ` ${state.cause}` : ""}`}>
          <IconAlert />
          <p>
            <strong>{message.title}</strong> <span>{message.detail}</span>
          </p>
        </div>
      )}
    </div>
  );
}
