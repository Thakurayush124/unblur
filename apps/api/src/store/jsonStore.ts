/**
 * Serves worker `--json` output files. `source` is one result file or a directory of them.
 * Dashboard settings are saved next to each file as `<file>.settings.json`; the worker CLI
 * picks that file up automatically on its next `--json <file>` run.
 */
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { SettingsSchema, type Settings } from "../settings.js";
import type { RepoData, RepoSummary } from "../types.js";
import type { DataStore } from "./index.js";

interface Entry {
  file: string;
  mtimeMs: number;
  data: RepoData;
}

export class JsonStore implements DataStore {
  private cache = new Map<string, Entry>(); // repoId -> entry

  constructor(private readonly source: string) {}

  private async files(): Promise<string[]> {
    const st = await stat(this.source);
    if (st.isFile()) return [this.source];
    const names = await readdir(this.source);
    return names
      .filter((n) => n.endsWith(".json") && !n.endsWith(".settings.json"))
      .map((n) => path.join(this.source, n));
  }

  private async refresh(): Promise<void> {
    const seen = new Set<string>();
    for (const file of await this.files()) {
      const st = await stat(file);
      const cached = [...this.cache.values()].find((e) => e.file === file);
      if (cached && cached.mtimeMs === st.mtimeMs) {
        seen.add(cached.data.repo._id);
        continue;
      }
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
      } catch {
        continue; // partially written or not a Grasp file
      }
      if (!raw.repo || !Array.isArray(raw.fileScores)) continue;
      const data: RepoData = {
        repo: raw.repo as RepoData["repo"],
        contributors: (raw.contributors ?? []) as RepoData["contributors"],
        commits: (raw.commits ?? []) as RepoData["commits"],
        fileScores: raw.fileScores as RepoData["fileScores"],
        moduleScores: (raw.moduleScores ?? []) as RepoData["moduleScores"],
        snapshots: (raw.snapshots ?? []) as RepoData["snapshots"],
        config: (raw.config ?? null) as RepoData["config"],
      };
      this.cache.set(data.repo._id, { file, mtimeMs: st.mtimeMs, data });
      seen.add(data.repo._id);
    }
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
  }

  async listRepos(): Promise<RepoSummary[]> {
    await this.refresh();
    return [...this.cache.values()]
      .map(({ data: { repo } }) => ({
        id: repo._id,
        name: repo.name,
        source: repo.source,
        lastAnalyzedAt: repo.lastAnalyzedAt ?? null,
        origin: repo.remoteUrl ?? repo.path ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(repoId: string): Promise<RepoData | null> {
    await this.refresh();
    return this.cache.get(repoId)?.data ?? null;
  }

  outputFor(repoId: string): string | null {
    return this.cache.get(repoId)?.file ?? null;
  }

  private settingsFile(repoId: string): string | null {
    const e = this.cache.get(repoId);
    return e ? `${e.file}.settings.json` : null;
  }

  async getSettings(repoId: string): Promise<Settings> {
    await this.refresh();
    const file = this.settingsFile(repoId);
    if (!file) return {};
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(await readFile(file, "utf-8")));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async saveSettings(repoId: string, settings: Settings): Promise<void> {
    await this.refresh();
    const file = this.settingsFile(repoId);
    if (!file) throw new Error(`unknown repo ${repoId}`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(settings, null, 2), "utf-8");
    await rename(tmp, file);
  }
}
