/**
 * Reads the collections the worker writes (see worker/unblur/store/mongo_store.py).
 * Dashboard settings live on the repo document as `settings`; the worker merges them into
 * its config on the next Mongo-mode run.
 */
import mongoose, { type Connection } from "mongoose";

import { SettingsSchema, type Settings } from "../settings.js";
import type { RepoData, RepoSummary } from "../types.js";
import type { DataStore } from "./index.js";

export class MongoStore implements DataStore {
  private conn: Connection;
  // Invalidated whenever the worker writes a new analysis (lastAnalyzedSha/At change).
  private cache = new Map<string, { key: string; data: RepoData }>();

  constructor(url: string, dbName = "unblur") {
    this.conn = mongoose.createConnection(url, { dbName });
  }

  private col(name: string) {
    return this.conn.collection(name);
  }

  async listRepos(): Promise<RepoSummary[]> {
    const repos = await this.col("repos")
      .find({}, { projection: { name: 1, source: 1, lastAnalyzedAt: 1, remoteUrl: 1, path: 1 } })
      .toArray();
    return repos
      .map((r) => ({
        id: String(r._id),
        name: String(r.name),
        source: r.source === "github" ? ("github" as const) : ("local" as const),
        lastAnalyzedAt: r.lastAnalyzedAt ? new Date(r.lastAnalyzedAt as Date).toISOString() : null,
        origin: (r.remoteUrl as string | undefined) ?? (r.path as string | undefined) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(repoId: string): Promise<RepoData | null> {
    const repo = await this.col("repos").findOne({ _id: repoId as never });
    if (!repo) return null;
    const key = String(repo.lastAnalyzedSha) + String(repo.lastAnalyzedAt);
    const hit = this.cache.get(repoId);
    if (hit && hit.key === key) return hit.data;
    const q = { repoId };
    const noId = { projection: { _id: 0 } };
    const [contributors, commits, fileScores, moduleScores, snapshots] = await Promise.all([
      this.col("contributors").find(q).toArray(),
      this.col("commits")
        .find(q, {
          projection: {
            _id: 0,
            sha: 1,
            authorId: 1,
            authoredAt: 1,
            message: 1,
            isAiAssisted: 1,
            aiEvidence: 1,
            prNumber: 1,
          },
        })
        .toArray(),
      this.col("file_scores").find(q, noId).toArray(),
      this.col("module_scores").find(q, noId).toArray(),
      this.col("snapshots").find(q, noId).sort({ takenAt: 1 }).toArray(),
    ]);
    // Dates come back as Date objects; normalise to the JSON-mode wire format.
    const data = JSON.parse(
      JSON.stringify({
        repo,
        contributors,
        commits,
        fileScores,
        moduleScores: moduleScores.sort((a, b) => Number(b.risk) - Number(a.risk)),
        snapshots,
        config: repo.effectiveConfig ?? null,
      }),
    ) as RepoData;
    this.cache.set(repoId, { key, data });
    return data;
  }

  async getSettings(repoId: string): Promise<Settings> {
    const repo = await this.col("repos").findOne({ _id: repoId as never }, { projection: { settings: 1 } });
    const parsed = SettingsSchema.safeParse(repo?.settings ?? {});
    return parsed.success ? parsed.data : {};
  }

  async saveSettings(repoId: string, settings: Settings): Promise<void> {
    await this.col("repos").updateOne({ _id: repoId as never }, { $set: { settings } });
  }

  async close(): Promise<void> {
    await this.conn.close();
  }
}
