import { useEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

/**
 * On a route change: a new page starts at the top (BrowserRouter restores
 * nothing itself), while Back and Forward (POP) keep the browser's restored
 * position. Then focus moves to the page so keyboard and screen-reader users
 * start at the new content. Only path changes count, so changing a filter in
 * the URL doesn't jump the list.
 */
export function useRouteFocus(targetId = "main"): void {
  const { pathname } = useLocation();
  const navType = useNavigationType();
  const navTypeRef = useRef(navType);
  navTypeRef.current = navType;
  useEffect(() => {
    if (navTypeRef.current !== "POP") window.scrollTo(0, 0);
    document.getElementById(targetId)?.focus({ preventScroll: true });
  }, [pathname, targetId]);
}
