import { act, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRouteFocus } from "./route-focus.js";

let navigate: NavigateFunction = () => undefined;

function Harness() {
  useRouteFocus();
  navigate = useNavigate();
  return (
    <main id="main" tabIndex={-1}>
      <Routes>
        <Route path="/" element={<p>list</p>} />
        <Route path="/sessions/:id" element={<p>detail</p>} />
      </Routes>
    </main>
  );
}

describe("useRouteFocus", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts a newly opened page at the top and focuses it", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>,
    );
    scrollTo.mockClear();
    act(() => void navigate("/sessions/1"));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(document.activeElement?.id).toBe("main");
  });

  it("leaves Back and Forward to the browser's restored position", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>,
    );
    act(() => void navigate("/sessions/1"));
    scrollTo.mockClear();
    act(() => void navigate(-1));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("doesn't jump when only the query string changes, such as a filter", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>,
    );
    scrollTo.mockClear();
    act(() => void navigate("/?state=failed"));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
