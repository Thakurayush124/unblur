from __future__ import annotations

from datetime import UTC, datetime

import pytest

from grasp.config import GraspConfig
from grasp.ingest.ai_detect import AiDetector
from grasp.ingest.commits import RawCommit


def _c(message: str, name: str = "Alice", email: str = "a@x.com") -> RawCommit:
    return RawCommit("a" * 40, [], name, email, datetime(2026, 1, 1, tzinfo=UTC), message)


@pytest.mark.parametrize(
    "trailer",
    [
        "Co-Authored-By: Claude <noreply@anthropic.com>",
        "co-authored-by: claude opus <noreply@anthropic.com>",
        "Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>",
        "Co-Authored-By: Cursor Agent <cursoragent@cursor.com>",
        "Co-Authored-By: Codex <codex@openai.com>",
        "Co-Authored-By: Devin AI <devin@cognition.ai>",
        "Co-Authored-By: Gemini <gemini@google.com>",
        "Co-authored-by: aider (gpt-4o) <noreply@aider.chat>",
    ],
)
def test_trailers_detected(trailer: str) -> None:
    ev = AiDetector(GraspConfig()).evidence(_c(f"Fix bug\n\n{trailer}"))
    assert ev and ev[0].startswith("trailer:")
    assert trailer.split(":", 1)[1].strip() in ev[0]


def test_human_coauthor_not_detected() -> None:
    ev = AiDetector(GraspConfig()).evidence(_c("Pair\n\nCo-Authored-By: Bob <bob@x.com>"))
    assert ev == []


def test_trailer_must_start_line() -> None:
    ev = AiDetector(GraspConfig()).evidence(_c("Docs: explain Co-Authored-By: Claude usage"))
    assert ev == []


def test_message_patterns() -> None:
    d = AiDetector(GraspConfig())
    assert d.evidence(_c("Add x\n\nGenerated with Claude Code"))
    assert d.evidence(_c("\N{ROBOT FACE} refactor"))
    assert d.evidence(_c("Plain change")) == []


def test_custom_regex() -> None:
    cfg = GraspConfig(ai_message_patterns=[r"\[ai\]"])
    d = AiDetector(cfg)
    assert d.evidence(_c("[AI] scaffold module")) == ["message matches /\\[ai\\]/"]
    assert d.evidence(_c("Generated with Claude Code")) == []


def test_bot_authors() -> None:
    d = AiDetector(GraspConfig())
    # Dependency / CI bots are non-human but NOT AI-written
    dep = ("dependabot[bot]", "49699333+dependabot[bot]@users.noreply.github.com")
    assert d.is_bot(*dep) and d.evidence(_c("Bump", *dep)) == []
    assert d.is_bot("pre-commit-ci[bot]", "66853113+pre-commit-ci[bot]@users.noreply.github.com")
    # AI coding agents are both
    for agent in [
        ("copilot-swe-agent[bot]", "198982749+copilot-swe-agent[bot]@users.noreply.github.com"),
        ("devin-ai-integration[bot]", "158243242+devin-ai-integration[bot]@users.noreply.github.com"),
        ("Copilot", "198982749+Copilot@users.noreply.github.com"),
        ("Claude", "noreply@anthropic.com"),
    ]:
        assert d.is_bot(*agent)
        ev = d.evidence(_c("x", *agent))
        assert ev and ev[0].startswith("AI agent author:"), agent
    # GitHub web-UI commits by humans also use users.noreply.github.com: not a bot
    assert not d.is_bot("Alice", "123+alice@users.noreply.github.com")
    assert d.evidence(_c("x", "Alice", "123+alice@users.noreply.github.com")) == []


def test_pr_label() -> None:
    d = AiDetector(GraspConfig())
    c = _c("Add feature (#12)")
    assert d.evidence(c, {12: ["AI-Generated"]}) == ["PR #12 labelled 'AI-Generated'"]
    assert d.evidence(c, {12: ["bug"]}) == []
    assert d.evidence(_c("Merge pull request #7 from x/y"), {7: ["ai-generated"]})


def test_multiple_evidence_collected() -> None:
    ev = AiDetector(GraspConfig()).evidence(
        _c("x\n\n\N{ROBOT FACE} Generated with Claude Code\n\nCo-Authored-By: Claude <n@a.com>")
    )
    assert len(ev) == 3
