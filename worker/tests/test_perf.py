"""Acceptance: a 50k-LOC repo analyses in < 2 minutes.  Run with: pytest -m slow -s"""

from __future__ import annotations

import random
import subprocess
import time
from pathlib import Path

import pytest

from tests.conftest import AS_OF
from unblur.pipeline import analyze

N_FILES, LINES_PER_FILE, N_COMMITS = 500, 100, 400


def _fast_import(path: Path) -> None:
    """Generate history with `git fast-import` (thousands of times faster than git commit)."""
    rng = random.Random(7)
    contents = {
        f"src/mod{i % 25}/file{i}.py": [f"v0 {i} {j}" for j in range(LINES_PER_FILE)] for i in range(N_FILES)
    }
    out: list[bytes] = []

    def blob(data: str) -> None:
        raw = data.encode()
        out.append(b"data %d\n" % len(raw) + raw + b"\n")

    t = 1_700_000_000
    for n in range(N_COMMITS):
        ai = n % 3 == 0
        who = rng.choice(["Ann A <ann@x.com>", "Ben B <ben@x.com>", "Cy C <cy@x.com>"])
        out.append(b"commit refs/heads/main\n")
        out.append(f"author {who} {t + n * 3600} +0000\ncommitter {who} {t + n * 3600} +0000\n".encode())
        blob(f"change {n}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n" if ai else f"change {n}\n")
        targets = list(contents) if n == 0 else rng.sample(list(contents), 15)
        for p in targets:
            body = contents[p]
            if n:
                k = rng.randrange(LINES_PER_FILE - 10)
                body[k : k + 10] = [f"v{n} {p} {j}" for j in range(10)]
            out.append(f"M 100644 inline {p}\n".encode())
            blob("\n".join(body) + "\n")
        out.append(b"\n")
    subprocess.run(["git", "init", "-q", "-b", "main", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "fast-import", "--quiet"], input=b"".join(out), check=True)
    subprocess.run(["git", "-C", str(path), "checkout", "-q", "main"], check=True)


@pytest.mark.slow
def test_50k_loc_under_two_minutes(tmp_path: Path) -> None:
    repo = tmp_path / "big"
    _fast_import(repo)
    t0 = time.perf_counter()
    res = analyze(repo, as_of=AS_OF)
    elapsed = time.perf_counter() - t0
    total = sum(f.loc for f in res.file_scores)
    print(f"\n{len(res.file_scores)} files, {total} LOC, {len(res.commits)} commits: {elapsed:.1f}s")
    assert total == N_FILES * LINES_PER_FILE
    assert elapsed < 120
    t1 = time.perf_counter()
    analyze(repo, as_of=AS_OF, previous=res)
    print(f"incremental no-op re-run: {time.perf_counter() - t1:.2f}s")
