import type { Settings } from "../settings.js";
import type { RepoData, RepoSummary } from "../types.js";

export interface DataStore {
  listRepos(): Promise<RepoSummary[]>;
  /** Full analysis data for one repo, or null if unknown. Implementations cache. */
  load(repoId: string): Promise<RepoData | null>;
  /** Dashboard overrides only (not merged with the worker's config). */
  getSettings(repoId: string): Promise<Settings>;
  saveSettings(repoId: string, settings: Settings): Promise<void>;
  close?(): Promise<void>;
}
