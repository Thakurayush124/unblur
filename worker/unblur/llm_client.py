"""Provider-agnostic LLM wrapper. One env var holds the key: UNBLUR_LLM_API_KEY.

Providers (UNBLUR_LLM_PROVIDER):
  anthropic  Claude via the official `anthropic` SDK (optional dependency, imported lazily)
  gemini     Google AI Studio REST API (has a free tier) - stdlib HTTP, no extra deps
  openai     Any OpenAI-compatible /chat/completions endpoint - stdlib HTTP, no extra deps.
             Free options: Groq, OpenRouter ":free" models, or a local Ollama
             (UNBLUR_LLM_BASE_URL=http://localhost:11434/v1, no key; code never leaves the machine).

Nothing here is called unless a feature is explicitly opted in (see criticality/llm.py).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

DEFAULT_MODELS = {
    "anthropic": "claude-opus-5-5",
    "gemini": "gemini-2.5-flash",
    "openai": "llama-3.3-70b-versatile",  # Groq's free-tier model name; override per endpoint
}
DEFAULT_BASE_URLS = {
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "openai": "https://api.groq.com/openai/v1",
}
TIMEOUT_SEC = 60


class LlmError(RuntimeError):
    pass


class LlmClient(Protocol):
    provider: str
    model: str

    def complete(self, prompt: str, max_tokens: int = 1024) -> str: ...


def _post_json(url: str, body: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            out: dict[str, Any] = json.loads(resp.read().decode("utf-8"))
            return out
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise LlmError(f"HTTP {e.code} from LLM provider: {detail}") from e
    except urllib.error.URLError as e:
        raise LlmError(f"cannot reach LLM provider: {e.reason}") from e


@dataclass
class AnthropicClient:
    model: str
    api_key: str | None
    provider: str = "anthropic"

    def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        try:
            import anthropic
        except ImportError as e:
            raise LlmError(
                "provider 'anthropic' needs the SDK: pip install anthropic "
                "(or use UNBLUR_LLM_PROVIDER=gemini / openai for a free option)"
            ) from e
        client = anthropic.Anthropic(api_key=self.api_key) if self.api_key else anthropic.Anthropic()
        try:
            msg = client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                output_config={"effort": "low"},
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.APIStatusError as e:
            raise LlmError(f"Anthropic API error {e.status_code}: {e.message}") from e
        except anthropic.APIConnectionError as e:
            raise LlmError("cannot reach the Anthropic API") from e
        if msg.stop_reason == "refusal":
            raise LlmError("model declined the request")
        return "".join(b.text for b in msg.content if b.type == "text")


@dataclass
class GeminiClient:
    model: str
    api_key: str
    base_url: str
    provider: str = "gemini"

    def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        data = _post_json(
            f"{self.base_url}/models/{self.model}:generateContent",
            {
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"maxOutputTokens": max_tokens},
            },
            {"x-goog-api-key": self.api_key},
        )
        try:
            parts = data["candidates"][0]["content"]["parts"]
            return "".join(p.get("text", "") for p in parts)
        except (KeyError, IndexError) as e:
            raise LlmError(f"unexpected Gemini response: {str(data)[:200]}") from e


@dataclass
class OpenAICompatClient:
    model: str
    api_key: str | None
    base_url: str
    provider: str = "openai"

    def complete(self, prompt: str, max_tokens: int = 1024) -> str:
        headers = {"authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        data = _post_json(
            f"{self.base_url.rstrip('/')}/chat/completions",
            {
                "model": self.model,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": prompt}],
            },
            headers,
        )
        try:
            return str(data["choices"][0]["message"]["content"] or "")
        except (KeyError, IndexError) as e:
            raise LlmError(f"unexpected response: {str(data)[:200]}") from e


def get_client(env: dict[str, str] | None = None) -> LlmClient:
    env = dict(os.environ) if env is None else env
    provider = env.get("UNBLUR_LLM_PROVIDER", "anthropic").strip().lower()
    key = env.get("UNBLUR_LLM_API_KEY") or None
    model = env.get("UNBLUR_LLM_MODEL") or DEFAULT_MODELS.get(provider, "")
    base = env.get("UNBLUR_LLM_BASE_URL") or DEFAULT_BASE_URLS.get(provider, "")
    if provider == "anthropic":
        return AnthropicClient(model=model, api_key=key)
    if provider == "gemini":
        if not key:
            raise LlmError("UNBLUR_LLM_API_KEY is required for provider 'gemini'")
        return GeminiClient(model=model, api_key=key, base_url=base)
    if provider == "openai":
        return OpenAICompatClient(model=model, api_key=key, base_url=base)
    raise LlmError(f"unknown UNBLUR_LLM_PROVIDER: {provider!r} (anthropic | gemini | openai)")


def extract_json(text: str) -> dict[str, Any]:
    """Pull the first JSON object out of a model reply (tolerates code fences / prose)."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise LlmError(f"no JSON object in reply: {text[:120]!r}")
    try:
        out: dict[str, Any] = json.loads(text[start : end + 1])
        return out
    except json.JSONDecodeError as e:
        raise LlmError(f"invalid JSON in reply: {text[:120]!r}") from e
