"""Enumerate analysable files at a revision, with LOC, ignore rules and module mapping."""

from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path, PurePosixPath

from unblur.config import UnblurConfig
from unblur.gitutil import empty_tree, git


@dataclass(frozen=True)
class TrackedFile:
    path: str
    loc: int


class IgnoreMatcher:
    """gitignore-flavoured globs.

    * ``name/``      -> any path segment equal to (or matching) ``name``
    * ``a/b/``       -> files under the directory ``a/b`` (from the repo root)
    * ``*.min.js``   -> no slash: matched against the basename
    * ``docs/**/x``  -> contains a slash: matched against the full path
    """

    def __init__(self, globs: list[str]) -> None:
        self._dirs = [g.rstrip("/") for g in globs if g.endswith("/")]
        self._names = [g for g in globs if "/" not in g]
        self._paths = [g for g in globs if "/" in g and not g.endswith("/")]

    def __call__(self, path: str) -> bool:
        p = PurePosixPath(path)
        dirs = p.parts[:-1]
        prefixes = ["/".join(dirs[: i + 1]) for i in range(len(dirs))]
        for d in self._dirs:
            # "name/" matches any directory segment; "a/b/" matches a directory path prefix
            targets = prefixes if "/" in d else dirs
            if any(fnmatchcase(t, d) for t in targets):
                return True
        if any(fnmatchcase(p.name, n) for n in self._names):
            return True
        return any(fnmatchcase(path, g) for g in self._paths)


def module_for(path: str, roots: list[str]) -> str:
    parts = PurePosixPath(path).parts
    for root in roots:
        rparts = PurePosixPath(root).parts
        n = len(rparts)
        if tuple(parts[:n]) == rparts:
            rest = parts[n:]
            return f"{root}/{rest[0]}" if len(rest) > 1 else root
    return parts[0] if len(parts) > 1 else "(root)"


def _linguist_excluded(repo: str | Path, paths: list[str]) -> set[str]:
    """Honour `.gitattributes` linguist-generated / linguist-vendored markers."""
    if not paths:
        return set()
    out = git(
        repo,
        "check-attr",
        "-z",
        "--stdin",
        "linguist-generated",
        "linguist-vendored",
        input_text="\0".join(paths) + "\0",
    )
    fields = out.split("\0")
    excluded: set[str] = set()
    for i in range(0, len(fields) - 2, 3):
        path, _attr, value = fields[i : i + 3]
        if value in ("set", "true"):
            excluded.add(path)
    return excluded


def list_files(repo: str | Path, rev: str, cfg: UnblurConfig) -> tuple[list[TrackedFile], int]:
    """Return (analysable files, number ignored). Binary files are always skipped."""
    out = git(repo, "diff", "--numstat", "-z", "--no-renames", empty_tree(repo), rev)
    ignore = IgnoreMatcher(cfg.ignore_globs)
    candidates: list[TrackedFile] = []
    ignored = 0
    for rec in out.split("\0"):
        if not rec:
            continue
        added, _deleted, path = rec.split("\t", 2)
        if added == "-" or ignore(path):  # "-" = binary
            ignored += 1
            continue
        loc = int(added)
        if loc == 0 or loc > cfg.max_file_lines:
            ignored += 1
            continue
        candidates.append(TrackedFile(path, loc))
    generated = _linguist_excluded(repo, [f.path for f in candidates])
    kept = [f for f in candidates if f.path not in generated]
    return sorted(kept, key=lambda f: f.path), ignored + len(generated)
