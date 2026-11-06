from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta

import pytest

from grasp.config import Weights
from grasp.models import LearningTask, PullRequest, Review
from grasp.scoring.score import comprehension, contributions, risk
from grasp.signals.human_touch import FileCommit, decay, human_touch
from grasp.signals.review import pr_index, pr_review_score, review_depth
from grasp.signals.verified import verified

NOW = datetime(2026, 11, 1, tzinfo=UTC)


def _pr(
    number: int = 1, changed: int = 100, reviews: list[Review] | None = None, **kw: object
) -> PullRequest:
    return PullRequest(
        repo_id="r",
        number=number,
        author_id="author",
        opened_at=NOW - timedelta(days=1),
        additions=changed,
        deletions=0,
        reviews=reviews or [],
        **kw,  # type: ignore[arg-type]
    )


def _rev(state: str = "APPROVED", comments: int = 0, body: int = 0, who: str = "rev") -> Review:
    return Review(
        reviewer_id=who,
        state=state,
        submitted_at=NOW,
        comment_count=comments,
        body_length=body,  # type: ignore[arg-type]
    )


# ---- R: review depth ---------------------------------------------------------
class TestReview:
    def test_unreviewed(self) -> None:
        assert pr_review_score(_pr()) == (0.0, "merged without review")

    def test_self_review_ignored(self) -> None:
        assert pr_review_score(_pr(reviews=[_rev(comments=5, who="author")]))[0] == 0.0

    def test_rubber_stamp_on_big_diff(self) -> None:
        score, note = pr_review_score(_pr(changed=500, reviews=[_rev()], time_to_first_review_mins=600))
        assert score == 0.1 and "0-comment approval on a 500-line diff" in note

    def test_silent_approval_small_diff_is_not_rubber_stamp(self) -> None:
        # 100 lines, 10 min -> norm 10/2 = 5 -> time 0.5; not substantive -> 0.25
        score, note = pr_review_score(_pr(changed=100, reviews=[_rev()], time_to_first_review_mins=10))
        assert score == pytest.approx(0.25) and note == "approved without comments"

    def test_substantive_and_time_normalised_by_size(self) -> None:
        # 300 lines -> divisor 6; 60 min -> norm 10 -> full time credit
        pr = _pr(changed=300, reviews=[_rev(comments=3)], time_to_first_review_mins=60)
        assert pr_review_score(pr) == (1.0, "reviewed with 3 comments")
        pr = _pr(changed=300, reviews=[_rev(body=41)], time_to_first_review_mins=30)
        assert pr_review_score(pr)[0] == pytest.approx(0.5 + 0.5 * 0.5)

    def test_body_threshold(self) -> None:
        pr = _pr(changed=500, reviews=[_rev(body=40)], time_to_first_review_mins=0)
        assert pr_review_score(pr)[0] == 0.1  # 40 chars is not substantive

    def test_review_minutes_derived_from_timestamps(self) -> None:
        pr = _pr(changed=50, reviews=[_rev(comments=1)])  # opened 1 day before review
        assert pr_review_score(pr)[0] == 1.0

    def test_blame_weighted_and_direct_push(self) -> None:
        good = _pr(1, changed=50, reviews=[_rev(comments=1)], time_to_first_review_mins=10)
        idx = pr_index([good], {"a": 1, "b": None})
        res = review_depth({"a": 30, "b": 70}, idx, have_pr_data=True)
        assert res.available and res.value == pytest.approx(0.3)
        assert res.note == "pushed without a PR"

    def test_pr_commit_list_takes_precedence(self) -> None:
        pr = _pr(7, commit_shas=["x"])
        assert pr_index([pr], {"x": None})["x"].number == 7

    def test_local_mode_neutral(self) -> None:
        res = review_depth({"a": 10}, {}, have_pr_data=False)
        assert (res.value, res.available, res.note) == (0.5, False, "review data unavailable")


# ---- H and K -----------------------------------------------------------------
def _fc(author: str, days_ago: float, ai: bool = False, sha: str = "s") -> FileCommit:
    return FileCommit(sha, author, NOW - timedelta(days=days_ago), ai)


class TestHumanTouch:
    def test_decay_half_life(self) -> None:
        assert decay(0) == 1.0 and decay(120) == pytest.approx(0.5) and decay(240) == pytest.approx(0.25)

    def test_only_after_ai_landed_and_non_ai(self) -> None:
        landed = NOW - timedelta(days=100)
        commits = [
            _fc("before", 200),  # before AI landed -> ignored
            _fc("ai-user", 50, ai=True),  # AI commit -> ignored
            _fc("bot", 10),  # bot -> ignored
            _fc("carol", 0),
        ]
        res = human_touch(commits, landed, {"bot": True}, {"carol": True}, NOW)
        assert [t.contributor_id for t in res.touchers] == ["carol"]
        assert res.h == pytest.approx(1 - math.exp(-1))
        assert res.k == 1.0

    def test_distinct_contributors_latest_touch(self) -> None:
        commits = [_fc("a", 240), _fc("a", 120), _fc("b", 0)]
        res = human_touch(commits, None, {}, {"b": True}, NOW)
        weights = {t.contributor_id: t.weight for t in res.touchers}
        assert weights == {"a": 0.5, "b": 1.0}
        assert res.h == pytest.approx(1 - math.exp(-1.5))
        assert res.k == pytest.approx(1.0 / 1.5)

    def test_nobody(self) -> None:
        res = human_touch([], NOW - timedelta(days=1), {}, {}, NOW)
        assert (res.h, res.k, res.touchers) == (0.0, 0.0, [])

    def test_departed_only(self) -> None:
        res = human_touch([_fc("gone", 150)], None, {}, {"gone": False}, NOW)
        assert res.h > 0 and res.k == 0.0


# ---- E -----------------------------------------------------------------------
def _task(days_ago: float, verifier: str | None = "v", status: str = "passed") -> LearningTask:
    return LearningTask(
        repo_id="r",
        path="f.py",
        assignee_id="a",
        status=status,  # type: ignore[arg-type]
        verified_by_id=verifier,
        completed_at=NOW - timedelta(days=days_ago),
    )


class TestVerified:
    def test_stub_zero(self) -> None:
        assert verified("f.py", [], NOW) == 0.0

    def test_decay(self) -> None:
        assert verified("f.py", [_task(10)], NOW) == 1.0
        assert verified("f.py", [_task(180)], NOW) == 1.0
        assert verified("f.py", [_task(272.5)], NOW) == pytest.approx(0.5)
        assert verified("f.py", [_task(365)], NOW) == 0.0

    def test_requires_independent_verifier_and_pass(self) -> None:
        assert verified("f.py", [_task(1, verifier=None)], NOW) == 0.0
        assert verified("f.py", [_task(1, verifier="a")], NOW) == 0.0
        assert verified("f.py", [_task(1, status="failed")], NOW) == 0.0
        assert verified("other.py", [_task(1)], NOW) == 0.0


# ---- scoring -------------------------------------------------------------------
class TestScoring:
    def test_formula_defaults(self) -> None:
        w = Weights()
        # A=0.8, R=0.5, H=0.6, K=0.5, E=0 -> 0.3*0.2 + 0.2*0.5 + 0.3*0.3 + 0 = 0.25
        assert comprehension(0.8, 0.5, 0.6, 0.5, 0.0, w) == 25.0
        assert sum(contributions(0.8, 0.5, 0.6, 0.5, 0.0, w).values()) == pytest.approx(25.0)

    def test_bounds_and_clamp(self) -> None:
        w = Weights()
        assert comprehension(1, 0, 0, 0, 0, w) == 0.0
        assert comprehension(0, 1, 1, 1, 1, w) == 100.0
        assert comprehension(0, 1, 1, 1, 1, Weights(w_a=1, w_r=1, w_h=1, w_e=1)) == 100.0

    def test_custom_weights(self) -> None:
        assert comprehension(0.0, 0, 0, 0, 0, Weights(w_a=0.5, w_r=0, w_h=0, w_e=0)) == 50.0

    def test_risk(self) -> None:
        assert risk(0.9, 20.0) == 72.0
        assert risk(0.0, 0.0) == 0.0
        assert risk(1.5, 0.0) == 100.0
