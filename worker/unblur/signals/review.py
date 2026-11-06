"""Signal R: how thoroughly the lines in a file were reviewed (blame-weighted over PRs).

Per PR:
  * no review by anyone other than the author          -> 0.0  ("merged without review")
  * approval(s), zero substantive comments, diff > 200  -> 0.1  ("rubber-stamp")
  * otherwise 0.5 * substantive + 0.5 * time_score, where
      substantive = any review with >= 1 comment or a body > 40 chars
      time_score  = min(1, (review_minutes / max(1, changed_lines / 50)) / 10)
Lines whose commit has no PR (direct pushes) score 0 when PR data exists.
Local mode (no PR data at all): R = 0.5 (neutral) and the UI shows "review data unavailable".
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from unblur.models import PullRequest

NEUTRAL = 0.5
RUBBER_STAMP = 0.1
SUBSTANTIVE_BODY_CHARS = 40
RUBBER_STAMP_MIN_LINES = 200
FULL_CREDIT_NORM_MINUTES = 10.0


@dataclass(frozen=True)
class ReviewResult:
    value: float
    available: bool
    note: str


def _review_minutes(pr: PullRequest) -> float:
    if pr.time_to_first_review_mins is not None:
        return pr.time_to_first_review_mins
    others = [r for r in pr.reviews if r.reviewer_id != pr.author_id]
    if not others:
        return 0.0
    first = min(r.submitted_at for r in others)
    return max(0.0, (first - pr.opened_at).total_seconds() / 60)


def pr_review_score(pr: PullRequest) -> tuple[float, str]:
    changed = pr.additions + pr.deletions
    reviews = [r for r in pr.reviews if r.reviewer_id != pr.author_id and r.state != "PENDING"]
    if not reviews:
        return 0.0, "merged without review"
    comments = sum(r.comment_count for r in reviews)
    substantive = any(r.comment_count >= 1 or r.body_length > SUBSTANTIVE_BODY_CHARS for r in reviews)
    approved = any(r.state == "APPROVED" for r in reviews)
    if approved and not substantive and changed > RUBBER_STAMP_MIN_LINES:
        return RUBBER_STAMP, f"merged with a 0-comment approval on a {changed}-line diff"
    norm = _review_minutes(pr) / max(1.0, changed / 50)
    time_score = min(1.0, norm / FULL_CREDIT_NORM_MINUTES)
    score = 0.5 * (1.0 if substantive else 0.0) + 0.5 * time_score
    if substantive:
        noun = "comment" if comments == 1 else "comments"
        return score, f"reviewed with {comments} {noun}"
    return score, "approved without comments"


def pr_index(prs: list[PullRequest], commit_pr: Mapping[str, int | None]) -> dict[str, PullRequest]:
    """Map commit sha -> PR, using the PR's own commit list first, then message-parsed numbers."""
    by_number = {p.number: p for p in prs}
    out: dict[str, PullRequest] = {}
    for p in prs:
        for sha in p.commit_shas:
            out[sha] = p
    for sha, num in commit_pr.items():
        if sha not in out and num is not None and num in by_number:
            out[sha] = by_number[num]
    return out


def review_depth(
    blame_counts: Mapping[str, int],
    sha_to_pr: Mapping[str, PullRequest],
    have_pr_data: bool,
) -> ReviewResult:
    if not have_pr_data:
        return ReviewResult(NEUTRAL, False, "review data unavailable")
    total = sum(blame_counts.values())
    if not total:
        return ReviewResult(NEUTRAL, True, "")
    weighted = 0.0
    note_lines: dict[str, int] = {}
    for sha, n in blame_counts.items():
        pr = sha_to_pr.get(sha)
        if pr is None:
            score, note = 0.0, "pushed without a PR"
        else:
            score, note = pr_review_score(pr)
        weighted += score * n
        note_lines[note] = note_lines.get(note, 0) + n
    dominant = sorted(note_lines.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    return ReviewResult(weighted / total, True, dominant)
