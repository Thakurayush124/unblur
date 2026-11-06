/** Pure view-model builders: RepoData -> what each dashboard page needs. */
import type { Contributor, FileScore, RepoData } from "./types.js";

const HOLDER_MIN_SHARE = 0.1;

export interface Person {
  id: string;
  name: string;
  active: boolean;
  lastActiveAt: string;
}

function people(data: RepoData): Map<string, Contributor> {
  return new Map(data.contributors.map((c) => [c._id, c]));
}

function person(c: Contributor | undefined, id: string): Person {
  return {
    id,
    name: c?.canonicalName ?? "unknown",
    active: c?.active ?? false,
    lastActiveAt: c?.lastActiveAt ?? "",
  };
}

function fileRow(f: FileScore) {
  return {
    path: f.path,
    module: f.module,
    loc: f.loc,
    aiLineShare: f.aiLineShare,
    comprehension: f.comprehension ?? 0,
    criticality: f.criticality ?? 0,
    risk: f.risk ?? 0,
    explanation: f.explanation,
  };
}
export type FileRow = ReturnType<typeof fileRow>;

const byRisk = (a: FileScore, b: FileScore) =>
  (b.risk ?? 0) - (a.risk ?? 0) || b.loc - a.loc || a.path.localeCompare(b.path);

/** Knowledge holders of a module: humans owning >=10% of a file, or who touched it since AI landed. */
function moduleHolders(data: RepoData): Map<string, Set<string>> {
  const bots = new Set(data.contributors.filter((c) => c.isBot).map((c) => c._id));
  const out = new Map<string, Set<string>>();
  for (const f of data.fileScores) {
    const set = out.get(f.module) ?? new Set<string>();
    for (const o of f.topOwners)
      if (o.share >= HOLDER_MIN_SHARE && !bots.has(o.contributorId)) set.add(o.contributorId);
    for (const t of f.touchers) if (!bots.has(t.contributorId)) set.add(t.contributorId);
    out.set(f.module, set);
  }
  return out;
}

export function overview(data: RepoData, riskThreshold: number) {
  const latest = data.snapshots.at(-1);
  const loc = data.fileScores.reduce((s, f) => s + f.loc, 0);
  const aiLines = data.fileScores.reduce((s, f) => s + f.aiLines, 0);
  const humans = data.contributors.filter((c) => !c.isBot);
  const busFactorZero = data.moduleScores.filter((m) => m.activeKnowledgeHolders === 0).length;
  return {
    repo: {
      id: data.repo._id,
      name: data.repo.name,
      source: data.repo.source,
      defaultBranch: data.repo.defaultBranch,
      lastAnalyzedAt: data.repo.lastAnalyzedAt ?? null,
      lastAnalyzedSha: data.repo.lastAnalyzedSha ?? null,
    },
    comprehension: latest?.repoComprehension ?? null,
    risk: latest?.repoRisk ?? null,
    trend: data.snapshots.map((s) => ({
      takenAt: s.takenAt,
      headSha: s.headSha,
      comprehension: s.repoComprehension,
      risk: s.repoRisk,
    })),
    totals: {
      files: data.fileScores.length,
      loc,
      aiLineShare: loc ? aiLines / loc : 0,
      contributors: humans.length,
      activeContributors: humans.filter((c) => c.active).length,
      modules: data.moduleScores.length,
      busFactorZeroModules: busFactorZero,
      filesAboveThreshold: data.fileScores.filter((f) => (f.risk ?? 0) >= riskThreshold).length,
    },
    riskThreshold,
    reviewDataAvailable: data.fileScores.some((f) => f.signals?.reviewDataAvailable),
    topRisk: [...data.fileScores].sort(byRisk).slice(0, 10).map(fileRow),
  };
}

export function heatmap(data: RepoData) {
  const files = new Map<string, FileScore[]>();
  for (const f of data.fileScores) {
    const list = files.get(f.module);
    if (list) list.push(f);
    else files.set(f.module, [f]);
  }
  return {
    modules: data.moduleScores.map((m) => ({
      module: m.module,
      loc: m.loc,
      risk: m.risk,
      comprehension: m.comprehension,
      files: (files.get(m.module) ?? []).sort(byRisk).map((f) => ({
        path: f.path,
        loc: f.loc,
        risk: f.risk ?? 0,
        comprehension: f.comprehension ?? 0,
      })),
    })),
  };
}

export interface FileQuery {
  q?: string;
  module?: string;
  sort: "risk" | "comprehension" | "aiLineShare" | "loc" | "path";
  limit: number;
  offset: number;
}

export function fileList(data: RepoData, query: FileQuery) {
  let rows = data.fileScores.map(fileRow);
  if (query.module) rows = rows.filter((r) => r.module === query.module);
  if (query.q) {
    const q = query.q.toLowerCase();
    rows = rows.filter((r) => r.path.toLowerCase().includes(q));
  }
  const key = query.sort;
  rows.sort((a, b) => {
    if (key === "path") return a.path.localeCompare(b.path);
    const dir = key === "comprehension" ? 1 : -1; // lowest comprehension first
    return dir * (a[key] - b[key]) || a.path.localeCompare(b.path);
  });
  return { total: rows.length, items: rows.slice(query.offset, query.offset + query.limit) };
}

export function fileDetail(data: RepoData, path: string, weights: Record<string, number> | null) {
  const f = data.fileScores.find((x) => x.path === path);
  if (!f) return null;
  const who = people(data);
  const commits = new Map(data.commits.map((c) => [c.sha, c]));
  return {
    ...f,
    weights,
    owners: f.topOwners.map((o) => ({
      ...person(who.get(o.contributorId), o.contributorId),
      share: o.share,
    })),
    touchers: f.touchers.map((t) => ({
      ...person(who.get(t.contributorId), t.contributorId),
      lastTouchAt: t.lastTouchAt,
      weight: t.weight,
    })),
    aiSources: f.aiSources.map((s) => {
      const c = commits.get(s.sha);
      return {
        ...s,
        summary: c?.message.split("\n")[0] ?? "",
        authoredAt: c?.authoredAt ?? null,
        author: c ? person(who.get(c.authorId), c.authorId).name : "unknown",
        prNumber: c?.prNumber ?? null,
      };
    }),
  };
}

/** Team view: knowledge coverage per module. Deliberately no per-person scores or rankings. */
export function knowledge(data: RepoData) {
  const who = people(data);
  const holders = moduleHolders(data);
  const modules = data.moduleScores.map((m) => {
    const ids = [...(holders.get(m.module) ?? [])];
    const ppl = ids.map((id) => person(who.get(id), id)).sort((a, b) => a.name.localeCompare(b.name));
    return {
      module: m.module,
      files: m.files,
      loc: m.loc,
      risk: m.risk,
      aiLineShare: m.aiLineShare,
      busFactor: ppl.filter((p) => p.active).length,
      activeHolders: ppl.filter((p) => p.active),
      departedHolders: ppl.filter((p) => !p.active),
    };
  });
  modules.sort((a, b) => a.busFactor - b.busFactor || b.risk - a.risk || a.module.localeCompare(b.module));
  return {
    modules,
    busFactorZero: modules.filter((m) => m.busFactor === 0).map((m) => m.module),
  };
}
