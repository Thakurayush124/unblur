/**
 * PR comprehension guard (pure logic, no I/O).
 *
 * A PR that modifies any file with risk >= threshold gets an `action_required` check until
 *   1. its description has a `## Why this works` section (>= minSentences sentences), AND
 *   2. a reviewer other than the author approves with a review containing `/unblur verified`.
 * PRs that touch only low-risk files always pass; repos Unblur has not analysed yet are neutral.
 */

export const CHECK_NAME = "Unblur: comprehension check";
export const COMMENT_MARKER = "<!-- unblur:comprehension-check -->";
export const VERIFY_PHRASE = "/unblur verified";

export interface FileRisk {
  risk: number;
  comprehension: number;
  explanation: string;
}

export interface PrReview {
  login: string;
  isBot: boolean;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  body: string;
  submittedAt: string | null;
}

export interface GuardInput {
  prAuthor: string;
  prBody: string;
  files: string[]; // changed paths (new and previous names)
  scores: Map<string, FileRisk> | null; // null = repo not analysed yet
  threshold: number;
  minSentences: number;
  reviews: PrReview[];
  dashboardUrl?: (path: string) => string | null;
}

export type GuardState = "not_analysed" | "low_risk" | "action_required" | "passed";

export interface GuardResult {
  state: GuardState;
  conclusion: "success" | "action_required" | "neutral";
  risky: ({ path: string } & FileRisk)[];
  why: { present: boolean; sentences: number; ok: boolean };
  verifiedBy: string | null;
  title: string;
  summary: string;
}

/** Text of the `Why this works` section (any heading level), HTML comments removed. */
export function whySection(body: string): string | null {
  const text = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s{0,3}(#{1,6})\s*why this works\s*:?\s*#*\s*$/i.test(l));
  if (start < 0) return null;
  const level = /^\s{0,3}(#{1,6})/.exec(lines[start]!)![1]!.length;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const h = /^\s{0,3}(#{1,6})\s/.exec(l);
    if (h && h[1]!.length <= level) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

export function countSentences(text: string): number {
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, "code");
  return prose
    .split(/(?<=[.!?])\s+|\n\s*[-*]\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => /[a-z]{2,}/i.test(s) && s.split(/\s+/).length >= 3).length;
}

/** First non-author human whose latest decisive review is APPROVED and who wrote /unblur verified. */
export function verifiedBy(reviews: PrReview[], prAuthor: string): string | null {
  const byUser = new Map<string, PrReview[]>();
  for (const r of reviews) {
    if (r.isBot || r.login.toLowerCase() === prAuthor.toLowerCase() || r.state === "PENDING") continue;
    byUser.set(r.login, [...(byUser.get(r.login) ?? []), r]);
  }
  for (const [login, rs] of [...byUser].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...rs].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
    const decisive = sorted.filter((r) => r.state !== "COMMENTED");
    const latest = decisive.at(-1);
    const phrase = sorted.some((r) => r.state === "APPROVED" && r.body.toLowerCase().includes(VERIFY_PHRASE));
    if (latest?.state === "APPROVED" && phrase) return login;
  }
  return null;
}

export function evaluate(input: GuardInput): GuardResult {
  const why = whySection(input.prBody);
  const sentences = why ? countSentences(why) : 0;
  const whyState = { present: why !== null, sentences, ok: why !== null && sentences >= input.minSentences };
  const base = { why: whyState, verifiedBy: null as string | null, risky: [] as GuardResult["risky"] };

  if (!input.scores) {
    return {
      ...base,
      state: "not_analysed",
      conclusion: "neutral",
      title: "Not analysed yet",
      summary: "Unblur has not finished analysing this repository yet, so this PR is not checked.",
    };
  }
  const seen = new Set<string>();
  const scores = input.scores;
  const risky: GuardResult["risky"] = [];
  for (const path of input.files) {
    if (seen.has(path)) continue;
    seen.add(path);
    const s = scores.get(path); // new files have no score yet: they are not "high risk"
    if (s && s.risk >= input.threshold) risky.push({ path, ...s });
  }
  risky.sort((a, b) => b.risk - a.risk || a.path.localeCompare(b.path));

  if (risky.length === 0) {
    return {
      ...base,
      state: "low_risk",
      conclusion: "success",
      title: "No high-risk files touched",
      summary: `None of the ${seen.size} changed file(s) has a comprehension risk of ${input.threshold} or more.`,
    };
  }

  const verifier = verifiedBy(input.reviews, input.prAuthor);
  const passed = whyState.ok && verifier !== null;
  const plural = risky.length === 1 ? "file" : "files";
  return {
    ...base,
    risky,
    verifiedBy: verifier,
    state: passed ? "passed" : "action_required",
    conclusion: passed ? "success" : "action_required",
    title: passed
      ? `Comprehension verified by @${verifier}`
      : `${risky.length} high-risk ${plural} need${risky.length === 1 ? "s" : ""} an explanation and a verified review`,
    summary: renderSummary(input, risky, whyState, verifier),
  };
}

function tick(ok: boolean) {
  return ok ? "✅" : "⬜";
}

function renderSummary(
  input: GuardInput,
  risky: GuardResult["risky"],
  why: GuardResult["why"],
  verifier: string | null,
): string {
  const rows = risky.slice(0, 20).map((f) => {
    const link = input.dashboardUrl?.(f.path);
    const name = link ? `[\`${f.path}\`](${link})` : `\`${f.path}\``;
    return `| ${name} | ${f.risk.toFixed(0)} | ${f.comprehension.toFixed(0)} | ${f.explanation.replace(/\|/g, "\\|")} |`;
  });
  const more = risky.length > 20 ? `\n_…and ${risky.length - 20} more._` : "";
  const whyText = why.present
    ? why.ok
      ? `found (${why.sentences} sentences)`
      : `found, but only ${why.sentences} sentence${why.sentences === 1 ? "" : "s"} (need ${input.minSentences}+)`
    : "missing";
  return [
    `This PR changes code that few people on the team currently understand (risk ≥ ${input.threshold}).`,
    "",
    "| File | Risk | Comprehension | Why it's risky |",
    "|---|---:|---:|---|",
    ...rows,
    more,
    "",
    "**To pass this check:**",
    `- ${tick(why.ok)} The author adds a \`## Why this works\` section to the PR description (3–5 sentences: what the change relies on, the invariants it keeps, what would break it). Status: ${whyText}.`,
    `- ${tick(verifier !== null)} A reviewer other than the author approves with a review that contains \`${VERIFY_PHRASE}\`${verifier ? ` (done by @${verifier})` : ""}.`,
  ].join("\n");
}

export function commentBody(result: GuardResult, prAuthor: string): string {
  const head =
    result.state === "passed"
      ? `✅ **Unblur comprehension check passed.** Verified by @${result.verifiedBy}. Thanks for writing down why this works.`
      : `👋 @${prAuthor}, this PR touches **${result.risky.length} high-risk file${result.risky.length === 1 ? "" : "s"}**: code with high criticality that few people on the team currently understand. Please add a \`## Why this works\` section (3–5 sentences) to the PR description so reviewers, and future maintainers, can follow the reasoning.`;
  return `${COMMENT_MARKER}\n${head}\n\n${result.summary}\n\n<sub>Posted by Unblur. This comment is updated in place.</sub>`;
}
