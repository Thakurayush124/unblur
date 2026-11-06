// Builds the e2e datasets in e2e/.data: the realistic demo (via the Python worker) and a
// synthetic 5,000-file repo for the load-time check. Run by playwright.config.ts's webServer.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = path.join(here, ".data");
rmSync(data, { recursive: true, force: true });
mkdirSync(data, { recursive: true });

const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
execFileSync(
  python,
  [
    path.resolve(here, "../../../worker/scripts/demo.py"),
    "--repo",
    path.join(data, "demo-repo"),
    "--out",
    path.join(data, "demo.json"),
  ],
  { stdio: "inherit" },
);

// ---- synthetic 5k-file dataset (shape = worker JSON output) ----------------------------
let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const at = new Date().toISOString();
const N = 5000;
const MODULES = 60;
const contributors = Array.from({ length: 40 }, (_, i) => ({
  _id: `c${i}`,
  canonicalName: `Dev ${i}`,
  isBot: false,
  lastActiveAt: at,
  active: i % 3 !== 0,
}));
const fileScores = Array.from({ length: N }, (_, i) => {
  const module = `src/mod${String(i % MODULES).padStart(2, "0")}`;
  const loc = 20 + Math.floor(rand() * 600);
  const a = rand();
  const comprehension = Math.round((100 - a * 70 - rand() * 20) * 100) / 100;
  const criticality = rand() < 0.15 ? 0.9 : Math.round(rand() * 80) / 100;
  return {
    path: `${module}/sub${i % 7}/file${i}.ts`,
    module,
    loc,
    aiLines: Math.round(loc * a),
    aiLineShare: Math.round(a * 1e4) / 1e4,
    aiSources: [],
    topOwners: [{ contributorId: `c${i % 40}`, share: 1 }],
    reviewDepth: 0.5,
    humanTouch: 0.3,
    retention: 0.5,
    verified: 0,
    comprehension,
    criticality,
    criticalityReasons: [],
    risk: Math.round(criticality * (100 - comprehension) * 100) / 100,
    touchers: [],
    signals: null,
    explanation: `Synthetic file ${i}.`,
    computedAt: at,
  };
});
const moduleScores = Array.from({ length: MODULES }, (_, m) => {
  const files = fileScores.filter((f) => f.module === `src/mod${String(m).padStart(2, "0")}`);
  const loc = files.reduce((s, f) => s + f.loc, 0);
  const w = (k) => files.reduce((s, f) => s + f[k] * f.loc, 0) / loc;
  return {
    module: `src/mod${String(m).padStart(2, "0")}`,
    files: files.length,
    loc,
    aiLineShare: w("aiLineShare"),
    comprehension: w("comprehension"),
    criticality: w("criticality"),
    risk: w("risk"),
    activeKnowledgeHolders: m % 9 === 0 ? 0 : 2,
  };
}).sort((a, b) => b.risk - a.risk);
const snapshots = Array.from({ length: 30 }, (_, i) => ({
  takenAt: new Date(Date.now() - (30 - i) * 7 * 86400000).toISOString(),
  headSha: `sha${i}`,
  repoComprehension: 40 + i * 0.3,
  repoRisk: 45 - i * 0.2,
  perModule: [],
}));
writeFileSync(
  path.join(data, "large.json"),
  JSON.stringify({
    repo: {
      _id: "r_large",
      name: "large-5k",
      source: "local",
      defaultBranch: "main",
      lastAnalyzedAt: at,
      lastAnalyzedSha: "deadbeef",
    },
    contributors,
    commits: [],
    fileScores,
    moduleScores,
    snapshots,
    config: null,
  }),
);
console.log(`e2e data ready in ${data}`);
