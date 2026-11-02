import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { ApiProvider } from "./api-context.js";
import { App } from "./App.js";
import { createQueryClient } from "./hooks.js";
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

const queryClient = createQueryClient();

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
