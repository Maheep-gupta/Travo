// Code-split page loading with recoverable failures.
//
// React.lazy caches a rejected import permanently, so a plain error boundary
// could never recover from a failed chunk download. `retryableLazy` swaps in a
// fresh lazy component after a failure, and `PageErrorBoundary` shows a
// retryable error for *page download* failures only; any other error is
// re-thrown so it is not silently hidden.
import { Component, lazy, type ComponentType, type ErrorInfo, type ReactNode } from "react";
import { IconAlert } from "./icons.js";

/** A page's JavaScript chunk could not be downloaded or evaluated. */
export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super("This page could not be loaded.", { cause });
    this.name = "PageLoadError";
  }
}

// Resetters for pages whose last load failed. A failed page keeps its rejected
// lazy instance (so React surfaces the error to the boundary) until the user
// retries or navigates; swapping it immediately would make React re-request
// the chunk in a loop and never show the error.
const failedPages = new Set<() => void>();

/** Give every failed page a fresh import attempt on its next render. */
export function resetFailedPages(): void {
  for (const reset of failedPages) reset();
  failedPages.clear();
}

export function retryableLazy<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const fresh = (): ComponentType<P> =>
    lazy(async () => {
      try {
        return { default: await load() };
      } catch (e: unknown) {
        failedPages.add(() => {
          Current = fresh();
        });
        throw new PageLoadError(e);
      }
    }) as unknown as ComponentType<P>;
  let Current: ComponentType<P> = fresh();
  function RetryablePage(props: P) {
    return <Current {...props} />;
  }
  return RetryablePage;
}

interface BoundaryProps {
  /** Changing this (e.g. the pathname) clears a previous failure. */
  resetKey: string;
  children: ReactNode;
}

interface BoundaryState {
  error: PageLoadError | null;
  /** Bumped on retry to remount the subtree. */
  attempt: number;
  /** An error that is not ours; re-thrown during render. */
  foreign: unknown;
}

export class PageErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, attempt: 0, foreign: null };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return error instanceof PageLoadError ? { error } : { foreign: error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (error instanceof PageLoadError) console.warn("Page chunk failed to load", error.cause, info.componentStack);
  }

  override componentDidUpdate(prev: BoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      resetFailedPages();
      this.setState({ error: null });
    }
  }

  private retry = () => {
    resetFailedPages();
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  override render(): ReactNode {
    // Not a page-load failure: let it propagate exactly as before.
    if (this.state.foreign) throw this.state.foreign;
    if (this.state.error) {
      return (
        <main className="page">
          <div className="state page-error" role="alert" aria-labelledby="page-error-title">
            <IconAlert />
            <h2 id="page-error-title">Couldn't load this page</h2>
            <p>Part of the app failed to download. Check your connection, then try again. Nothing else was affected.</p>
            <button type="button" className="btn primary" onClick={this.retry}>
              Retry
            </button>
          </div>
        </main>
      );
    }
    return <PageAttempt key={this.state.attempt}>{this.props.children}</PageAttempt>;
  }
}

function PageAttempt({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
