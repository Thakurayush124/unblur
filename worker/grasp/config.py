"""Per-repo configuration. Everything here is overridable via `.grasp.json` or `--config`."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

DEFAULT_AI_TRAILER_PATTERNS = [
    r"^Co-Authored-By:.*(Claude|Copilot|Cursor|Codex|Devin|Gemini|aider)",
]
DEFAULT_AI_MESSAGE_PATTERNS = [r"Generated with", "\N{ROBOT FACE}"]
# Matched against "Name <email>" of the commit author.
# Bots are non-human (excluded from knowledge/touch); only AI *agent* bots count as AI-written.
DEFAULT_BOT_PATTERNS = [r"\[bot\]", r"noreply@anthropic\.com"]
DEFAULT_AI_BOT_PATTERNS = [
    r"(copilot|devin|claude|codex|cursor|gemini|openhands|sweep|jules|aider)[\w.-]*\[bot\]",
    r"noreply@anthropic\.com",
    r"^Copilot <\d+\+Copilot@users\.noreply\.github\.com>",
]
DEFAULT_IGNORE_GLOBS = [
    # directories (trailing slash = match any path segment)
    "node_modules/",
    "dist/",
    "build/",
    "out/",
    "vendor/",
    "third_party/",
    ".next/",
    "coverage/",
    "__pycache__/",
    ".venv/",
    "venv/",
    "target/",
    # generated / minified
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.snap",
    "*.pb.go",
    "*_pb2.py",
    "*.generated.*",
    # lockfiles
    "*.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "go.sum",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "composer.lock",
    "Gemfile.lock",
]


DEFAULT_CRITICAL_PATH_PATTERNS = [
    r"auth|login|session|payment|billing|crypto|migration|schema|permission|token",
]


class Weights(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)
    w_a: float = 0.30
    w_r: float = 0.20
    w_h: float = 0.30
    w_e: float = 0.20


class GraspConfig(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    ai_trailer_patterns: list[str] = Field(default_factory=lambda: list(DEFAULT_AI_TRAILER_PATTERNS))
    ai_message_patterns: list[str] = Field(default_factory=lambda: list(DEFAULT_AI_MESSAGE_PATTERNS))
    bot_patterns: list[str] = Field(default_factory=lambda: list(DEFAULT_BOT_PATTERNS))
    ai_bot_patterns: list[str] = Field(default_factory=lambda: list(DEFAULT_AI_BOT_PATTERNS))
    ai_pr_labels: list[str] = Field(default_factory=lambda: ["ai-generated"])
    ignore_globs: list[str] = Field(default_factory=lambda: list(DEFAULT_IGNORE_GLOBS))
    # Files under one of these roots are grouped by their first sub-directory.
    module_roots: list[str] = Field(default_factory=lambda: ["src"])
    # Globs (same syntax as ignoreGlobs) you mark as critical -> criticality 1.0
    critical_paths: list[str] = Field(default_factory=list)
    # Regexes searched in the file path -> criticality 0.9
    critical_path_patterns: list[str] = Field(default_factory=lambda: list(DEFAULT_CRITICAL_PATH_PATTERNS))
    path_criticality: float = 0.9
    fan_in_weight: float = 0.8  # criticality = fan_in_weight * fan-in percentile
    churn_weight: float = 0.6  # criticality = churn_weight * churn percentile
    churn_days: int = 90
    criticality_floor: float = 0.1
    # Import specifier prefixes mapped to repo paths (e.g. TS path aliases)
    import_aliases: dict[str, str] = Field(default_factory=lambda: {"@/": "src/", "~/": "src/"})
    # Opt-in LLM criticality. ALSO requires env GRASP_ALLOW_LLM_CODE=true.
    llm_criticality: bool = False
    llm_max_files: int = 200
    weights: Weights = Field(default_factory=Weights)
    touch_half_life_days: float = 120.0
    risk_threshold: float = 60.0
    active_days: int = 90
    max_file_lines: int = 20_000
    blame_workers: int = Field(default_factory=lambda: min(16, (os.cpu_count() or 4) * 2))

    @classmethod
    def load(
        cls,
        repo_path: str | Path,
        explicit: str | Path | None = None,
        overrides: dict[str, Any] | None = None,
    ) -> GraspConfig:
        """Defaults < `<repo>/.grasp.json` (or `explicit`) < dashboard `overrides`."""
        path = Path(explicit) if explicit else Path(repo_path) / ".grasp.json"
        data: dict[str, Any] = {}
        if path.is_file():
            data = json.loads(path.read_text(encoding="utf-8"))
        elif explicit:
            raise FileNotFoundError(f"config file not found: {path}")
        data.update(overrides or {})
        return cls.model_validate(data)

    def dump(self) -> dict[str, Any]:
        out: dict[str, Any] = self.model_dump(by_alias=True)
        return out
