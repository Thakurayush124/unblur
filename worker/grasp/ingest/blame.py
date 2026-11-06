"""Line ownership via `git blame --line-porcelain`."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from grasp.gitutil import git

_HEADER = re.compile(r"^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+")


def parse_line_porcelain(out: str) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for line in out.split("\n"):
        if not line or line[0] == "\t":
            continue
        m = _HEADER.match(line)
        if m:
            counts[m.group(1)] += 1
    return dict(counts)


def blame_file(repo: str | Path, rev: str, path: str) -> dict[str, int]:
    """Return {commit sha: number of lines it currently owns} for one file."""
    return parse_line_porcelain(git(repo, "blame", "--line-porcelain", rev, "--", path))


def blame_many(repo: str | Path, rev: str, paths: Iterable[str], workers: int) -> dict[str, dict[str, int]]:
    paths = list(paths)
    if not paths:
        return {}
    # git does the heavy lifting in subprocesses, so threads parallelise fine.
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = pool.map(lambda p: blame_file(repo, rev, p), paths)
        return dict(zip(paths, results, strict=True))
