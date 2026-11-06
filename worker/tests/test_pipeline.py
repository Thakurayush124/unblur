from __future__ import annotations

import json
from pathlib import Path

import pytest

from grasp.config import GraspConfig
from grasp.ingest import blame as blame_mod
from grasp.ingest.files import IgnoreMatcher, module_for
from grasp.models import AnalysisResult, FileScore
from grasp.pipeline import analyze
from tests.conftest import AS_OF
from tests.fixture_repo import CLAUDE, FixtureRepo, build_demo_repo, lines


def _file(result: AnalysisResult, path: str) -> FileScore:
    return next(f for f in result.file_scores if f.path == path)


def test_ai_line_share_exact(repo: FixtureRepo) -> None:
    repo.commit("human base", {"src/a/x.py": lines("h", 63)})
    repo.commit(f"ai append\n\n{CLAUDE}", {"src/a/x.py": lines("h", 63) + lines("ai", 37)})
    f = _file(analyze(repo.path, as_of=AS_OF), "src/a/x.py")
    assert f.loc == 100
    assert f.ai_lines == 37
    assert f.ai_line_share == pytest.approx(0.37, abs=0.01)
    assert f.ai_sources[0].lines == 37
    assert f.ai_sources[0].evidence[0].startswith("trailer: Co-Authored-By: Claude")


def test_ai_rewrite_in_middle_and_human_edit_over_ai(repo: FixtureRepo) -> None:
    base = lines("h", 50)
    repo.commit("base", {"m.py": base})
    rewritten = lines("h", 10) + lines("ai", 20) + lines("h", 20, start=30)
    repo.commit(f"ai rewrite\n\n{CLAUDE}", {"m.py": rewritten})
    # human rewrites 5 of the AI lines -> those are no longer AI-owned
    human_fix = lines("h", 10) + lines("fix", 5) + lines("ai", 15, start=5) + lines("h", 20, start=30)
    repo.commit("human fix", {"m.py": human_fix}, author=("Bob B", "bob@example.com"))
    f = _file(analyze(repo.path, as_of=AS_OF), "m.py")
    assert (f.loc, f.ai_lines) == (50, 15)
    assert f.ai_line_share == 0.3


def test_since_window_still_counts_old_ai_lines(repo: FixtureRepo) -> None:
    repo.commit(f"old ai\n\n{CLAUDE}", {"a.py": lines("ai", 40)}, date="2023-01-01T00:00:00+00:00")
    repo.commit("recent human", {"a.py": lines("ai", 40) + lines("h", 60)}, date="2026-10-01T00:00:00+00:00")
    res = analyze(repo.path, as_of=AS_OF, since_days=90)
    assert _file(res, "a.py").ai_line_share == 0.4
    assert {c.sha for c in res.commits} and len(res.commits) == 2  # old one fetched via blame


def test_ignored_and_binary_files(repo: FixtureRepo) -> None:
    repo.write_bytes("logo.png", b"\x89PNG\r\n\x1a\n\x00\x00binary")
    repo.commit(
        "stuff",
        {
            "src/ok.py": lines("x", 5),
            "node_modules/lib/index.js": lines("x", 5),
            "web/dist/bundle.js": lines("x", 5),
            "web/app.min.js": lines("x", 5),
            "package-lock.json": lines("x", 5),
            "gen/api.ts": lines("x", 5),
            ".gitattributes": "gen/** linguist-generated=true\n",
        },
    )
    res = analyze(repo.path, as_of=AS_OF)
    assert sorted(f.path for f in res.file_scores) == [".gitattributes", "src/ok.py"]
    assert res.stats.files_ignored == 6


def test_custom_ignore_globs(repo: FixtureRepo) -> None:
    repo.commit("x", {"src/a.py": lines("a", 3), "docs/guide/x.md": lines("b", 3)})
    cfg = GraspConfig(ignore_globs=["docs/**"])
    assert [f.path for f in analyze(repo.path, cfg, as_of=AS_OF).file_scores] == ["src/a.py"]


def test_ignore_matcher_and_modules() -> None:
    m = IgnoreMatcher(["node_modules/", "*.min.js", "docs/**"])
    assert m("a/node_modules/b.js") and m("x/y.min.js") and m("docs/a/b.md")
    assert not m("src/node_modules_util.js") and not m("src/docs/a.md")
    nested = IgnoreMatcher(["src/gen/"])
    assert nested("src/gen/a.ts") and nested("src/gen/x/b.ts") and not nested("lib/src/gen/a.ts")
    assert module_for("src/auth/session.py", ["src"]) == "src/auth"
    assert module_for("src/main.py", ["src"]) == "src"
    assert module_for("lib/x/y.py", ["src"]) == "lib"
    assert module_for("setup.py", ["src"]) == "(root)"
    assert module_for("packages/api/src/a.ts", ["packages"]) == "packages/api"


def test_contributors_merge_and_activity(repo: FixtureRepo) -> None:
    repo.commit("a", {"a.py": "1\n"}, author=("Dana Dev", "dana@work.com"), date="2025-01-01T00:00:00+00:00")
    repo.commit("b", {"b.py": "1\n"}, author=("Dana Dev", "dana@home.org"), date="2026-10-15T00:00:00+00:00")
    repo.commit("c", {"c.py": "1\n"}, author=("Eve Gone", "eve@work.com"), date="2026-01-01T00:00:00+00:00")
    repo.commit(
        "d",
        {"d.py": "1\n"},
        author=("ellie", "123+ellie@users.noreply.github.com"),
        date="2026-10-30T00:00:00+00:00",
    )
    res = analyze(repo.path, as_of=AS_OF)
    by_name = {c.canonical_name: c for c in res.contributors}
    assert set(by_name) == {"Dana Dev", "Eve Gone", "ellie"}
    assert by_name["Dana Dev"].emails == ["dana@home.org", "dana@work.com"]
    assert by_name["Dana Dev"].active and not by_name["Eve Gone"].active
    assert by_name["ellie"].github_login == "ellie"


def test_owners_and_explanation(tmp_path: Path) -> None:
    r = build_demo_repo(tmp_path / "demo")
    res = analyze(r.path, as_of=AS_OF)
    tokens = _file(res, "src/auth/tokens.py")
    assert tokens.ai_line_share == 1.0
    bob = next(c for c in res.contributors if c.canonical_name == "Bob Departed")
    assert not bob.active
    assert tokens.top_owners[0].contributor_id == bob.id
    assert tokens.explanation == (
        "Critical (path matches 'auth'): 100% AI-written, and no human has touched it since."
    )
    pr = _file(res, "src/billing/proration.py")
    assert pr.ai_line_share == pytest.approx(280 / 300, abs=1e-4)
    assert any("Generated with" in e for e in pr.ai_sources[0].evidence)
    assert "package-lock.json" not in {f.path for f in res.file_scores}
    assert next(c for c in res.commits if c.message.startswith("Billing")).pr_number == 42


def test_deterministic_across_runs(tmp_path: Path) -> None:
    r = build_demo_repo(tmp_path / "demo")
    a = analyze(r.path, as_of=AS_OF).model_dump(by_alias=True, exclude={"stats"})
    b = analyze(r.path, as_of=AS_OF).model_dump(by_alias=True, exclude={"stats"})
    assert a == b


def test_incremental_reblames_only_changed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    r = build_demo_repo(tmp_path / "demo")
    first = analyze(r.path, as_of=AS_OF)
    assert not first.stats.incremental

    calls: list[str] = []
    real = blame_mod.blame_file
    monkeypatch.setattr(blame_mod, "blame_file", lambda *a: calls.append(a[2]) or real(*a))

    # no new commits: nothing re-blamed, identical output
    again = analyze(r.path, as_of=AS_OF, previous=first)
    assert again.stats.incremental and calls == []
    assert again.model_dump(exclude={"stats"}) == first.model_dump(exclude={"stats"})

    r.commit(
        f"ai helper\n\n{CLAUDE}", {"src/core/util.py": lines("ai-util", 30)}, date="2026-10-25T00:00:00+00:00"
    )
    inc = analyze(r.path, as_of=AS_OF, previous=again)
    assert calls == ["src/core/util.py"]
    assert (inc.stats.commits_new, inc.stats.files_reblamed) == (1, 1)
    full = analyze(r.path, as_of=AS_OF)
    skip = {"stats", "snapshots"}
    assert inc.model_dump(exclude=skip) == full.model_dump(exclude=skip)
    # incremental keeps history: one snapshot per analysed HEAD
    assert len(inc.snapshots) == 2 and inc.snapshots[-1] == full.snapshots[-1]


def test_cli_json_roundtrip(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import cli

    r = build_demo_repo(tmp_path / "demo")
    out = tmp_path / "out.json"
    args = ["analyze", str(r.path), "--json", str(out), "--as-of", AS_OF.isoformat()]
    assert cli.main(args) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert {"repo", "contributors", "commits", "fileScores", "blameCache"} <= data.keys()
    assert "aiLineShare" in data["fileScores"][0]
    assert cli.main(args) == 0  # second run reads previous output -> incremental
    assert "incremental" in capsys.readouterr().out


def test_cli_applies_dashboard_overrides(tmp_path: Path) -> None:
    import cli

    r = build_demo_repo(tmp_path / "demo")
    out = tmp_path / "out.json"
    (tmp_path / "out.json.settings.json").write_text(
        json.dumps({"criticalPaths": ["README.md"], "weights": {"wA": 1, "wR": 0, "wH": 0, "wE": 0}}),
        encoding="utf-8",
    )
    assert cli.main(["analyze", str(r.path), "--json", str(out), "--as-of", AS_OF.isoformat()]) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["config"]["criticalPaths"] == ["README.md"]
    readme = next(f for f in data["fileScores"] if f["path"] == "README.md")
    assert readme["criticality"] == 1.0 and readme["comprehension"] == 100.0
