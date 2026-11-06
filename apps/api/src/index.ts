import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import type { DataStore } from "./store/index.js";
import { JsonStore } from "./store/jsonStore.js";
import { MongoStore } from "./store/mongoStore.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4000);
const mongoUrl = process.env.GRASP_MONGO_URL;
// Default for `make demo` / local use: <repo root>/data, where worker --json output lands.
const defaultData = path.resolve(here, "../../../data");
const jsonSource =
  process.env.GRASP_DATA_JSON ?? (!mongoUrl && existsSync(defaultData) ? defaultData : undefined);

let store: DataStore;
if (jsonSource) {
  store = new JsonStore(path.resolve(jsonSource));
  console.log(`grasp api: serving worker JSON from ${jsonSource}`);
} else if (mongoUrl) {
  store = new MongoStore(mongoUrl, process.env.GRASP_MONGO_DB ?? "grasp");
  console.log("grasp api: serving from MongoDB");
} else {
  console.error("Set GRASP_DATA_JSON (worker --json output file/dir) or GRASP_MONGO_URL.");
  process.exit(1);
}

const webDist = process.env.GRASP_WEB_DIST ?? path.resolve(here, "../../web/dist");
const server = createApp(store, { webDist }).listen(port, () => {
  console.log(`grasp api listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => void store.close?.().finally(() => process.exit(0)));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
