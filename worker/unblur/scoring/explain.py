"""One plain-English sentence per file, built only from stored signals and evidence.

e.g. "Critical (path matches 'auth'): 82% AI-written, merged with a 0-comment approval,
      and the only human who has touched it since left 5 months ago."
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime

from unblur.models import Toucher

CRITICAL_PREFIX_AT = 0.7


def _months(as_of: datetime, then: datetime | None) -> int:
    return max(0, (as_of - then).days // 30) if then else 0


def explain(
    *,
    ai_share: float,
    review_note: str,
    review_available: bool,
    touchers: list[Toucher],
    last_active: Mapping[str, datetime],
    criticality: float,
    criticality_reason: str | None,
    verified: float,
    as_of: datetime,
) -> str:
    parts: list[str] = []
    has_ai = ai_share >= 0.005
    if ai_share >= 0.5:
        parts.append(f"{ai_share:.0%} AI-written")
    elif has_ai:
        parts.append(f"mostly human-written ({ai_share:.0%} AI)")
    else:
        parts.append("human-written")

    if review_available and review_note:
        parts.append(review_note)

    n = len(touchers)
    k = sum(1 for t in touchers if t.active)
    if has_ai:
        if n == 0:
            parts.append("no human has touched it since")
        elif n == 1:
            t = touchers[0]
            if t.active:
                parts.append("only one human, still active, has touched it since")
            else:
                m = _months(as_of, last_active.get(t.contributor_id))
                when = f"{m} month{'s' if m != 1 else ''} ago" if m else "recently"
                parts.append(f"the only human who has touched it since left {when}")
        else:
            parts.append(f"{n} humans have touched it since ({k} still active)")
    elif n == 0:
        parts.append("no human activity on record")
    elif k == 0:
        parts.append(
            f"none of the {n} people who worked on it are still active"
            if n > 1
            else "its only author has left"
        )
    else:
        noun = "person" if n == 1 else "people"
        parts.append(f"worked on by {n} {noun} ({k} still active)")

    if verified > 0:
        parts.append("understanding was verified via a learning task")

    body = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + ", and " + parts[-1]
    if criticality >= CRITICAL_PREFIX_AT and criticality_reason:
        return f"Critical ({criticality_reason}): {body}."
    return body[0].upper() + body[1:] + "."
