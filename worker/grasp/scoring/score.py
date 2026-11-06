"""comprehension = 100 * clamp(w_a*(1-A) + w_r*R + w_h*(H*K) + w_e*E, 0, 1)
risk          = criticality * (100 - comprehension)
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping
from datetime import datetime

from grasp.config import Weights
from grasp.models import FileScore, ModuleScore, Snapshot


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def contributions(a: float, r: float, h: float, k: float, e: float, w: Weights) -> dict[str, float]:
    """Each signal's share of the comprehension score, in points out of 100."""
    return {
        "a": round(100 * w.w_a * (1 - a), 2),
        "r": round(100 * w.w_r * r, 2),
        "hk": round(100 * w.w_h * h * k, 2),
        "e": round(100 * w.w_e * e, 2),
    }


def comprehension(a: float, r: float, h: float, k: float, e: float, w: Weights) -> float:
    raw = w.w_a * (1 - a) + w.w_r * r + w.w_h * (h * k) + w.w_e * e
    return round(100 * clamp(raw), 2)


def risk(criticality: float, comp: float) -> float:
    return round(clamp(criticality) * (100 - comp), 2)


def _wmean(pairs: Iterable[tuple[float, int]]) -> float:
    pairs = list(pairs)
    total = sum(w for _, w in pairs)
    return sum(v * w for v, w in pairs) / total if total else 0.0


def aggregate_modules(scores: list[FileScore], active: Mapping[str, bool]) -> list[ModuleScore]:
    groups: dict[str, list[FileScore]] = defaultdict(list)
    for f in scores:
        groups[f.module].append(f)
    out: list[ModuleScore] = []
    for module, files in groups.items():
        holders: set[str] = set()
        for f in files:
            holders.update(o.contributor_id for o in f.top_owners if o.share >= 0.1)
            holders.update(t.contributor_id for t in f.touchers)
        out.append(
            ModuleScore(
                module=module,
                files=len(files),
                loc=sum(f.loc for f in files),
                ai_line_share=round(_wmean((f.ai_line_share, f.loc) for f in files), 4),
                comprehension=round(_wmean((f.comprehension or 0.0, f.loc) for f in files), 2),
                criticality=round(_wmean((f.criticality or 0.0, f.loc) for f in files), 4),
                risk=round(_wmean((f.risk or 0.0, f.loc) for f in files), 2),
                active_knowledge_holders=sum(1 for h in holders if active.get(h, False)),
            )
        )
    return sorted(out, key=lambda m: (-m.risk, m.module))


def snapshot(
    repo_id: str, as_of: datetime, head: str, scores: list[FileScore], modules: list[ModuleScore]
) -> Snapshot:
    return Snapshot(
        repo_id=repo_id,
        taken_at=as_of,
        head_sha=head,
        repo_comprehension=round(_wmean((f.comprehension or 0.0, f.loc) for f in scores), 2),
        repo_risk=round(_wmean((f.risk or 0.0, f.loc) for f in scores), 2),
        per_module=modules,
    )
