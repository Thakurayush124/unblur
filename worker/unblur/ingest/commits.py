"""Read commit metadata from `git log`."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from unblur.gitutil import git

_RS, _US = "\x1e", "\x1f"
_FORMAT = _RS + _US.join(["%H", "%P", "%aN", "%aE", "%aI", "%B"]) + _US
_PR_MERGE = re.compile(r"^Merge pull request #(\d+)")
_PR_SQUASH = re.compile(r"\(#(\d+)\)\s*$")


@dataclass
class RawCommit:
    sha: str
    parents: list[str]
    author_name: str
    author_email: str
    authored_at: datetime
    message: str
    files: list[str] = field(default_factory=list)

    @property
    def pr_number(self) -> int | None:
        first = self.message.splitlines()[0] if self.message else ""
        m = _PR_MERGE.match(first) or _PR_SQUASH.search(first)
        return int(m.group(1)) if m else None


def parse_since(value: str | None) -> int | None:
    """'365d' / '12w' / '2y' / '90' -> days."""
    if not value:
        return None
    m = re.fullmatch(r"(\d+)\s*([dwmy]?)", value.strip().lower())
    if not m:
        raise ValueError(f"invalid --since value: {value!r} (use e.g. 365d, 12w, 6m, 2y)")
    n, unit = int(m.group(1)), m.group(2) or "d"
    return n * {"d": 1, "w": 7, "m": 30, "y": 365}[unit]


def _parse(out: str) -> list[RawCommit]:
    commits: list[RawCommit] = []
    for rec in out.split(_RS):
        if not rec.strip():
            continue
        parts = rec.split(_US)
        if len(parts) < 7:
            continue
        sha, parents, name, email, date, message, files_block = parts[:7]
        files = [f for f in files_block.splitlines() if f.strip()]
        commits.append(
            RawCommit(
                sha=sha.strip(),
                parents=parents.split(),
                author_name=name,
                author_email=email.lower(),
                authored_at=datetime.fromisoformat(date),
                message=message.strip(),
                files=files,
            )
        )
    return commits


def read_log(repo: str | Path, rev_range: str = "HEAD", since_days: int | None = None) -> list[RawCommit]:
    args = ["log", "--use-mailmap", "--no-renames", "--name-only", f"--format={_FORMAT}", rev_range]
    if since_days is not None:
        args.insert(1, f"--since={since_days}.days.ago")
    return _parse(git(repo, *args))


def read_commits_by_sha(repo: str | Path, shas: Iterable[str]) -> list[RawCommit]:
    shas = list(shas)
    if not shas:
        return []
    out = git(
        repo,
        "log",
        "--use-mailmap",
        "--no-walk=unsorted",
        "--stdin",
        "--no-renames",
        "--name-only",
        f"--format={_FORMAT}",
        input_text="\n".join(shas) + "\n",
    )
    return _parse(out)
