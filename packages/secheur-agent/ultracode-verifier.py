#!/usr/bin/env python3
"""JSON bridge around the reusable llm-verifier package."""

from __future__ import annotations

import json
import os
import sys
from types import SimpleNamespace
from typing import Any


class WholeEndpointTransport:
    """Rewrite OpenAI's appended /chat/completions path for whole-endpoint gateways."""

    def __init__(self, endpoint: str) -> None:
        import httpx2

        self._httpx = httpx2
        self._endpoint = httpx2.URL(endpoint)
        self._transport = httpx2.HTTPTransport()

    def handle_request(self, request: Any) -> Any:
        rewritten_url = request.url.copy_with(
            scheme=self._endpoint.scheme,
            host=self._endpoint.host,
            port=self._endpoint.port,
            path=self._endpoint.path,
            query=self._endpoint.query,
        )
        rewritten = self._httpx.Request(
            request.method,
            rewritten_url,
            headers=request.headers,
            content=request.stream,
            extensions=request.extensions,
        )
        return self._transport.handle_request(rewritten)

    def close(self) -> None:
        self._transport.close()


def _response_text_parts(response: Any) -> tuple[str, list[Any]]:
    """Flatten Responses output text and its token logprob records."""
    texts: list[str] = []
    logprobs: list[Any] = []
    for output in getattr(response, "output", []) or []:
        if getattr(output, "type", None) != "message":
            continue
        for content in getattr(output, "content", []) or []:
            if getattr(content, "type", None) != "output_text":
                continue
            texts.append(getattr(content, "text", "") or "")
            for item in getattr(content, "logprobs", None) or []:
                top = [
                    SimpleNamespace(token=choice.token, logprob=choice.logprob)
                    for choice in (getattr(item, "top_logprobs", None) or [])
                ]
                logprobs.append(
                    SimpleNamespace(
                        token=getattr(item, "token", ""),
                        logprob=getattr(item, "logprob", 0.0),
                        top_logprobs=top,
                    )
                )
    return "".join(texts), logprobs


def _responses_input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate the small Chat Completions message subset used by the verifier."""
    converted: list[dict[str, Any]] = []
    for message in messages:
        content = message.get("content", "")
        if isinstance(content, list):
            parts: list[dict[str, Any]] = []
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text":
                    parts.append({"type": "input_text", "text": part.get("text", "")})
                elif part.get("type") == "image_url":
                    image = part.get("image_url") or {}
                    url = image.get("url") if isinstance(image, dict) else image
                    parts.append({"type": "input_image", "image_url": url})
            content = parts
        converted.append({"role": message.get("role", "user"), "content": content})
    return converted


class ResponsesVerifierClient:
    """Expose Responses API output through llm-verifier's chat interface."""

    def __init__(self, client: Any) -> None:
        self._client = client
        self._llm_verifier_deepseek = True
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **params: Any) -> Any:
        request: dict[str, Any] = {
            "model": params["model"],
            "input": _responses_input(params.get("messages", [])),
            "max_output_tokens": params.get("max_tokens", 4096),
            "temperature": params.get("temperature", 1.0),
            "top_logprobs": params.get("top_logprobs", 20),
            "include": ["message.output_text.logprobs"],
            "store": False,
        }
        response = self._client.responses.create(**request)
        text, logprobs = _response_text_parts(response)
        choice = SimpleNamespace(
            message=SimpleNamespace(content=text),
            logprobs=SimpleNamespace(content=logprobs) if logprobs else None,
            finish_reason=getattr(response, "status", None),
        )
        return SimpleNamespace(choices=[choice], usage=getattr(response, "usage", None))


def build_client(api_key: str, base_url: str, headers: dict[str, str], api: str) -> Any:
    from openai import OpenAI

    if os.environ.get("ULTRACODE_VERIFIER_WHOLE_ENDPOINT") != "1":
        client = OpenAI(api_key=api_key, base_url=base_url, default_headers=headers or None)
        return ResponsesVerifierClient(client) if api == "openai-responses" else client

    import httpx2

    transport = WholeEndpointTransport(base_url)
    http_client = httpx2.Client(transport=transport)
    client = OpenAI(api_key=api_key, base_url=base_url, default_headers=headers or None, http_client=http_client)
    return ResponsesVerifierClient(client) if api == "openai-responses" else client


def main() -> int:
    try:
        import llm_verifier

        request: dict[str, Any] = json.load(sys.stdin)
        headers = json.loads(os.environ.get("ULTRACODE_VERIFIER_HEADERS", "{}"))
        client = build_client(
            os.environ.get("ULTRACODE_VERIFIER_API_KEY") or "unused",
            os.environ["ULTRACODE_VERIFIER_BASE_URL"],
            headers,
            os.environ.get("ULTRACODE_VERIFIER_API", "openai-completions"),
        )
        result = llm_verifier.select(
            problem=request["problem"],
            candidates=[candidate["transcript"] for candidate in request["candidates"]],
            criteria=request["criteria"],
            model=request.get("model") or os.environ["ULTRACODE_VERIFIER_MODEL"],
            n_evaluations=int(request.get("nEvaluations", 4)),
            pivots=int(request.get("pivots", 2)),
            max_workers=int(request.get("maxWorkers", 8)),
            seed=int(request.get("seed", 0)),
            cache=request.get("cache"),
            progress=False,
            on_error="raise",
            client=client,
        )
        print(
            json.dumps(
                {
                    "index": result.index,
                    "best": result.best,
                    "scores": result.scores,
                    "ranking": result.ranking,
                    "n_comparisons": result.n_comparisons,
                    "criteria": result.criteria,
                },
                ensure_ascii=True,
            )
        )
        return 0
    except Exception as error:  # noqa: BLE001 - the Node caller needs one actionable error.
        print(f"ultracode verifier failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
