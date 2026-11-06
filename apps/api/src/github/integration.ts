/**
 * GitHub App integration: reacts to webhooks, backfills PR/review history (so signal R is real),
 * runs the PR comprehension guard, and re-analyses on merge / push to the default branch.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { JobQueue } from "../jobs.js";
import { effectiveSettings } from "../settings.js";
import type { DataStore } from "../store/index.js";
import type { GitHubClient } from "./client.js";
import {
  CHECK_NAME,
  COMMENT_MARKER,
  commentBody,
  evaluate,
  type FileRisk,
  type GuardResult,
} from "./guard.js";

export interface IntegrationOptions {
  /** Directory for backfilled PR data (one `<owner>-<repo>.prs.json` per repo). */
  prDir: string;
  /** github.com web base (GHES: https://ghe.example.com). */
  webUrl?: string;
  /** Public dashboard URL, used for links in checks/comments. */
  publicUrl?: string;
  minSentences?: number;
  backfillLimit?: number;
}

/** PullRequest document in the worker's camelCase schema (worker/unblur/models.py). */
export interface WorkerPullRequest {
  repoId: string;
  number: number;
  authorId: string;
  openedAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  labels: string[];
  commitShas: string[];
  reviews: {
    reviewerId: string;
    state: string;
    submittedAt: string;
    commentCount: number;
    bodyLength: number;
  }[];
  timeToFirstReviewMins: number | null;
}

interface GqlPr {
  number: number;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  mergeCommit: { oid: string } | null;
  commits: { nodes: { commit: { oid: string } }[] };
  reviews: {
    nodes: {
      author: { login: string } | null;
      state: string;
      submittedAt: string | null;
      body: string;
      comments: { totalCount: number };
    }[];
  };
}

const PR_FIELDS = `
  number createdAt mergedAt additions deletions
  author { login }
  labels(first: 20) { nodes { name } }
  mergeCommit { oid }
  commits(first: 100) { nodes { commit { oid } } }
  reviews(first: 50) { nodes { author { login } state submittedAt body comments { totalCount } } }`;

export const BACKFILL_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PR_FIELDS} }
    }
  }
}`;
export const ONE_PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } }
}`;

/** GraphQL PR -> worker PullRequest (logins are the ids: only compared within one PR). */
export function mapPullRequest(pr: GqlPr): WorkerPullRequest {
  const author = pr.author?.login ?? "ghost";
  const reviews = pr.reviews.nodes
    .filter((r) => r.submittedAt && r.state !== "PENDING")
    .map((r) => ({
      reviewerId: r.author?.login ?? "ghost",
      state: r.state,
      submittedAt: r.submittedAt!,
      commentCount: r.comments.totalCount,
      bodyLength: r.body.trim().length,
    }));
  const first = reviews
    .filter((r) => r.reviewerId !== author)
    .map((r) => new Date(r.submittedAt).getTime())
    .sort((a, b) => a - b)[0];
  const shas = pr.commits.nodes.map((c) => c.commit.oid);
  if (pr.mergeCommit) shas.push(pr.mergeCommit.oid); // squash / merge commit lands on main
  return {
    repoId: "",
    number: pr.number,
    authorId: author,
    openedAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    labels: pr.labels.nodes.map((l) => l.name),
    commitShas: [...new Set(shas)],
    reviews,
    timeToFirstReviewMins:
      first === undefined ? null : Math.max(0, (first - new Date(pr.createdAt).getTime()) / 60_000),
  };
}

export interface IntegrationEvent {
  at: string;
  event: string;
  action: string | null;
  repo: string | null;
  outcome: string;
}

interface RepoRef {
  installationId: number;
  owner: string;
  name: string;
  htmlUrl: string;
}

const slugOf = (r: { owner: string; name: string }) => `${r.owner}-${r.name}`.replace(/[^\w.-]+/g, "-");
const normUrl = (u: string) => u.replace(/(\.git)?\/?$/, "").toLowerCase();

export class GitHubIntegration {
  private chain: Promise<void> = Promise.resolve();
  private deliveries = new Set<string>();
  readonly events: IntegrationEvent[] = [];
  private readonly webUrl: string;
  private readonly minSentences: number;
  private readonly backfillLimit: number;

  constructor(
    private readonly gh: GitHubClient,
    private readonly store: DataStore,
    private readonly jobs: JobQueue | undefined,
    private readonly opts: IntegrationOptions,
  ) {
    this.webUrl = (opts.webUrl ?? "https://github.com").replace(/\/$/, "");
    this.minSentences = opts.minSentences ?? 3;
    this.backfillLimit = opts.backfillLimit ?? 300;
  }

  get appId(): string {
    return this.gh.config.appId;
  }

  /** Accept a verified webhook; processing is serialized in the background. */
  handle(event: string, deliveryId: string, payload: Record<string, unknown>): void {
    if (deliveryId && this.deliveries.has(deliveryId)) return; // GitHub redelivery
    if (deliveryId) this.deliveries.add(deliveryId);
    if (this.deliveries.size > 1000) this.deliveries.clear();
    const action = typeof payload.action === "string" ? payload.action : null;
    const repo = (payload.repository as { full_name?: string } | undefined)?.full_name ?? null;
    this.chain = this.chain
      .then(() => this.dispatch(event, action, payload))
      .then((outcome) => this.record(event, action, repo, outcome))
      .catch((e: unknown) => {
        console.error(`github ${event}:`, e);
        this.record(event, action, repo, `error: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  /** Resolves once queued webhook processing is done (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private record(event: string, action: string | null, repo: string | null, outcome: string) {
    this.events.unshift({ at: new Date().toISOString(), event, action, repo, outcome });
    this.events.splice(50);
  }

  private async dispatch(event: string, action: string | null, p: Record<string, unknown>): Promise<string> {
    const installationId = (p.installation as { id?: number } | undefined)?.id;
    if (!installationId) return "ignored (no installation)";
    const repo = p.repository as
      { name: string; owner: { login: string }; html_url: string; default_branch: string } | undefined;
    const ref = repo
      ? { installationId, owner: repo.owner.login, name: repo.name, htmlUrl: repo.html_url }
      : null;

    switch (event) {
      case "installation": {
        if (action !== "created" && action !== "new_permissions_accepted" && action !== "unsuspend")
          return "ignored";
        const repos = (p.repositories as { full_name: string }[] | undefined) ?? [];
        return this.onboard(
          installationId,
          repos.map((r) => r.full_name),
        );
      }
      case "installation_repositories": {
        if (action !== "added") return "ignored";
        const repos = (p.repositories_added as { full_name: string }[] | undefined) ?? [];
        return this.onboard(
          installationId,
          repos.map((r) => r.full_name),
        );
      }
      case "pull_request": {
        const pr = p.pull_request as { number: number; merged?: boolean };
        if (!ref) return "ignored";
        if (action === "closed" && pr.merged) return this.onMerged(ref, pr.number);
        if (["opened", "reopened", "synchronize", "edited", "ready_for_review"].includes(action ?? ""))
          return this.evaluatePr(ref, pr.number);
        return "ignored";
      }
      case "pull_request_review": {
        if (!ref || !["submitted", "edited", "dismissed"].includes(action ?? "")) return "ignored";
        return this.evaluatePr(ref, (p.pull_request as { number: number }).number);
      }
      case "push": {
        if (!ref || p.ref !== `refs/heads/${repo!.default_branch}`) return "ignored (not default branch)";
        return `re-analysis ${(await this.analyse(ref))?.status ?? "skipped (jobs disabled)"}`;
      }
      case "ping":
        return "pong";
      default:
        return "ignored";
    }
  }

  // ---- onboarding, backfill, analysis -------------------------------------------------

  async onboard(installationId: number, fullNames: string[]): Promise<string> {
    for (const full of fullNames) {
      const [owner, name] = full.split("/") as [string, string];
      const ref = { installationId, owner, name, htmlUrl: `${this.webUrl}/${owner}/${name}` };
      const n = await this.backfill(ref);
      await this.analyse(ref);
      console.log(`unblur github: onboarded ${full} (${n} merged PRs backfilled)`);
    }
    return `onboarded ${fullNames.length} repo(s)`;
  }

  prFile(ref: { owner: string; name: string }): string {
    return path.join(this.opts.prDir, `${slugOf(ref)}.prs.json`);
  }

  private async readPrs(ref: RepoRef): Promise<WorkerPullRequest[]> {
    try {
      return JSON.parse(await readFile(this.prFile(ref), "utf-8")) as WorkerPullRequest[];
    } catch {
      return [];
    }
  }

  private async writePrs(ref: RepoRef, prs: WorkerPullRequest[]): Promise<void> {
    await mkdir(this.opts.prDir, { recursive: true });
    const file = this.prFile(ref);
    await writeFile(`${file}.tmp`, JSON.stringify(prs.sort((a, b) => a.number - b.number)), "utf-8");
    await rename(`${file}.tmp`, file);
  }

  /** Fetch up to `backfillLimit` merged PRs with reviews (GraphQL, 50 per page). */
  async backfill(ref: RepoRef): Promise<number> {
    const out = new Map<number, WorkerPullRequest>();
    let cursor: string | null = null;
    while (out.size < this.backfillLimit) {
      type Page = {
        repository: {
          pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlPr[] };
        };
      };
      const data: Page = await this.gh.graphql<Page>(ref.installationId, BACKFILL_QUERY, {
        owner: ref.owner,
        name: ref.name,
        cursor,
      });
      const page = data.repository.pullRequests;
      for (const node of page.nodes) out.set(node.number, mapPullRequest(node));
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
    const merged = new Map((await this.readPrs(ref)).map((p) => [p.number, p]));
    for (const [n, p] of out) merged.set(n, p);
    await this.writePrs(ref, [...merged.values()]);
    return out.size;
  }

  /** Queue an incremental (re-)analysis with this repo's PR data and an install token for git. */
  async analyse(ref: RepoRef) {
    if (!this.jobs) return null;
    const known = (await this.store.listRepos()).find(
      (r) => r.origin && normUrl(r.origin) === normUrl(ref.htmlUrl),
    );
    return this.jobs.submit(ref.htmlUrl, {
      out: known ? (this.store.outputFor?.(known.id) ?? null) : null,
      extraArgs: ["--pr-data", this.prFile(ref), "--github-installation-id", String(ref.installationId)],
      env: () => this.gh.gitAuthEnv(ref.installationId, this.webUrl),
    });
  }

  private async onMerged(ref: RepoRef, number: number): Promise<string> {
    type One = { repository: { pullRequest: GqlPr | null } };
    const data = await this.gh.graphql<One>(ref.installationId, ONE_PR_QUERY, {
      owner: ref.owner,
      name: ref.name,
      number,
    });
    if (data.repository.pullRequest) {
      const prs = (await this.readPrs(ref)).filter((p) => p.number !== number);
      prs.push(mapPullRequest(data.repository.pullRequest));
      await this.writePrs(ref, prs);
    }
    const job = await this.analyse(ref);
    return `PR #${number} merged: review data stored, re-analysis ${job?.status ?? "skipped"}`;
  }

  // ---- PR guard ---------------------------------------------------------------------------

  private async scoresFor(
    htmlUrl: string,
  ): Promise<{ scores: Map<string, FileRisk> | null; threshold: number; repoId: string | null }> {
    const repo = (await this.store.listRepos()).find(
      (r) => r.origin && normUrl(r.origin) === normUrl(htmlUrl),
    );
    if (!repo) return { scores: null, threshold: 60, repoId: null };
    const data = await this.store.load(repo.id);
    if (!data) return { scores: null, threshold: 60, repoId: null };
    const settings = effectiveSettings(data.config, await this.store.getSettings(repo.id));
    const scores = new Map<string, FileRisk>(
      data.fileScores.map((f) => [
        f.path,
        { risk: f.risk ?? 0, comprehension: f.comprehension ?? 0, explanation: f.explanation },
      ]),
    );
    return { scores, threshold: settings.riskThreshold ?? 60, repoId: repo.id };
  }

  async evaluatePr(ref: RepoRef, number: number): Promise<string> {
    const { installationId: inst, owner, name } = ref;
    const base = `/repos/${owner}/${name}`;
    const pr = await this.gh.request<{
      state: string;
      body: string | null;
      user: { login: string };
      head: { sha: string };
      html_url: string;
    }>(inst, "GET", `${base}/pulls/${number}`);
    if (pr.state !== "open") return `PR #${number} not open`;
    const [files, reviews, { scores, threshold, repoId }] = await Promise.all([
      this.gh.paginate<{ filename: string; previous_filename?: string }>(
        inst,
        `${base}/pulls/${number}/files`,
      ),
      this.gh.paginate<{
        user: { login: string; type: string } | null;
        state: string;
        body: string | null;
        submitted_at: string | null;
      }>(inst, `${base}/pulls/${number}/reviews`),
      this.scoresFor(ref.htmlUrl),
    ]);
    const publicUrl = this.opts.publicUrl?.replace(/\/$/, "");
    const result = evaluate({
      prAuthor: pr.user.login,
      prBody: pr.body ?? "",
      files: files.flatMap((f) => [f.filename, ...(f.previous_filename ? [f.previous_filename] : [])]),
      scores,
      threshold,
      minSentences: this.minSentences,
      reviews: reviews.map((r) => ({
        login: r.user?.login ?? "ghost",
        isBot: r.user?.type === "Bot",
        state: r.state,
        body: r.body ?? "",
        submittedAt: r.submitted_at,
      })),
      dashboardUrl:
        publicUrl && repoId
          ? (p) => `${publicUrl}/#/file?${new URLSearchParams({ repo: repoId, path: p }).toString()}`
          : undefined,
    });
    await this.upsertCheck(
      ref,
      pr.head.sha,
      result,
      publicUrl && repoId ? `${publicUrl}/#/overview?repo=${repoId}` : pr.html_url,
    );
    await this.upsertComment(ref, number, result, pr.user.login);
    return `PR #${number}: ${result.state} (${result.risky.length} high-risk file(s))`;
  }

  private async upsertCheck(ref: RepoRef, sha: string, result: GuardResult, detailsUrl: string) {
    const base = `/repos/${ref.owner}/${ref.name}`;
    const existing = await this.gh.request<{ check_runs: { id: number; app: { id: number } | null }[] }>(
      ref.installationId,
      "GET",
      `${base}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=latest`,
    );
    const mine = existing.check_runs.find((c) => String(c.app?.id) === String(this.gh.config.appId));
    const body = {
      name: CHECK_NAME,
      status: "completed",
      conclusion: result.conclusion,
      completed_at: new Date().toISOString(),
      details_url: detailsUrl,
      output: { title: result.title, summary: result.summary },
    };
    if (mine) await this.gh.request(ref.installationId, "PATCH", `${base}/check-runs/${mine.id}`, body);
    else await this.gh.request(ref.installationId, "POST", `${base}/check-runs`, { ...body, head_sha: sha });
  }

  /** Exactly one Unblur comment per PR: created when action is first required, then edited in place. */
  private async upsertComment(ref: RepoRef, number: number, result: GuardResult, author: string) {
    if (result.state !== "action_required" && result.state !== "passed") return;
    const base = `/repos/${ref.owner}/${ref.name}`;
    const comments = await this.gh.paginate<{ id: number; body: string; user: { type: string } | null }>(
      ref.installationId,
      `${base}/issues/${number}/comments`,
    );
    const mine = comments.find((c) => c.user?.type === "Bot" && c.body.includes(COMMENT_MARKER));
    const body = commentBody(result, author);
    if (mine) {
      if (mine.body !== body)
        await this.gh.request(ref.installationId, "PATCH", `${base}/issues/comments/${mine.id}`, { body });
    } else if (result.state === "action_required") {
      await this.gh.request(ref.installationId, "POST", `${base}/issues/${number}/comments`, { body });
    }
  }
}
