"""Build throwaway git repos with scripted (optionally AI-trailered) commits."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

CLAUDE = "Co-Authored-By: Claude <noreply@anthropic.com>"
COPILOT = "Co-authored-by: Copilot <copilot@github.com>"


class FixtureRepo:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.mkdir(parents=True, exist_ok=True)
        self._git("init", "-q", "-b", "main")
        self._git("config", "user.name", "Fixture")
        self._git("config", "user.email", "fixture@example.com")
        self._git("config", "commit.gpgsign", "false")
        self._git("config", "core.autocrlf", "false")

    def _git(self, *args: str, env: dict[str, str] | None = None) -> str:
        proc = subprocess.run(
            ["git", "-C", str(self.path), *args],
            capture_output=True,
            check=True,
            env={**os.environ, **(env or {})},
        )
        return proc.stdout.decode("utf-8", errors="replace")

    def write(self, rel: str, content: str) -> None:
        p = self.path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content.encode("utf-8"))

    def write_bytes(self, rel: str, data: bytes) -> None:
        p = self.path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def commit(
        self,
        message: str,
        files: dict[str, str] | None = None,
        author: tuple[str, str] = ("Alice Human", "alice@example.com"),
        date: str = "2026-06-01T12:00:00+00:00",
    ) -> str:
        for rel, content in (files or {}).items():
            self.write(rel, content)
        self._git("add", "-A")
        with tempfile.NamedTemporaryFile("wb", suffix=".msg", delete=False) as fh:
            fh.write(message.encode("utf-8"))
            msg_file = fh.name
        env = {
            "GIT_AUTHOR_NAME": author[0],
            "GIT_AUTHOR_EMAIL": author[1],
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_NAME": author[0],
            "GIT_COMMITTER_EMAIL": author[1],
            "GIT_COMMITTER_DATE": date,
        }
        try:
            self._git("commit", "-q", "--allow-empty", "-F", msg_file, env=env)
        finally:
            os.unlink(msg_file)
        return self._git("rev-parse", "HEAD").strip()


def lines(prefix: str, n: int, start: int = 0) -> str:
    return "".join(f"{prefix} line {i}\n" for i in range(start, start + n))


def build_demo_repo(path: Path) -> FixtureRepo:
    """A small, realistic mix used by the sample-output script and smoke tests."""
    r = FixtureRepo(path)
    alice = ("Alice Human", "alice@example.com")
    bob = ("Bob Departed", "bob@example.com")
    carol = ("Carol Active", "carol@example.com")
    r.commit(
        "Initial app skeleton",
        {
            "src/core/app.py": lines("app", 120),
            "src/auth/session.py": lines("session", 40),
            "README.md": lines("readme", 10),
            "package-lock.json": lines("lock", 500),
        },
        author=alice,
        date="2025-01-10T09:00:00+00:00",
    )
    r.commit(
        f"Add token refresh\n\n{CLAUDE}",
        {
            "src/auth/session.py": lines("session", 40) + lines("ai-refresh", 160),
            "src/auth/tokens.py": lines("ai-tokens", 220),
        },
        author=bob,
        date="2025-04-02T10:00:00+00:00",
    )
    r.commit(
        "Billing: proration (#42)\n\n\N{ROBOT FACE} Generated with Claude Code",
        {
            "src/billing/proration.py": lines("ai-prorate", 300),
        },
        author=bob,
        date="2025-05-20T15:00:00+00:00",
    )
    r.commit(
        "Hand-tune proration rounding",
        {
            "src/billing/proration.py": lines("ai-prorate", 280) + lines("human-round", 20),
        },
        author=carol,
        date="2026-09-15T11:00:00+00:00",
    )
    r.commit(
        "Bump deps",
        {"package-lock.json": lines("lock2", 520)},
        author=("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com"),
        date="2026-10-01T08:00:00+00:00",
    )
    r.commit(
        f"Speed up app loop\n\n{COPILOT}",
        {
            "src/core/app.py": lines("app", 100) + lines("copilot", 20),
        },
        author=carol,
        date="2026-10-20T16:00:00+00:00",
    )
    return r
