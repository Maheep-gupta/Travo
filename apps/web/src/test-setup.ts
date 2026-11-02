// Setup for the "dom" vitest project. Vitest globals are off, so Testing
// Library cannot register its own cleanup; do it here, and start every test
// with empty storage so stored alerts never leak between tests.
import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import * as axeMatchers from "vitest-axe/matchers";

// `expect(await axe(el)).toHaveNoViolations()`. vitest-axe's own type
// augmentation targets the pre-1.0 `Vi` namespace, so declare it here.
expect.extend(axeMatchers);
declare module "vitest" {
  interface Matchers<R = void | Promise<void>> {
    toHaveNoViolations(): R;
  }
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.title = "";
});
