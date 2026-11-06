"""Signals H (human touch) and K (retention).

H: distinct human contributors who made non-AI commits to the file after its AI-authored
   lines landed (for a file with no AI lines: all human commits). Each contributor is
   weighted by recency of their latest such commit, half-life 120 days:
       w = 0.5 ** (age_days / 120);   H = 1 - exp(-sum(w))
K: share of that weight coming from contributors who are still active.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime

from unblur.models import Toucher

HALF_LIFE_DAYS = 120.0


@dataclass(frozen=True)
class FileCommit:
    sha: str
    author_id: str
    authored_at: datetime
    is_ai: bool


@dataclass(frozen=True)
class TouchResult:
    h: float
    k: float
    touchers: list[Toucher]


def decay(age_days: float, half_life: float = HALF_LIFE_DAYS) -> float:
    return float(0.5 ** (max(0.0, age_days) / half_life))


def human_touch(
    file_commits: Iterable[FileCommit],
    ai_landed_at: datetime | None,
    is_bot: Mapping[str, bool],
    is_active: Mapping[str, bool],
    as_of: datetime,
    half_life: float = HALF_LIFE_DAYS,
) -> TouchResult:
    latest: dict[str, datetime] = {}
    for c in file_commits:
        if c.is_ai or is_bot.get(c.author_id, False) or c.authored_at > as_of:
            continue
        if ai_landed_at is not None and c.authored_at <= ai_landed_at:
            continue
        if c.author_id not in latest or c.authored_at > latest[c.author_id]:
            latest[c.author_id] = c.authored_at

    touchers = sorted(
        (
            Toucher(
                contributor_id=cid,
                last_touch_at=at,
                weight=round(decay((as_of - at).total_seconds() / 86400, half_life), 4),
                active=is_active.get(cid, False),
            )
            for cid, at in latest.items()
        ),
        key=lambda t: (-t.weight, t.contributor_id),
    )
    total = sum(t.weight for t in touchers)
    h = 1.0 - math.exp(-total)
    k = sum(t.weight for t in touchers if t.active) / total if total else 0.0
    return TouchResult(h, k, touchers)
