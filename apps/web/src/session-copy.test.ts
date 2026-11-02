import { describe, expect, it } from "vitest";
import { untrustedHostReason } from "./pages/SessionPage.js";

describe("untrustedHostReason", () => {
  it("never claims a revoked or missing host merely stopped reporting", () => {
    expect(untrustedHostReason("disconnected", "Work laptop")).toBe("Work laptop has stopped reporting");
    expect(untrustedHostReason("revoked", "Old desktop")).toBe("Old desktop was revoked and no longer reports");
    expect(untrustedHostReason("never_connected", "New laptop")).toBe("New laptop has never reported");
    expect(untrustedHostReason("disconnected", "Unknown host")).toBe("This session's host is no longer listed");
  });
});
