"""Mongo persistence. pymongo is imported lazily so JSON mode has no extra dependency.

Collections: repos, contributors, commits, file_scores, module_scores, snapshots,
pull_requests, learning_tasks, blame_cache, llm_cache, llm_audit (append-only).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from grasp.models import (
    AnalysisResult,
    Commit,
    Contributor,
    FileScore,
    LearningTask,
    LlmAuditEntry,
    LlmCacheEntry,
    ModuleScore,
    PullRequest,
    Repo,
    RunStats,
    Snapshot,
)


def _db(url: str, db_name: str) -> Any:
    try:
        from pymongo import MongoClient
    except ImportError as e:  # pragma: no cover
        raise SystemExit("Mongo mode needs pymongo: pip install 'grasp-worker[mongo]'") from e
    return MongoClient(url, tz_aware=True)[db_name]


def _dump(doc: Any) -> dict[str, Any]:
    out: dict[str, Any] = doc.model_dump(by_alias=True, mode="python")
    return out


def load_overrides(url: str, repo_path: str | Path, db_name: str = "grasp") -> dict[str, Any]:
    db = _db(url, db_name)
    doc = db.repos.find_one({"path": Path(repo_path).resolve().as_posix()}, {"settings": 1})
    settings = (doc or {}).get("settings") or {}
    return settings if isinstance(settings, dict) else {}


def load(url: str, repo_path: str | Path, db_name: str = "grasp") -> AnalysisResult | None:
    db = _db(url, db_name)
    repo_doc = db.repos.find_one({"path": Path(repo_path).resolve().as_posix()})
    if not repo_doc:
        return None
    rid = repo_doc["_id"]
    q, strip = {"repoId": rid}, {"_id": 0}
    return AnalysisResult(
        repo=Repo.model_validate(repo_doc),  # extra keys (settings, effectiveConfig) are ignored
        contributors=[Contributor.model_validate(d) for d in db.contributors.find(q)],
        commits=[Commit.model_validate(d) for d in db.commits.find(q, strip)],
        file_scores=[FileScore.model_validate(d) for d in db.file_scores.find(q, strip)],
        blame_cache={d["path"]: d["counts"] for d in db.blame_cache.find(q)},
        module_scores=[ModuleScore.model_validate(d) for d in db.module_scores.find(q, strip)],
        snapshots=[Snapshot.model_validate(d) for d in db.snapshots.find(q, strip).sort("takenAt", 1)],
        pull_requests=[PullRequest.model_validate(d) for d in db.pull_requests.find(q, strip)],
        learning_tasks=[LearningTask.model_validate(d) for d in db.learning_tasks.find(q, strip)],
        llm_cache={d["hash"]: LlmCacheEntry.model_validate(d) for d in db.llm_cache.find({}, strip)},
        llm_audit=[],  # append-only in Mongo; never re-read
        stats=RunStats(),
    )


def save(
    result: AnalysisResult,
    url: str,
    db_name: str = "grasp",
    previous_audit_len: int = 0,
) -> None:
    from pymongo import ReplaceOne

    db = _db(url, db_name)
    rid = result.repo.id
    # $set (not replace) so the dashboard's `settings` on the repo document survive re-runs.
    repo_doc = {k: v for k, v in _dump(result.repo).items() if k != "_id"}
    repo_doc["effectiveConfig"] = result.config
    db.repos.update_one({"_id": rid}, {"$set": repo_doc}, upsert=True)

    def sync(coll: Any, docs: list[dict[str, Any]], key: list[str], prune: bool = True) -> None:
        ops = [ReplaceOne({k: d[k] for k in key}, d, upsert=True) for d in docs]
        if ops:
            coll.bulk_write(ops, ordered=False)
        if prune:  # drop documents that no longer exist (deleted files, rewritten history)
            field = key[-1]
            coll.delete_many({"repoId": rid, field: {"$nin": [d[field] for d in docs]}})
        coll.create_index([(k, 1) for k in key], unique=True)

    sync(db.contributors, [_dump(c) for c in result.contributors], ["_id"])
    sync(db.commits, [_dump(c) for c in result.commits], ["repoId", "sha"])
    sync(db.file_scores, [_dump(f) for f in result.file_scores], ["repoId", "path"])
    sync(
        db.module_scores,
        [{"repoId": rid, **_dump(m)} for m in result.module_scores],
        ["repoId", "module"],
    )
    sync(db.snapshots, [_dump(s) for s in result.snapshots], ["repoId", "takenAt"], prune=False)
    sync(db.pull_requests, [_dump(p) for p in result.pull_requests], ["repoId", "number"], prune=False)
    sync(
        db.blame_cache,
        [{"repoId": rid, "path": p, "counts": c} for p, c in result.blame_cache.items()],
        ["repoId", "path"],
    )
    cache_ops = [
        ReplaceOne({"hash": h}, {"hash": h, **_dump(v)}, upsert=True) for h, v in result.llm_cache.items()
    ]
    if cache_ops:
        db.llm_cache.bulk_write(cache_ops, ordered=False)
    new_audit: list[LlmAuditEntry] = result.llm_audit[previous_audit_len:]
    if new_audit:
        db.llm_audit.insert_many([_dump(a) for a in new_audit])
