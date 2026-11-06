"""Read file contents at a revision in one `git cat-file --batch` call."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from grasp.gitutil import git_bytes


def read_blobs(repo: str | Path, rev: str, paths: Iterable[str]) -> dict[str, str]:
    paths = list(paths)
    if not paths:
        return {}
    req = "".join(f"{rev}:{p}\n" for p in paths).encode("utf-8")
    out = git_bytes(repo, "cat-file", "--batch", input_bytes=req)
    result: dict[str, str] = {}
    pos = 0
    for p in paths:
        nl = out.index(b"\n", pos)
        header = out[pos:nl].decode("utf-8", errors="replace").split()
        pos = nl + 1
        if len(header) < 3 or header[1] == "missing":
            continue
        size = int(header[2])
        result[p] = out[pos : pos + size].decode("utf-8", errors="replace")
        pos += size + 1  # trailing newline after each object
    return result
