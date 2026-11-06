from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from grasp.ingest import source
from grasp.ingest.source import ensure_clone, is_remote, slug_for, validate_remote
from tests.fixture_repo import CLAUDE, FixtureRepo, lines


@pytest.mark.parametrize(
    "url",
    [
        "https://github.com/pallets/click",
        "https://github.com/pallets/click.git",
        "https://gitlab.com/group/sub/project.git",
        "ssh://git@github.com/owner/repo.git",
        "git@github.com:owner/repo.git",
        "git://example.org/repo",
    ],
)
def test_remote_urls_accepted(url: str) -> None:
    assert is_remote(url) and validate_remote(url) == url


@pytest.mark.parametrize(
    "bad",
    [
        "-oProxyCommand=evil",
        "ext::sh -c touch% /tmp/pwned",
        "file:///etc/passwd",
        "https://github.com/a/b; rm -rf /",
        "/home/me/repo",
        "C:/code/repo",
        "",
    ],
)
def test_unsafe_or_local_rejected(bad: str) -> None:
    with pytest.raises(ValueError):
        validate_remote(bad)


def test_display_names() -> None:
    from grasp.ingest.source import display_name

    assert display_name("https://github.com/pallets/click.git") == "pallets/click"
    assert display_name("git@github.com:owner/repo") == "owner/repo"


def test_slugs() -> None:
    assert slug_for("https://github.com/pallets/click.git") == "pallets-click"
    assert slug_for("git@github.com:owner/my.repo.git") == "owner-my.repo"
    assert slug_for("https://gitlab.com/group/sub/project") == "sub-project"
    local = slug_for("/tmp/some dir/My Repo")
    assert local.startswith("My-Repo-") and len(local) == len("My-Repo-") + 6
    assert slug_for("/tmp/a/x") != slug_for("/tmp/b/x")  # same name, different path


def test_clone_then_fetch_updates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Use a local "remote" (validate_remote normally refuses local paths, by design).
    monkeypatch.setattr(source, "validate_remote", lambda u: u)
    monkeypatch.setattr(source, "slug_for", lambda u: "upstream")
    up = FixtureRepo(tmp_path / "upstream")
    up.commit("one", {"a.py": lines("h", 10)})
    msgs: list[str] = []
    dest = ensure_clone(str(up.path), tmp_path / "work", msgs.append)
    assert (dest / "a.py").is_file() and msgs[0].startswith("Cloning")

    up.commit(f"two\n\n{CLAUDE}", {"b.py": lines("ai", 5)})
    dest2 = ensure_clone(str(up.path), tmp_path / "work", msgs.append)
    assert dest2 == dest and (dest / "b.py").is_file() and msgs[-1].startswith("Fetching")

    other = FixtureRepo(tmp_path / "other")
    other.commit("x", {"c.py": "1\n"})
    with pytest.raises(ValueError, match="is a clone of"):
        ensure_clone(str(other.path), tmp_path / "work")


def test_cli_rejects_non_repo_and_reports(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import cli

    (tmp_path / "plain").mkdir()
    assert cli.main(["analyze", str(tmp_path / "plain")]) == 2
    assert "not a git repository" in capsys.readouterr().err
    assert cli.main(["analyze", str(tmp_path / "missing")]) == 2


def test_cli_data_dir_slug_and_progress(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import json

    import cli

    r = FixtureRepo(tmp_path / "My Repo")
    r.commit("one", {"a.py": lines("h", 3)})
    assert cli.main(["analyze", str(r.path), "--data-dir", str(tmp_path / "data")]) == 0
    out = list((tmp_path / "data").glob("My-Repo-*.json"))
    assert len(out) == 1 and json.loads(out[0].read_text(encoding="utf-8"))["repo"]["name"] == "My Repo"
    err = capsys.readouterr().err
    assert "[grasp] Reading commit history" in err and "[grasp] Saving results" in err
    subprocess.run(["git", "--version"], check=True, capture_output=True)
