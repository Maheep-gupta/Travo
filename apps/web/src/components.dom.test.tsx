import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "@mc/api-client/demo";
import { ErrorState } from "./components.js";

describe("ErrorState", () => {
  it("shows ApiError messages, which are written for users", () => {
    render(<ErrorState error={new ApiError("Your sign-in has expired. Please sign in again.", "unauthorized")} />);
    expect(screen.getByRole("alert").textContent).toContain("Your sign-in has expired");
  });

  it("never shows raw text from other errors (e.g. schema-parse details)", () => {
    render(<ErrorState error={new Error('[{"path":["owner_id"],"received":"secret-value"}]')} />);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).not.toContain("owner_id");
    expect(text).not.toContain("secret-value");
    expect(text).toContain("Something went wrong");
  });
});

describe("ErrorState for a paused project", () => {
  it("gives the full message where no banner is saying it (sign-in, setup)", () => {
    render(<ErrorState error={new ApiError("Your Supabase project is paused. Restore it from the project's page.", "paused")} />);
    expect(screen.getByRole("alert").textContent).toContain("Restore it from the project's page");
  });
});
