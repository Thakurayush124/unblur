import { useEffect, useState } from "react";

/* Response shapes of apps/api (see apps/api/src/views.ts). */

export interface RepoSummary {
  id: string;
  name: string;
  source: "local" | "github";
  lastAnalyzedAt: string | null;
  origin: string | null;
}

export interface Capabilities {
  analyze: boolean;
  addRepos: boolean;
  localPaths: boolean;
  reason: string | null;
}

export interface Job {
  id: string;
  source: string;
  full: boolean;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: string;
  log: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  repoId: string | null;
  error: string | null;
}

export interface FileRow {
  path: string;
  module: string;
  loc: number;
  aiLineShare: number;
  comprehension: number;
  criticality: number;
  risk: number;
  explanation: string;
}

export interface Overview {
  repo: {
    id: string;
    name: string;
    defaultBranch: string;
    lastAnalyzedAt: string | null;
    lastAnalyzedSha: string | null;
  };
  comprehension: number | null;
  risk: number | null;
  trend: { takenAt: string; headSha: string; comprehension: number; risk: number }[];
  totals: {
    files: number;
    loc: number;
    aiLineShare: number;
    contributors: number;
    activeContributors: number;
    modules: number;
    busFactorZeroModules: number;
    filesAboveThreshold: number;
  };
  riskThreshold: number;
  reviewDataAvailable: boolean;
  topRisk: FileRow[];
}

export interface HeatmapFile {
  path: string;
  loc: number;
  risk: number;
  comprehension: number;
}
export interface HeatmapModule {
  module: string;
  loc: number;
  risk: number;
  comprehension: number;
  files: HeatmapFile[];
}

export interface Person {
  id: string;
  name: string;
  active: boolean;
  lastActiveAt: string;
}

export interface FileDetail {
  path: string;
  module: string;
  loc: number;
  aiLines: number;
  aiLineShare: number;
  comprehension: number | null;
  criticality: number | null;
  criticalityReasons: string[];
  risk: number | null;
  explanation: string;
  computedAt: string;
  weights: { wA: number; wR: number; wH: number; wE: number } | null;
  signals: {
    a: number;
    r: number;
    h: number;
    k: number;
    e: number;
    contributions: { a: number; r: number; hk: number; e: number };
    reviewDataAvailable: boolean;
    reviewNote: string;
  } | null;
  owners: (Person & { share: number })[];
  touchers: (Person & { lastTouchAt: string; weight: number })[];
  aiSources: {
    sha: string;
    lines: number;
    evidence: string[];
    summary: string;
    authoredAt: string | null;
    author: string;
    prNumber: number | null;
  }[];
}

export interface Knowledge {
  modules: {
    module: string;
    files: number;
    loc: number;
    risk: number;
    aiLineShare: number;
    busFactor: number;
    activeHolders: Person[];
    departedHolders: Person[];
  }[];
  busFactorZero: string[];
}

export interface Settings {
  weights?: { wA: number; wR: number; wH: number; wE: number };
  aiTrailerPatterns?: string[];
  aiMessagePatterns?: string[];
  botPatterns?: string[];
  aiBotPatterns?: string[];
  aiPrLabels?: string[];
  ignoreGlobs?: string[];
  criticalPaths?: string[];
  criticalPathPatterns?: string[];
  llmCriticality?: boolean;
  activeDays?: number;
  riskThreshold?: number;
}
export interface SettingsResponse {
  effective: Settings;
  overrides: Settings;
  note: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${url}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; details?: unknown };
    throw new ApiError(res.status, b.error ?? `HTTP ${res.status}`, b.details);
  }
  return body as T;
}

export type Loadable<T> =
  { status: "loading" } | { status: "error"; error: Error } | { status: "ok"; data: T };

/** Fetch `url` (relative to /api) whenever it or `version` changes. `null` skips the request. */
export function useApi<T>(url: string | null, version = 0): Loadable<T> {
  const [state, setState] = useState<{ url: string | null; value: Loadable<T> }>({
    url: null,
    value: { status: "loading" },
  });
  useEffect(() => {
    if (url === null) return;
    let live = true;
    // Same URL refetched (e.g. after a re-analysis): keep showing the old data until new arrives.
    setState((prev) =>
      prev.url === url && prev.value.status === "ok" ? prev : { url, value: { status: "loading" } },
    );
    api<T>(url).then(
      (data) => live && setState({ url, value: { status: "ok", data } }),
      (error: Error) => live && setState({ url, value: { status: "error", error } }),
    );
    return () => {
      live = false;
    };
  }, [url, version]);
  return state.url === url ? state.value : { status: "loading" };
}

export const enc = encodeURIComponent;

const ACTIVE: Job["status"][] = ["queued", "running"];

/** Poll a job once a second until it finishes. */
export function useJob(jobId: string | null, onFinish?: (job: Job) => void): Job | null {
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api<Job>(`/jobs/${jobId}`);
        if (!live) return;
        setJob(j);
        if (ACTIVE.includes(j.status)) timer = setTimeout(tick, 1000);
        else onFinish?.(j);
      } catch {
        if (live) timer = setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId]); // onFinish intentionally not a dependency
  return job;
}
