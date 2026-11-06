from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from grasp.config import GraspConfig
from grasp.criticality.heuristics import heuristic_criticality, percentiles
from grasp.criticality.imports import fan_in
from grasp.criticality.llm import build_prompt, classify, exported_symbols, llm_allowed
from grasp.llm_client import (
    GeminiClient,
    LlmError,
    OpenAICompatClient,
    extract_json,
    get_client,
)
from grasp.models import LlmAuditEntry, LlmCacheEntry

NOW = datetime(2026, 11, 1, tzinfo=UTC)


# ---- path heuristics + percentiles -------------------------------------------
def test_path_heuristics_and_floor() -> None:
    cfg = GraspConfig()
    c = heuristic_criticality(
        ["src/auth/login.ts", "src/ui/Button.tsx", "db/Migrations/001.sql"], {}, {}, cfg
    )
    assert c["src/auth/login.ts"].value == 0.9
    assert c["src/auth/login.ts"].reasons == ["path matches 'auth'"]
    assert c["db/Migrations/001.sql"].value == 0.9  # case-insensitive
    assert c["src/ui/Button.tsx"].value == cfg.criticality_floor


def test_configured_critical_paths_win() -> None:
    cfg = GraspConfig(critical_paths=["src/ledger/"], critical_path_patterns=[])
    c = heuristic_criticality(["src/ledger/post.py", "src/x.py"], {}, {}, cfg)
    assert c["src/ledger/post.py"].value == 1.0
    assert c["src/x.py"].value == cfg.criticality_floor


def test_percentiles_ignore_zeros() -> None:
    p = percentiles({"a": 0, "b": 1, "c": 1, "d": 5, "e": 10})
    assert p == {"a": 0.0, "b": 0.5, "c": 0.5, "d": 0.75, "e": 1.0}
    assert percentiles({"a": 0}) == {"a": 0.0}


def test_fan_in_and_churn_scaled() -> None:
    cfg = GraspConfig(critical_path_patterns=[])
    paths = ["core.py", "leaf.py", "hot.py"]
    c = heuristic_criticality(paths, {"core.py": 20, "leaf.py": 1}, {"hot.py": 12}, cfg)
    assert c["core.py"].value == pytest.approx(0.8)
    assert c["core.py"].reasons[0].startswith("imported by 20 files")
    assert c["leaf.py"].value == pytest.approx(0.4)
    assert c["hot.py"].value == pytest.approx(0.6)
    assert "12 commits in 90d" in c["hot.py"].reasons[0]


# ---- import graph --------------------------------------------------------------
def test_js_ts_fan_in() -> None:
    files = {
        "src/lib/db.ts",
        "src/lib/index.ts",
        "src/a.ts",
        "src/b.tsx",
        "src/c.js",
        "src/d.mjs",
    }
    contents = {
        "src/a.ts": "import { q } from './lib/db';\nimport x from '@/lib';",
        "src/b.tsx": "import type { Q } from './lib/db.js'\nexport * from './a'",
        "src/c.js": "const db = require('./lib/db')\nimport('react')",
        "src/d.mjs": "import './lib/db.ts'; import lodash from 'lodash'",
        "src/lib/index.ts": "export { q } from './db'",
    }
    fi = fan_in(contents, files, {"@/": "src/"})
    assert fi["src/lib/db.ts"] == 5  # a, b, c, d, lib/index
    assert fi["src/lib/index.ts"] == 1  # via alias
    assert fi["src/a.ts"] == 1


def test_python_fan_in() -> None:
    files = {
        "app/__init__.py",
        "app/models.py",
        "app/services/billing.py",
        "app/services/__init__.py",
        "app/api.py",
        "scripts/run.py",
    }
    contents = {
        "app/api.py": "from app.models import User\nfrom .services import billing\n",
        "app/services/billing.py": "from ..models import Invoice\nimport app.models as m\n",
        "scripts/run.py": "import app.api, os\nfrom app.services.billing import charge\n",
    }
    fi = fan_in(contents, files, {})
    assert fi["app/models.py"] == 2  # api, billing (counted once despite two imports)
    assert fi["app/services/billing.py"] == 2  # api (submodule), run
    assert fi["app/api.py"] == 1


# ---- LLM criticality ----------------------------------------------------------------
class FakeClient:
    provider, model = "fake", "fake-1"

    def __init__(self, reply: str = '{"criticality": 0.95, "reason": "handles refunds"}') -> None:
        self.reply = reply
        self.prompts: list[str] = []

    def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        self.prompts.append(prompt)
        return self.reply


def test_llm_double_opt_in() -> None:
    assert not llm_allowed(GraspConfig(), {"GRASP_ALLOW_LLM_CODE": "true"})
    assert not llm_allowed(GraspConfig(llm_criticality=True), {})
    assert llm_allowed(GraspConfig(llm_criticality=True), {"GRASP_ALLOW_LLM_CODE": "true"})


def test_prompt_sends_minimum_context() -> None:
    src = "".join(f"line{i}\n" for i in range(100)) + "def public_fn():\n    pass\ndef _private():\n"
    prompt = build_prompt("src/pay.py", src)
    assert "line59" in prompt and "line60" not in prompt
    assert "public_fn" in prompt and "_private" not in prompt
    assert exported_symbols("a.ts", "export async function go() {}\nexport const X = 1") == ["X", "go"]


def test_classify_caches_and_audits() -> None:
    cache: dict[str, LlmCacheEntry] = {}
    audit: list[LlmAuditEntry] = []
    fake = FakeClient()
    contents = {"a.py": "x = 1\n", "b.py": "y = 2\n"}
    v, errors = classify(["a.py", "b.py"], contents, cache, audit, "r", NOW, lambda: fake)
    assert errors == [] and v["a.py"].criticality == 0.95
    assert [a.path for a in audit] == ["a.py", "b.py"]
    assert audit[0].bytes_sent == len(fake.prompts[0].encode()) and audit[0].provider == "fake"
    # second run: same content -> served from cache, no new call or audit entry
    classify(["a.py", "b.py"], contents, cache, audit, "r", NOW, lambda: fake)
    assert len(fake.prompts) == 2 and len(audit) == 2


def test_classify_bad_reply_and_clamp() -> None:
    audit: list[LlmAuditEntry] = []
    v, errors = classify(["a.py"], {"a.py": "x"}, {}, audit, "r", NOW, lambda: FakeClient("nope"))
    assert v == {} and errors and len(audit) == 1  # the call is still audited
    v, _ = classify(["a.py"], {"a.py": "x"}, {}, [], "r", NOW, lambda: FakeClient('{"criticality": 7}'))
    assert v["a.py"].criticality == 1.0


def test_classify_misconfigured_provider_stops_early() -> None:
    def boom() -> FakeClient:
        raise LlmError("no key")

    v, errors = classify(["a.py", "b.py"], {"a.py": "1", "b.py": "2"}, {}, [], "r", NOW, boom)
    assert v == {} and len(errors) == 1


# ---- llm_client --------------------------------------------------------------------
def test_get_client_providers() -> None:
    c = get_client({"GRASP_LLM_PROVIDER": "gemini", "GRASP_LLM_API_KEY": "k"})
    assert isinstance(c, GeminiClient) and c.model
    c2 = get_client(
        {
            "GRASP_LLM_PROVIDER": "openai",
            "GRASP_LLM_BASE_URL": "http://localhost:11434/v1",
            "GRASP_LLM_MODEL": "llama3.2",
        }
    )
    assert isinstance(c2, OpenAICompatClient) and c2.api_key is None and c2.model == "llama3.2"
    assert get_client({}).provider == "anthropic"
    with pytest.raises(LlmError):
        get_client({"GRASP_LLM_PROVIDER": "gemini"})
    with pytest.raises(LlmError):
        get_client({"GRASP_LLM_PROVIDER": "nope"})


def test_http_providers_parse(monkeypatch: pytest.MonkeyPatch) -> None:
    import grasp.llm_client as lc

    seen: list[tuple[str, dict[str, Any], dict[str, str]]] = []

    def fake_post(url: str, body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        seen.append((url, body, headers))
        if "generateContent" in url:
            return {"candidates": [{"content": {"parts": [{"text": '{"criticality": 0.2}'}]}}]}
        return {"choices": [{"message": {"content": "hi"}}]}

    monkeypatch.setattr(lc, "_post_json", fake_post)
    g = GeminiClient(model="m", api_key="k", base_url="https://g")
    assert g.complete("p") == '{"criticality": 0.2}'
    assert seen[0][0] == "https://g/models/m:generateContent" and seen[0][2] == {"x-goog-api-key": "k"}
    o = OpenAICompatClient(model="m", api_key="k", base_url="https://o/v1/")
    assert o.complete("p") == "hi"
    assert seen[1][0] == "https://o/v1/chat/completions"
    assert seen[1][2] == {"authorization": "Bearer k"}


def test_extract_json() -> None:
    assert extract_json('```json\n{"criticality": 0.5, "reason": "x"}\n```')["criticality"] == 0.5
    with pytest.raises(LlmError):
        extract_json("no json here")
