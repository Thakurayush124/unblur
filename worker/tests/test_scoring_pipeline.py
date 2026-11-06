"""End-to-end Phase 2 scoring on fixture repos."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from grasp.config import GraspConfig
from grasp.models import AnalysisResult, FileScore, PullRequest, Review
from grasp.pipeline import analyze
from tests.conftest import AS_OF
from tests.fixture_repo import CLAUDE, FixtureRepo, build_demo_repo, lines

ALICE = ("Alice Human", "alice@example.com")
BOB = ("Bob Gone", "bob@example.com")
CAROL = ("Carol Here", "carol@example.com")


def _f(res: AnalysisResult, path: str) -> FileScore:
    return next(f for f in res.file_scores if f.path == path)


def test_departed_toucher_and_explanation(repo: FixtureRepo) -> None:
    repo.commit(
        f"ai\n\n{CLAUDE}",
        {"src/payment/charge.py": lines("ai", 82)},
        author=CAROL,
        date="2026-01-01T00:00:00+00:00",
    )
    repo.commit(
        "tweak",
        {"src/payment/charge.py": lines("ai", 82) + lines("h", 18)},
        author=BOB,
        date="2026-06-01T00:00:00+00:00",
    )
    repo.commit("other", {"README.md": "x\n"}, author=CAROL, date="2026-10-30T00:00:00+00:00")
    f = _f(analyze(repo.path, as_of=AS_OF), "src/payment/charge.py")
    assert f.ai_line_share == 0.82
    assert [t.contributor_id for t in f.touchers] and f.retention == 0.0
    assert f.human_touch == pytest.approx(1 - 2.718281828 ** -(0.5 ** (153 / 120)), abs=1e-3)
    assert f.review_depth == 0.5 and f.verified == 0.0
    # 0.3*0.18 + 0.2*0.5 + 0 + 0 = 0.154
    assert f.comprehension == 15.4
    assert f.criticality == 0.9 and f.risk == pytest.approx(0.9 * 84.6)
    assert f.explanation == (
        "Critical (path matches 'payment'): 82% AI-written, and the only human who has touched it "
        "since left 5 months ago."
    )
    assert f.signals and f.signals.contributions == {"a": 5.4, "r": 10.0, "hk": 0.0, "e": 0.0}


def test_active_touchers_raise_comprehension(repo: FixtureRepo) -> None:
    repo.commit(
        f"ai\n\n{CLAUDE}",
        {"src/x/a.py": lines("ai", 50), "src/x/b.py": lines("ai", 50)},
        author=CAROL,
        date="2026-01-01T00:00:00+00:00",
    )
    repo.commit(
        "human edit",
        {"src/x/b.py": lines("ai", 40) + lines("h", 10)},
        author=ALICE,
        date="2026-10-25T00:00:00+00:00",
    )
    res = analyze(repo.path, as_of=AS_OF)
    a, b = _f(res, "src/x/a.py"), _f(res, "src/x/b.py")
    assert a.human_touch == 0.0 and b.human_touch > 0.6 and b.retention == 1.0
    assert b.comprehension is not None and a.comprehension is not None
    assert b.comprehension > a.comprehension + 15
    assert "only one human, still active, has touched it since" in b.explanation


def test_pr_data_enables_review_signal(repo: FixtureRepo) -> None:
    sha = repo.commit(
        f"Big AI feature (#5)\n\n{CLAUDE}",
        {"src/api/big.py": lines("ai", 400)},
        author=CAROL,
        date="2026-10-01T00:00:00+00:00",
    )
    repo.commit(
        "Small fix (#6)", {"src/api/small.py": lines("h", 20)}, author=CAROL, date="2026-10-02T00:00:00+00:00"
    )
    opened = AS_OF - timedelta(days=40)
    prs = [
        PullRequest(
            repo_id="r",
            number=5,
            author_id="carol",
            opened_at=opened,
            additions=400,
            labels=["ai-generated"],
            commit_shas=[sha],
            reviews=[Review(reviewer_id="alice", state="APPROVED", submitted_at=opened)],
        ),
        PullRequest(
            repo_id="r",
            number=6,
            author_id="carol",
            opened_at=opened,
            additions=20,
            time_to_first_review_mins=30,
            reviews=[Review(reviewer_id="alice", state="APPROVED", submitted_at=opened, comment_count=2)],
        ),
    ]
    res = analyze(repo.path, as_of=AS_OF, pull_requests=prs)
    big, small = _f(res, "src/api/big.py"), _f(res, "src/api/small.py")
    assert big.review_depth == 0.1
    assert "merged with a 0-comment approval on a 400-line diff" in big.explanation
    assert big.signals and big.signals.review_data_available
    assert any("labelled 'ai-generated'" in e for e in big.ai_sources[0].evidence)
    assert small.review_depth == 1.0
    # PR data is retained for incremental re-runs without passing it again
    again = analyze(repo.path, as_of=AS_OF, previous=res)
    assert _f(again, "src/api/big.py").review_depth == 0.1


def test_modules_snapshot_and_fan_in(repo: FixtureRepo) -> None:
    repo.commit(
        "base",
        {
            "src/core/util.py": lines("u", 100),
            "src/feat/a.py": "from src.core.util import x\n" + lines("a", 9),
            "src/feat/b.py": "from src.core import util\n" + lines("b", 9),
        },
        author=ALICE,
        date="2026-10-20T00:00:00+00:00",
    )
    res = analyze(repo.path, as_of=AS_OF)
    util = _f(res, "src/core/util.py")
    assert util.criticality_reasons[0].startswith("imported by 2 files")
    mods = {m.module: m for m in res.module_scores}
    assert set(mods) == {"src/core", "src/feat"}
    assert mods["src/feat"].loc == 20 and mods["src/feat"].active_knowledge_holders == 1
    snap = res.snapshots[-1]
    total = sum(f.loc for f in res.file_scores)
    expect = sum((f.comprehension or 0) * f.loc for f in res.file_scores) / total
    assert snap.repo_comprehension == pytest.approx(expect, abs=0.01)
    assert snap.head_sha == res.repo.last_analyzed_sha


def test_weights_from_config_change_scores(tmp_path: Path) -> None:
    r = build_demo_repo(tmp_path / "demo")
    base = analyze(r.path, as_of=AS_OF)
    heavy_a = analyze(
        r.path, GraspConfig.model_validate({"weights": {"wA": 1, "wR": 0, "wH": 0, "wE": 0}}), as_of=AS_OF
    )
    f0, f1 = _f(base, "src/auth/tokens.py"), _f(heavy_a, "src/auth/tokens.py")
    assert f1.comprehension == 0.0 and f0.comprehension == 10.0  # only R=0.5 * 0.2


def test_llm_criticality_wired_with_fake_client(tmp_path: Path) -> None:
    r = build_demo_repo(tmp_path / "demo")
    calls: list[str] = []

    class Fake:
        provider, model = "fake", "f"

        def complete(self, prompt: str, max_tokens: int = 1024) -> str:
            calls.append(prompt)
            return '{"criticality": 1.0, "reason": "core request loop"}'

    cfg = GraspConfig(llm_criticality=True, llm_max_files=2)
    off = analyze(r.path, cfg, as_of=AS_OF, env={}, llm_client_factory=Fake)
    assert calls == [] and off.llm_audit == []
    on = analyze(r.path, cfg, as_of=AS_OF, env={"GRASP_ALLOW_LLM_CODE": "true"}, llm_client_factory=Fake)
    assert len(calls) == 2 and len(on.llm_audit) == 2
    bumped = [f for f in on.file_scores if f.criticality == 1.0]
    assert len(bumped) == 2 and bumped[0].criticality_reasons[0] == "LLM: core request loop"


def test_scores_deterministic(tmp_path: Path) -> None:
    r = build_demo_repo(tmp_path / "demo")
    a = analyze(r.path, as_of=AS_OF).model_dump(exclude={"stats"})
    b = analyze(r.path, as_of=AS_OF).model_dump(exclude={"stats"})
    assert a == b


def test_cli_pr_data_and_summary(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import json

    import cli

    r = build_demo_repo(tmp_path / "demo")
    prs = tmp_path / "prs.json"
    prs.write_text(
        json.dumps(
            [
                {
                    "repoId": "r",
                    "number": 42,
                    "authorId": "bob",
                    "openedAt": "2025-05-19T10:00:00Z",
                    "additions": 300,
                    "reviews": [
                        {"reviewerId": "alice", "state": "APPROVED", "submittedAt": "2025-05-20T14:58:00Z"}
                    ],
                }
            ]
        )
    )
    out = tmp_path / "out.json"
    argv = ["analyze", str(r.path), "--json", str(out), "--pr-data", str(prs), "--as-of", AS_OF.isoformat()]
    assert cli.main(argv) == 0
    text = capsys.readouterr().out
    assert "repo comprehension" in text and "riskiest files" in text
    data = json.loads(out.read_text(encoding="utf-8"))
    billing = next(f for f in data["fileScores"] if f["path"] == "src/billing/proration.py")
    assert billing["signals"]["reviewDataAvailable"] is True
    assert "0-comment approval" in billing["explanation"]


def test_cli_github_mode_with_squash_merge_pr_data(tmp_path: Path) -> None:
    """PR data as the API's GitHub backfill writes it: logins as ids, squash merge commit sha."""
    import json

    import cli

    r = FixtureRepo(tmp_path / "gh")
    sha = r.commit(
        f"Add auth (#7)\n\n{CLAUDE}",
        {"src/auth/login.py": lines("ai", 300)},
        author=CAROL,
        date="2026-10-01T00:00:00+00:00",
    )
    prs = tmp_path / "prs.json"
    prs.write_text(
        json.dumps(
            [
                {
                    "repoId": "",
                    "number": 7,
                    "authorId": "carol",
                    "openedAt": "2026-09-30T10:00:00Z",
                    "mergedAt": "2026-10-01T00:00:00Z",
                    "additions": 300,
                    "deletions": 0,
                    "labels": [],
                    "commitShas": ["0" * 40, sha],
                    "timeToFirstReviewMins": 3,
                    "reviews": [
                        {
                            "reviewerId": "alice",
                            "state": "APPROVED",
                            "submittedAt": "2026-09-30T10:03:00Z",
                            "commentCount": 0,
                            "bodyLength": 0,
                        }
                    ],
                }
            ]
        ),
        encoding="utf-8",
    )
    out = tmp_path / "out.json"
    argv = [
        "analyze",
        str(r.path),
        "--json",
        str(out),
        "--pr-data",
        str(prs),
        "--github-installation-id",
        "42",
        "--as-of",
        AS_OF.isoformat(),
    ]
    assert cli.main(argv) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["repo"]["source"] == "github" and data["repo"]["githubInstallationId"] == 42
    f = next(f for f in data["fileScores"] if f["path"] == "src/auth/login.py")
    assert f["reviewDepth"] == 0.1 and "0-comment approval" in f["explanation"]
    # a missing PR file (first run before backfill finishes) is not an error
    assert cli.main([*argv[:5], str(tmp_path / "nope.json"), *argv[6:]]) == 0
