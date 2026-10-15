# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The OpenAI SDK factory -- ONE module for the whole family.

The factory binds deployment config + base_url into an :class:`OpenaiSdk`
whose surface covers everything the family can do: the two chat wire
shapes (``openai.chat_completions`` and ``openai.responses`` -- the bare
``openai`` sdk value points at the Responses shape), native structured
output in two tiers, the embeddings API (the embedding service's
``embed()``), and the Decisions API (the decision service's
``decide()`` -- OpenAI's ``/v1/decisions`` endpoint, the second
decision family beside ``sdk/typesafe.py``).  The wire internals port
from the former dialect modules unchanged -- only the binding moved.
"""

import json
import logging
import queue
import threading
import time
import typing as t

from .. import caching, usage
from ..config import (
    dimensions,
    embedding_passthrough,
    extra_body,
    extra_headers,
    params,
    reasoning_passback,
)
from . import clients
from .base import system_of

logger = logging.getLogger(__name__)

CHAT_KIND = "openai.chat_completions"
RESPONSES_KIND = "openai.responses"
JSON_TIERS = 2

DECISIONS_INSTRUCTIONS_MAX = 2000
"""One decision question's instruction cap (the parse layer caps at 400;
the framework's own gates write longer ones -- still one sentence each)."""


def _chat_wire_messages(cfg: dict[str, t.Any], messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The canonical conversation in chat-completions wire shape: the dicts
    go over the wire verbatim EXCEPT the internal ``reasoning_blocks`` /
    ``thought_signature`` keys are stripped, and an assistant turn that
    reasoned echoes its ``reasoning_content`` back when the deployment
    asked for it (``zjsearch.llm.reasoning_passback: true``)."""
    passback = reasoning_passback(cfg)
    out: list[dict[str, t.Any]] = []
    for message in messages:
        wire = {k: v for k, v in message.items() if k not in ("reasoning_blocks", "thought_signature")}
        for tc in wire.get("tool_calls") or []:
            if isinstance(tc, dict):
                tc.pop("thought_signature", None)
        if wire.get("role") == "assistant" and message.get("encrypted_content"):
            # doubao's encrypted 思考原文: tool loops MUST echo it back
            # verbatim, and it takes priority over the summary text
            wire["encrypted_content"] = message["encrypted_content"]
        if passback and wire.get("role") == "assistant" and wire.get("tool_calls") and message.get("reasoning_blocks"):
            wire["reasoning_content"] = "\n\n".join(
                str(b.get("text") or "") for b in message["reasoning_blocks"] if b.get("text")
            )
        out.append(wire)
    return out


async def _chat_pump(  # pylint: disable=too-many-branches, too-many-locals
    sdk: "OpenaiSdk",
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None,
) -> None:
    """The chat-completions wire shape: relay ``delta.content``, plus the
    deepseek-style ``reasoning_content`` / openrouter-style ``reasoning``
    extras as think events when ``relay_reasoning`` is set.  With tool
    specs, ``delta.tool_calls`` fragments (keyed by index) accumulate into
    one ``("tool_calls", calls)`` event that closes a clean turn.  The
    stream's ``finish_reason`` and the usage chunk land in one terminal
    ``("finish", meta)`` event.  The usage chunk rides ``stream_options``
    include_usage per the OpenAI contract -- whatever the endpoint reports
    (cache hits included) is rendered; one that rejects the parameter
    outright still streams -- one retry without it, stats simply absent."""
    from openai import (
        BadRequestError,
        UnprocessableEntityError,
    )  # pylint: disable=import-outside-toplevel

    cfg = sdk.cfg
    client = clients.openai_client(cfg, sdk.base, family=sdk.family)
    extra = {"tools": [{"type": "function", "function": tool} for tool in tools]} if tools else {}
    kwargs: dict[str, t.Any] = {
        "model": str(cfg.get("model")),
        "messages": _chat_wire_messages(cfg, messages),
        "stream": True,
        "timeout": clients.sdk_timeout(),
        "extra_headers": extra_headers(cfg),
        "extra_body": caching.cache_body(cfg),
        **caching.model_kwargs(params(cfg), CHAT_KIND),
        **extra,
        "stream_options": {"include_usage": True},
    }
    try:
        stream = await client.chat.completions.create(**kwargs)
    except (BadRequestError, UnprocessableEntityError):
        kwargs.pop("stream_options", None)
        stream = await client.chat.completions.create(**kwargs)
    calls: dict[int, dict[str, str]] = {}
    finish: str | None = None
    usage_meta: dict[str, t.Any] | None = None
    model: str | None = None
    encrypted = ""
    try:
        async for chunk in stream:
            if model is None:
                # the API-REPORTED model id (riders on every chunk, the
                # usage chunk included) -- what the endpoint actually ran,
                # not what we asked for
                model = str(getattr(chunk, "model", "") or "") or None
            if getattr(chunk, "usage", None) is not None:
                usage_meta = usage.openai_usage(chunk.usage)
            if not chunk.choices:
                continue
            choice = chunk.choices[0]
            if choice.finish_reason:
                finish = str(choice.finish_reason)
            delta = choice.delta
            if delta is None:
                continue
            # doubao's 思考内容加密原文 (the encrypted reasoning that tool
            # loops MUST echo back verbatim) rides the reasoning deltas
            enc = getattr(delta, "encrypted_content", None)
            if enc:
                encrypted += str(enc)
            if relay_reasoning:
                reasoning = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
                if reasoning:
                    events.put(("think", str(reasoning)))
            if delta.content:
                events.put(("delta", str(delta.content)))
            for tc in delta.tool_calls or []:
                slot = calls.setdefault(
                    tc.index if tc.index is not None else 0,
                    {"id": "", "name": "", "arguments": ""},
                )
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] = tc.function.name
                if tc.function and tc.function.arguments:
                    slot["arguments"] += tc.function.arguments
        if calls:
            events.put(("tool_calls", [calls[index] for index in sorted(calls)]))
        events.put(
            (
                "finish",
                {
                    "finish": finish,
                    "usage": usage_meta,
                    "encrypted_content": encrypted or None,
                    "model": model,
                },
            )
        )
    finally:
        await stream.close()


def _responses_message(message: dict[str, t.Any]) -> dict[str, t.Any]:
    """One chat message in Responses-API input shape (``input_text`` /
    ``input_image`` content parts); string content passes through."""
    content = message.get("content")
    if not isinstance(content, list):
        return message
    parts: list[t.Any] = []
    for part in content:
        if part.get("type") == "text":
            parts.append({"type": "input_text", "text": part.get("text")})
        elif part.get("type") == "image_url":
            parts.append(
                {
                    "type": "input_image",
                    "image_url": (part.get("image_url") or {}).get("url"),
                }
            )
        else:
            parts.append(part)
    return {**message, "content": parts}


def _responses_input(messages: list[dict[str, t.Any]]) -> list[dict[str, t.Any]]:
    """The whole conversation as Responses-API input items: canonical
    assistant tool calls become ``function_call`` items, ``tool`` results
    become ``function_call_output`` items.  A reasoning turn's captured
    reasoning items (encrypted content included) are echoed back VERBATIM
    ahead of the function calls -- the API enforces the pairing."""
    items: list[dict[str, t.Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        calls = message.get("tool_calls")
        if calls:
            for reasoning_item in message.get("reasoning_items") or []:
                if isinstance(reasoning_item, dict) and reasoning_item.get("type") == "reasoning":
                    items.append(reasoning_item)
            text = message.get("content")
            if text:
                items.append(
                    {
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": str(text)}],
                    }
                )
            for tc in calls:
                fn = tc.get("function") or {}
                items.append(
                    {
                        "type": "function_call",
                        "call_id": str(tc.get("id") or ""),
                        "name": str(fn.get("name") or ""),
                        "arguments": str(fn.get("arguments") or "{}"),
                    }
                )
            continue
        if role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": str(message.get("tool_call_id") or ""),
                    "output": str(message.get("content") or ""),
                }
            )
            continue
        items.append(_responses_message(message))
    return items


async def _responses_pump(  # pylint: disable=too-many-branches, too-many-locals
    sdk: "OpenaiSdk",
    messages: list[dict[str, t.Any]],
    events: "queue.Queue[tuple[str, t.Any]]",
    relay_reasoning: bool,
    tools: list[dict[str, t.Any]] | None,
) -> None:
    """The Responses-API wire shape: relay the output text deltas, the
    reasoning text / summary deltas as think events.  Function-call items
    stream as ``output_item.added`` + ``function_call_arguments.delta``
    fragments.  The terminal response event's status and usage land in one
    ``("finish", meta)`` event (``max_output_tokens`` maps to ``length``)."""
    cfg = sdk.cfg
    client = clients.openai_client(cfg, sdk.base, family=sdk.family)
    extra: dict[str, t.Any] = {"tools": [dict(tool, type="function") for tool in tools]} if tools else {}
    stream = await client.responses.create(
        model=str(cfg.get("model")),
        input=_responses_input(messages),
        instructions=system_of(messages) or None,
        stream=True,
        timeout=clients.sdk_timeout(),
        extra_headers=extra_headers(cfg),
        extra_body=caching.cache_body(cfg),
        **caching.model_kwargs(params(cfg), RESPONSES_KIND),
        **extra,
    )
    calls: dict[str, dict[str, str]] = {}
    order: list[str] = []
    finish: str | None = None
    usage_meta: dict[str, t.Any] | None = None
    model: str | None = None
    reasoning_items: list[dict[str, t.Any]] = []
    try:
        async for event in stream:
            event_type = getattr(event, "type", "")
            if event_type == "response.output_text.delta":
                if event.delta:
                    events.put(("delta", str(event.delta)))
            elif relay_reasoning and event_type in (
                "response.reasoning_text.delta",
                "response.reasoning_summary_text.delta",
            ):
                if event.delta:
                    events.put(("think", str(event.delta)))
            elif event_type in ("response.completed", "response.incomplete"):
                response = getattr(event, "response", None)
                if response is not None:
                    # the API-REPORTED model id (what the endpoint actually ran)
                    model = str(getattr(response, "model", "") or "") or None
                    if getattr(response, "usage", None) is not None:
                        usage_meta = usage.openai_usage(response.usage)
                    # the REASONING output items ride the terminal response --
                    # function-calling turns must ECHO them back on the next
                    # request (the API enforces the pairing), so capture them
                    # verbatim for the canonical history
                    for output in getattr(response, "output", None) or []:
                        if str(getattr(output, "type", "") or "") == "reasoning":
                            try:
                                reasoning_items.append(output.model_dump(exclude_none=True))
                            except Exception:  # pylint: disable=broad-except
                                pass
                    incomplete = getattr(response, "incomplete_details", None)
                    reason = str(getattr(incomplete, "reason", "") or "") if incomplete else ""
                    finish = "length" if reason == "max_output_tokens" else (reason or "stop")
            elif event_type == "response.output_item.added":
                item = getattr(event, "item", None)
                if item is not None and getattr(item, "type", "") == "function_call":
                    item_id = str(item.id)
                    calls[item_id] = {
                        "id": str(getattr(item, "call_id", "") or item_id),
                        "name": str(item.name or ""),
                        "arguments": "",
                    }
                    order.append(item_id)
            elif event_type == "response.function_call_arguments.delta":
                slot = calls.get(str(getattr(event, "item_id", "")))
                if slot is not None and event.delta:
                    slot["arguments"] += str(event.delta)
        if calls:
            events.put(("tool_calls", [calls[item_id] for item_id in order]))
        events.put(
            (
                "finish",
                {
                    "finish": finish,
                    "usage": usage_meta,
                    "reasoning_items": reasoning_items or None,
                    "model": model,
                },
            )
        )
    finally:
        await stream.close()


def _decisions_field(obj: t.Any, key: str, default: t.Any = None) -> t.Any:
    """One field off a Decisions response: the SDK hands back pydantic
    models and plain dicts interchangeably -- both read through here."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        value = obj.get(key, default)
        return default if value is None else value
    value = getattr(obj, key, default)
    return default if value is None else value


def _decisions_text(value: t.Any) -> str:
    """One decision criteria value (str | dict | list) as instruction
    text."""
    return value.strip() if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _decisions_instructions(question: dict[str, t.Any]) -> str:
    """The Decisions wire requires ``instructions`` on every question:
    the wire's own first, then a noul's true/false criteria composed in,
    then a generic floor."""
    text = str(question.get("instructions") or "").strip()
    if text:
        return text[:DECISIONS_INSTRUCTIONS_MAX]
    criteria = question.get("criteria")
    if isinstance(criteria, dict) and criteria:
        parts = [
            f"{side}: {_decisions_text(criteria[side])}" for side in ("true", "false") if criteria.get(side) is not None
        ]
        if parts:
            return "; ".join(parts)[:DECISIONS_INSTRUCTIONS_MAX]
    return "Judge the provided input."


def _decisions_question(name: str, question: dict[str, t.Any]) -> dict[str, t.Any] | None:
    """One wire question in Decisions shape, or ``None`` when the question
    cannot be expressed there (a choice without >= 2 options, a score
    without >= 2 levels -- the API would 400 the WHOLE request for one
    malformed question, so the unusable one drops instead; its answer
    simply stays absent, the consumers' fail-open)."""
    kind = str(question.get("type") or "")
    wire: dict[str, t.Any] = {
        "type": "predicate" if kind == "noul" else kind,
        "name": name,
        "instructions": _decisions_instructions(question),
    }
    criteria = question.get("criteria")
    if kind == "choice":
        if not isinstance(criteria, dict) or len(criteria) < 2:
            return None
        choices: list[dict[str, t.Any]] = []
        for option, description in criteria.items():
            choice: dict[str, t.Any] = {"value": str(option)}
            text = _decisions_text(description)
            if text:
                choice["description"] = text
            choices.append(choice)
        wire["choices"] = choices
    elif kind == "score":
        if not isinstance(criteria, list) or len(criteria) < 2:
            return None
        wire["levels"] = [{"label": _decisions_text(level)[:200]} for level in criteria]
    elif kind != "noul":
        return None
    return wire


def _decisions_answer(raw: t.Any) -> tuple[str, dict[str, t.Any]] | None:
    """One Decisions answer downgraded into the canonical named-verdict
    shape (same JSON-safe dicts the typesafe family's models dump), or
    ``None`` when unusable (no name, unknown type, malformed fields --
    one bad answer drops, the rest still land)."""
    name = str(_decisions_field(raw, "name") or "").strip()
    kind = _decisions_field(raw, "type")
    if not name:
        return None
    if kind == "predicate":
        # the yes/no probability IS the condition probability
        return name, {
            "type": "noul",
            "noul": round(float(_decisions_field(raw, "probability", 0.0)), 4),
        }
    if kind == "choice":
        probabilities = {
            str(_decisions_field(option, "value")): round(float(_decisions_field(option, "probability", 0.0)), 4)
            for option in _decisions_field(raw, "probabilities") or []
        }
        return name, {
            "type": "choice",
            "choice": str(_decisions_field(raw, "choice") or ""),
            "confidence": round(float(_decisions_field(raw, "confidence", 0.0)), 4),
            "probabilities": probabilities,
        }
    if kind == "score":
        legend: dict[str, str] = {}
        probabilities = {}
        for option in _decisions_field(raw, "probabilities") or []:
            level = str(_decisions_field(option, "value"))
            legend[level] = str(_decisions_field(option, "label") or level)
            probabilities[level] = round(float(_decisions_field(option, "probability", 0.0)), 4)
        return name, {
            "type": "score",
            "score": round(float(_decisions_field(raw, "score", 0.0)), 4),
            "confidence": round(float(_decisions_field(raw, "confidence", 0.0)), 4),
            "legend": legend,
            "probabilities": probabilities,
        }
    if kind == "refusal":
        # the model declined THIS question; the consumers' fail-open reads
        # the marker as no-verdict (noul 0 / empty choice)
        return name, {"type": "refusal"}
    return None


_decisions_clients: dict[tuple[str, str], t.Any] = {}
_decisions_lock = threading.Lock()
"""The sync Decisions clients, cached per (base_url, api_key) -- the same
pool-reuse discipline as the rerank openai leg (a fresh client per call
paid a new connection handshake on EVERY judgment).  A SYNC cache beside
``clients``: the chat/embedding clients are loop-bound async objects,
the decisions call is a one-shot on the calling thread."""


def _decisions_client(cfg: dict[str, t.Any], base: str, api_key: str) -> t.Any:
    from openai import OpenAI  # pylint: disable=import-outside-toplevel

    key = (base, api_key)
    with _decisions_lock:
        client = _decisions_clients.get(key)
        if client is None:
            client = OpenAI(
                api_key=api_key,
                base_url=base or None,
                default_headers=extra_headers(cfg) or None,
                timeout=clients.sdk_timeout(),
                max_retries=0,
            )
            _decisions_clients[key] = client
    return client


class OpenaiSdk:
    """The bound OpenAI family surface: one instance per (config, base)
    binding, all request methods carrying that binding."""

    json_tiers = JSON_TIERS

    def __init__(self, cfg: dict[str, t.Any], base: str, kind: str, family: str, account: t.Any = None):
        self.cfg = cfg
        self.base = base
        self.kind = kind
        self.family = family
        # the run's spend ledger -- only the DECISION surface records
        # (chat/embedding usage rides their own captures)
        self.account = account

    async def pump(
        self,
        messages: list[dict[str, t.Any]],
        events: "queue.Queue[tuple[str, t.Any]]",
        relay_reasoning: bool = False,
        tools: list[dict[str, t.Any]] | None = None,
    ) -> None:
        if self.kind == RESPONSES_KIND:
            await _responses_pump(self, messages, events, relay_reasoning, tools)
        else:
            await _chat_pump(self, messages, events, relay_reasoning, tools)

    async def json_completion(
        self,
        messages: list[dict[str, t.Any]],
        name: str,
        schema: dict[str, t.Any],
        strict: bool,
    ) -> tuple[str, dict[str, t.Any] | None]:
        """One native structured-object completion; ``(text, usage)`` out --
        the usage rides back so the gates' token spend is accountable."""
        cfg = self.cfg
        client = clients.openai_client(cfg, self.base, family=self.family)
        usage_meta = None
        if self.kind == RESPONSES_KIND:
            text_format = (
                {"type": "json_schema", "name": name, "strict": True, "schema": schema}
                if strict
                else {"type": "json_object"}
            )
            response = await client.responses.create(
                model=str(cfg.get("model")),
                input=_responses_input(messages),
                instructions=system_of(messages) or None,
                text={"format": text_format},
                timeout=clients.sdk_timeout(),
                extra_headers=extra_headers(cfg),
                extra_body=extra_body(cfg),
                **caching.model_kwargs(params(cfg), RESPONSES_KIND),
            )
            if getattr(response, "usage", None) is not None:
                usage_meta = usage.openai_usage(response.usage)
            return str(getattr(response, "output_text", "") or ""), usage_meta
        response_format = (
            {
                "type": "json_schema",
                "json_schema": {"name": name, "strict": True, "schema": schema},
            }
            if strict
            else {"type": "json_object"}
        )
        # the deployment's params may carry their own ``response_format``
        # -- the gate's structured-output key wins (a duplicate kwarg is
        # a TypeError)
        gate_kwargs = caching.model_kwargs(params(cfg), CHAT_KIND)
        gate_kwargs.pop("response_format", None)
        response = await client.chat.completions.create(
            model=str(cfg.get("model")),
            messages=_chat_wire_messages(cfg, messages),
            response_format=response_format,
            timeout=clients.sdk_timeout(),
            extra_headers=extra_headers(cfg),
            extra_body=extra_body(cfg),
            **gate_kwargs,
        )
        if getattr(response, "usage", None) is not None:
            usage_meta = usage.openai_usage(response.usage)
        if response.choices and response.choices[0].message and response.choices[0].message.content:
            return str(response.choices[0].message.content), usage_meta
        return "", usage_meta

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], dict[str, t.Any] | None]:
        """One embeddings-API batch in input order (the embedding column
        width rides the ``params.dimensions`` key -- llm.embed owns the
        width resolution).  The API's ``usage.prompt_tokens`` rides along
        when the upstream reports it (the embeddings用量 stats)."""
        cfg = self.cfg
        client = clients.openai_client(cfg, self.base, family=self.family)
        call: dict[str, t.Any] = {
            **embedding_passthrough(cfg),
            "model": str(cfg.get("model")),
            "input": [text[:8000] for text in texts],
            "dimensions": dimensions(cfg, "openai"),
            "extra_headers": cfg.get("extra_headers") or None,
            "extra_body": cfg.get("extra_body") or None,
        }
        response = await client.embeddings.create(**call)
        # the API returns data in input order, but sort by index to be sure
        ordered = sorted(response.data, key=lambda item: item.index)
        reported = getattr(response, "usage", None)
        meta = {"input": reported.prompt_tokens} if reported is not None and reported.prompt_tokens else None
        return [item.embedding for item in ordered], meta

    def decide(
        self,
        state: t.Any,
        questions: dict[str, dict[str, t.Any]],
        timeout: float | None = None,
        images: list[dict[str, str]] | None = None,
    ) -> dict[str, t.Any] | None:
        """One decision-model judgment over the Decisions wire (the
        decision service's ``openai`` family -- the ``embed()`` pattern,
        the family method on the family surface): the named questions map
        to ``predicate`` / ``choice`` / ``score``, the answers map back
        into the canonical shapes, and the result reads ``{"answers",
        "usage", "latency_ms"}`` exactly like the typesafe family's.
        ``base_url`` follows the openai SDK convention (the ``.../v1``
        root; absent rides the public endpoint).  ``images`` are the
        service-resolved assets (``{ref, data_base64, format}``) -- the
        wire only takes INLINE data URLs, so they ride one user message
        as ``input_image`` parts after the state text, in order (the
        state references ``image-N``; the parts arrive in that order).
        A sync one-shot on the calling thread (no loop bridging) on the
        SDK's own HTTP stack.  Raised errors propagate (the service owns
        the fail-open)."""
        wire_questions = []
        for name, question in questions.items():
            wire = _decisions_question(name, question)
            if wire is None:
                logger.debug(
                    "zjsearch decision openai: question %r not expressible, dropped",
                    name,
                )
                continue
            wire_questions.append(wire)
        if not wire_questions:
            return None
        state_text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
        if images:
            content: list[dict[str, t.Any]] = [{"type": "input_text", "text": state_text}]
            for asset in images:
                content.append(
                    {
                        "type": "input_image",
                        "image_url": f"data:image/{asset['format']};base64,{asset['data_base64']}",
                    }
                )
            wire_input: t.Any = [{"role": "user", "content": content}]
        else:
            wire_input = state_text
        client = _decisions_client(self.cfg, self.base, str(self.cfg.get("api_key") or ""))
        started = time.monotonic()
        response = client.decisions.create(
            model=str(self.cfg.get("model")),
            input=wire_input,
            questions=wire_questions,
            timeout=float(timeout) if timeout is not None else clients.sdk_timeout(),
            extra_headers=extra_headers(self.cfg) or None,
            extra_body=extra_body(self.cfg) or None,
        )
        answers: dict[str, dict[str, t.Any]] = {}
        for raw in _decisions_field(response, "answers") or []:
            try:
                mapped = _decisions_answer(raw)
            except (TypeError, ValueError):
                continue
            if mapped is not None:
                answers[mapped[0]] = mapped[1]
        if not answers:
            return None
        usage_raw = _decisions_field(response, "usage")
        usage_meta: dict[str, int] = {}
        if usage_raw is not None:
            for key in ("input_tokens", "output_tokens"):
                usage_meta[key] = int(_decisions_field(usage_raw, key) or 0)
        if self.account is not None:
            # the family records its own spend (the account is the run's
            # ledger): one successful forward pass, input-only
            self.account.record("decision", 1, usage_meta.get("input_tokens") or 0)
        return {
            "answers": answers,
            "usage": usage_meta,
            "latency_ms": int((time.monotonic() - started) * 1000),
        }


def factory(cfg: dict[str, t.Any], base: str, kind: str, family: str = "openai", account: t.Any = None) -> OpenaiSdk:
    """The OpenAI family factory: config + base_url + wire kind bound into
    one callable surface.  ``family`` separates the client cache
    namespaces (the chat transport and the embedding feature can share a
    base_url while carrying DIFFERENT keys).  The decision registry binds
    the same factory for its ``openai`` family (``decide`` ignores the
    chat ``kind``) and hands its spend ledger in."""
    return OpenaiSdk(cfg, base, kind, family, account=account)
