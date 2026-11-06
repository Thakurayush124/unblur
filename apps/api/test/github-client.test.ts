import { createHmac, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { GitHubClient, verifyWebhookSignature } from "../src/github/client.js";
import { mapPullRequest } from "../src/github/integration.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("webhook signatures", () => {
  const body = Buffer.from('{"action":"opened"}');
  const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
  it("accepts the right HMAC and rejects everything else", () => {
    expect(verifyWebhookSignature(body, good, "s3cret")).toBe(true);
    expect(verifyWebhookSignature(body, good, "other")).toBe(false);
    expect(verifyWebhookSignature(Buffer.from("{}"), good, "s3cret")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, "s3cret")).toBe(false);
    expect(verifyWebhookSignature(body, "sha1=abc", "s3cret")).toBe(false);
    expect(verifyWebhookSignature(body, good, "")).toBe(false);
  });
});

describe("GitHubClient", () => {
  it("signs an RS256 App JWT that verifies with the public key", () => {
    const gh = new GitHubClient({ appId: "123", privateKey: pem, webhookSecret: "x" });
    const jwt = gh.appJwt(1_700_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p!, "base64url").toString())).toEqual({
      iat: 1_700_000_000 - 60,
      exp: 1_700_000_000 + 540,
      iss: "123",
    });
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, "base64url"))).toBe(
      true,
    );
  });

  it("caches installation tokens, follows pagination and builds git auth env", async () => {
    const calls: string[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method} ${u}`);
      if (u.endsWith("/access_tokens"))
        return Response.json({ token: "ghs_abc", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (u.includes("page=2")) return Response.json([{ n: 3 }]);
      return Response.json([{ n: 1 }, { n: 2 }], {
        headers: { link: '<https://api.test/items?per_page=100&page=2>; rel="next"' },
      });
    }) as typeof fetch;
    const gh = new GitHubClient(
      { appId: "1", privateKey: pem, webhookSecret: "x", apiUrl: "https://api.test" },
      fake,
    );
    expect(await gh.paginate(9, "/items")).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await gh.paginate(9, "/items");
    expect(calls.filter((c) => c.endsWith("/access_tokens"))).toHaveLength(1);
    const env = await gh.gitAuthEnv(9, "https://github.com");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.split(" ").pop()!, "base64").toString()).toBe(
      "x-access-token:ghs_abc",
    );
  });
});

describe("PR backfill mapping", () => {
  it("maps GraphQL PRs to the worker schema, incl. squash merge sha and first-review time", () => {
    const pr = mapPullRequest({
      number: 7,
      createdAt: "2026-10-01T10:00:00Z",
      mergedAt: "2026-10-02T10:00:00Z",
      additions: 400,
      deletions: 20,
      author: { login: "carol" },
      labels: { nodes: [{ name: "ai-generated" }] },
      mergeCommit: { oid: "m".repeat(40) },
      commits: { nodes: [{ commit: { oid: "a".repeat(40) } }] },
      reviews: {
        nodes: [
          {
            author: { login: "carol" },
            state: "COMMENTED",
            submittedAt: "2026-10-01T10:01:00Z",
            body: "self",
            comments: { totalCount: 0 },
          },
          {
            author: { login: "alice" },
            state: "APPROVED",
            submittedAt: "2026-10-01T10:05:00Z",
            body: "",
            comments: { totalCount: 2 },
          },
          {
            author: { login: "bob" },
            state: "PENDING",
            submittedAt: null,
            body: "",
            comments: { totalCount: 0 },
          },
        ],
      },
    });
    expect(pr).toMatchObject({
      number: 7,
      authorId: "carol",
      labels: ["ai-generated"],
      commitShas: ["a".repeat(40), "m".repeat(40)],
      timeToFirstReviewMins: 5,
    });
    expect(pr.reviews.map((r) => [r.reviewerId, r.state, r.commentCount])).toEqual([
      ["carol", "COMMENTED", 0],
      ["alice", "APPROVED", 2],
    ]);
  });
});
