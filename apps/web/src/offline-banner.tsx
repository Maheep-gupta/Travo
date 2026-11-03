// Shell banner for offline, unreachable, paused and stale data (spec 3.5, 14.2,
// Part 16). Reads the browser's online flag and the existing query cache; it
// never fetches anything itself. A laptop that stopped reporting is shown on
// its host card, not here: the banner only judges this client's own fetches.
// Refetching on reconnect is TanStack Query's own (onlineManager resumes paused
// queries and refetchOnReconnect refreshes stale ones), so it isn't repeated here.
import { useEffect, useSyncExternalStore } from "react";
import { connectionMessage, formatDataTime } from "./connectivity.js";
import { useConnection, useStatusClock } from "./hooks.js";
import { IconAlert } from "./icons.js";

// Whether a mounted banner is saying the project is paused, so a page's own
// error state can point to it instead of repeating the same message (QA LOW-4).
let showsPaused = false;
const pausedListeners = new Set<() => void>();

function setShowsPaused(next: boolean): void {
  if (showsPaused === next) return;
  showsPaused = next;
  for (const l of pausedListeners) l();
}

function subscribePaused(listener: () => void): () => void {
  pausedListeners.add(listener);
  return () => pausedListeners.delete(listener);
}

/** True while the banner says the Supabase project is paused. False where no banner is mounted (sign-in, setup). */
export function useBannerShowsPaused(): boolean {
  return useSyncExternalStore(subscribePaused, () => showsPaused, () => false);
}

/**
 * Announced politely and never focused: it informs without interrupting, and
 * sits in the page flow so it covers nothing. The live region is always
 * present so screen readers notice when text appears in it.
 */
export function OfflineBanner() {
  // The shared status clock (every 5 s), so the banner and the top bar's indicator change together.
  const now = useStatusClock();
  const state = useConnection(now);
  const message = connectionMessage(state, (at) => formatDataTime(at, now.getTime()));
  const paused = message !== null && state.kind === "unreachable" && state.cause === "paused";
  useEffect(() => {
    setShowsPaused(paused);
    return () => setShowsPaused(false);
  }, [paused]);

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
