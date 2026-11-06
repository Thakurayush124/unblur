"""Optional LLM criticality classification.

Double opt-in: repo setting `llmCriticality: true` AND env `UNBLUR_ALLOW_LLM_CODE=true`.
Sends ONLY: file path, first 60 lines, exported symbol names. Results are cached by content
hash; every real call is appended to the audit log (file, bytes sent, provider, model).
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Callable, Mapping
from datetime import datetime

from unblur.config import UnblurConfig
from unblur.llm_client import LlmClient, LlmError, extract_json, get_client
from unblur.models import LlmAuditEntry, LlmCacheEntry

HEAD_LINES = 60
_PY_EXPORT = re.compile(r"^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)", re.MULTILINE)
_JS_EXPORT = re.compile(
    r"^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+(\w+)",
    re.MULTILINE,
)

PROMPT = """You rate how critical a source file is to a software system's correctness and safety.
Critical = auth, payments, data integrity, security, migrations, core business rules.
Reply with ONLY a JSON object: {{"criticality": <number 0..1>, "reason": "<max 15 words>"}}

Path: {path}
Exported symbols: {symbols}
First {n} lines:
```
{head}
```"""


def llm_allowed(cfg: UnblurConfig, env: Mapping[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    return cfg.llm_criticality and env.get("UNBLUR_ALLOW_LLM_CODE", "").lower() == "true"


def exported_symbols(path: str, src: str) -> list[str]:
    if path.endswith(".py"):
        names = [n for n in _PY_EXPORT.findall(src) if not n.startswith("_")]
    else:
        names = _JS_EXPORT.findall(src)
    return sorted(set(names))[:50]


def build_prompt(path: str, src: str) -> str:
    head = "\n".join(src.splitlines()[:HEAD_LINES])
    symbols = ", ".join(exported_symbols(path, src)) or "(none found)"
    return PROMPT.format(path=path, symbols=symbols, n=HEAD_LINES, head=head)


def content_hash(src: str) -> str:
    return hashlib.sha256(src.encode("utf-8")).hexdigest()


def classify(
    candidates: list[str],
    contents: Mapping[str, str],
    cache: dict[str, LlmCacheEntry],
    audit: list[LlmAuditEntry],
    repo_id: str,
    as_of: datetime,
    client_factory: Callable[[], LlmClient] = get_client,
) -> tuple[dict[str, LlmCacheEntry], list[str]]:
    """Return ({path: verdict}, [error messages]). Mutates cache and audit in place."""
    verdicts: dict[str, LlmCacheEntry] = {}
    errors: list[str] = []
    client: LlmClient | None = None
    for path in candidates:
        src = contents.get(path)
        if src is None:
            continue
        h = content_hash(src)
        if h in cache:
            verdicts[path] = cache[h]
            continue
        try:
            client = client or client_factory()
            prompt = build_prompt(path, src)
            reply = client.complete(prompt, max_tokens=256)
            audit.append(
                LlmAuditEntry(
                    repo_id=repo_id,
                    at=as_of,
                    purpose="criticality",
                    path=path,
                    provider=client.provider,
                    model=client.model,
                    bytes_sent=len(prompt.encode("utf-8")),
                )
            )
            data = extract_json(reply)
            value = max(0.0, min(1.0, float(data.get("criticality", 0))))
            entry = LlmCacheEntry(criticality=round(value, 4), reason=str(data.get("reason", ""))[:200])
        except (LlmError, TypeError, ValueError) as e:
            errors.append(f"{path}: {e}")
            if isinstance(e, LlmError) and client is None:
                break  # misconfigured provider: don't retry for every file
            continue
        cache[h] = entry
        verdicts[path] = entry
    return verdicts, errors
