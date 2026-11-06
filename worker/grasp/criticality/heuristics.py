"""Heuristic criticality = max(path match, fan-in percentile, churn percentile, floor)."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field

from grasp.config import GraspConfig
from grasp.ingest.files import IgnoreMatcher


@dataclass
class Criticality:
    value: float
    reasons: list[str] = field(default_factory=list)

    def bump(self, value: float, reason: str) -> None:
        if value > self.value + 1e-9:
            self.value = value
            self.reasons.insert(0, reason)
        elif value > 0:
            self.reasons.append(reason)


def percentiles(values: Mapping[str, int]) -> dict[str, float]:
    """Percentile among non-zero values: (#non-zero values <= v) / #non-zero. Zero -> 0."""
    nz = sorted(v for v in values.values() if v > 0)
    if not nz:
        return dict.fromkeys(values, 0.0)
    import bisect

    n = len(nz)
    return {k: (bisect.bisect_right(nz, v) / n if v > 0 else 0.0) for k, v in values.items()}


def heuristic_criticality(
    paths: list[str],
    fan_in: Mapping[str, int],
    churn: Mapping[str, int],
    cfg: GraspConfig,
) -> dict[str, Criticality]:
    pats = [re.compile(p, re.IGNORECASE) for p in cfg.critical_path_patterns]
    marked = IgnoreMatcher(cfg.critical_paths)
    fan_pct = percentiles({p: fan_in.get(p, 0) for p in paths})
    churn_pct = percentiles({p: churn.get(p, 0) for p in paths})
    out: dict[str, Criticality] = {}
    for p in paths:
        c = Criticality(cfg.criticality_floor, [])
        if cfg.critical_paths and marked(p):
            c.bump(1.0, "configured critical path")
        for pat in pats:
            m = pat.search(p)
            if m:
                c.bump(cfg.path_criticality, f"path matches '{m.group(0).lower()}'")
                break
        if fan_in.get(p, 0):
            c.bump(
                cfg.fan_in_weight * fan_pct[p],
                f"imported by {fan_in[p]} files, p{round(fan_pct[p] * 100)}",
            )
        if churn.get(p, 0):
            n = churn[p]
            c.bump(
                cfg.churn_weight * churn_pct[p],
                f"{n} commit{'s' if n != 1 else ''} in {cfg.churn_days}d, p{round(churn_pct[p] * 100)}",
            )
        c.value = round(min(1.0, c.value), 4)
        out[p] = c
    return out
