"""Thin wrapper around the `git` binary. All output is decoded as UTF-8."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

_GLOBAL_OPTS = [
    "-c",
    "core.quotepath=off",
    "-c",
    "i18n.logOutputEncoding=UTF-8",
    "-c",
    "color.ui=false",
]


class GitError(RuntimeError):
    pass


def git(repo: str | Path, *args: str, input_text: str | None = None) -> str:
    data = input_text.encode("utf-8") if input_text is not None else None
    return git_bytes(repo, *args, input_bytes=data).decode("utf-8", errors="replace")


def git_bytes(repo: str | Path, *args: str, input_bytes: bytes | None = None) -> bytes:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat"}
    proc = subprocess.run(
        ["git", "-C", str(repo), *_GLOBAL_OPTS, *args],
        input=input_bytes,
        capture_output=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise GitError(f"git {' '.join(args[:3])} failed: {err}")
    return proc.stdout


def head_sha(repo: str | Path) -> str:
    return git(repo, "rev-parse", "HEAD").strip()


def current_branch(repo: str | Path) -> str:
    try:
        return git(repo, "symbolic-ref", "--short", "HEAD").strip()
    except GitError:
        return "HEAD"


def is_ancestor(repo: str | Path, ancestor: str, descendant: str) -> bool:
    try:
        git(repo, "merge-base", "--is-ancestor", ancestor, descendant)
        return True
    except GitError:
        return False


def empty_tree(repo: str | Path) -> str:
    return git(repo, "mktree", input_text="").strip()
