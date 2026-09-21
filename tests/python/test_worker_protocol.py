"""Unit tests for the NDJSON envelope layer (UI-002).

The subprocess tests in ``test_worker.py`` prove the wire end-to-end;
these pin the parser/builder semantics directly.
"""

from __future__ import annotations

import json

import pytest

from hornscribe.worker import protocol


def test_parse_valid_request() -> None:
    msg = protocol.parse_message(
        '{"v":1,"id":"req-1","kind":"request","method":"engine.ping","payload":{"echo":1}}'
    )
    assert msg.v == 1
    assert msg.kind == protocol.KIND_REQUEST
    assert msg.id == "req-1"
    assert msg.method == "engine.ping"
    assert msg.payload == {"echo": 1}
    assert msg.error is None


def test_parse_ignores_unknown_fields() -> None:
    msg = protocol.parse_message(
        '{"v":1,"id":"r","kind":"request","method":"m","future":42,"payload":null}'
    )
    assert msg.method == "m"


def test_parse_valid_event() -> None:
    msg = protocol.parse_message(
        '{"v":1,"id":null,"kind":"event","method":"job.event","payload":{"phase":"x"}}'
    )
    assert msg.kind == protocol.KIND_EVENT
    assert msg.id is None


@pytest.mark.parametrize(
    "line",
    [
        "",
        "   ",
        "{nope",
        "[1]",
        "null",
        '"s"',
        "{}",  # missing v/kind
        '{"v":"1","kind":"request"}',  # v wrong type
        '{"v":true,"kind":"request"}',  # bool is not an int version
        '{"v":1,"kind":"request","method":"m"}',  # missing id
        '{"v":1,"id":"r","kind":"request"}',  # missing method
        '{"v":1,"id":"r","kind":"request","method":""}',  # empty method
        '{"v":1,"id":"r","kind":"bogus","method":"m"}',  # bad kind
        '{"v":1,"id":"r","kind":"event","method":"m"}',  # event id must be null
        # response carrying both payload and error
        '{"v":1,"id":"r","kind":"response","payload":{},"error":{"code":"X","message":"y"}}',
        '{"v":1,"id":"r","kind":"response","error":"oops"}',  # error not object
    ],
)
def test_parse_rejects_malformed(line: str) -> None:
    with pytest.raises(protocol.ProtocolError) as excinfo:
        protocol.parse_message(line)
    assert excinfo.value.code == protocol.ERR_MALFORMED_MESSAGE


def test_parse_version_mismatch() -> None:
    with pytest.raises(protocol.ProtocolError) as excinfo:
        protocol.parse_message('{"v":99,"id":"r","kind":"request","method":"m"}')
    assert excinfo.value.code == protocol.ERR_PROTOCOL_VERSION_MISMATCH
    assert excinfo.value.details == {"expected": 1, "got": 99}


def test_request_id_recovered_from_bad_frames() -> None:
    with pytest.raises(protocol.ProtocolError) as excinfo:
        protocol.parse_message('{"id":"keep-me","kind":"request"}')  # missing v
    assert excinfo.value.request_id == "keep-me"
    with pytest.raises(protocol.ProtocolError) as excinfo:
        protocol.parse_message("{not json")
    assert excinfo.value.request_id is None


def test_response_carries_payload_or_error_never_both() -> None:
    ok = protocol.make_response("r1", "engine.ping", {"echo": 1})
    assert ok["payload"] == {"echo": 1} and ok["error"] is None
    err = protocol.make_error_response("r1", "X_CODE", "msg")
    assert err["payload"] is None
    assert err["error"] == {"code": "X_CODE", "message": "msg"}


def test_error_response_may_carry_null_id() -> None:
    err = protocol.make_error_response(None, protocol.ERR_MALFORMED_MESSAGE, "bad")
    assert err["id"] is None
    assert err["kind"] == protocol.KIND_RESPONSE


def test_event_frame_has_null_id() -> None:
    ev = protocol.make_event("job.event", {"jobId": "job-1", "phase": "progress"})
    assert ev["id"] is None
    assert ev["kind"] == protocol.KIND_EVENT


def test_encode_is_single_line_ndjson() -> None:
    line = protocol.encode_message(
        protocol.make_event("job.event", {"note": "line1\nline2", "emoji": "𝄞"})
    )
    assert "\n" not in line and "\r" not in line
    assert line == line.encode("ascii").decode("ascii")  # ensure_ascii
    assert json.loads(line)["payload"]["note"] == "line1\nline2"


def test_encode_roundtrip() -> None:
    env = protocol.make_response("r9", "engine.ping", {"echo": [1, "two", None]})
    msg = protocol.parse_message(protocol.encode_message(env))
    assert msg.id == "r9" and msg.payload == {"echo": [1, "two", None]}
