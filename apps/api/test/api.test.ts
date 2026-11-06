import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { effectiveSettings } from "../src/settings.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { fileList, knowledge, overview } from "../src/views.js";
import { fixture } from "./fixture.js";

let dir: string;
let dataFile: string;
let server: Server;
let base: string;

async function get(url: string) {
  const res = await fetch(base + url);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & unknown[] };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "grasp-api-"));
  dataFile = path.join(dir, "demo.json");
  await writeFile(dataFile, JSON.stringify(fixture()));
  await writeFile(path.join(dir, "junk.json"), "{ not json");
  server = createApp(new JsonStore(dir)).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe("views", () => {
  it("overview ranks the riskiest files and summarises the repo", () => {
    const o = overview(fixture(), 60);
    expect(o.comprehension).toBe(25);
    expect(o.topRisk.map((f) => f.path)).toEqual([
      "src/auth/tokens.py",
      "src/auth/session.py",
      "src/ui/button.ts",
    ]);
    expect(o.trend).toHaveLength(2);
    expect(o.totals).toMatchObject({
      files: 3,
      contributors: 2,
      activeContributors: 1,
      busFactorZeroModules: 1,
      filesAboveThreshold: 2,
    });
    expect(o.reviewDataAvailable).toBe(false);
  });

  it("knowledge view lists holders per module, never scores people", () => {
    const k = knowledge(fixture());
    expect(k.busFactorZero).toEqual(["src/auth"]);
    const ui = k.modules.find((m) => m.module === "src/ui")!;
    expect(ui.activeHolders.map((p) => p.name)).toEqual(["Alice"]);
    expect(ui.departedHolders).toEqual([]); // Bob's 5% share is below the holder threshold
    const auth = k.modules.find((m) => m.module === "src/auth")!;
    expect(auth.departedHolders.map((p) => p.name)).toEqual(["Bob"]);
    for (const p of [...auth.activeHolders, ...auth.departedHolders]) {
      expect(Object.keys(p).sort()).toEqual(["active", "id", "lastActiveAt", "name"]);
    }
  });

  it("file list filters, sorts and pages", () => {
    const all = fileList(fixture(), { sort: "comprehension", limit: 2, offset: 0 });
    expect(all.total).toBe(3);
    expect(all.items.map((i) => i.path)).toEqual(["src/auth/tokens.py", "src/auth/session.py"]);
    expect(fileList(fixture(), { sort: "path", limit: 10, offset: 0, q: "BUTTON" }).items).toHaveLength(1);
    expect(fileList(fixture(), { sort: "risk", limit: 10, offset: 0, module: "src/auth" }).total).toBe(2);
  });

  it("effective settings take valid worker values and skip JS-invalid regexes", () => {
    const s = effectiveSettings(fixture().config, { riskThreshold: 50 });
    expect(s.riskThreshold).toBe(50);
    expect(s.weights).toEqual({ wA: 0.3, wR: 0.2, wH: 0.3, wE: 0.2 });
    expect(s.aiMessagePatterns).toBeUndefined(); // "(?P<py>...)" is Python-only
    expect(s).not.toHaveProperty("blameWorkers");
  });
});

describe("HTTP API (JSON store)", () => {
  it("lists repos and ignores non-Grasp files", async () => {
    const { status, body } = await get("/repos");
    expect(status).toBe(200);
    expect(body).toEqual([
      { id: "r_demo", name: "demo", source: "local", lastAnalyzedAt: "2026-11-01T00:00:00Z" },
    ]);
  });

  it("serves overview, heatmap and people", async () => {
    expect((await get("/repos/r_demo/overview")).body.comprehension).toBe(25);
    const hm = await get("/repos/r_demo/heatmap");
    expect((hm.body.modules as { files: unknown[] }[])[0]!.files).toHaveLength(2);
    expect((await get("/repos/r_demo/people")).body.busFactorZero).toEqual(["src/auth"]);
  });

  it("file detail resolves names, commits and weights", async () => {
    const { status, body } = await get(`/repos/r_demo/file?path=${encodeURIComponent("src/auth/tokens.py")}`);
    expect(status).toBe(200);
    expect(body.owners).toEqual([
      { id: "bob", name: "Bob", active: false, lastActiveAt: "2025-01-01T00:00:00Z", share: 1 },
    ]);
    expect((body.aiSources as { summary: string; prNumber: number }[])[0]).toMatchObject({
      summary: "Add tokens (#3)",
      prNumber: 3,
    });
    expect(body.weights).toEqual({ wA: 0.3, wR: 0.2, wH: 0.3, wE: 0.2 });
  });

  it("validates input and returns 404s", async () => {
    expect((await get("/repos/nope/overview")).status).toBe(404);
    expect((await get("/repos/r_demo/file?path=missing.py")).status).toBe(404);
    expect((await get("/repos/r_demo/file")).status).toBe(400);
    expect((await get("/repos/r_demo/files?limit=99999")).status).toBe(400);
    expect((await get("/repos/bad%20id!/overview")).status).toBe(400);
    expect((await get("/nope")).status).toBe(404);
  });

  it("saves valid settings next to the data file and rejects invalid ones", async () => {
    const put = (body: unknown) =>
      fetch(`${base}/repos/r_demo/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await put({ aiMessagePatterns: ["(unclosed"] })).status).toBe(400);
    expect((await put({ weights: { wA: -1, wR: 0, wH: 0, wE: 0 } })).status).toBe(400);
    expect((await put({ weights: { wA: 0, wR: 0, wH: 0, wE: 0 } })).status).toBe(400);
    expect((await put({ unknownKey: 1 })).status).toBe(400);

    const ok = await put({ llmCriticality: true, criticalPaths: ["src/ledger/"], riskThreshold: 40 });
    expect(ok.status).toBe(200);
    const saved = JSON.parse(await readFile(`${dataFile}.settings.json`, "utf-8"));
    expect(saved).toEqual({ llmCriticality: true, criticalPaths: ["src/ledger/"], riskThreshold: 40 });
    const s = await get("/repos/r_demo/settings");
    expect(s.body.effective).toMatchObject({ llmCriticality: true, riskThreshold: 40, weights: { wA: 0.3 } });
    expect((await get("/repos/r_demo/overview")).body.riskThreshold).toBe(40);
  });

  it("picks up a re-written data file without restarting", async () => {
    const next = fixture();
    next.snapshots.push({
      takenAt: "2026-11-05T00:00:00Z",
      headSha: "new",
      repoComprehension: 40,
      repoRisk: 50,
      perModule: [],
    });
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(dataFile, JSON.stringify(next));
    expect((await get("/repos/r_demo/overview")).body.comprehension).toBe(40);
  });
});
