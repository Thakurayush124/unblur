"""Seed a realistic demo:  python worker/scripts/demo.py [--repo repos/demo] [--out data/demo.json]

Builds a synthetic git repo (dates relative to today) with a mix of:
  * human-written code and AI-assisted code (Claude / Copilot / Cursor trailers)
  * rubber-stamp approvals, substantive reviews and unreviewed PRs
  * a departed contributor who wrote most of the auth module with an AI agent
  * a dependency bot
then analyses it (with matching PR data) and writes the worker JSON the dashboard reads.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from grasp.models import PullRequest, Review  # noqa: E402
from grasp.pipeline import analyze  # noqa: E402
from grasp.store import json_store  # noqa: E402
from tests.fixture_repo import FixtureRepo  # noqa: E402

NOW = datetime.now(UTC).replace(microsecond=0)
DANA = ("Dana Founder", "dana@acme.dev")  # departed ~14 months ago
MARCO = ("Marco Rossi", "marco@acme.dev")  # departed ~7 months ago, heavy AI user
PRIYA = ("Priya Shah", "priya@acme.dev")
SAM = ("Sam Lee", "sam@acme.dev")
LEE = ("Lee Kim", "lee@acme.dev")
BOT = ("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")

CLAUDE = "Co-Authored-By: Claude <noreply@anthropic.com>"
COPILOT = "Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>"
CURSOR = "Co-Authored-By: Cursor Agent <cursoragent@cursor.com>"


def ago(days: float) -> str:
    return (NOW - timedelta(days=days)).isoformat()


def py(name: str, n: int, tag: str, imports: list[str] | None = None, start: int = 0) -> str:
    head = "".join(f"from {m} import *  # noqa\n" for m in imports or [])
    body = "".join(
        f"def {name}_{i}(value):\n    return value  # {tag} {i}\n\n" for i in range(start, start + n // 3)
    )
    return head + body


class Demo:
    def __init__(self, path: Path) -> None:
        self.r = FixtureRepo(path)
        self.files: dict[str, str] = {}
        self.prs: list[PullRequest] = []

    def commit(
        self,
        subject: str,
        files: dict[str, str],
        author: tuple[str, str],
        days: float,
        trailer: str | None = None,
        pr: int | None = None,
        review: str | None = None,  # "stamp" | "deep" | "light" | None (no review)
        reviewer: tuple[str, str] = PRIYA,
    ) -> None:
        msg = f"{subject} (#{pr})" if pr else subject
        if trailer:
            msg += f"\n\n{trailer}"
        changed = sum(c.count("\n") for c in files.values())
        self.files.update(files)
        sha = self.r.commit(msg, files, author=author, date=ago(days))
        if pr is None:
            return
        opened = NOW - timedelta(days=days + 1)
        reviews: list[Review] = []
        ttfr: float | None = None
        if review == "stamp":
            reviews = [Review(reviewer_id=reviewer[1], state="APPROVED", submitted_at=opened)]
            ttfr = 2
        elif review == "light":
            reviews = [Review(reviewer_id=reviewer[1], state="APPROVED", submitted_at=opened)]
            ttfr = 6
        elif review == "deep":
            reviews = [
                Review(reviewer_id=reviewer[1], state="CHANGES_REQUESTED", submitted_at=opened,
                       comment_count=4, body_length=220),
                Review(reviewer_id=reviewer[1], state="APPROVED", submitted_at=opened, comment_count=1),
            ]
            ttfr = 90
        self.prs.append(
            PullRequest(
                repo_id="demo", number=pr, author_id=author[1], opened_at=opened,
                merged_at=NOW - timedelta(days=days), additions=changed, commit_shas=[sha],
                labels=["ai-generated"] if trailer and review == "stamp" else [],
                reviews=reviews, time_to_first_review_mins=ttfr,
            )
        )


def build(path: Path) -> Demo:
    d = Demo(path)
    utils = ["src.utils.helpers"]
    d.commit("Project skeleton", {
        "README.md": "# Acme Payments\n\nInternal payments service.\n",
        "requirements.txt": "flask==3.0.0\nsqlalchemy==2.0.0\n",
        "src/utils/helpers.py": py("helper", 90, "dana"),
        "src/utils/log.py": py("log", 45, "dana"),
        "src/api/routes.py": py("route", 60, "dana", utils),
        "src/ui/layout.py": py("layout", 75, "dana", utils),
        "src/ui/forms.py": py("form", 60, "dana", utils),
    }, DANA, 700)
    d.commit("Data models", {"src/data/models.py": py("model", 120, "dana", utils)}, DANA, 600, pr=3)
    d.commit("Add session + token auth", {
        "src/auth/session.py": py("session", 210, "ai-auth", utils + ["src.data.models"]),
        "src/auth/tokens.py": py("token", 270, "ai-tokens", utils),
        "src/auth/permissions.py": py("perm", 150, "ai-perm", utils + ["src.auth.session"]),
    }, MARCO, 420, CLAUDE, pr=11, review="stamp", reviewer=DANA)
    d.commit("Initial migrations", {
        "src/data/migrations/m0001_init.py": py("m1", 90, "ai-mig"),
        "src/data/migrations/m0002_users.py": py("m2", 60, "ai-mig"),
    }, MARCO, 400, CLAUDE, pr=14)
    d.commit("Invoice generation", {
        "src/billing/invoice.py": py("invoice", 240, "ai-invoice", utils + ["src.data.models"]),
    }, MARCO, 300, CLAUDE, pr=19, review="deep", reviewer=PRIYA)
    d.commit("Hand-tune invoice rounding + tax rules", {
        "src/billing/invoice.py": py("invoice", 200, "ai-invoice", utils + ["src.data.models"])
        + py("rounding", 45, "priya"),
        "src/billing/tax.py": py("tax", 120, "priya", utils + ["src.billing.invoice"]),
    }, PRIYA, 250, pr=22, review="deep", reviewer=LEE)
    d.commit("API handlers for payments", {
        "src/api/handlers.py": py("handler", 300, "ai-handlers",
                                  utils + ["src.auth.session", "src.billing.invoice"]),
    }, MARCO, 240, CLAUDE, pr=25, review="stamp", reviewer=PRIYA)
    d.commit("Fix token expiry off-by-one", {
        "src/auth/tokens.py": py("token", 255, "ai-tokens", utils) + py("expiry", 15, "marco"),
    }, MARCO, 215, pr=27, review="light", reviewer=PRIYA)
    d.commit("Dashboard widgets", {
        "src/ui/dashboard.py": py("widget", 180, "copilot-ui", utils + ["src.ui.layout"]),
    }, SAM, 120, COPILOT, pr=31, review="light", reviewer=LEE)
    d.commit("Handler validation and error mapping", {
        "src/api/handlers.py": py("handler", 240, "ai-handlers",
                                  utils + ["src.auth.session", "src.billing.invoice"])
        + py("validate", 60, "lee"),
    }, LEE, 90, pr=33, review="deep", reviewer=PRIYA)
    d.commit("Bump flask", {"requirements.txt": "flask==3.0.3\nsqlalchemy==2.0.0\n"}, BOT, 60)
    d.commit("Refund flow", {
        "src/billing/refunds.py": py("refund", 330, "cursor-refunds",
                                     utils + ["src.billing.invoice", "src.auth.permissions"]),
    }, SAM, 45, CURSOR, pr=36, review="stamp", reviewer=PRIYA)
    d.commit("Invoice: partial payments", {
        "src/billing/invoice.py": py("invoice", 200, "ai-invoice", utils + ["src.data.models"])
        + py("rounding", 45, "priya") + py("partial", 30, "priya"),
    }, PRIYA, 30, pr=38, review="deep", reviewer=SAM)
    d.commit("Refunds migration", {
        "src/data/migrations/m0003_refunds.py": py("m3", 75, "ai-mig"),
    }, SAM, 20, CLAUDE, pr=40)
    d.commit("Refactor helpers", {"src/utils/helpers.py": py("helper", 60, "dana") + py("helper", 45, "lee", start=30)},
             LEE, 10, pr=42, review="deep", reviewer=SAM)
    d.commit("Dark theme", {"src/ui/theme.py": py("theme", 90, "priya", ["src.ui.layout"])},
             PRIYA, 5, pr=44, review="light", reviewer=SAM)
    d.commit("Billing tests", {
        "tests/test_billing.py": py("test_bill", 150, "ai-tests", ["src.billing.invoice", "src.billing.tax"]),
    }, SAM, 3, CLAUDE, pr=45, review="deep", reviewer=PRIYA)
    return d


def main() -> int:
    grasp_root = ROOT.parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=str(grasp_root / "repos" / "demo"))
    ap.add_argument("--out", default=str(grasp_root / "data" / "demo.json"))
    args = ap.parse_args()
    repo, out = Path(args.repo), Path(args.out)
    if repo.exists():
        if not (repo / ".git").is_dir():
            raise SystemExit(f"refusing to delete {repo}: not a git repo")
        shutil.rmtree(repo)
    demo = build(repo)
    result = analyze(repo, as_of=NOW, pull_requests=demo.prs)
    json_store.save(result, out)
    s = result.snapshots[-1]
    print(f"demo repo: {repo}\nresults:   {out}")
    print(f"{len(result.file_scores)} files, comprehension {s.repo_comprehension}, risk {s.repo_risk}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
