"""Analysis pipeline: git log + blame -> signals -> comprehension, criticality, risk.

Incremental: when a previous result exists and its `lastAnalyzedSha` is an ancestor of HEAD,
only new commits are read and only files changed since then are re-blamed. Signals and scores
are cheap and are always recomputed from the (cached) blame + commit data, so changing weights
or patterns takes effect on the next run.
"""

from __future__ import annotations

import hashlib
import time
from collections import Counter, defaultdict
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

from grasp.config import GraspConfig
from grasp.criticality.heuristics import heuristic_criticality
from grasp.criticality.imports import fan_in, is_import_source
from grasp.criticality.llm import classify, llm_allowed
from grasp.gitutil import current_branch, git, head_sha, is_ancestor
from grasp.ingest.ai_detect import AiDetector
from grasp.ingest.blame import blame_many
from grasp.ingest.commits import RawCommit, read_commits_by_sha, read_log
from grasp.ingest.contents import read_blobs
from grasp.ingest.contributors import is_active, resolve
from grasp.ingest.files import list_files, module_for
from grasp.llm_client import LlmClient, get_client
from grasp.models import (
    AiSource,
    AnalysisResult,
    Commit,
    Contributor,
    FileScore,
    Owner,
    PullRequest,
    Repo,
    RunStats,
    Signals,
)
from grasp.scoring import score as scoring
from grasp.scoring.explain import explain
from grasp.signals.human_touch import FileCommit, human_touch
from grasp.signals.review import pr_index, review_depth
from grasp.signals.verified import verified

TOP_OWNERS = 5
TOP_AI_SOURCES = 10
MAX_SNAPSHOTS = 400


def repo_id_for(path: Path) -> str:
    return "r_" + hashlib.sha1(path.as_posix().lower().encode()).hexdigest()[:12]


def _raw_from_doc(c: Commit) -> RawCommit:
    return RawCommit(
        sha=c.sha,
        parents=list(c.parents),
        author_name=c.author_name,
        author_email=c.author_email,
        authored_at=c.authored_at,
        message=c.message,
        files=list(c.files_changed),
    )


def _changed_paths(repo: Path, old: str, new: str) -> set[str]:
    out = git(repo, "diff", "--name-only", "-z", "--no-renames", old, new)
    return {p for p in out.split("\0") if p}


def analyze(
    repo_path: str | Path,
    cfg: GraspConfig | None = None,
    *,
    since_days: int | None = None,
    as_of: datetime | None = None,
    previous: AnalysisResult | None = None,
    pr_labels: Mapping[int, Sequence[str]] | None = None,
    pull_requests: list[PullRequest] | None = None,
    llm_client_factory: Callable[[], LlmClient] | None = None,
    env: Mapping[str, str] | None = None,
) -> AnalysisResult:
    t0 = time.perf_counter()
    repo = Path(repo_path).resolve()
    cfg = cfg or GraspConfig.load(repo)
    as_of = as_of or datetime.now(UTC)
    head = head_sha(repo)
    rid = repo_id_for(repo)
    prs = pull_requests if pull_requests is not None else (previous.pull_requests if previous else [])
    tasks = previous.learning_tasks if previous else []

    # ---- commits (incremental when possible) --------------------------------
    raw: dict[str, RawCommit] = {}
    blame_cache: dict[str, dict[str, int]] = {}
    prev_sha = previous.repo.last_analyzed_sha if previous else None
    incremental = bool(previous and prev_sha and is_ancestor(repo, prev_sha, head))
    if previous and prev_sha and incremental:
        raw = {c.sha: _raw_from_doc(c) for c in previous.commits}
        new_commits = read_log(repo, f"{prev_sha}..{head}") if prev_sha != head else []
        stale = _changed_paths(repo, prev_sha, head) if prev_sha != head else set()
        blame_cache = {p: v for p, v in previous.blame_cache.items() if p not in stale}
    else:
        new_commits = read_log(repo, head, since_days)
    for c in new_commits:
        raw[c.sha] = c

    # ---- files + blame -------------------------------------------------------
    files, ignored = list_files(repo, head, cfg)
    to_blame = [f.path for f in files if f.path not in blame_cache]
    blame_cache.update(blame_many(repo, head, to_blame, cfg.blame_workers))
    blame_cache = {f.path: blame_cache[f.path] for f in files}

    # Lines may come from commits older than --since; fetch their metadata too.
    missing = {sha for counts in blame_cache.values() for sha in counts} - raw.keys()
    for c in read_commits_by_sha(repo, sorted(missing)):
        raw[c.sha] = c

    # ---- AI detection + contributors ----------------------------------------
    labels: dict[int, list[str]] = {p.number: list(p.labels) for p in prs}
    for num, extra in (pr_labels or {}).items():
        labels.setdefault(num, []).extend(extra)
    detector = AiDetector(cfg)
    idents, email_to_id = resolve(raw.values(), detector.is_bot)
    evidence = {sha: detector.evidence(c, labels) for sha, c in raw.items()}
    author_of = {sha: email_to_id[c.author_email] for sha, c in raw.items()}
    active = {cid: is_active(i, as_of, cfg.active_days) for cid, i in idents.items()}
    bots = {cid: i.is_bot for cid, i in idents.items()}
    last_active = {cid: i.last_active_at for cid, i in idents.items() if i.last_active_at}

    commits = [
        Commit(
            repo_id=rid,
            sha=c.sha,
            author_id=author_of[c.sha],
            author_name=c.author_name,
            author_email=c.author_email,
            authored_at=c.authored_at,
            message=c.message,
            is_ai_assisted=bool(evidence[c.sha]),
            ai_evidence=evidence[c.sha],
            pr_number=c.pr_number,
            files_changed=c.files,
            parents=c.parents,
        )
        for c in sorted(raw.values(), key=lambda c: (c.authored_at, c.sha), reverse=True)
    ]
    contributors = sorted(
        (
            Contributor(
                _id=cid,
                repo_id=rid,
                canonical_name=ident.canonical_name,
                emails=sorted(ident.emails),
                github_login=ident.github_login,
                is_bot=ident.is_bot,
                last_active_at=ident.last_active_at or as_of,
                active=active[cid],
            )
            for cid, ident in idents.items()
        ),
        key=lambda c: (c.canonical_name.lower(), c.id),
    )

    # ---- per-file history index (non-merge commits) --------------------------
    history: dict[str, list[FileCommit]] = defaultdict(list)
    for c in raw.values():
        if len(c.parents) > 1:
            continue
        fc = FileCommit(c.sha, author_of[c.sha], c.authored_at, bool(evidence[c.sha]))
        for path in c.files:
            history[path].append(fc)
    churn_since = as_of - timedelta(days=cfg.churn_days)
    churn = {
        f.path: sum(1 for c in history.get(f.path, ()) if churn_since <= c.authored_at <= as_of)
        for f in files
    }
    sha_to_pr = pr_index(prs, {sha: c.pr_number for sha, c in raw.items()})

    # ---- criticality (heuristics) --------------------------------------------
    paths = [f.path for f in files]
    path_set = set(paths)
    contents = read_blobs(repo, head, [p for p in paths if is_import_source(p)])
    crit = heuristic_criticality(paths, fan_in(contents, path_set, cfg.import_aliases), churn, cfg)

    # ---- per-file signals + scores ------------------------------------------
    scores: list[FileScore] = []
    for f in files:
        counts = blame_cache[f.path]
        total = sum(counts.values())
        ai_shas = [sha for sha in counts if evidence.get(sha)]
        ai_lines = sum(counts[sha] for sha in ai_shas)
        a = ai_lines / total if total else 0.0
        owners: Counter[str] = Counter()
        for sha, n in counts.items():
            owners[author_of[sha]] += n
        top = sorted(owners.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_OWNERS]
        sources = sorted(
            (AiSource(sha=sha, lines=counts[sha], evidence=evidence[sha]) for sha in ai_shas),
            key=lambda s: (-s.lines, s.sha),
        )
        rev = review_depth(counts, sha_to_pr, have_pr_data=bool(prs))
        landed = min((raw[sha].authored_at for sha in ai_shas), default=None)
        touch = human_touch(history.get(f.path, ()), landed, bots, active, as_of, cfg.touch_half_life_days)
        e = verified(f.path, tasks, as_of)
        comp = scoring.comprehension(a, rev.value, touch.h, touch.k, e, cfg.weights)
        scores.append(
            FileScore(
                repo_id=rid,
                path=f.path,
                module=module_for(f.path, cfg.module_roots),
                loc=total,
                ai_lines=ai_lines,
                ai_line_share=round(a, 4),
                ai_sources=sources[:TOP_AI_SOURCES],
                top_owners=[Owner(contributor_id=c, share=round(n / total, 4)) for c, n in top],
                review_depth=round(rev.value, 4),
                human_touch=round(touch.h, 4),
                retention=round(touch.k, 4),
                verified=round(e, 4),
                comprehension=comp,
                touchers=touch.touchers,
                signals=Signals(
                    a=round(a, 4),
                    r=round(rev.value, 4),
                    h=round(touch.h, 4),
                    k=round(touch.k, 4),
                    e=round(e, 4),
                    contributions=scoring.contributions(a, rev.value, touch.h, touch.k, e, cfg.weights),
                    review_data_available=rev.available,
                    review_note=rev.note,
                ),
                computed_at=as_of,
            )
        )

    # ---- optional LLM criticality (double opt-in) ----------------------------
    llm_cache = dict(previous.llm_cache) if previous else {}
    llm_audit = list(previous.llm_audit) if previous else []
    llm_errors: list[str] = []
    if llm_allowed(cfg, env):
        ranked = sorted(scores, key=lambda s: (s.comprehension or 0.0, -s.loc, s.path))
        cand = [s.path for s in ranked[: cfg.llm_max_files]]
        cand_contents = {**contents, **read_blobs(repo, head, [p for p in cand if p not in contents])}
        verdicts, llm_errors = classify(
            cand,
            cand_contents,
            llm_cache,
            llm_audit,
            rid,
            as_of,
            client_factory=llm_client_factory or (lambda: get_client(dict(env) if env else None)),
        )
        for path, v in verdicts.items():
            crit[path].bump(v.criticality, f"LLM: {v.reason}" if v.reason else "LLM classification")

    # ---- risk + explanations --------------------------------------------------
    for s in scores:
        cr = crit[s.path]
        s.criticality = round(min(1.0, cr.value), 4)
        s.criticality_reasons = cr.reasons
        s.risk = scoring.risk(s.criticality, s.comprehension or 0.0)
        assert s.signals is not None
        s.explanation = explain(
            ai_share=s.ai_line_share,
            review_note=s.signals.review_note,
            review_available=s.signals.review_data_available,
            touchers=s.touchers,
            last_active=last_active,
            criticality=s.criticality,
            criticality_reason=cr.reasons[0] if cr.reasons else None,
            verified=s.verified or 0.0,
            as_of=as_of,
        )

    modules = scoring.aggregate_modules(scores, active)
    snap = scoring.snapshot(rid, as_of, head, scores, modules)
    snapshots = list(previous.snapshots) if previous else []
    if snapshots and snapshots[-1].head_sha == head:
        snapshots[-1] = snap  # same code, refreshed view
    else:
        snapshots.append(snap)

    stats = RunStats(
        commits_ingested=len(commits),
        commits_new=len(new_commits),
        files_analyzed=len(files),
        files_reblamed=len(to_blame),
        files_ignored=ignored,
        duration_sec=round(time.perf_counter() - t0, 3),
        incremental=incremental,
        llm_errors=llm_errors[:20],
    )
    return AnalysisResult(
        repo=Repo(
            _id=rid,
            name=repo.name,
            source="local",
            path=repo.as_posix(),
            default_branch=current_branch(repo),
            last_analyzed_at=as_of,
            last_analyzed_sha=head,
        ),
        contributors=contributors,
        commits=commits,
        file_scores=scores,
        blame_cache=blame_cache,
        module_scores=modules,
        snapshots=snapshots[-MAX_SNAPSHOTS:],
        pull_requests=prs,
        learning_tasks=tasks,
        llm_cache=llm_cache,
        llm_audit=llm_audit,
        config=cfg.dump(),
        stats=stats,
    )
