import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { effectiveSettings, SettingsSchema } from "./settings.js";
import type { DataStore } from "./store/index.js";
import type { RepoData } from "./types.js";
import { fileDetail, fileList, heatmap, knowledge, overview } from "./views.js";

const DEFAULT_RISK_THRESHOLD = 60;

const RepoParams = z.object({ repoId: z.string().regex(/^[\w-]{1,64}$/) });
const FilesQuery = z.object({
  q: z.string().max(200).optional(),
  module: z.string().max(500).optional(),
  sort: z.enum(["risk", "comprehension", "aiLineShare", "loc", "path"]).default("risk"),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const DetailQuery = z.object({ path: z.string().min(1).max(2000) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface AppOptions {
  /** Serve the built dashboard (apps/web/dist) from the same origin. */
  webDist?: string;
}

export function createApp(store: DataStore, opts: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  async function repoData(req: Request): Promise<RepoData> {
    const { repoId } = RepoParams.parse(req.params);
    const data = await store.load(repoId);
    if (!data) throw new HttpError(404, `repo not found: ${repoId}`);
    return data;
  }

  async function settingsFor(data: RepoData) {
    return effectiveSettings(data.config, await store.getSettings(data.repo._id));
  }

  const api = express.Router();

  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  api.get("/repos", async (_req, res) => {
    res.json(await store.listRepos());
  });

  api.get("/repos/:repoId/overview", async (req, res) => {
    const data = await repoData(req);
    const s = await settingsFor(data);
    res.json(overview(data, s.riskThreshold ?? DEFAULT_RISK_THRESHOLD));
  });

  api.get("/repos/:repoId/heatmap", async (req, res) => {
    res.json(heatmap(await repoData(req)));
  });

  api.get("/repos/:repoId/files", async (req, res) => {
    const data = await repoData(req);
    res.json(fileList(data, FilesQuery.parse(req.query)));
  });

  api.get("/repos/:repoId/file", async (req, res) => {
    const data = await repoData(req);
    const { path: filePath } = DetailQuery.parse(req.query);
    const s = await settingsFor(data);
    const detail = fileDetail(data, filePath, s.weights ?? null);
    if (!detail) throw new HttpError(404, `file not found: ${filePath}`);
    res.json(detail);
  });

  api.get("/repos/:repoId/people", async (req, res) => {
    res.json(knowledge(await repoData(req)));
  });

  api.get("/repos/:repoId/settings", async (req, res) => {
    const data = await repoData(req);
    res.json({
      effective: await settingsFor(data),
      overrides: await store.getSettings(data.repo._id),
      note: "Changes take effect on the next analysis run.",
    });
  });

  api.put("/repos/:repoId/settings", async (req, res) => {
    const data = await repoData(req);
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, "invalid settings", z.flattenError(parsed.error));
    await store.saveSettings(data.repo._id, parsed.data);
    res.json({
      effective: effectiveSettings(data.config, parsed.data),
      overrides: parsed.data,
      note: "Saved. Changes take effect on the next analysis run.",
    });
  });

  app.use("/api", api);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "not found")));

  if (opts.webDist && existsSync(opts.webDist)) {
    app.use(express.static(opts.webDist, { maxAge: "1h", index: false }));
    app.get("/{*splat}", (_req, res) => res.sendFile(path.join(opts.webDist!, "index.html")));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "invalid request", details: z.flattenError(err) });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
    } else {
      console.error(err);
      res.status(500).json({ error: "internal error" });
    }
  });
  return app;
}
