// Setup for the "dom" vitest project. Vitest globals are off, so Testing
// Library cannot register its own cleanup; do it here, and start every test
// with empty storage so stored alerts never leak between tests.
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.title = "";
});
