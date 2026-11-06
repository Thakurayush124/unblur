import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { isRemote, normalisePath, type JobQueue } from "./jobs.js";
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
  /** Enables adding / re-analysing repos from the dashboard. */
  jobs?: JobQueue;
  /** Allow local filesystem paths as sources (in addition to git URLs). */
  allowLocalPaths?: boolean;
  /** Why adding new repos is unavailable even though re-analysis works (e.g. single-file JSON). */
  addDisabledReason?: string;
}

const AddRepoBody = z.object({
  source: z.string().trim().min(1).max(500),
  full: z.boolean().optional(),
});
const AnalyzeBody = z.object({ full: z.boolean().optional() }).default({});

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

  // ---- analysis jobs -------------------------------------------------------------------
  const jobs = opts.jobs;
  const sameOrigin = (a: string, b: string) =>
    isRemote(a) || isRemote(b)
      ? a.replace(/(\.git)?\/?$/, "") === b.replace(/(\.git)?\/?$/, "")
      : normalisePath(a) === normalisePath(b);

  function requireJobs(): JobQueue {
    if (!jobs) throw new HttpError(403, "Analysing from the dashboard is disabled on this server.");
    return jobs;
  }

  /** Validate a user-supplied source; returns the string to hand to the worker. */
  function resolveSource(raw: string): string {
    if (raw.startsWith("-")) throw new HttpError(400, "invalid source");
    if (isRemote(raw)) {
      if (raw.includes("::")) throw new HttpError(400, "unsupported git transport");
      return raw;
    }
    if (/^[a-z][\w+.-]*:\/\//i.test(raw) || raw.includes("::"))
      throw new HttpError(400, "Unsupported URL. Use https://, ssh://, git:// or git@host:owner/repo.");
    if (!opts.allowLocalPaths) throw new HttpError(400, "Only git URLs are accepted on this server.");
    const abs = path.resolve(raw);
    if (!existsSync(path.join(abs, ".git")))
      throw new HttpError(400, `Not a git checkout: ${abs} (expected a folder containing .git)`);
    return abs;
  }

  api.get("/capabilities", (_req, res) => {
    res.json({
      analyze: Boolean(jobs),
      addRepos: Boolean(jobs) && !opts.addDisabledReason,
      localPaths: Boolean(jobs && opts.allowLocalPaths),
      reason: !jobs
        ? "Analysing from the dashboard is disabled on this server."
        : (opts.addDisabledReason ?? null),
    });
  });

  api.post("/repos", async (req, res) => {
    const q = requireJobs();
    if (opts.addDisabledReason) throw new HttpError(400, opts.addDisabledReason);
    const { source, full } = AddRepoBody.parse(req.body);
    const src = resolveSource(source);
    const known = (await store.listRepos()).find((r) => r.origin && sameOrigin(r.origin, src));
    const job = q.submit(src, { full, out: known ? (store.outputFor?.(known.id) ?? null) : null });
    res.status(202).json(job);
  });

  api.post("/repos/:repoId/analyze", async (req, res) => {
    const q = requireJobs();
    const data = await repoData(req);
    const origin = data.repo.remoteUrl ?? data.repo.path;
    if (!origin) throw new HttpError(400, "This repo has no recorded source to re-analyse.");
    const { full } = AnalyzeBody.parse(req.body ?? {});
    res.status(202).json(q.submit(origin, { full, out: store.outputFor?.(data.repo._id) ?? null }));
  });

  api.get("/jobs", (_req, res) => {
    res.json(requireJobs().list());
  });

  api.get("/jobs/:jobId", (req, res) => {
    const { jobId } = z.object({ jobId: z.uuid() }).parse(req.params);
    const job = requireJobs().get(jobId);
    if (!job) throw new HttpError(404, "job not found");
    res.json(job);
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

  const webDist = opts.webDist ? path.resolve(opts.webDist) : null; // sendFile needs an absolute path
  if (webDist && existsSync(webDist)) {
    app.use(express.static(webDist, { maxAge: "1h", index: false }));
    app.get("/{*splat}", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
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
