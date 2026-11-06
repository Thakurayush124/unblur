import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { GitHubClient } from "./github/client.js";
import { GitHubIntegration } from "./github/integration.js";
import { JobQueue } from "./jobs.js";
import type { DataStore } from "./store/index.js";
import { JsonStore } from "./store/jsonStore.js";
import { MongoStore } from "./store/mongoStore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../.."); // repository root (unblur/)
const env = process.env;
const port = Number(env.PORT ?? 4000);
// The API can clone and analyse repos, so it only listens on localhost unless told otherwise.
const host = env.HOST ?? "127.0.0.1";
const mongoUrl = env.UNBLUR_MONGO_URL;
// Default for `make demo` / local use: <repo root>/data, where worker --json output lands.
const defaultData = path.join(root, "data");
const jsonSource = env.UNBLUR_DATA_JSON ?? (!mongoUrl ? defaultData : undefined);

let store: DataStore;
let dataDir: string | undefined;
if (jsonSource) {
  const src = path.resolve(jsonSource);
  if (!existsSync(src) && src === defaultData) mkdirSync(src, { recursive: true });
  store = new JsonStore(src);
  dataDir = statSync(src).isDirectory() ? src : undefined;
  console.log(`unblur api: serving worker JSON from ${src}`);
} else if (mongoUrl) {
  store = new MongoStore(mongoUrl, env.UNBLUR_MONGO_DB ?? "unblur");
  console.log("unblur api: serving from MongoDB");
} else {
  console.error("Set UNBLUR_DATA_JSON (worker --json output file/dir) or UNBLUR_MONGO_URL.");
  process.exit(1);
}

const cliPath = path.resolve(env.UNBLUR_WORKER_CLI ?? path.join(root, "worker", "cli.py"));
const jobsEnabled = env.UNBLUR_JOBS !== "off" && existsSync(cliPath);
const jobs = jobsEnabled
  ? new JobQueue({
      cliPath,
      python: env.UNBLUR_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
      workdir: path.resolve(env.UNBLUR_WORKDIR ?? path.join(root, "repos")),
      dataDir,
      mongoUrl: dataDir ? undefined : mongoUrl,
      mongoDb: env.UNBLUR_MONGO_DB,
    })
  : undefined;
console.log(
  jobs
    ? `unblur api: dashboard analysis enabled (worker ${cliPath})`
    : "unblur api: dashboard analysis disabled",
);

// ---- GitHub App (optional) -------------------------------------------------------------
const privateKey =
  // Allow the PEM in a single-line env var with literal "\n" sequences.
  env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n") ??
  (env.GITHUB_PRIVATE_KEY_PATH ? readFileSync(env.GITHUB_PRIVATE_KEY_PATH, "utf-8") : undefined);
let github: GitHubIntegration | undefined;
if (env.GITHUB_APP_ID && privateKey && env.GITHUB_WEBHOOK_SECRET) {
  const client = new GitHubClient({
    appId: env.GITHUB_APP_ID,
    privateKey,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    apiUrl: env.GITHUB_API_URL,
    graphqlUrl: env.GITHUB_GRAPHQL_URL,
  });
  github = new GitHubIntegration(client, store, jobs, {
    prDir: path.join(dataDir ?? defaultData, ".github"),
    webUrl: env.GITHUB_WEB_URL,
    publicUrl: env.UNBLUR_PUBLIC_URL,
    minSentences: env.UNBLUR_GUARD_MIN_SENTENCES ? Number(env.UNBLUR_GUARD_MIN_SENTENCES) : undefined,
    backfillLimit: env.UNBLUR_GITHUB_BACKFILL ? Number(env.UNBLUR_GITHUB_BACKFILL) : undefined,
  });
  console.log(`unblur api: GitHub App ${env.GITHUB_APP_ID} enabled (webhook: POST /api/github/webhook)`);
} else if (env.GITHUB_APP_ID) {
  console.warn(
    "unblur api: GITHUB_APP_ID set but GITHUB_PRIVATE_KEY(_PATH) or GITHUB_WEBHOOK_SECRET missing",
  );
}

const webDist = env.UNBLUR_WEB_DIST ?? path.join(root, "apps", "web", "dist");
const server = createApp(store, {
  webDist,
  jobs,
  allowLocalPaths: env.UNBLUR_ALLOW_LOCAL_PATHS !== "false",
  addDisabledReason:
    jsonSource && !dataDir
      ? "UNBLUR_DATA_JSON points at a single file; point it at a directory to add repos."
      : undefined,
  github,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
}).listen(port, host, () => {
  console.log(`unblur api listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});

function shutdown() {
  server.close(() => void store.close?.().finally(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
