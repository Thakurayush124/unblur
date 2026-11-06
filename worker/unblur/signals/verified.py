"""Signal E: verified understanding from a passed + independently verified LearningTask.

1.0 while the verification is <= 180 days old, then linear decay to 0 at day 365.
(Phase 2: no tasks exist yet, so E = 0 everywhere. Phase 5 creates them.)
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime

from unblur.models import LearningTask

FULL_DAYS = 180
ZERO_DAYS = 365


def verified(path: str, tasks: Iterable[LearningTask], as_of: datetime) -> float:
    best = 0.0
    for t in tasks:
        if t.path != path or t.status != "passed" or t.completed_at is None:
            continue
        if t.verified_by_id is None or t.verified_by_id == t.assignee_id:
            continue
        age = (as_of - t.completed_at).total_seconds() / 86400
        if age < 0:
            continue
        if age <= FULL_DAYS:
            score = 1.0
        elif age >= ZERO_DAYS:
            score = 0.0
        else:
            score = 1.0 - (age - FULL_DAYS) / (ZERO_DAYS - FULL_DAYS)
        best = max(best, score)
    return best
