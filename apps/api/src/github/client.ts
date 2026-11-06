/**
 * Minimal GitHub App client: App JWT (RS256 via node:crypto), cached installation tokens,
 * REST with pagination, and GraphQL. No SDK dependency. `apiUrl` is overridable for GitHub
 * Enterprise Server and for tests (a fake GitHub server).
 */
import { createHmac, sign, timingSafeEqual } from "node:crypto";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string; // PEM
  webhookSecret: string;
  apiUrl?: string; // default https://api.github.com
  graphqlUrl?: string; // default <apiUrl>/graphql
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Verify X-Hub-Signature-256 over the raw request body (constant-time). */
export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header?.startsWith("sha256=") || !secret) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export class GitHubClient {
  readonly apiUrl: string;
  private readonly graphqlUrl: string;
  private tokens = new Map<number, { token: string; expiresAt: number }>();

  constructor(
    readonly config: GitHubAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.apiUrl = (config.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.graphqlUrl = config.graphqlUrl ?? `${this.apiUrl}/graphql`;
  }

  /** Short-lived JWT identifying the App itself (10 min max; backdated 60 s for clock skew). */
  appJwt(nowSec = Math.floor(Date.now() / 1000)): string {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: this.config.appId }),
    );
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), this.config.privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const res = await this.raw("POST", `/app/installations/${installationId}/access_tokens`, undefined, {
      authorization: `Bearer ${this.appJwt()}`,
    });
    const body = (await res.json()) as { token: string; expires_at: string };
    this.tokens.set(installationId, { token: body.token, expiresAt: new Date(body.expires_at).getTime() });
    return body.token;
  }

  private async raw(method: string, pathOrUrl: string, body: unknown, headers: Record<string, string>) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiUrl}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "grasp-comprehension-radar",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return res;
      if (res.status >= 500 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new GitHubError(
        res.status,
        `GitHub ${method} ${pathOrUrl} failed: ${res.status} ${text.slice(0, 200)}`,
      );
    }
  }

  async request<T>(installationId: number, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.installationToken(installationId);
    const res = await this.raw(method, path, body, { authorization: `token ${token}` });
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** GET every page of a list endpoint (follows `Link: rel="next"`), up to `max` items. */
  async paginate<T>(
    installationId: number,
    path: string,
    max = 3000,
    pick?: (body: unknown) => T[],
  ): Promise<T[]> {
    const token = await this.installationToken(installationId);
    const out: T[] = [];
    let next: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (next && out.length < max) {
      const res = await this.raw("GET", next, undefined, { authorization: `token ${token}` });
      const body: unknown = await res.json();
      out.push(...(pick ? pick(body) : (body as T[])));
      const link = res.headers.get("link") ?? "";
      next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
    }
    return out.slice(0, max);
  }

  async graphql<T>(installationId: number, query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.installationToken(installationId);
    const res = await this.raw(
      "POST",
      this.graphqlUrl,
      { query, variables },
      { authorization: `bearer ${token}` },
    );
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length)
      throw new GitHubError(200, `GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data as T;
  }

  /**
   * Git config for an authenticated clone/fetch, passed to the worker through the environment
   * (GIT_CONFIG_*), so the token never lands in .git/config, argv or logs.
   */
  async gitAuthEnv(installationId: number, webBase: string): Promise<Record<string, string>> {
    const token = await this.installationToken(installationId);
    const origin = new URL(webBase).origin;
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    };
  }
}
