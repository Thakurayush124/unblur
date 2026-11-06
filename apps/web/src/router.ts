import { useEffect, useState } from "react";

/** Tiny hash router: #/<page>?<query>. Hash routing works from any static host. */
export type Page = "overview" | "heatmap" | "file" | "people" | "settings" | "add";
const PAGES: Page[] = ["overview", "heatmap", "file", "people", "settings", "add"];

export interface Route {
  page: Page;
  params: URLSearchParams;
}

export function parse(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const page = (PAGES as string[]).includes(path) ? (path as Page) : "overview";
  return { page, params: new URLSearchParams(query) };
}

export function href(page: Page, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `#/${page}${q ? `?${q}` : ""}`;
}

export function fileHref(path: string): string {
  return href("file", { path });
}

export function navigate(to: string): void {
  window.location.hash = to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
