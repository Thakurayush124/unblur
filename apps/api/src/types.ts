/** Shapes produced by the Python worker (camelCase JSON / Mongo documents). */

export interface Repo {
  _id: string;
  name: string;
  source: "local" | "github";
  path?: string | null;
  remoteUrl?: string | null;
  defaultBranch: string;
  lastAnalyzedAt?: string | null;
  lastAnalyzedSha?: string | null;
}

export interface Contributor {
  _id: string;
  canonicalName: string;
  isBot: boolean;
  lastActiveAt: string;
  active: boolean;
}

export interface Commit {
  sha: string;
  authorId: string;
  authoredAt: string;
  message: string;
  isAiAssisted: boolean;
  aiEvidence: string[];
  prNumber?: number | null;
}

export interface Owner {
  contributorId: string;
  share: number;
}

export interface Toucher {
  contributorId: string;
  lastTouchAt: string;
  weight: number;
  active: boolean;
}

export interface AiSource {
  sha: string;
  lines: number;
  evidence: string[];
}

export interface Signals {
  a: number;
  r: number;
  h: number;
  k: number;
  e: number;
  contributions: Record<"a" | "r" | "hk" | "e", number>;
  reviewDataAvailable: boolean;
  reviewNote: string;
}

export interface FileScore {
  path: string;
  module: string;
  loc: number;
  aiLines: number;
  aiLineShare: number;
  aiSources: AiSource[];
  topOwners: Owner[];
  reviewDepth: number | null;
  humanTouch: number | null;
  retention: number | null;
  verified: number | null;
  comprehension: number | null;
  criticality: number | null;
  criticalityReasons: string[];
  risk: number | null;
  touchers: Toucher[];
  signals: Signals | null;
  explanation: string;
  computedAt: string;
}

export interface ModuleScore {
  module: string;
  files: number;
  loc: number;
  aiLineShare: number;
  comprehension: number;
  criticality: number;
  risk: number;
  activeKnowledgeHolders: number;
}

export interface Snapshot {
  takenAt: string;
  headSha: string;
  repoComprehension: number;
  repoRisk: number;
  perModule: ModuleScore[];
}

/** Effective worker config (UnblurConfig) as used for the last analysis. */
export type WorkerConfig = Record<string, unknown>;

export interface RepoData {
  repo: Repo;
  contributors: Contributor[];
  commits: Commit[];
  fileScores: FileScore[];
  moduleScores: ModuleScore[];
  snapshots: Snapshot[];
  config: WorkerConfig | null;
}

export interface RepoSummary {
  id: string;
  name: string;
  source: Repo["source"];
  lastAnalyzedAt: string | null;
  /** What to re-analyse: the remote URL it was cloned from, else the local checkout path. */
  origin: string | null;
}
