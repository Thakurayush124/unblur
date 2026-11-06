import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { useApi, type RepoSummary } from "./api";
import { Load } from "./components/ui";
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
  // Deep links from GitHub checks/comments carry ?repo=<id>.
  const linkedRepo = route.params.get("repo");
  useEffect(() => {
    if (linkedRepo) selectRepo(linkedRepo);
  }, [linkedRepo, selectRepo]);
  const refresh = useCallback(() => {
    setVersion((v) => v + 1);
    setReposVersion((v) => v + 1);
  }, []);
  useEffect(() => {
    if (repoId) localStorage.setItem(REPO_KEY, repoId);
  }, [repoId]);

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
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-3 px-5 pt-4 sm:px-8">
          <a href={href("overview")} className="flex items-center gap-2.5 pb-3" aria-label="Grasp, overview">
            {/* Mark: a square half surveyed, half hatched */}
            <span
              aria-hidden
              className="relative inline-block h-5 w-5 overflow-hidden rounded-[3px] border border-ink/70"
            >
              <span className="hatch absolute inset-0" />
              <span className="absolute inset-y-0 left-0 w-1/2 bg-ink" />
            </span>
            <span className="font-display text-xl font-semibold tracking-tight">Grasp</span>
          </a>
          <nav aria-label="Main" className="order-last -mb-px flex w-full gap-6 sm:order-none sm:w-auto">
            {NAV.map((n) => (
              <a
                key={n.page}
                href={href(n.page)}
                aria-current={active === n.page ? "page" : undefined}
                className={`border-b-2 pb-3 text-[15px] ${
                  active === n.page
                    ? "border-accent font-semibold text-ink"
                    : "border-transparent text-ink-2 hover:border-rule hover:text-ink"
                }`}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-3 pb-3 text-sm">
            {repos.status === "ok" && repos.data.length > 0 && (
              <label className="flex items-center gap-2">
                <span className="text-ink-2">Repository</span>
                <select
                  value={repoId}
                  onChange={(e) => selectRepo(e.target.value)}
                  className="max-w-[14rem] rounded-md border border-line bg-surface px-2 py-1.5"
                >
                  {repos.data.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <a
              href={href("add")}
              aria-current={route.page === "add" ? "page" : undefined}
              className="rounded-md bg-accent px-3 py-1.5 font-semibold text-accent-ink hover:opacity-90"
            >
              Add repo
            </a>
            <label className="flex items-center">
              <span className="sr-only">Theme</span>
              <select
                aria-label="Theme"
                value={theme.choice}
                onChange={(e) => theme.setChoice(e.target.value as ThemeChoice)}
                className="rounded-md border border-line bg-surface px-2 py-1.5"
              >
                <option value="system">System theme</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-5 py-10 outline-none sm:px-8">
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
