"""NDJSON wire protocol for the HornScribe engine sidecar (UI-002).

Implements ``protocol/PROTOCOL.md``: one JSON object per line on stdout,
diagnostics on stderr, structured errors, strict envelope validation.

Spike extensions beyond the original draft (documented in PROTOCOL.md):

- unrecoverable frames get an error response with ``id: null``
- inbound ``response``/``event`` frames are logged and dropped, not
  answered (avoids reply loops)
- ``job.event`` phases: started | progress | completed | cancelled | failed
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Final

PROTOCOL_VERSION: Final = 1

KIND_REQUEST: Final = "request"
KIND_RESPONSE: Final = "response"
KIND_EVENT: Final = "event"
_VALID_KINDS: Final = frozenset({KIND_REQUEST, KIND_RESPONSE, KIND_EVENT})

# Error codes (UPPER_SNAKE per PROTOCOL.md).
ERR_PROTOCOL_VERSION_MISMATCH: Final = "PROTOCOL_VERSION_MISMATCH"
ERR_MALFORMED_MESSAGE: Final = "MALFORMED_MESSAGE"
ERR_UNKNOWN_METHOD: Final = "UNKNOWN_METHOD"
ERR_INVALID_PARAMS: Final = "INVALID_PARAMS"
ERR_JOB_NOT_FOUND: Final = "JOB_NOT_FOUND"
ERR_JOB_ALREADY_RUNNING: Final = "JOB_ALREADY_RUNNING"
ERR_UNKNOWN_JOB_KIND: Final = "UNKNOWN_JOB_KIND"
ERR_JOB_TIMEOUT: Final = "JOB_TIMEOUT"
ERR_JOB_FAILED: Final = "JOB_FAILED"
ERR_INTERNAL: Final = "INTERNAL_ERROR"

# A JSON dict that maps onto the wire envelope.
Envelope = dict[str, Any]


class ProtocolError(Exception):
    """Structured protocol failure; converts directly to an error envelope."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details
        self.request_id = request_id


@dataclass(frozen=True)
class Message:
    """A validated inbound envelope. Unknown fields are dropped safely."""

    v: int
    kind: str
    id: str | None
    method: str | None
    payload: Any
    error: dict[str, Any] | None


def _recover_id(raw: Any) -> str | None:
    """Best-effort request-id recovery for error replies on bad frames."""
    if isinstance(raw, dict):
        rid = raw.get("id")
        if isinstance(rid, str) and rid:
            return rid
        if isinstance(rid, int) and not isinstance(rid, bool):
            return str(rid)
    return None


def _validate_error_object(error: Any, request_id: str | None) -> dict[str, Any]:
    if not isinstance(error, dict):
        raise ProtocolError(
            ERR_MALFORMED_MESSAGE,
            "'error' must be an object {code, message, details?}",
            request_id=request_id,
        )
    if not isinstance(error.get("code"), str) or not isinstance(error.get("message"), str):
        raise ProtocolError(
            ERR_MALFORMED_MESSAGE,
            "'error' requires string 'code' and 'message'",
            request_id=request_id,
        )
    return error


def parse_message(line: str) -> Message:
    """Strictly parse one NDJSON frame into a :class:`Message`.

    Raises :class:`ProtocolError` (``MALFORMED_MESSAGE`` or
    ``PROTOCOL_VERSION_MISMATCH``) on any envelope violation. Unknown
    additive fields are ignored per ADR-0002.
    """
    text = line.strip()
    if not text:
        raise ProtocolError(ERR_MALFORMED_MESSAGE, "empty frame")
    try:
        raw: Any = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProtocolError(
            ERR_MALFORMED_MESSAGE, f"frame is not valid JSON: {exc.msg}"
        ) from exc
    if not isinstance(raw, dict):
        raise ProtocolError(ERR_MALFORMED_MESSAGE, "envelope must be a JSON object")

    request_id = _recover_id(raw)

    v = raw.get("v")
    if isinstance(v, bool) or not isinstance(v, int):
        raise ProtocolError(
            ERR_MALFORMED_MESSAGE,
            "'v' must be an integer protocol version",
            request_id=request_id,
        )
    if v != PROTOCOL_VERSION:
        raise ProtocolError(
            ERR_PROTOCOL_VERSION_MISMATCH,
            f"unsupported protocol version {v}; worker speaks v{PROTOCOL_VERSION}",
            details={"expected": PROTOCOL_VERSION, "got": v},
            request_id=request_id,
        )

    kind = raw.get("kind")
    if kind not in _VALID_KINDS:
        raise ProtocolError(
            ERR_MALFORMED_MESSAGE,
            "'kind' must be one of request|response|event",
            request_id=request_id,
        )

    method = raw.get("method")
    payload = raw.get("payload")
    error = raw.get("error")

    if kind == KIND_REQUEST:
        if not isinstance(raw.get("id"), str) or not raw["id"]:
            raise ProtocolError(
                ERR_MALFORMED_MESSAGE,
                "request requires a non-empty string 'id'",
                request_id=request_id,
            )
        if not isinstance(method, str) or not method:
            raise ProtocolError(
                ERR_MALFORMED_MESSAGE,
                "request requires a non-empty string 'method'",
                request_id=request_id,
            )
    elif kind == KIND_EVENT:
        if raw.get("id") is not None:
            raise ProtocolError(
                ERR_MALFORMED_MESSAGE,
                "events must carry 'id': null",
                request_id=request_id,
            )
        if not isinstance(method, str) or not method:
            raise ProtocolError(
                ERR_MALFORMED_MESSAGE,
                "event requires a non-empty string 'method'",
                request_id=request_id,
            )
    else:  # response
        if not isinstance(raw.get("id"), str) or not raw["id"]:
            raise ProtocolError(
                ERR_MALFORMED_MESSAGE,
                "response requires a non-empty string 'id'",
                request_id=request_id,
            )
        if payload is not None and error is not None:
            raise ProtocolError(
                ERR_MALFORMED_MESSAGE,
                "response carries either 'payload' or 'error', never both",
                request_id=request_id,
            )
        if error is not None:
            _validate_error_object(error, request_id)

    return Message(v=v, kind=kind, id=raw.get("id"), method=method, payload=payload, error=error)


def make_response(request_id: str, method: str | None, payload: Any) -> Envelope:
    """Success response: ``payload`` set, ``error`` null (never both)."""
    return {
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "kind": KIND_RESPONSE,
        "method": method,
        "payload": payload,
        "error": None,
    }


def make_error_response(
    request_id: str | None,
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    method: str | None = None,
) -> Envelope:
    """Error response: ``error`` set, ``payload`` null (never both).

    ``request_id`` is ``None`` only when the inbound frame was too broken
    to recover an id — the one case where a response may carry ``id: null``.
    """
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return {
        "v": PROTOCOL_VERSION,
        "id": request_id,
        "kind": KIND_RESPONSE,
        "method": method,
        "payload": None,
        "error": error,
    }


def make_event(method: str, payload: dict[str, Any]) -> Envelope:
    """Asynchronous event frame (``id: null`` per spec)."""
    return {
        "v": PROTOCOL_VERSION,
        "id": None,
        "kind": KIND_EVENT,
        "method": method,
        "payload": payload,
        "error": None,
    }


def encode_message(envelope: Envelope) -> str:
    """Serialize an envelope to a single NDJSON line (no trailing newline).

    ``json.dumps`` escapes all control characters, so the output can never
    contain a raw newline — NDJSON safety is structural, not conventional.
    """
    return json.dumps(envelope, ensure_ascii=True, separators=(",", ":"))
