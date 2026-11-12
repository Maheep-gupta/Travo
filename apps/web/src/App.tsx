import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router";
import { ApiError, type AuthUser, type SignOutResult } from "@mc/api-client/demo";
import { checkSchemaCompat, statusIndicator, unreadCount } from "@mc/domain";
import { AlertsProvider, useAlerts } from "./alerts-context.js";
import "./alerts.css";
import "./shell.css";
import { useApi, useApiContext, useLiveUpdates } from "./api-context.js";
import { ErrorState, Notice, Spinner } from "./components.js";
import { SignOutReportContext, clearUserData, useStatusSync } from "./hooks.js";
import { BrandMark, IconBell, IconHost, IconSessions, IconSettings } from "./icons.js";
import { forgetUserLocalData, noteSignedInUser } from "./local-data.js";
import { OfflineBanner } from "./offline-banner.js";
import { PageErrorBoundary, retryableLazy } from "./page-loading.js";
import { useRouteFocus } from "./route-focus.js";
import { webStorage } from "./platform.js";
import { closeSystemNotifications } from "./system-notifications.js";
import { BASE_TITLE, titleWithUnread, updateAppBadge } from "./unread-indicator.js";
import { DashboardPage } from "./pages/DashboardPage.js";

// Route-level code splitting: only the dashboard ships in the initial chunk.
// retryableLazy + PageErrorBoundary make a failed chunk download recoverable.
const SessionPage = retryableLazy(() => import("./pages/SessionPage.js").then((m) => m.SessionPage));
const HostsPage = retryableLazy(() => import("./pages/HostsPage.js").then((m) => m.HostsPage));
const HostPage = retryableLazy(() => import("./pages/HostPage.js").then((m) => m.HostPage));
const AlertsPage = retryableLazy(() => import("./pages/AlertsPage.js").then((m) => m.AlertsPage));
const SettingsPage = retryableLazy(() => import("./pages/SettingsPage.js").then((m) => m.SettingsPage));
const SetupPage = retryableLazy(() => import("./pages/SetupPage.js").then((m) => m.SetupPage));
const SetupChecklistPage = retryableLazy(() => import("./pages/SetupChecklistPage.js").then((m) => m.SetupChecklistPage));
const SignInPage = retryableLazy(() => import("./pages/SignInPage.js").then((m) => m.SignInPage));

export function App() {
  const { state, setChoice } = useApiContext();
  if (state.status === "none") {
    return (
      <PageErrorBoundary resetKey="setup">
        <Suspense fallback={<Spinner />}>
          <SetupPage />
        </Suspense>
      </PageErrorBoundary>
    );
  }
  if (state.status === "loading") return <Spinner label="Starting…" />;
  if (state.status === "error") {
    return (
      <Centered title="Couldn't start">
        <Notice tone="error">
          <p>{state.message}</p>
        </Notice>
        <div className="row">
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Retry
          </button>
          <button type="button" className="btn ghost" onClick={() => setChoice(null)}>
            Change backend
          </button>
        </div>
      </Centered>
    );
  }
  return <AuthGate />;
}

function AuthGate() {
  const api = useApi();
  const [user, setUserState] = useState<AuthUser | null | undefined>(undefined);
  const [expired, setExpired] = useState(false);
  // The project refused the publishable key: signing in again can't fix that.
  const [keyRejected, setKeyRejected] = useState<ApiError | null>(null);
  // An explicit sign-out ended the session here but the server wasn't told.
  const [serverNotTold, setServerNotTold] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const queryClient = useQueryClient();
  // The user the cache belongs to, readable synchronously from the listeners below.
  const current = useRef<AuthUser | null | undefined>(undefined);

  const setUser = useCallback(
    (next: AuthUser | null) => {
      // Cached sessions, hosts and preferences belong to the previous user. Drop
      // them on sign-out and on any direct switch to another account (a token
      // swap, a sign-in in another tab), so the next user never sees them or
      // is baselined against them.
      const prev = current.current;
      if (prev && prev.id !== next?.id) {
        clearUserData(queryClient);
        closeSystemNotifications();
        // Re-detected by the next user's first query if the key is still refused.
        setKeyRejected(null);
      }
      current.current = next;
      if (next) {
        // A different person than last time: forget the previous one's local
        // alert history before anything of the new user mounts.
        noteSignedInUser(webStorage, api.kind, next.id);
        setExpired(false);
        setServerNotTold(false);
      }
      setUserState(next);
    },
    [api.kind, queryClient],
  );

  useEffect(() => {
    let alive = true;
    // Only the initial value: an auth event that already arrived is newer.
    const initial = (u: AuthUser | null) => {
      if (alive && current.current === undefined) setUser(u);
    };
    api.getUser().then(initial, () => initial(null));
    const off = api.onAuthChange(setUser);
    return () => {
      alive = false;
      off();
    };
  }, [api, setUser]);

  // Expired authentication: a query of the CURRENT user rejected as
  // unauthorized signs out locally and returns to sign-in with a notice.
  // Errors from another user's queries (e.g. a late 401 after switching
  // accounts) are ignored, and so are mutations: they are not keyed by user,
  // and an expired session is caught by the next query anyway. Only acts while
  // signed in, so failures still in flight afterwards cannot repeat it. A
  // rejected publishable key is not an expiry: it shows a configuration error
  // and keeps the sign-in, instead of a sign-in loop that can never succeed.
  useEffect(() => {
    // Demo data has no real session and never expires.
    if (api.kind === "demo") return;
    let alive = true;
    // Set while a failed read of the stored sign-in waits for the network to return.
    let offOnline: (() => void) | null = null;
    // Another tab signed in to another account. Its auth event normally
    // follows at once; follow the stored sign-in in case none comes. If that
    // read fails (offline), the pinned queries keep refusing with their
    // "reload" message, and it is tried again when the browser is back online
    // or the next of them is refused.
    const followStoredSignIn = (signedIn: AuthUser) => {
      api.getUser().then(
        (u) => alive && current.current === signedIn && setUser(u),
        () => {
          if (!alive || offOnline) return;
          const retry = () => {
            offOnline?.();
            offOnline = null;
            if (alive && current.current === signedIn) followStoredSignIn(signedIn);
          };
          window.addEventListener("online", retry);
          offOnline = () => window.removeEventListener("online", retry);
        },
      );
    };
    const offQueries = queryClient.getQueryCache().subscribe((e) => {
      if (e.type !== "updated" || e.action.type !== "error") return;
      const error = e.action.error;
      const signedIn = current.current;
      if (!(error instanceof ApiError) || !signedIn) return;
      if (e.query.queryKey[2] !== signedIn.id) return; // userKey: [scope, kind, userId, ...]
      if (error.code === "misconfigured") {
        setKeyRejected(error);
        return;
      }
      if (error.code === "account_changed") {
        followStoredSignIn(signedIn);
        return;
      }
      if (error.code !== "unauthorized") return;
      setExpired(true);
      setUser(null);
      api.signOut({ localOnly: true }).catch(() => undefined);
    });
    return () => {
      alive = false;
      offOnline?.();
      offQueries();
    };
  }, [api, queryClient, setUser]);

  const schema = useQuery({ queryKey: ["schema", api.kind], queryFn: () => api.getSchemaVersion(), staleTime: Infinity });

  // Sign-out reported by Settings, which unmounts once it completes.
  const reportSignOut = useCallback((result: SignOutResult) => setServerNotTold(!result.serverRevoked), []);

  // Sign out from the key-rejected screen. Local only: the project refuses the
  // app's key, so it can't accept a logout either (auth-js would read that 401
  // as success). Signing out on purpose forgets this device's alert history.
  const signOutHere = () => {
    const leaving = current.current;
    setSignOutFailed(false);
    api.signOut({ localOnly: true }).then(
      () => {
        if (leaving) forgetUserLocalData(webStorage, api.kind, leaving.id);
        closeSystemNotifications();
        setServerNotTold(true);
      },
      () => setSignOutFailed(true),
    );
  };

  if (schema.isLoading || user === undefined) return <Spinner label="Connecting…" />;
  if (schema.error) {
    const code = schema.error instanceof ApiError ? schema.error.code : null;
    return (
      <Centered title={schemaErrorTitle(code)}>
        <ErrorState error={schema.error} onRetry={() => void schema.refetch()} />
        <div className="row">
          {/* The stored sign-in is refused: drop it here, then check again signed out. */}
          {code === "unauthorized" && (
            <button type="button" className="btn" onClick={() => void api.signOut({ localOnly: true }).catch(() => undefined).finally(() => void schema.refetch())}>
              Sign in again
            </button>
          )}
          <ResetBackend />
        </div>
      </Centered>
    );
  }
  const compat = checkSchemaCompat(schema.data ?? null);
  if (!compat.ok) {
    return (
      <Centered title="Database needs attention">
        <Notice tone="warn">
          <p>{compat.message}</p>
          <p className="muted">See docs/BYOS.md for how to apply migrations. Nothing was changed in your project.</p>
        </Notice>
        <ResetBackend />
      </Centered>
    );
  }
  if (keyRejected && user) {
    return (
      <Centered title="Connection key rejected">
        {/* Remounts the app on retry; its queries then try the same key again. */}
        <ErrorState error={keyRejected} onRetry={() => setKeyRejected(null)} />
        {signOutFailed && (
          <Notice tone="error">
            <p>Couldn't sign out on this device. Try again.</p>
          </Notice>
        )}
        <div className="row">
          <button type="button" className="btn" onClick={signOutHere}>
            Sign out
          </button>
          <ResetBackend />
        </div>
      </Centered>
    );
  }
  if (!user) {
    return (
      <PageErrorBoundary resetKey="sign-in">
        <Suspense fallback={<Spinner />}>
          <SignInPage
            onSignedIn={setUser}
            notice={
              expired ? (
                <Notice tone="warn" role="alert">
                  <p>Your session expired. Sign in again.</p>
                </Notice>
              ) : serverNotTold ? (
                <Notice tone="warn" role="alert">
                  <p>{SERVER_NOT_TOLD_MESSAGE}</p>
                </Notice>
              ) : null
            }
          />
        </Suspense>
      </PageErrorBoundary>
    );
  }
  // Keyed by user: nothing held in component state (drafts, scroll, open
  // detail) survives into another account.
  return (
    <SignOutReportContext value={reportSignOut}>
      <AlertsProvider key={user.id} userId={user.id}>
        <Shell />
      </AlertsProvider>
    </SignOutReportContext>
  );
}

export const SERVER_NOT_TOLD_MESSAGE =
  "Signed out on this device, but Tavro couldn't end the session on your Supabase project. To end it there too, sign in and sign out again once the project is reachable.";

function schemaErrorTitle(code: ApiError["code"] | null): string {
  if (code === "misconfigured") return "Connection key rejected";
  if (code === "unauthorized") return "Sign-in not accepted";
  if (code === "forbidden") return "Access refused";
  if (code === "rate_limited") return "Too many requests";
  return "Can't reach your project";
}

function Centered({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-inner">
        <div className="auth-brand">
          <BrandMark />
          <span className="eyebrow">Tavro</span>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function ResetBackend() {
  const { setChoice } = useApiContext();
  return (
    <button type="button" className="btn ghost" onClick={() => setChoice(null)}>
      Change backend
    </button>
  );
}

const NAV = [
  { to: "/", label: "Sessions", icon: <IconSessions />, match: (p: string) => p === "/" || p.startsWith("/sessions/") },
  { to: "/alerts", label: "Alerts", icon: <IconBell />, match: (p: string) => p.startsWith("/alerts") },
  { to: "/hosts", label: "Hosts", icon: <IconHost />, match: (p: string) => p.startsWith("/hosts") },
  { to: "/settings", label: "Settings", icon: <IconSettings />, match: (p: string) => p.startsWith("/settings") || p.startsWith("/setup") },
];

/**
 * The backend indicator. It follows the same rule as the pages (useStatusSync)
 * and ticks with the offline banner's clock, so it never says "Connected" while
 * the banner or a page says data couldn't be refreshed or loaded.
 */
export function LivePill() {
  const { connection, sessions, hosts } = useStatusSync();
  const pill = statusIndicator(connection, [sessions, hosts]);
  return (
    <Link to="/settings" className={`env-pill live ${pill.tone}`} aria-label={`${pill.label}. Open settings`}>
      <span className="dot" aria-hidden="true" />
      {pill.text}
    </Link>
  );
}

function Shell() {
  const api = useApi();
  const { pathname } = useLocation();
  useLiveUpdates();
  const unread = unreadCount(useAlerts());

  useEffect(() => {
    document.title = titleWithUnread(unread);
    updateAppBadge(unread);
  }, [unread]);
  // Reset when leaving the signed-in shell (sign-out, backend change).
  useEffect(
    () => () => {
      document.title = BASE_TITLE;
      updateAppBadge(0);
    },
    [],
  );

  useRouteFocus();

  const navLink = (n: (typeof NAV)[number], withIcon: boolean) => {
    const active = n.match(pathname);
    const badge = n.to === "/alerts" && unread > 0 ? (unread > 99 ? "99+" : String(unread)) : null;
    return (
      <Link
        key={n.to}
        to={n.to}
        className={active ? "active" : undefined}
        aria-current={active ? "page" : undefined}
        aria-label={badge ? `${n.label}, ${unread} unread` : undefined}
      >
        {withIcon && n.icon}
        {n.label}
        {badge && (
          <span className="badge-count" aria-hidden="true">
            {badge}
          </span>
        )}
      </Link>
    );
  };

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand" end aria-label="Tavro, sessions">
            <BrandMark />
            <span aria-hidden="true">Tavro</span>
          </NavLink>
          <nav className="topnav" aria-label="Main">
            {NAV.map((n) => navLink(n, false))}
          </nav>
          <div className="topbar-end">
            {api.kind === "demo" ? (
              <Link to="/settings" className="env-pill demo" aria-label="Demo data: all sessions are simulated. Open settings">
                <span className="dot" aria-hidden="true" />
                Demo data
              </Link>
            ) : (
              <LivePill />
            )}
          </div>
        </div>
      </header>
      <OfflineBanner />
      <div id="main" tabIndex={-1} className="main-focus">
        <PageErrorBoundary resetKey={pathname}>
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/sessions/:id" element={<SessionPage />} />
              <Route path="/alerts" element={<AlertsPage />} />
              <Route path="/hosts" element={<HostsPage />} />
              <Route path="/hosts/:id" element={<HostPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/setup" element={<SetupChecklistPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </PageErrorBoundary>
      </div>
      <nav className="tabbar" aria-label="Main (mobile)">
        {NAV.map((n) => navLink(n, true))}
      </nav>
    </>
  );
}
