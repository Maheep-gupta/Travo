// Appearance: apply an explicit Dark/Light choice before first paint. Loaded as a
// blocking classic script from index.html so a strict CSP (script-src 'self') needs
// no hash. Keep in sync with THEME_STORAGE_KEY in src/theme.ts; main.tsx re-applies
// it with the metas.
try {
  var t = localStorage.getItem("tavro.theme.v1");
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
} catch {
  // Storage blocked (private mode, policy): fall back to the system theme.
}
