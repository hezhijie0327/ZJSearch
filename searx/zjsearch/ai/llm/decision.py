# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""The decision-model service: config + the server-side call.

A dedicated block (``zjsearch.decision``) for the decision models: one
forward pass answers NAMED QUESTIONS about a state -- choice
(classification), score (graded), noul (boolean) -- each with its
probability distribution / confidence, WITHOUT generating prose.  The
high-frequency structured-judgment primitive (ticket triage, content
review, agent routing, result verification).

``zjsearch.decision.sdk``: ``typesafe`` (the typesafe-sdk vendor surface
-- that vendor's own API is their "SystemOne" endpoint,
``/v1/systemone``) or ``openai`` (OpenAI's ``/v1/decisions`` endpoint
through the SDK's typed ``client.decisions.create`` -- ``base_url`` per
the openai SDK convention, the ``.../v1`` root); the registry dict +
package gate are the pre-embedded SDK-selection seam -- future decision
families slot in beside them.  The call is a single synchronous HTTP
round trip (tens of milliseconds) -- it runs on the calling thread by
design, no loop bridging.
"""

import base64
import importlib.util
import io
import logging
import typing as t

from searx.zjsearch.ai.core import config as core_config
from searx.zjsearch.ai.core import guard, security

logger = logging.getLogger(__name__)

SDKS = ("typesafe", "openai")
"""The ``zjsearch.decision.sdk`` values -- one SDK per decision API
family.  ``typesafe`` is the first (the default); ``openai`` the second
(the Decisions wire, ``sdk/openai.py``'s ``decide``); the registry is
the seam for the next (the selection pre-embeds the shape, not just the
name)."""

SDK_PACKAGES = {"typesafe": "typesafe_sdk", "openai": "openai"}
"""The import name of the SDK package each decision sdk needs."""

MAX_QUESTIONS = 12
"""Questions per judgment call -- a triage routes a handful of named
questions, not a questionnaire."""

MAX_STATE_CHARS = 24_000
"""The state payload's truncation point (the decision model reads the
state in one forward pass; a novel is not what it is for)."""

MAX_IMAGES = 4
"""Images per judgment call -- a decision model looks at a handful of
pictures, not a gallery."""

MAX_IMAGE_BYTES = 6 * 1024 * 1024
"""One image's decoded size cap (the typesafe wire takes 16 MiB a file
and 32 MiB a request; six MiB an image keeps four of them clear of the
request ceiling with the base64 headroom to spare)."""

IMAGE_FETCH_TIMEOUT = 8.0
"""One image fetch's budget -- thumbnails and page photos land in well
under a second; the cap exists so a hung host cannot stall the calling
thread (the resolution runs on it, no loop bridging)."""

_IMAGE_MIN_SIDE = 256
_IMAGE_MAX_SIDE = 1568
_IMAGE_MIN_PIXELS = 78_400
_IMAGE_MAX_PIXELS = 2_458_624
"""The typesafe wire's image geometry window (256-1568 px a side,
78,400-2,458,624 pixels in total); violations are rejected with the
WHOLE request, so the resolver drops too-small images and downscales
the oversized ones instead of letting one bad picture kill the call."""


def cfg() -> dict[str, t.Any]:
    """The ``zjsearch.decision`` settings block (absent unless the
    deployment defines it): ``enabled`` / ``base_url`` / ``api_key`` /
    ``model`` / ``sdk``.  ``base_url`` follows the selected sdk's own
    convention: the typesafe family takes the workspace root (the SDK
    appends ``/v1/systemone``), the openai family the ``.../v1`` root
    (the SDK appends ``/decisions``; absent rides the public endpoint)."""
    return core_config.zj_block("decision")


def sdk(cfg_block: dict[str, t.Any] | None = None) -> str:
    """The selected decision SDK: ``typesafe`` (the default) or ``openai``
    -- the registry pre-embeds the selection for the next family."""
    block = cfg_block if cfg_block is not None else cfg()
    kind = str(block.get("sdk") or "typesafe")
    return kind if kind in SDKS else "typesafe"


def decision_key(cfg_block: dict[str, t.Any]) -> str:
    """The effective API key: the ``api_key`` setting first, then the
    ``ZJSEARCH_DECISION_KEY`` environment."""
    return core_config.env_key(cfg_block, "ZJSEARCH_DECISION_KEY")


def enabled() -> bool:
    """The decision feature flag: ``zjsearch.decision.enabled`` -- True
    unless explicitly switched off."""
    return cfg().get("enabled") is not False


def configured() -> bool:
    """True when the decision route may serve: model and key present
    (``base_url`` for a dedicated workspace, absent for the public
    endpoint)."""
    block = cfg()
    return bool(block.get("model") and decision_key(block))


def sdk_missing() -> str | None:
    """The missing SDK package for the configured decision sdk, or
    ``None`` when it imports (the install gate)."""
    package = SDK_PACKAGES[sdk()]
    if importlib.util.find_spec(package) is None:
        return package
    return None


def capability() -> dict[str, str] | None:
    """The page-data ``decision`` payload (token + model label); ``None``
    when the feature is off or unconfigured -- the client hides the
    surface then (the browser proxies its judgments through the route
    with this token)."""
    if not enabled() or not configured():
        return None
    return {"tk": security.issue_token(), "model": str(cfg().get("model"))}


FEATURE_DEFAULTS: dict[str, dict[str, t.Any]] = {
    # the framework-side judgment gates (v5's model funnel): every gate
    # FAILS OPEN -- an unconfigured decision model, a timeout or a low
    # confidence simply leaves the previous behavior standing.  The
    # thresholds are starting points (the RAG-gate cookbook's), to be
    # tuned against real runs.
    "read_gate": {"enabled": True, "injection_max": 0.70, "relevant_min": 0.45},
    "diversity": {"enabled": True, "cosine": 0.92},
    "coverage": {"enabled": True},
    "plan_review": {"enabled": True, "max_tasks": 4},
    "depth_probe": {
        "enabled": True,
        # the round LADDERS the probe's score (0-4) scales to -- the
        # model-controlled depth made literal: an exhaustive question
        # earns a huge runway, a quick lookup a small one
        "ladder_deep": [12, 24, 48, 96, 120],
        "ladder_balanced": [4, 8, 16, 24, 32],
    },
    "evidence_check": {"enabled": True, "head": 8, "pass_min": 0.45},
    # the pre-write CLAIM check (rides the evidence_check pass,
    # referee.py): the ledger's load-bearing figures judged against
    # BM25-retrieved corpus evidence -- a finding the evidence
    # CONTRADICTS is marked contested for the writer (present the
    # disagreement, never average).  The noul asks the POSITIVE question
    # (contradicted?) -- small models read it reliably, the double
    # negative did not survive the live probe -- so a HIGH score flags.
    "claim_check": {"enabled": True, "max_facts": 6, "contradict_min": 0.55},
    # the report SYNTHESIZE's per-section citation spot check (runs/search/
    # report/synth.py): sampled claims judged against their sources, a
    # failing claim earns one targeted rewrite BEFORE delivery
    "citation_gate": {"enabled": True, "support_min": 0.5},
    "memory_dedup": {
        "enabled": True,
        # the cosine above which a new fact "reads as" a stored one -- the
        # save gate AND the extractor's filter share the one floor
        "cosine": 0.92,
    },
    "clarify_gate": {
        "enabled": True,
        # the noul floors: BELOW either the query is genuinely ambiguous OR
        # high-stakes and the (expensive) clarify gate may ask; above both
        # the query reads clear AND safe -- skip the round-trip.  Two
        # questions on purpose: "which index fund should I buy" reads clear
        # and still must not run on a guess.
        "ambiguous_min": 0.65,
        "high_stakes_min": 0.60,
    },
}


def features(key: str) -> dict[str, t.Any]:
    """One framework gate's merged config: ``zjsearch.decision.features.
    <key>`` over :py:data:`FEATURE_DEFAULTS` -- unknown keys fall back to
    the defaults wholesale (a gate the deployment never named still
    works, still fails open)."""
    merged = dict(FEATURE_DEFAULTS.get(key, {}))
    block = cfg().get("features")
    if isinstance(block, dict) and isinstance(block.get(key), dict):
        merged.update(block[key])
    return merged


def _image_entry(data: bytes, fmt: str) -> dict[str, str]:
    """One resolved asset: ``{ref, data_base64, format}`` -- the ref is
    the plain-text handle the state/instructions write (the typesafe wire
    matches reference strings verbatim; the openai family attaches the
    parts in order, so ``image-N`` reads the same on both)."""
    return {
        "ref": "",
        "data_base64": base64.b64encode(data).decode("ascii"),
        "format": fmt,
    }


def _normalize_image(data: bytes, declared: str) -> tuple[bytes, str] | None:
    """Sniff, validate and fit one image into the wires' geometry window:
    in-window PNG/JPEG bytes ride VERBATIM; anything else (webp, gif,
    bmp) transcodes to PNG when PIL is importable; the oversized
    downscale and the EXIF rotation re-encode (a downscaled picture
    still answers the question -- a 400 on the WHOLE typesafe request
    does not).  ``(data, format)`` out, ``None`` when the image is
    unusable (too small, undecodable)."""
    try:
        from PIL import Image, ImageOps  # pylint: disable=import-outside-toplevel
    except ImportError:
        # no PIL on this deploy: only the wire-native formats pass, unchecked
        return (data, declared) if declared in ("png", "jpeg") and len(data) <= MAX_IMAGE_BYTES else None
    try:
        with Image.open(io.BytesIO(data)) as probe:
            src = (probe.format or "").upper()
            fmt = "png" if src == "PNG" else ("jpeg" if src in ("JPEG", "MPO") else "png")
            width, height = probe.size
            if width * height < _IMAGE_MIN_PIXELS or min(width, height) < _IMAGE_MIN_SIDE:
                return None
            scale = min(
                1.0,
                _IMAGE_MAX_SIDE / max(width, height),
                (_IMAGE_MAX_PIXELS / (width * height)) ** 0.5,
            )
            if (
                scale >= 1.0
                and fmt == declared
                and not probe.getexif().get(274)  # no EXIF rotation to apply
                and probe.mode in ("RGB", "RGBA", "L", "P", "1")
                and len(data) <= MAX_IMAGE_BYTES
            ):
                return data, fmt  # in-window wire-native bytes: untouched
            image = ImageOps.exif_transpose(probe)
            if scale < 1.0:
                image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))))
            if image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            out = _encode(image, fmt)
            if len(out) > MAX_IMAGE_BYTES:
                out = _encode(image, "jpeg" if fmt == "png" else "png")
            return (out, fmt) if len(out) <= MAX_IMAGE_BYTES else None
    except Exception as exc:  # pylint: disable=broad-except
        logger.debug("zjsearch_decision: image normalization failed, dropped: %r", exc)
        return None


def _encode(image: t.Any, fmt: str) -> bytes:
    """One PIL image as PNG or JPEG bytes."""
    buffer = io.BytesIO()
    if fmt == "png":
        image.save(buffer, format="PNG", optimize=True)
    else:
        image.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()


def _resolve_one(url: str, client: t.Any) -> dict[str, str] | None:
    """One URL (``data:`` or public http(s)) as ``{data_base64,
    format}`` -- ``None`` when unusable."""
    if url.startswith("data:"):
        header, _, payload = url.partition(",")
        if not payload or not header.endswith(";base64"):
            return None
        meta = header[5:].lower()
        if not meta.startswith("image/"):
            return None
        declared = "png" if "image/png" in meta else ("jpeg" if "image/jpeg" in meta or "image/jpg" in meta else "")
        data = base64.b64decode(payload, validate=True)
        if len(data) > MAX_IMAGE_BYTES:
            return None
        normalized = _normalize_image(data, declared)
        return None if normalized is None else _image_entry(*normalized)
    rejection = guard.public_url_rejection(url)
    if rejection is not None:
        logger.debug("zjsearch_decision: image url refused: %s", rejection)
        return None
    response = client.get(url)
    if response.status_code != 200:
        return None
    content_type = str(response.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not content_type.startswith("image/"):
        return None
    data = response.content
    if not data or len(data) > MAX_IMAGE_BYTES:
        return None
    declared = "png" if content_type == "image/png" else ("jpeg" if content_type in ("image/jpeg", "image/jpg") else "")
    normalized = _normalize_image(data, declared)
    return None if normalized is None else _image_entry(*normalized)


def resolve_images(images: t.Any) -> list[dict[str, str]]:
    """The caller's image URLs (http/https or ``data:`` URLs) resolved
    into the wire assets: the SSRF gate first (the model names URLs, the
    server fetches -- the reader's doctrine), then a size-capped fetch
    and the geometry normalization.  A ref rides ``image-1..N`` in the
    order given; a dropped image KEEPS its ordinal gap (the state's
    ``image-2`` mention degrades to plain text -- every wire reads
    unmatched reference text as text, and renumbering would silently
    move the evidence under the caller's words)."""
    resolved: list[dict[str, str]] = []
    if not isinstance(images, (list, tuple)):
        return resolved
    candidates = [str(url or "").strip() for url in images][:MAX_IMAGES]
    if not any(candidates):
        return resolved
    import httpx2  # pylint: disable=import-outside-toplevel

    with httpx2.Client(timeout=IMAGE_FETCH_TIMEOUT, follow_redirects=True) as client:
        for index, url in enumerate(candidates, 1):
            if not url:
                continue
            try:
                entry = _resolve_one(url, client)
            except Exception as exc:  # pylint: disable=broad-except
                logger.debug("zjsearch_decision: image %r dropped: %r", url[:120], exc)
                entry = None
            if entry is not None:
                # the ref rides the URL's POSITION, not the survivor count:
                # a dropped image leaves an ordinal gap so the caller's
                # "image-2" mention keeps pointing at the same picture
                entry["ref"] = f"image-{index}"
                resolved.append(entry)
    return resolved


def _surface(block: dict[str, t.Any], account: t.Any = None) -> t.Any:
    """The configured family's bound decision surface -- the embedding
    service's ``resolve`` pattern, scoped to the decision families (the
    chat registry cannot know the typesafe family, so the two factories
    dispatch here; both surfaces speak ``decide(state, questions,
    timeout)``).  ``account`` binds the run's spend ledger at FACTORY
    time: the surface records its own usage after every successful
    answer, so no evaluate call site ever folds a bucket.  The imports stay
    lazy (the SDK packages are optional installs -- the package gate has
    already checked this one)."""
    bound = {**block, "api_key": decision_key(block)}
    base = str(block.get("base_url") or "")
    if sdk(block) == "typesafe":
        from .sdk.typesafe import factory  # pylint: disable=import-outside-toplevel
    else:
        from .sdk.openai import factory  # pylint: disable=import-outside-toplevel
    return factory(bound, base, sdk(block), "decision", account=account)


def evaluate(  # pylint: disable=too-many-return-statements
    state: t.Any,
    questions: dict[str, dict[str, t.Any]],
    timeout: float | None = None,
    images: t.Any = None,
    account: t.Any = None,
) -> dict[str, t.Any] | None:
    """One decision-model judgment: ``state`` (text or a JSON object) +
    ``questions`` (the wire question dict: type/criteria/instructions
    per name) -> ``{"answers": {...}, "usage": {...}, "latency_ms": ...}``
    verbatim from the model; ``None`` when the feature is off/unconfigured
    or the upstream fails -- every consumer degrades silently (a decision
    is a lens, not a dependency).  The question shapes follow the wire's
    own vocabulary: ``choice`` (criteria = label -> description),
    ``score`` (criteria = ordered legend), ``noul`` (boolean).  The call
    itself delegates to the FAMILY surface (``llm.sdk.typesafe`` or the
    openai family's ``decide`` in ``llm.sdk.openai`` -- the client
    lifecycle and the typed-answer downgrade live there), like the
    embedding service resolves its families.  ``images`` lists picture
    URLs for visual judgments: each resolves (SSRF gate, size/geometry
    caps, transcode) into an asset the state/instructions reference as
    plain ``image-N`` text -- the typesafe family ships the assets map
    (references matched verbatim), the openai family attaches data-URL
    parts in the same order.  ``account`` (the run's spend ledger) binds
    the family surface, which records its own usage -- the callers never
    touch a bucket."""
    if not enabled() or not configured():
        return None
    block = cfg()
    family = sdk(block)
    if importlib.util.find_spec(SDK_PACKAGES[family]) is None:
        return None
    trimmed = {
        name: questions[name]
        for name in list(questions)[:MAX_QUESTIONS]
        if isinstance(questions.get(name), dict) and questions[name].get("type")
    }
    if not trimmed:
        return None
    assets = resolve_images(images) if images else []

    try:
        return _surface(block, account).decide(
            state=str(state)[:MAX_STATE_CHARS] if isinstance(state, str) else state,
            questions=trimmed,
            timeout=timeout,
            images=assets,
        )
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("zjsearch_decision: evaluate failed: %s", exc)
        return None
