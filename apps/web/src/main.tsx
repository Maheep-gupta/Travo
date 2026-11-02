import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@mc/api-client/demo";
import { BrowserRouter } from "react-router";
import { ApiProvider } from "./api-context.js";
import { App } from "./App.js";
import { webStorage } from "./platform.js";
import { THEME_STORAGE_KEY, applyThemePreference, loadThemePreference, parseThemePreference } from "./theme.js";
import "./styles.css";

// Before the first React render: the inline script in index.html has already set
// data-theme; this also syncs the theme-color and color-scheme metas, and still
// applies the choice if a CSP ever blocks that script.
applyThemePreference(loadThemePreference(webStorage), document);
// Another tab changed Appearance: follow it here too.
window.addEventListener("storage", (e) => {
  if (e.key === THEME_STORAGE_KEY || e.key === null) applyThemePreference(parseThemePreference(e.newValue), document);
});

const queryClient = new QueryClient({
  defaultOptions: {
    // One retry for transient failures; never for an expired sign-in, which
    // retrying can't fix and would only delay the return to the sign-in page.
    queries: { staleTime: 15_000, retry: (failures, error) => failures < 1 && !(error instanceof ApiError && error.code === "unauthorized"), refetchOnWindowFocus: true },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ApiProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ApiProvider>
    </QueryClientProvider>
  </StrictMode>,
);
