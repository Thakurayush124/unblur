"""Document shapes shared by the JSON and Mongo stores (camelCase on the wire)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class _Doc(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Repo(_Doc):
    id: str = Field(alias="_id")
    name: str
    source: Literal["local", "github"] = "local"
    path: str | None = None
    remote_url: str | None = None
    github_installation_id: int | None = None
    default_branch: str
    last_analyzed_at: datetime | None = None
    last_analyzed_sha: str | None = None


class Contributor(_Doc):
    id: str = Field(alias="_id")
    repo_id: str
    canonical_name: str
    emails: list[str]
    github_login: str | None = None
    is_bot: bool = False
    last_active_at: datetime
    active: bool


class Commit(_Doc):
    repo_id: str
    sha: str
    author_id: str
    author_name: str
    author_email: str
    authored_at: datetime
    message: str
    is_ai_assisted: bool
    ai_evidence: list[str] = Field(default_factory=list)
    pr_number: int | None = None
    files_changed: list[str] = Field(default_factory=list)
    parents: list[str] = Field(default_factory=list)


class Owner(_Doc):
    contributor_id: str
    share: float


class AiSource(_Doc):
    """One AI-assisted commit that still owns lines in a file (why A is what it is)."""

    sha: str
    lines: int
    evidence: list[str]


class Review(_Doc):
    reviewer_id: str
    state: Literal["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]
    submitted_at: datetime
    comment_count: int = 0
    body_length: int = 0


class PullRequest(_Doc):
    repo_id: str
    number: int
    author_id: str
    opened_at: datetime
    merged_at: datetime | None = None
    additions: int = 0
    deletions: int = 0
    labels: list[str] = Field(default_factory=list)
    commit_shas: list[str] = Field(default_factory=list)
    reviews: list[Review] = Field(default_factory=list)
    time_to_first_review_mins: float | None = None


class LearningTask(_Doc):
    repo_id: str
    path: str
    assignee_id: str
    walkthrough_md: str = ""
    quiz: list[dict[str, object]] = Field(default_factory=list)
    status: Literal["assigned", "passed", "failed"] = "assigned"
    verified_by_id: str | None = None
    completed_at: datetime | None = None


class Toucher(_Doc):
    """A human who made a non-AI commit to the file after its AI lines landed (signal H)."""

    contributor_id: str
    last_touch_at: datetime
    weight: float
    active: bool


class Signals(_Doc):
    """Raw 0..1 signal values and each one's weighted contribution to comprehension."""

    a: float
    r: float
    h: float
    k: float
    e: float
    contributions: dict[str, float]
    review_data_available: bool
    review_note: str = ""


class FileScore(_Doc):
    repo_id: str
    path: str
    module: str
    loc: int
    ai_lines: int
    ai_line_share: float
    ai_sources: list[AiSource] = Field(default_factory=list)
    top_owners: list[Owner] = Field(default_factory=list)
    review_depth: float | None = None
    human_touch: float | None = None
    retention: float | None = None
    verified: float | None = None
    comprehension: float | None = None
    criticality: float | None = None
    criticality_reasons: list[str] = Field(default_factory=list)
    risk: float | None = None
    touchers: list[Toucher] = Field(default_factory=list)
    signals: Signals | None = None
    explanation: str = ""
    computed_at: datetime


class ModuleScore(_Doc):
    module: str
    files: int
    loc: int
    ai_line_share: float
    comprehension: float
    criticality: float
    risk: float
    active_knowledge_holders: int


class Snapshot(_Doc):
    repo_id: str
    taken_at: datetime
    head_sha: str
    repo_comprehension: float
    repo_risk: float
    per_module: list[ModuleScore]


class LlmAuditEntry(_Doc):
    repo_id: str
    at: datetime
    purpose: str
    path: str
    provider: str
    model: str
    bytes_sent: int
    cached: bool = False


class LlmCacheEntry(_Doc):
    criticality: float
    reason: str


class RunStats(_Doc):
    commits_ingested: int = 0
    commits_new: int = 0
    files_analyzed: int = 0
    files_reblamed: int = 0
    files_ignored: int = 0
    duration_sec: float = 0.0
    incremental: bool = False
    llm_errors: list[str] = Field(default_factory=list)


class AnalysisResult(_Doc):
    schema_version: int = 3
    repo: Repo
    contributors: list[Contributor]
    commits: list[Commit]
    file_scores: list[FileScore]
    # path -> {sha: lineCount}; lets re-runs skip blaming unchanged files.
    blame_cache: dict[str, dict[str, int]] = Field(default_factory=dict)
    module_scores: list[ModuleScore] = Field(default_factory=list)
    snapshots: list[Snapshot] = Field(default_factory=list)
    pull_requests: list[PullRequest] = Field(default_factory=list)
    learning_tasks: list[LearningTask] = Field(default_factory=list)
    # content-hash -> LLM criticality verdict, and an append-only audit of every LLM call
    llm_cache: dict[str, LlmCacheEntry] = Field(default_factory=dict)
    llm_audit: list[LlmAuditEntry] = Field(default_factory=list)
    # The effective UnblurConfig used for this run (camelCase), shown by the dashboard.
    config: dict[str, Any] | None = None
    stats: RunStats = Field(default_factory=RunStats)
