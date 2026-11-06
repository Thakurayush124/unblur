"""Grasp CLI.

python cli.py analyze /path/to/repo [--since 365d] [--json out.json | --mongo-url URL]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from types import ModuleType

from grasp.config import GraspConfig
from grasp.gitutil import GitError, git
from grasp.ingest.commits import parse_since
from grasp.ingest.source import ensure_clone, is_remote, slug_for, validate_remote
from grasp.models import AnalysisResult, PullRequest
from grasp.pipeline import analyze
from grasp.store import json_store


def _summary(result: AnalysisResult, top: int) -> str:
    s = result.stats
    total_loc = sum(f.loc for f in result.file_scores) or 1
    ai_loc = sum(f.ai_lines for f in result.file_scores)
    ai_commits = sum(1 for c in result.commits if c.is_ai_assisted)
    lines = [
        f"Grasp analysis: {result.repo.name} @ {(result.repo.last_analyzed_sha or '')[:10]}"
        f" ({'incremental' if s.incremental else 'full'}, {s.duration_sec:.2f}s)",
        f"  files analysed {s.files_analyzed} (re-blamed {s.files_reblamed}, ignored {s.files_ignored})",
        f"  commits {s.commits_ingested} (new {s.commits_new}), AI-assisted {ai_commits}",
        f"  contributors {len(result.contributors)} (active {sum(c.active for c in result.contributors)})",
        f"  repo AI line share {ai_loc / total_loc:.1%} ({ai_loc}/{total_loc} lines)",
    ]
    if result.snapshots:
        snap = result.snapshots[-1]
        lines.append(f"  repo comprehension {snap.repo_comprehension:.1f}/100, risk {snap.repo_risk:.1f}/100")
    sig = result.file_scores[0].signals if result.file_scores else None
    if sig and not sig.review_data_available:
        lines.append("  (review data unavailable: R = 0.5 neutral; pass --pr-data or use GitHub mode)")
    if s.llm_errors:
        lines.append(f"  LLM errors ({len(s.llm_errors)}), first: {s.llm_errors[0]}")
    lines += ["", "  Modules by risk:"]
    for m in result.module_scores[:top]:
        lines.append(
            f"   risk {m.risk:5.1f}  comp {m.comprehension:5.1f}  AI {m.ai_line_share:6.1%}  "
            f"active holders {m.active_knowledge_holders}  {m.module}"
        )
    lines += ["", f"  Top {top} riskiest files:"]
    ranked = sorted(result.file_scores, key=lambda f: (-(f.risk or 0), -f.loc, f.path))[:top]
    for f in ranked:
        lines.append(
            f"   risk {f.risk or 0:5.1f}  comp {f.comprehension or 0:5.1f}  "
            f"crit {f.criticality or 0:.2f}  {f.path}"
        )
        lines.append(f"           {f.explanation}")
    return "\n".join(lines)


def _progress(msg: str) -> None:
    # Machine-readable progress on stderr (the API shows the latest line while a job runs).
    print(f"[grasp] {msg}", file=sys.stderr, flush=True)


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[1]
    ap = argparse.ArgumentParser(prog="grasp")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze", help="analyse a git repository (local path or remote URL)")
    a.add_argument("source", metavar="repo", help="local checkout path, or a git URL to clone")
    a.add_argument("--since", default=None, help="only ingest commits newer than e.g. 365d")
    a.add_argument("--json", dest="json_out", help="write results to this JSON file")
    a.add_argument("--data-dir", help="write results to <data-dir>/<repo-slug>.json")
    a.add_argument(
        "--workdir",
        default=os.environ.get("GRASP_WORKDIR", str(root / "repos")),
        help="where remote URLs are cloned (default: <grasp>/repos)",
    )
    a.add_argument("--mongo-url", default=os.environ.get("GRASP_MONGO_URL"))
    a.add_argument("--mongo-db", default=os.environ.get("GRASP_MONGO_DB", "grasp"))
    a.add_argument("--config", help="config JSON (default: <repo>/.grasp.json)")
    a.add_argument("--full", action="store_true", help="ignore previous results; re-analyse")
    a.add_argument("--as-of", help="ISO timestamp used as 'now' (for reproducible runs)")
    a.add_argument("--top", type=int, default=10)
    a.add_argument("--pr-data", help="JSON list of PullRequest docs (enables signal R locally)")
    args = ap.parse_args(argv)

    try:
        return _analyze(args)
    except (ValueError, GitError, FileNotFoundError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2


def _analyze(args: argparse.Namespace) -> int:
    as_of = datetime.fromisoformat(args.as_of) if args.as_of else None

    remote_url: str | None = None
    if is_remote(args.source):
        remote_url = validate_remote(args.source)
        repo_path = ensure_clone(remote_url, args.workdir, _progress)
    else:
        repo_path = Path(args.source).resolve()
        if not repo_path.is_dir():
            raise FileNotFoundError(f"no such directory: {repo_path}")
        try:
            git(repo_path, "rev-parse", "--verify", "--quiet", "HEAD")
        except GitError as e:
            raise ValueError(f"{repo_path} is not a git repository with at least one commit") from e

    json_out = args.json_out
    if not json_out and args.data_dir:
        json_out = str(Path(args.data_dir) / f"{slug_for(remote_url or str(repo_path))}.json")

    mongo: ModuleType | None = None
    if args.mongo_url and not json_out:
        from grasp.store import mongo_store

        mongo = mongo_store

    # Settings saved from the dashboard override the repo's .grasp.json.
    overrides: dict[str, object] = {}
    if json_out:
        overrides = json_store.load_overrides(json_out)
    elif mongo is not None:
        overrides = mongo.load_overrides(args.mongo_url, repo_path, args.mongo_db)
    cfg = GraspConfig.load(repo_path, args.config, overrides)

    previous = None
    if not args.full:
        if json_out:
            previous = json_store.load(json_out, repo_path)
        elif mongo is not None:
            previous = mongo.load(args.mongo_url, repo_path, args.mongo_db)

    prs = None
    if args.pr_data:
        raw = json.loads(Path(args.pr_data).read_text(encoding="utf-8"))
        prs = [PullRequest.model_validate(p) for p in raw]

    result = analyze(
        repo_path,
        cfg,
        since_days=parse_since(args.since),
        as_of=as_of,
        previous=previous,
        pull_requests=prs,
        remote_url=remote_url,
        progress=_progress,
    )
    _progress("Saving results")
    if json_out:
        json_store.save(result, json_out)
    elif mongo is not None:
        # Mongo never re-reads llm_audit, so every entry in result.llm_audit is new.
        mongo.save(result, args.mongo_url, args.mongo_db)

    _progress(f"repo-id {result.repo.id}")
    print(_summary(result, args.top))
    if json_out:
        print(f"\nresults: {json_out}")
    elif mongo is None:
        print("\n(no --json, --data-dir or --mongo-url given: results were not persisted)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
