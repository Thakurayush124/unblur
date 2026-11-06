"""Resolve what to analyse: a local checkout, or a remote git URL cloned into a work dir."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from pathlib import Path

from grasp.gitutil import GitError, git

# https://host/owner/repo(.git), ssh://..., git://..., or scp-style git@host:owner/repo(.git)
_REMOTE = re.compile(r"^(?:https?://|ssh://|git://)[\w.@:-]+/[\w./~-]+$|^[\w.-]+@[\w.-]+:[\w./~-]+$")


def is_remote(source: str) -> bool:
    return bool(_REMOTE.match(source.strip()))


def validate_remote(url: str) -> str:
    url = url.strip()
    # Never let a "URL" become a git option or an exotic transport (ext::, fd::, file://).
    if url.startswith("-") or "::" in url or not is_remote(url):
        raise ValueError(f"not a supported git URL: {url!r} (use https://, ssh://, git:// or git@host:path)")
    return url


def _clean(s: str) -> str:
    return re.sub(r"[^\w.-]+", "-", s).strip("-.") or "repo"


def slug_for(source: str) -> str:
    """Stable, filesystem-safe name: owner-repo for URLs, name-<hash> for local paths."""
    s = source.strip().rstrip("/")
    if is_remote(s):
        path = re.split(r"[:/]", s.split("://", 1)[-1], maxsplit=1)[-1]
        parts = [p for p in path.removesuffix(".git").split("/") if p]
        return _clean("-".join(parts[-2:]))
    p = Path(s).resolve()
    digest = hashlib.sha1(p.as_posix().lower().encode()).hexdigest()[:6]
    return f"{_clean(p.name)}-{digest}"


def ensure_clone(url: str, workdir: str | Path, progress: Callable[[str], None] = lambda _: None) -> Path:
    """Clone `url` into `workdir/<slug>`, or fetch and fast-forward an existing clone."""
    url = validate_remote(url)
    root = Path(workdir).resolve()
    root.mkdir(parents=True, exist_ok=True)
    dest = root / slug_for(url)
    if (dest / ".git").is_dir():
        existing = git(dest, "remote", "get-url", "origin").strip()
        if existing != url:
            raise ValueError(f"{dest} is a clone of {existing}, not {url}")
        progress(f"Fetching {url}")
        git(dest, "fetch", "--quiet", "--prune", "origin")
        try:
            git(dest, "reset", "--quiet", "--hard", "origin/HEAD")
        except GitError:  # remote HEAD unknown (e.g. renamed default branch): re-detect it
            git(dest, "remote", "set-head", "origin", "--auto")
            git(dest, "reset", "--quiet", "--hard", "origin/HEAD")
    else:
        progress(f"Cloning {url}")
        git(root, "clone", "--quiet", "--no-recurse-submodules", "--", url, dest.name)
    return dest
