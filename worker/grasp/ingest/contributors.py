"""Collapse author identities into canonical contributors."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from grasp.ingest.commits import RawCommit

_GH_NOREPLY = re.compile(r"^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$")


@dataclass
class Identity:
    key: str
    names: dict[str, int] = field(default_factory=dict)  # name -> commit count
    emails: set[str] = field(default_factory=set)
    github_login: str | None = None
    last_active_at: datetime | None = None
    is_bot: bool = False

    @property
    def canonical_name(self) -> str:
        # most frequent name, ties broken alphabetically for determinism
        return sorted(self.names.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]

    @property
    def id(self) -> str:
        return "c_" + hashlib.sha1(self.key.encode()).hexdigest()[:12]


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # deterministic root: lexicographically smallest key
            lo, hi = sorted((ra, rb))
            self.parent[hi] = lo


def _norm_name(name: str) -> str | None:
    n = " ".join(name.lower().split())
    return n if " " in n else None  # only merge on full names, not "admin"/"dev"


def resolve(
    commits: Iterable[RawCommit],
    is_bot: Callable[[str, str], bool],
) -> tuple[dict[str, Identity], dict[str, str]]:
    """Return ({contributor id: Identity}, {email: contributor id})."""
    commits = list(commits)
    uf = _UnionFind()
    for c in commits:
        email_key = f"email:{c.author_email}"
        uf.find(email_key)
        m = _GH_NOREPLY.match(c.author_email)
        if m:
            uf.union(email_key, f"gh:{m.group(1).lower()}")
        nn = _norm_name(c.author_name)
        if nn and not is_bot(c.author_name, c.author_email):
            uf.union(email_key, f"name:{nn}")

    groups: dict[str, Identity] = {}
    for c in commits:
        root = uf.find(f"email:{c.author_email}")
        ident = groups.setdefault(root, Identity(key=root))
        ident.names[c.author_name] = ident.names.get(c.author_name, 0) + 1
        ident.emails.add(c.author_email)
        m = _GH_NOREPLY.match(c.author_email)
        if m:
            ident.github_login = m.group(1)
        if ident.last_active_at is None or c.authored_at > ident.last_active_at:
            ident.last_active_at = c.authored_at
        ident.is_bot = ident.is_bot or is_bot(c.author_name, c.author_email)

    by_id = {ident.id: ident for ident in groups.values()}
    email_to_id = {e: ident.id for ident in groups.values() for e in ident.emails}
    return by_id, email_to_id


def is_active(ident: Identity, as_of: datetime, active_days: int) -> bool:
    if ident.is_bot or ident.last_active_at is None:
        return False
    return as_of - ident.last_active_at <= timedelta(days=active_days)
