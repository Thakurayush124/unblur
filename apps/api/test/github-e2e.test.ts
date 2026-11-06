/**
 * End-to-end PR guard flow against a fake GitHub (REST + GraphQL) server:
 * signed webhooks -> real API app -> GitHub integration -> check runs + one comment.
 * The worker is a fake runner (no Python), but receives the exact args/env it would get.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { GitHubClient } from "../src/github/client.js";
import { CHECK_NAME, COMMENT_MARKER } from "../src/github/guard.js";
import { GitHubIntegration } from "../src/github/integration.js";
import { JobQueue } from "../src/jobs.js";
import { JsonStore } from "../src/store/jsonStore.js";
import { fixture } from "./fixture.js";

const SECRET = "whsec_test";
const APP_ID = "4242";
const INSTALL = 77;
const REPO = {
  name: "widgets",
  owner: { login: "acme" },
  full_name: "acme/widgets",
  html_url: "https://github.com/acme/widgets",
  default_branch: "main",
};

// ---- fake GitHub ---------------------------------------------------------------------------
interface FakePr {
  number: number;
  state: string;
  body: string;
  user: { login: string };
  head: { sha: string };
  files: string[];
  reviews: { user: { login: string; type: string }; state: string; body: string; submitted_at: string }[];
}
const gh = {
  prs: new Map<number, FakePr>(),
  checkRuns: [] as {
    id: number;
    head_sha: string;
    name: string;
    conclusion: string;
    output: { title: string; summary: string };
    app: { id: number };
  }[],
  comments: [] as { id: number; issue: number; body: string; user: { type: string; login: string } }[],
  requests: [] as string[],
  nextId: 1,
};

function fakeGitHub(): Server {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(req.url!, "http://x");
    const p = url.pathname;
    const m = req.method!;
    gh.requests.push(`${m} ${p}`);
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const auth = req.headers.authorization ?? "";
    if (p === `/app/installations/${INSTALL}/access_tokens` && m === "POST") {
      if (!auth.startsWith("Bearer ")) return json(401, {});
      return json(201, { token: "ghs_fake", expires_at: new Date(Date.now() + 3600e3).toISOString() });
    }
    if (!/^(token|bearer) ghs_fake$/.test(auth)) return json(401, { message: "bad token" });
    if (p === "/graphql") {
      const node = (n: number) => ({
        number: n,
        createdAt: "2026-10-01T10:00:00Z",
        mergedAt: "2026-10-02T10:00:00Z",
        additions: 300,
        deletions: 0,
        author: { login: "carol" },
        labels: { nodes: [] },
        mergeCommit: { oid: `${n}`.padStart(40, "0") },
        commits: { nodes: [] },
        reviews: {
          nodes: [
            {
              author: { login: "alice" },
              state: "APPROVED",
              submittedAt: "2026-10-01T10:02:00Z",
              body: "",
              comments: { totalCount: 0 },
            },
          ],
        },
      });
      if (body.query.includes("pullRequests("))
        return json(200, {
          data: {
            repository: {
              pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1), node(2)] },
            },
          },
        });
      return json(200, { data: { repository: { pullRequest: node(body.variables.number) } } });
    }
    let r: RegExpExecArray | null;
    if ((r = /^\/repos\/acme\/widgets\/pulls\/(\d+)$/.exec(p))) {
      const pr = gh.prs.get(Number(r[1]));
      return pr
        ? json(200, { ...pr, html_url: `https://github.com/acme/widgets/pull/${pr.number}` })
        : json(404, {});
    }
    if ((r = /^\/repos\/acme\/widgets\/pulls\/(\d+)\/files$/.exec(p)))
      return json(
        200,
        gh.prs.get(Number(r[1]))!.files.map((filename) => ({ filename })),
      );
    if ((r = /^\/repos\/acme\/widgets\/pulls\/(\d+)\/reviews$/.exec(p)))
      return json(200, gh.prs.get(Number(r[1]))!.reviews);
    if ((r = /^\/repos\/acme\/widgets\/commits\/(\w+)\/check-runs$/.exec(p))) {
      const runs = gh.checkRuns.filter(
        (c) => c.head_sha === r![1] && c.name === url.searchParams.get("check_name"),
      );
      return json(200, { total_count: runs.length, check_runs: runs });
    }
    if (p === "/repos/acme/widgets/check-runs" && m === "POST") {
      const run = { id: gh.nextId++, ...body, app: { id: Number(APP_ID) } };
      gh.checkRuns.push(run);
      return json(201, run);
    }
    if ((r = /^\/repos\/acme\/widgets\/check-runs\/(\d+)$/.exec(p)) && m === "PATCH") {
      const run = gh.checkRuns.find((c) => c.id === Number(r![1]))!;
      Object.assign(run, body);
      return json(200, run);
    }
    if ((r = /^\/repos\/acme\/widgets\/issues\/(\d+)\/comments$/.exec(p))) {
      const issue = Number(r[1]);
      if (m === "GET")
        return json(
          200,
          gh.comments.filter((c) => c.issue === issue),
        );
      const c = { id: gh.nextId++, issue, body: body.body, user: { type: "Bot", login: "unblur[bot]" } };
      gh.comments.push(c);
      return json(201, c);
    }
    if ((r = /^\/repos\/acme\/widgets\/issues\/comments\/(\d+)$/.exec(p)) && m === "PATCH") {
      const c = gh.comments.find((x) => x.id === Number(r![1]))!;
      c.body = body.body;
      return json(200, c);
    }
    json(404, { message: `fake GitHub: no route for ${m} ${p}` });
  });
}

// ---- harness ----------------------------------------------------------------------------------
let dir: string;
let ghServer: Server;
let api: Server;
let base: string;
let integration: GitHubIntegration;
let jobs: JobQueue;
const runs: { args: string[]; env?: Record<string, string> }[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "unblur-gh-"));
  const data = fixture(); // src/auth/tokens.py risk 80, src/auth/session.py 70, src/ui/button.ts 5
  data.repo.remoteUrl = "https://github.com/acme/widgets";
  await writeFile(path.join(dir, "acme-widgets.json"), JSON.stringify(data));
  ghServer = fakeGitHub().listen(0);
  const ghUrl = `http://127.0.0.1:${(ghServer.address() as AddressInfo).port}`;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const client = new GitHubClient({
    appId: APP_ID,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    webhookSecret: SECRET,
    apiUrl: ghUrl,
  });
  const store = new JsonStore(dir);
  jobs = new JobQueue({
    cliPath: "/worker/cli.py",
    python: "python",
    workdir: "/repos",
    dataDir: dir,
    runner: async (args, _onLine, _signal, env) => {
      runs.push({ args, env });
      return { code: 0 };
    },
  });
  integration = new GitHubIntegration(client, store, jobs, {
    prDir: path.join(dir, ".github"),
    publicUrl: "http://unblur.local",
  });
  api = createApp(store, { jobs, github: integration, webhookSecret: SECRET }).listen(0);
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => api.close(r));
  await new Promise((r) => ghServer.close(r));
  await rm(dir, { recursive: true, force: true });
});

let delivery = 0;
async function send(event: string, payload: unknown, opts: { secret?: string; id?: string } = {}) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac("sha256", opts.secret ?? SECRET)
    .update(raw)
    .digest("hex")}`;
  const res = await fetch(`${base}/api/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.id ?? `d-${++delivery}`,
      "x-hub-signature-256": sig,
    },
    body: raw,
  });
  await integration.idle();
  await jobs.idle();
  return res.status;
}

function openPr(number: number, files: string[], body = "") {
  gh.prs.set(number, {
    number,
    state: "open",
    body,
    user: { login: "carol" },
    head: { sha: `sha${number}` },
    files,
    reviews: [],
  });
  return send("pull_request", {
    action: "opened",
    installation: { id: INSTALL },
    repository: REPO,
    pull_request: { number },
  });
}
const checkFor = (sha: string) => gh.checkRuns.filter((c) => c.head_sha === sha);
const commentsOn = (n: number) => gh.comments.filter((c) => c.issue === n);

const WHY = `Fixes refresh.\n\n## Why this works\nTokens refresh only after expiry. The refresh is idempotent so retries are safe. Old tokens stay valid until the new one is stored.\n\n## Testing\nunit tests`;

describe("GitHub App webhooks", () => {
  it("rejects bad signatures and unconfigured calls", async () => {
    expect(await send("ping", {}, { secret: "wrong" })).toBe(401);
    const plain = createApp(new JsonStore(dir)).listen(0);
    try {
      const res = await fetch(
        `http://127.0.0.1:${(plain.address() as AddressInfo).port}/api/github/webhook`,
        { method: "POST", body: "{}" },
      );
      expect(res.status).toBe(404);
    } finally {
      await new Promise((r) => plain.close(r));
    }
  });

  it("installation: backfills merged PRs and queues an authenticated analysis", async () => {
    expect(
      await send("installation", {
        action: "created",
        installation: { id: INSTALL },
        repositories: [{ full_name: "acme/widgets" }],
      }),
    ).toBe(202);
    const prs = JSON.parse(await readFile(path.join(dir, ".github", "acme-widgets.prs.json"), "utf-8"));
    expect(prs.map((p: { number: number }) => p.number)).toEqual([1, 2]);
    const run = runs.at(-1)!;
    expect(run.args.slice(0, 3)).toEqual(["/worker/cli.py", "analyze", "https://github.com/acme/widgets"]);
    expect(run.args).toEqual(
      expect.arrayContaining([
        "--pr-data",
        path.join(dir, ".github", "acme-widgets.prs.json"),
        "--github-installation-id",
        "77",
      ]),
    );
    expect(run.args[run.args.indexOf("--json") + 1]).toBe(path.join(dir, "acme-widgets.json")); // known repo: same file
    expect(run.env?.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /); // token via env, never argv
    expect(run.args.join(" ")).not.toContain("ghs_fake");
  });

  it("never blocks a PR that only touches low-risk files", async () => {
    await openPr(10, ["src/ui/button.ts", "README.md"]);
    expect(checkFor("sha10").map((c) => [c.name, c.conclusion])).toEqual([[CHECK_NAME, "success"]]);
    expect(commentsOn(10)).toHaveLength(0);
  });

  it("high-risk PR: action_required + exactly one comment, updated in place until verified", async () => {
    await openPr(11, ["src/auth/tokens.py", "src/ui/button.ts"]);
    let [run] = checkFor("sha11");
    expect(run!.conclusion).toBe("action_required");
    expect(run!.output.summary).toContain("src/auth/tokens.py");
    expect(run!.output.summary).not.toContain("src/ui/button.ts");
    expect(commentsOn(11)).toHaveLength(1);
    expect(commentsOn(11)[0]!.body).toContain(COMMENT_MARKER);
    expect(commentsOn(11)[0]!.body).toContain(
      "http://unblur.local/#/file?repo=r_demo&path=src%2Fauth%2Ftokens.py",
    );

    // author adds the section: still blocked (needs a verified review), same check + comment updated
    gh.prs.get(11)!.body = WHY;
    await send("pull_request", {
      action: "edited",
      installation: { id: INSTALL },
      repository: REPO,
      pull_request: { number: 11 },
    });
    expect(checkFor("sha11")).toHaveLength(1);
    expect(checkFor("sha11")[0]!.conclusion).toBe("action_required");
    expect(checkFor("sha11")[0]!.output.summary).toContain("✅ The author adds");
    expect(commentsOn(11)).toHaveLength(1);

    // the author "verifying" their own PR does not count
    gh.prs.get(11)!.reviews.push({
      user: { login: "carol", type: "User" },
      state: "COMMENTED",
      body: "/unblur verified",
      submitted_at: "2026-11-01T10:00:00Z",
    });
    await send("pull_request_review", {
      action: "submitted",
      installation: { id: INSTALL },
      repository: REPO,
      pull_request: { number: 11 },
    });
    expect(checkFor("sha11")[0]!.conclusion).toBe("action_required");

    // another reviewer approves with /unblur verified -> passes; the one comment says so
    gh.prs.get(11)!.reviews.push({
      user: { login: "alice", type: "User" },
      state: "APPROVED",
      body: "Walked through the refresh path. /unblur verified",
      submitted_at: "2026-11-01T11:00:00Z",
    });
    await send("pull_request_review", {
      action: "submitted",
      installation: { id: INSTALL },
      repository: REPO,
      pull_request: { number: 11 },
    });
    [run] = checkFor("sha11");
    expect([run!.conclusion, run!.output.title]).toEqual(["success", "Comprehension verified by @alice"]);
    expect(commentsOn(11)).toHaveLength(1);
    expect(commentsOn(11)[0]!.body).toContain("Unblur comprehension check passed");

    // a new push gets a fresh check on the new head sha
    gh.prs.get(11)!.head.sha = "sha11b";
    await send("pull_request", {
      action: "synchronize",
      installation: { id: INSTALL },
      repository: REPO,
      pull_request: { number: 11 },
    });
    expect(checkFor("sha11b")[0]!.conclusion).toBe("success");
  });

  it("ignores GitHub redeliveries of the same event", async () => {
    const before = gh.requests.length;
    await send(
      "pull_request",
      { action: "edited", installation: { id: INSTALL }, repository: REPO, pull_request: { number: 10 } },
      { id: "same" },
    );
    const after = gh.requests.length;
    await send(
      "pull_request",
      { action: "edited", installation: { id: INSTALL }, repository: REPO, pull_request: { number: 10 } },
      { id: "same" },
    );
    expect(after).toBeGreaterThan(before);
    expect(gh.requests.length).toBe(after);
  });

  it("merge: stores the PR's review data and recomputes scores; pushes elsewhere are ignored", async () => {
    const n = runs.length;
    gh.prs.get(11)!.state = "closed";
    await send("pull_request", {
      action: "closed",
      installation: { id: INSTALL },
      repository: REPO,
      pull_request: { number: 11, merged: true },
    });
    const prs = JSON.parse(await readFile(path.join(dir, ".github", "acme-widgets.prs.json"), "utf-8"));
    expect(prs.map((p: { number: number }) => p.number)).toEqual([1, 2, 11]);
    expect(runs.length).toBe(n + 1);
    await send("push", { ref: "refs/heads/feature", installation: { id: INSTALL }, repository: REPO });
    expect(runs.length).toBe(n + 1);
    await send("push", { ref: "refs/heads/main", installation: { id: INSTALL }, repository: REPO });
    expect(runs.length).toBe(n + 2);
  });

  it("reports recent events on the status endpoint", async () => {
    const s = (await (await fetch(`${base}/api/github/status`)).json()) as {
      configured: boolean;
      appId: string;
      events: { outcome: string }[];
    };
    expect(s.configured).toBe(true);
    expect(s.appId).toBe(APP_ID);
    expect(s.events.some((e) => e.outcome.includes("passed"))).toBe(true);
    expect(s.events.every((e) => !e.outcome.startsWith("error"))).toBe(true);
  });
});
