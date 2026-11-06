"""Decide whether a commit is AI-assisted and record *why* (evidence strings)."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

from unblur.config import UnblurConfig
from unblur.ingest.commits import RawCommit


class AiDetector:
    def __init__(self, cfg: UnblurConfig) -> None:
        flags = re.IGNORECASE | re.MULTILINE
        self._trailers = [re.compile(p, flags) for p in cfg.ai_trailer_patterns]
        self._messages = [re.compile(p, flags) for p in cfg.ai_message_patterns]
        self._bots = [re.compile(p, re.IGNORECASE) for p in cfg.bot_patterns]
        self._ai_bots = [re.compile(p, re.IGNORECASE) for p in cfg.ai_bot_patterns]
        self._labels = {label.lower() for label in cfg.ai_pr_labels}

    def is_bot(self, name: str, email: str) -> bool:
        """Non-human account (dependency bots, CI, AI agents)."""
        ident = f"{name} <{email}>"
        return any(p.search(ident) for p in self._bots) or self.is_ai_agent(name, email)

    def is_ai_agent(self, name: str, email: str) -> bool:
        """Account that is itself an AI coding agent (its commits are AI-written)."""
        ident = f"{name} <{email}>"
        return any(p.search(ident) for p in self._ai_bots)

    def evidence(
        self,
        commit: RawCommit,
        pr_labels: Mapping[int, Sequence[str]] | None = None,
    ) -> list[str]:
        found: list[str] = []
        for p in self._trailers:
            m = p.search(commit.message)
            if m:
                line = commit.message[m.start() :].splitlines()[0].strip()
                found.append(f"trailer: {line}")
                break
        for p in self._messages:
            if p.search(commit.message):
                found.append(f"message matches /{p.pattern}/")
        if self.is_ai_agent(commit.author_name, commit.author_email):
            found.append(f"AI agent author: {commit.author_name} <{commit.author_email}>")
        pr = commit.pr_number
        if pr is not None and pr_labels:
            for label in pr_labels.get(pr, ()):
                if label.lower() in self._labels:
                    found.append(f"PR #{pr} labelled '{label}'")
        return found
