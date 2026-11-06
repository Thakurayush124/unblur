import type { FileScore, RepoData } from "../src/types.js";

const at = "2026-11-01T00:00:00Z";

function file(
  path: string,
  module: string,
  loc: number,
  risk: number,
  extra: Partial<FileScore> = {},
): FileScore {
  return {
    path,
    module,
    loc,
    aiLines: Math.round(loc * 0.5),
    aiLineShare: 0.5,
    aiSources: [{ sha: "c1", lines: Math.round(loc * 0.5), evidence: ["trailer: Co-Authored-By: Claude"] }],
    topOwners: [{ contributorId: "bob", share: 1 }],
    reviewDepth: 0.5,
    humanTouch: 0,
    retention: 0,
    verified: 0,
    comprehension: 100 - risk / 0.9,
    criticality: 0.9,
    criticalityReasons: ["path matches 'auth'"],
    risk,
    touchers: [],
    signals: {
      a: 0.5,
      r: 0.5,
      h: 0,
      k: 0,
      e: 0,
      contributions: { a: 15, r: 10, hk: 0, e: 0 },
      reviewDataAvailable: false,
      reviewNote: "review data unavailable",
    },
    explanation: `explanation for ${path}`,
    computedAt: at,
    ...extra,
  };
}

export function fixture(): RepoData {
  return {
    repo: {
      _id: "r_demo",
      name: "demo",
      source: "local",
      path: "/tmp/demo",
      defaultBranch: "main",
      lastAnalyzedAt: at,
      lastAnalyzedSha: "abc123",
    },
    contributors: [
      { _id: "alice", canonicalName: "Alice", isBot: false, lastActiveAt: at, active: true },
      { _id: "bob", canonicalName: "Bob", isBot: false, lastActiveAt: "2025-01-01T00:00:00Z", active: false },
      { _id: "bot", canonicalName: "dependabot[bot]", isBot: true, lastActiveAt: at, active: false },
    ],
    commits: [
      {
        sha: "c1",
        authorId: "bob",
        authoredAt: "2025-01-01T00:00:00Z",
        message: "Add tokens (#3)\n\nCo-Authored-By: Claude",
        isAiAssisted: true,
        aiEvidence: ["trailer: Co-Authored-By: Claude"],
        prNumber: 3,
      },
    ],
    fileScores: [
      file("src/auth/tokens.py", "src/auth", 200, 80),
      file("src/auth/session.py", "src/auth", 100, 70),
      file("src/ui/button.ts", "src/ui", 50, 5, {
        topOwners: [
          { contributorId: "alice", share: 0.95 },
          { contributorId: "bob", share: 0.05 },
        ],
        touchers: [{ contributorId: "alice", lastTouchAt: at, weight: 1, active: true }],
      }),
    ],
    moduleScores: [
      {
        module: "src/auth",
        files: 2,
        loc: 300,
        aiLineShare: 0.5,
        comprehension: 15,
        criticality: 0.9,
        risk: 76.7,
        activeKnowledgeHolders: 0,
      },
      {
        module: "src/ui",
        files: 1,
        loc: 50,
        aiLineShare: 0.5,
        comprehension: 94,
        criticality: 0.1,
        risk: 5,
        activeKnowledgeHolders: 1,
      },
    ],
    snapshots: [
      { takenAt: "2026-10-01T00:00:00Z", headSha: "old", repoComprehension: 30, repoRisk: 60, perModule: [] },
      { takenAt: at, headSha: "abc123", repoComprehension: 25, repoRisk: 66.4, perModule: [] },
    ],
    config: {
      weights: { wA: 0.3, wR: 0.2, wH: 0.3, wE: 0.2 },
      aiMessagePatterns: ["Generated with", "(?P<py>only-python)"],
      criticalPaths: [],
      llmCriticality: false,
      riskThreshold: 60,
      blameWorkers: 8,
    },
  };
}
