import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { JobQueue } from "./jobs.js";
import type { DataStore } from "./store/index.js";
import { JsonStore } from "./store/jsonStore.js";
import { MongoStore } from "./store/mongoStore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../.."); // repository root (grasp/)
const env = process.env;
const port = Number(env.PORT ?? 4000);
// The API can clone and analyse repos, so it only listens on localhost unless told otherwise.
const host = env.HOST ?? "127.0.0.1";
const mongoUrl = env.GRASP_MONGO_URL;
// Default for `make demo` / local use: <repo root>/data, where worker --json output lands.
const defaultData = path.join(root, "data");
const jsonSource = env.GRASP_DATA_JSON ?? (!mongoUrl ? defaultData : undefined);

let store: DataStore;
let dataDir: string | undefined;
if (jsonSource) {
  const src = path.resolve(jsonSource);
  if (!existsSync(src) && src === defaultData) mkdirSync(src, { recursive: true });
  store = new JsonStore(src);
  dataDir = statSync(src).isDirectory() ? src : undefined;
  console.log(`grasp api: serving worker JSON from ${src}`);
} else if (mongoUrl) {
  store = new MongoStore(mongoUrl, env.GRASP_MONGO_DB ?? "grasp");
  console.log("grasp api: serving from MongoDB");
} else {
  console.error("Set GRASP_DATA_JSON (worker --json output file/dir) or GRASP_MONGO_URL.");
  process.exit(1);
}

const cliPath = path.resolve(env.GRASP_WORKER_CLI ?? path.join(root, "worker", "cli.py"));
const jobsEnabled = env.GRASP_JOBS !== "off" && existsSync(cliPath);
const jobs = jobsEnabled
  ? new JobQueue({
      cliPath,
      python: env.GRASP_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
      workdir: path.resolve(env.GRASP_WORKDIR ?? path.join(root, "repos")),
      dataDir,
      mongoUrl: dataDir ? undefined : mongoUrl,
      mongoDb: env.GRASP_MONGO_DB,
    })
  : undefined;
console.log(
  jobs
    ? `grasp api: dashboard analysis enabled (worker ${cliPath})`
    : "grasp api: dashboard analysis disabled",
);

const webDist = env.GRASP_WEB_DIST ?? path.join(root, "apps", "web", "dist");
const server = createApp(store, {
  webDist,
  jobs,
  allowLocalPaths: env.GRASP_ALLOW_LOCAL_PATHS !== "false",
  addDisabledReason:
    jsonSource && !dataDir
      ? "GRASP_DATA_JSON points at a single file; point it at a directory to add repos."
      : undefined,
}).listen(port, host, () => {
  console.log(`grasp api listening on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});

function shutdown() {
  server.close(() => void store.close?.().finally(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
