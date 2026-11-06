import { describe, expect, it } from "vitest";

import {
  commentBody,
  COMMENT_MARKER,
  countSentences,
  evaluate,
  verifiedBy,
  whySection,
  type GuardInput,
  type PrReview,
} from "../src/github/guard.js";

const WHY = `## Why this works

Tokens are refreshed only when the stored expiry is in the past. The refresh call is idempotent, so a retry cannot issue two tokens. Sessions keep the old token until the new one is persisted, which preserves the logged-in invariant.`;

const scores = new Map([
  [
    "src/auth/tokens.py",
    { risk: 80, comprehension: 11, explanation: "100% AI-written, merged with a 0-comment approval." },
  ],
  ["src/ui/button.ts", { risk: 5, comprehension: 94, explanation: "Human-written." }],
]);

const review = (
  login: string,
  state: string,
  body = "",
  at = "2026-11-01T10:00:00Z",
  isBot = false,
): PrReview => ({
  login,
  state,
  body,
  submittedAt: at,
  isBot,
});

function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    prAuthor: "carol",
    prBody: "",
    files: ["src/auth/tokens.py"],
    scores,
    threshold: 60,
    minSentences: 3,
    reviews: [],
    ...over,
  };
}

describe("why-this-works section", () => {
  it("finds the section at any heading level and stops at the next heading", () => {
    const body = `Intro\n\n### Why this works:\nIt relies on X. It keeps Y stable. Z would break it.\n\n## Testing\nran it`;
    expect(whySection(body)).toBe("It relies on X. It keeps Y stable. Z would break it.");
    expect(whySection("## Why it works\nnope")).toBeNull();
    expect(whySection("")).toBeNull();
  });

  it("ignores template HTML comments and counts real sentences", () => {
    expect(whySection("## Why this works\n<!-- 3-5 sentences: explain the invariants. -->\n")).toBe("");
    expect(countSentences("It relies on X. It keeps Y stable. Z would break it.")).toBe(3);
    expect(countSentences("TODO.")).toBe(0);
    expect(countSentences("- uses the cache key\n- keeps ordering stable\n- retries are safe")).toBe(3);
  });
});

describe("verified reviewer", () => {
  it("needs an approval containing /grasp verified from someone other than the author", () => {
    expect(verifiedBy([review("carol", "APPROVED", "/grasp verified")], "carol")).toBeNull();
    expect(verifiedBy([review("alice", "APPROVED", "LGTM")], "carol")).toBeNull();
    expect(verifiedBy([review("alice", "COMMENTED", "/grasp verified")], "carol")).toBeNull();
    expect(verifiedBy([review("alice", "APPROVED", "Read it twice. /GRASP VERIFIED")], "carol")).toBe(
      "alice",
    );
    expect(verifiedBy([review("bot", "APPROVED", "/grasp verified", undefined, true)], "carol")).toBeNull();
  });

  it("is withdrawn by a later change request or dismissal, not by a later comment", () => {
    const ok = review("alice", "APPROVED", "/grasp verified", "2026-11-01T10:00:00Z");
    expect(
      verifiedBy([ok, review("alice", "CHANGES_REQUESTED", "wait", "2026-11-01T11:00:00Z")], "carol"),
    ).toBeNull();
    expect(verifiedBy([ok, review("alice", "DISMISSED", "", "2026-11-01T11:00:00Z")], "carol")).toBeNull();
    expect(verifiedBy([ok, review("alice", "COMMENTED", "nit", "2026-11-01T11:00:00Z")], "carol")).toBe(
      "alice",
    );
    // re-approval without the phrase keeps the earlier verification
    expect(verifiedBy([ok, review("alice", "APPROVED", "still good", "2026-11-01T12:00:00Z")], "carol")).toBe(
      "alice",
    );
  });
});

describe("evaluate", () => {
  it("never blocks PRs that touch only low-risk or brand-new files", () => {
    for (const files of [["src/ui/button.ts"], ["src/new_file.py"], []]) {
      const r = evaluate(input({ files }));
      expect(r.state).toBe("low_risk");
      expect(r.conclusion).toBe("success");
    }
  });

  it("is neutral (not blocking) before the repo is analysed", () => {
    const r = evaluate(input({ scores: null }));
    expect([r.state, r.conclusion]).toEqual(["not_analysed", "neutral"]);
  });

  it("requires the section AND a verified review for high-risk files", () => {
    const blocked = evaluate(input({ files: ["src/ui/button.ts", "src/auth/tokens.py"] }));
    expect([blocked.state, blocked.conclusion]).toEqual(["action_required", "action_required"]);
    expect(blocked.risky.map((f) => f.path)).toEqual(["src/auth/tokens.py"]);
    expect(blocked.summary).toContain("Status: missing");

    const onlyWhy = evaluate(input({ prBody: WHY }));
    expect(onlyWhy.state).toBe("action_required");
    expect(onlyWhy.why).toEqual({ present: true, sentences: 3, ok: true });

    const onlyReview = evaluate(input({ reviews: [review("alice", "APPROVED", "/grasp verified")] }));
    expect(onlyReview.state).toBe("action_required");

    const shortWhy = evaluate(
      input({
        prBody: "## Why this works\nIt works for every caller.",
        reviews: [review("alice", "APPROVED", "/grasp verified")],
      }),
    );
    expect(shortWhy.state).toBe("action_required");
    expect(shortWhy.summary).toContain("only 1 sentence (need 3+)");

    const ok = evaluate(input({ prBody: WHY, reviews: [review("alice", "APPROVED", "/grasp verified")] }));
    expect([ok.state, ok.conclusion, ok.verifiedBy]).toEqual(["passed", "success", "alice"]);
  });

  it("treats a renamed high-risk file as high-risk (previous name)", () => {
    const r = evaluate(input({ files: ["src/auth/token_store.py", "src/auth/tokens.py"] }));
    expect(r.risky.map((f) => f.path)).toEqual(["src/auth/tokens.py"]);
  });

  it("respects the configured threshold", () => {
    expect(evaluate(input({ threshold: 90 })).state).toBe("low_risk");
  });

  it("renders a single comment with the marker and links", () => {
    const r = evaluate(input({ dashboardUrl: (p) => `http://grasp.local/#/file?path=${p}` }));
    const body = commentBody(r, "carol");
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("@carol");
    expect(body).toContain("[`src/auth/tokens.py`](http://grasp.local/#/file?path=src/auth/tokens.py)");
    expect(body).toContain("`## Why this works`");
  });
});
