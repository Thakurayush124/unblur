import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { JobQueue, type Runner } from "../src/jobs.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { fixture } from "./fixture.js";

/** Fake worker: records argv, prints progress like cli.py, writes a result file. */
function fakeRunner(calls: string[][], dataDir: string, fail = new Set<string>()): Runner {
  return async (args, onLine) => {
    calls.push(args);
    const source = args[2]!;
    onLine("[grasp] Cloning " + source);
    onLine("[grasp] Running git blame on 3 of 3 files");
    if (fail.has(source)) {
      onLine("error: git clone --quiet failed: fatal: repository not found");
      return { code: 2 };
    }
    const data = fixture();
    data.repo._id = "r_" + Buffer.from(source).toString("hex").slice(-10);
    data.repo.name = path.basename(source);
    data.repo.remoteUrl = source.startsWith("https://") ? source : null;
    data.repo.path = source.startsWith("https://") ? "/clones/x" : source;
    const outIdx = args.indexOf("--json");
    const out = outIdx > 0 ? args[outIdx + 1]! : path.join(dataDir, `${data.repo.name}.json`);
    await writeFile(out, JSON.stringify(data));
    onLine(`[grasp] repo-id ${data.repo._id}`);
    return { code: 0 };
  };
}

let dir: string;
let base: string;
let server: Server;
let queue: JobQueue;
const calls: string[][] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "grasp-jobs-"));
  await mkdir(path.join(dir, "checkout", ".git"), { recursive: true });
  await writeFile(path.join(dir, "demo.json"), JSON.stringify(fixture()));
  queue = new JobQueue({
    cliPath: "/worker/cli.py",
    python: "python",
    workdir: "/repos",
    dataDir: dir,
    runner: fakeRunner(calls, dir, new Set(["https://github.com/nope/nope"])),
  });
  server = createApp(new JsonStore(dir), { jobs: queue, allowLocalPaths: true }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const post = (url: string, body: unknown) =>
  fetch(base + url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const getJson = async (url: string) => (await fetch(base + url)).json() as Promise<Record<string, unknown>>;

describe("analysis jobs", () => {
  it("reports capabilities", async () => {
    expect(await getJson("/capabilities")).toEqual({
      analyze: true,
      addRepos: true,
      localPaths: true,
      reason: null,
    });
  });

  it("adds a repo from a git URL and links the job to the new repo", async () => {
    const res = await post("/repos", { source: "https://github.com/acme/widgets" });
    expect(res.status).toBe(202);
    const job = (await res.json()) as { id: string; status: string };
    await queue.idle();
    const done = await getJson(`/jobs/${job.id}`);
    expect(done).toMatchObject({ status: "succeeded", progress: "Done" });
    expect(calls.at(-1)).toEqual([
      "/worker/cli.py",
      "analyze",
      "https://github.com/acme/widgets",
      "--workdir",
      "/repos",
      "--top",
      "0",
      "--data-dir",
      dir,
    ]);
    const repos = (await (await fetch(`${base}/repos`)).json()) as { id: string; origin: string }[];
    const added = repos.find((r) => r.origin === "https://github.com/acme/widgets");
    expect(added?.id).toBe(done.repoId);
  });

  it("re-analysing a known repo overwrites its own result file", async () => {
    const repos = (await (await fetch(`${base}/repos`)).json()) as { id: string; origin: string }[];
    const added = repos.find((r) => r.origin === "https://github.com/acme/widgets")!;
    const res = await post(`/repos/${added.id}/analyze`, { full: true });
    expect(res.status).toBe(202);
    await queue.idle();
    const args = calls.at(-1)!;
    expect(args).toContain("--full");
    expect(args[args.indexOf("--json") + 1]).toBe(path.join(dir, "widgets.json"));
    // adding the same URL again (even with .git) is treated as a re-analysis too
    await post("/repos", { source: "https://github.com/acme/widgets.git" });
    await queue.idle();
    expect(calls.at(-1)).toContain("--json");
  });

  it("accepts a local checkout path", async () => {
    const res = await post("/repos", { source: path.join(dir, "checkout") });
    expect(res.status).toBe(202);
    await queue.idle();
    expect(calls.at(-1)![2]).toBe(path.resolve(dir, "checkout"));
  });

  it("captures failures with the worker's error line", async () => {
    const job = (await (await post("/repos", { source: "https://github.com/nope/nope" })).json()) as {
      id: string;
    };
    await queue.idle();
    expect(await getJson(`/jobs/${job.id}`)).toMatchObject({
      status: "failed",
      error: "error: git clone --quiet failed: fatal: repository not found",
    });
  });

  it("rejects unsafe or invalid sources before running anything", async () => {
    const before = calls.length;
    for (const source of [
      "-oProxyCommand=evil",
      "ext::sh -c evil",
      "file:///etc",
      "ftp://example.com/repo",
      path.join(dir, "not-a-checkout"),
      "",
    ]) {
      const res = await post("/repos", { source });
      expect(res.status, source).toBe(400);
    }
    expect(calls.length).toBe(before);
    expect((await fetch(`${base}/jobs/not-a-uuid`)).status).toBe(400);
  });

  it("merges duplicates while queued, but queues a follow-up behind a running job", () => {
    const q = new JobQueue({ cliPath: "c", python: "p", workdir: "w", runner: () => new Promise(() => {}) });
    const running = q.submit("https://github.com/a/b");
    expect(running.status).toBe("running");
    const followUp = q.submit("https://github.com/a/b");
    expect(followUp.id).not.toBe(running.id);
    expect(q.submit("https://github.com/a/b", { full: true }).id).toBe(followUp.id);
    expect(followUp.full).toBe(true);
  });

  it("passes per-job args and lazily resolved env to the runner", async () => {
    const seen: { args: string[]; env?: Record<string, string> }[] = [];
    const q = new JobQueue({
      cliPath: "c",
      python: "p",
      workdir: "w",
      runner: async (args, _l, _s, env) => {
        seen.push({ args, env });
        return { code: 0 };
      },
    });
    q.submit("https://github.com/a/b", {
      extraArgs: ["--pr-data", "prs.json"],
      env: async () => ({ GIT_CONFIG_COUNT: "1" }),
    });
    await q.idle();
    expect(seen[0]!.args).toContain("--pr-data");
    expect(seen[0]!.env).toEqual({ GIT_CONFIG_COUNT: "1" });
  });
});

describe("jobs disabled", () => {
  it("returns 403 and says why", async () => {
    const s = createApp(new JsonStore(dir)).listen(0);
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`;
      const res = await fetch(`${url}/repos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "https://github.com/a/b" }),
      });
      expect(res.status).toBe(403);
      expect(((await (await fetch(`${url}/capabilities`)).json()) as { analyze: boolean }).analyze).toBe(
        false,
      );
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});
