// What Settings > Application reports about this build and this device.
import { version } from "../package.json";

export const APP_VERSION: string = version;

/** Vite's build mode: "production" for a release build, "development" under the dev server. */
export const BUILD_MODE: string = import.meta.env.MODE;

export type InstallState = "installed" | "browser" | "unknown";

/** The parts of window/navigator we read; injectable for tests. */
export interface InstallEnv {
  matchMedia?: (query: string) => { readonly matches: boolean };
  /** iOS Safari's non-standard flag for Home Screen apps. */
  standalone?: boolean;
}

function browserEnv(): InstallEnv {
  if (typeof window === "undefined") return {};
  return {
    matchMedia: typeof window.matchMedia === "function" ? (q) => window.matchMedia(q) : undefined,
    standalone: (navigator as { standalone?: boolean }).standalone,
  };
}

/** Whether Tavro is running as an installed app (its own window) or in a browser tab. */
export function installState(env: InstallEnv = browserEnv()): InstallState {
  if (env.standalone === true) return "installed";
  if (!env.matchMedia) return "unknown";
  try {
    return env.matchMedia("(display-mode: standalone)").matches || env.matchMedia("(display-mode: window-controls-overlay)").matches ? "installed" : "browser";
  } catch {
    return "unknown";
  }
}
