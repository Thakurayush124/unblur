"""Create the small synthetic demo repo:  python scripts/demo_repo.py <target_dir>"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.fixture_repo import build_demo_repo

if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "demo-repo")
    if target.exists() and any(target.iterdir()):
        raise SystemExit(f"{target} exists and is not empty")
    build_demo_repo(target)
    print(f"demo repo created at {target.resolve()}")
