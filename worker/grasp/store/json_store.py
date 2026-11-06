from __future__ import annotations

import json
from pathlib import Path

from pydantic import ValidationError

from grasp.models import AnalysisResult


def load(out_path: str | Path, repo_path: str | Path) -> AnalysisResult | None:
    """Load a previous result for incremental runs (only if it is for the same repo)."""
    p = Path(out_path)
    if not p.is_file():
        return None
    try:
        prev = AnalysisResult.model_validate_json(p.read_text(encoding="utf-8"))
    except (ValidationError, ValueError):
        return None
    if prev.repo.path != Path(repo_path).resolve().as_posix():
        return None
    return prev


def save(result: AnalysisResult, out_path: str | Path) -> None:
    p = Path(out_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(result.model_dump_json(by_alias=True, indent=2), encoding="utf-8")
    tmp.replace(p)


def settings_path(out_path: str | Path) -> Path:
    """Where the dashboard saves config overrides for this result file."""
    return Path(f"{out_path}.settings.json")


def load_overrides(out_path: str | Path) -> dict[str, object]:
    p = settings_path(out_path)
    if not p.is_file():
        return {}
    data = json.loads(p.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}
