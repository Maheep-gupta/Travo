import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router";
import { ApiError, type AuthUser } from "@mc/api-client/demo";
import { checkSchemaCompat, unreadCount } from "@mc/domain";
import { AlertsProvider, useAlerts } from "./alerts-context.js";
import "./alerts.css";
import { useApi, useApiContext, useLiveUpdates } from "./api-context.js";
import { ErrorState, Notice, Spinner } from "./components.js";
import { clearUserData } from "./hooks.js";
import { BrandMark, IconBell, IconHost, IconSessions, IconSettings } from "./icons.js";
import { PageErrorBoundary, retryableLazy } from "./page-loading.js";
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
      if (prev && prev.id !== next?.id) clearUserData(queryClient);
      current.current = next;
      if (next) setExpired(false);
      setUserState(next);
    },
    [queryClient],
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
  // signed in, so failures still in flight afterwards cannot repeat it.
  useEffect(() => {
    // Demo data has no real session and never expires.
    if (api.kind === "demo") return;
    const offQueries = queryClient.getQueryCache().subscribe((e) => {
      if (e.type !== "updated" || e.action.type !== "error") return;
      const error = e.action.error;
      const signedIn = current.current;
      if (!(error instanceof ApiError) || error.code !== "unauthorized" || !signedIn) return;
      if (e.query.queryKey[2] !== signedIn.id) return; // userKey: [scope, kind, userId, ...]
      setExpired(true);
      setUser(null);
      api.signOut({ localOnly: true }).catch(() => undefined);
    });
    return () => {
      offQueries();
    };
  }, [api, queryClient, setUser]);

  const schema = useQuery({ queryKey: ["schema", api.kind], queryFn: () => api.getSchemaVersion(), staleTime: Infinity });

  if (schema.isLoading || user === undefined) return <Spinner label="Connecting…" />;
  if (schema.error) {
    return (
      <Centered title="Can't reach your project">
        <ErrorState error={schema.error} onRetry={() => void schema.refetch()} />
        <ResetBackend />
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
    <AlertsProvider key={user.id} userId={user.id}>
      <Shell />
    </AlertsProvider>
  );
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
  { to: "/settings", label: "Settings", icon: <IconSettings />, match: (p: string) => p.startsWith("/settings") },
];

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

  // Move focus to the page on route change so keyboard and screen-reader users start at the new content.
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [pathname]);

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
              <Link to="/settings" className="env-pill live" aria-label="Connected to your Supabase project. Open settings">
                <span className="dot" aria-hidden="true" />
                Supabase
              </Link>
            )}
          </div>
        </div>
      </header>
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
