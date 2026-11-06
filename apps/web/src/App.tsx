import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { useApi, type RepoSummary } from "./api";
import { Load } from "./components/ui";
import { ago } from "./format";
import AddRepoPage from "./pages/AddRepo";
import FileDetailPage from "./pages/FileDetail";
import HeatmapPage from "./pages/Heatmap";
import OverviewPage from "./pages/Overview";
import PeoplePage from "./pages/People";
import SettingsPage from "./pages/Settings";
import { href, useRoute, type Page } from "./router";
import { useTheme, type ThemeChoice } from "./theme";

interface Ctx {
  repoId: string;
  dark: boolean;
  /** Bumped after a re-analysis so pages refetch. */
  version: number;
  refresh: () => void;
  selectRepo: (id: string) => void;
  reloadRepos: () => void;
}
const noop = () => {};
const AppCtx = createContext<Ctx>({
  repoId: "",
  dark: false,
  version: 0,
  refresh: noop,
  selectRepo: noop,
  reloadRepos: noop,
});
export const useApp = () => useContext(AppCtx);

const NAV: { page: Page; label: string }[] = [
  { page: "overview", label: "Overview" },
  { page: "heatmap", label: "Heatmap" },
  { page: "people", label: "People" },
  { page: "settings", label: "Settings" },
];
const REPO_KEY = "grasp-repo";

export default function App() {
  const route = useRoute();
  const theme = useTheme();
  const [reposVersion, setReposVersion] = useState(0);
  const [version, setVersion] = useState(0);
  const repos = useApi<RepoSummary[]>("/repos", reposVersion);
  const [repoId, setRepoId] = useState(() => localStorage.getItem(REPO_KEY) ?? "");
  // A repo selected right after it was added may not be in the (old) list yet: wait for it.
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (repos.status !== "ok" || repos.data.length === 0) return;
    const known = repos.data.some((r) => r.id === repoId);
    if (known) pending.current = null;
    else if (pending.current !== repoId) setRepoId(repos.data[0]!.id);
  }, [repos, repoId]);

  const selectRepo = useCallback((id: string) => {
    pending.current = id;
    setRepoId(id);
  }, []);
  const reloadRepos = useCallback(() => setReposVersion((v) => v + 1), []);
  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
    setReposVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    if (repoId) localStorage.setItem(REPO_KEY, repoId);
  }, [repoId]);

  const current = repos.status === "ok" ? repos.data.find((r) => r.id === repoId) : undefined;
  const active = route.page === "file" ? "heatmap" : route.page;

  return (
    <AppCtx.Provider value={{ repoId, dark: theme.dark, version, refresh, selectRepo, reloadRepos }}>
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <a href={href("overview")} className="flex items-baseline gap-2">
            <span className="text-lg font-bold">Grasp</span>
            <span className="hidden text-xs text-muted sm:inline">comprehension debt radar</span>
          </a>
          <nav aria-label="Main" className="flex gap-1">
            {NAV.map((n) => (
              <a
                key={n.page}
                href={href(n.page)}
                aria-current={active === n.page ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm ${active === n.page ? "bg-surface-2 font-semibold" : "text-ink-2 hover:bg-surface-2"}`}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-3 text-sm">
            {repos.status === "ok" && repos.data.length > 0 && (
              <label className="flex items-center gap-2">
                <span className="text-muted">Repo</span>
                <select
                  value={repoId}
                  onChange={(e) => selectRepo(e.target.value)}
                  className="rounded-md border border-line bg-surface px-2 py-1"
                >
                  {repos.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {current && (
              <span className="hidden text-muted md:inline">analysed {ago(current.lastAnalyzedAt)}</span>
            )}
            <a
              href={href("add")}
              aria-current={route.page === "add" ? "page" : undefined}
              className="rounded-md border border-line px-2.5 py-1 hover:bg-surface-2"
            >
              <span aria-hidden>+ </span>Add repo
            </a>
            <label className="flex items-center gap-2">
              <span className="sr-only">Theme</span>
              <select
                aria-label="Theme"
                value={theme.choice}
                onChange={(e) => theme.setChoice(e.target.value as ThemeChoice)}
                className="rounded-md border border-line bg-surface px-2 py-1"
              >
                <option value="system">System theme</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-7xl px-4 py-6 outline-none">
        <Load state={repos}>
          {(list) =>
            route.page === "add" || list.length === 0 ? (
              <AddRepoPage />
            ) : !repoId ? null : (
              <>
                {route.page === "overview" && <OverviewPage />}
                {route.page === "heatmap" && <HeatmapPage module={route.params.get("module")} />}
                {route.page === "file" && <FileDetailPage path={route.params.get("path") ?? ""} />}
                {route.page === "people" && <PeoplePage />}
                {route.page === "settings" && <SettingsPage />}
              </>
            )
          }
        </Load>
      </main>
    </AppCtx.Provider>
  );
}
