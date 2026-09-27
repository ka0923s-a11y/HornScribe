"""Subprocess lifecycle tests for the engine sidecar (UI-002).

Every test spawns a real ``python -m hornscribe.worker`` subprocess on
anonymous pipes — exactly the supervision contract the Tauri shell
(UI-001) will implement in Rust. The ``WorkerHandle`` class is the
test-side stand-in for that shell: ID correlation, event collection,
read timeouts, crash detection, and restart.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHONPATH_DIR = REPO_ROOT / "python"
READ_TIMEOUT_S = 10.0

_EOF = object()


class WorkerTimeout(AssertionError):
    """Supervisor-side read timeout — what a shell would treat as a hang."""


class WorkerDied(AssertionError):
    """stdout hit EOF — the worker process exited underneath us."""


class WorkerHandle:
    """Test-side supervisor for one sidecar subprocess.

    Mirrors what the Tauri shell must do: correlate request IDs, collect
    ``job.event`` frames interleaved with responses, apply read timeouts,
    and detect process death. stderr is captured separately to prove the
    protocol-clean-stdout / logs-on-stderr split.
    """

    def __init__(self) -> None:
        env = os.environ.copy()
        env["PYTHONPATH"] = (
            str(PYTHONPATH_DIR) + os.pathsep + env.get("PYTHONPATH", "")
        )
        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "hornscribe.worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            cwd=REPO_ROOT,
            env=env,
        )
        self._out_q: queue.Queue[Any] = queue.Queue()
        self._stderr_lines: list[str] = []
        self.stdout_lines: list[str] = []
        self._pending: list[dict[str, Any]] = []
        self._seq = 0
        assert self.proc.stdout is not None and self.proc.stderr is not None
        threading.Thread(
            target=self._pump,
            args=(self.proc.stdout, self._out_q, self.stdout_lines),
            daemon=True,
        ).start()
        threading.Thread(
            target=self._pump,
            args=(self.proc.stderr, None, self._stderr_lines),
            daemon=True,
        ).start()

    @staticmethod
    def _pump(stream: Any, q: queue.Queue[Any] | None, sink: list[str]) -> None:
        try:
            for line in iter(stream.readline, ""):
                sink.append(line)
                if q is not None:
                    q.put(line)
        except (OSError, ValueError):
            pass
        finally:
            if q is not None:
                q.put(_EOF)

    # -- supervisor primitives ------------------------------------------

    def _read_raw(self, timeout: float) -> dict[str, Any]:
        try:
            item = self._out_q.get(timeout=timeout)
        except queue.Empty:
            raise WorkerTimeout(
                f"no stdout frame within {timeout}s; stderr so far: {self.stderr_text()!r}"
            ) from None
        if item is _EOF:
            raise WorkerDied(f"worker stdout EOF, exit={self.proc.poll()}")
        msg = json.loads(item)
        assert isinstance(msg, dict), f"non-object frame on stdout: {item!r}"
        return msg

    def read_message(self, timeout: float = READ_TIMEOUT_S) -> dict[str, Any]:
        """Next frame, draining stashed frames first (FIFO preserved)."""
        if self._pending:
            return self._pending.pop(0)
        return self._read_raw(timeout)

    def send_frame(self, frame: dict[str, Any]) -> None:
        self.send_raw(json.dumps(frame))

    def send_raw(self, text: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(text + "\n")
        self.proc.stdin.flush()

    def request(
        self, method: str, payload: Any = None, timeout: float = READ_TIMEOUT_S
    ) -> dict[str, Any]:
        """Send a request; return its response, stashing other frames.

        Response correlation is by exact ``id`` echo — the property the
        shell relies on when events interleave with replies.
        """
        self._seq += 1
        rid = f"req-{self._seq:04d}"
        self.send_frame(
            {
                "v": 1,
                "id": rid,
                "kind": "request",
                "method": method,
                "payload": payload if payload is not None else {},
            }
        )
        deadline = time.monotonic() + timeout
        while True:
            msg = self._read_raw(max(deadline - time.monotonic(), 0.01))
            if msg.get("kind") == "response" and msg.get("id") == rid:
                return msg
            self._pending.append(msg)

    def next_event(self, timeout: float = READ_TIMEOUT_S) -> dict[str, Any]:
        """Next ``kind=event`` frame (stashed frames first)."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = max(deadline - time.monotonic(), 0.01)
            msg = self._pending.pop(0) if self._pending else self._read_raw(remaining)
            if msg.get("kind") == "event":
                return msg
            if time.monotonic() > deadline:
                raise WorkerTimeout("timed out waiting for an event frame")

    def wait_for_phase(self, phase: str, timeout: float = READ_TIMEOUT_S) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            ev = self.next_event(timeout=max(deadline - time.monotonic(), 0.01))
            if ev["payload"]["phase"] == phase:
                return ev

    def handshake(self, protocol_version: int = 1) -> dict[str, Any]:
        return self.request(
            "engine.handshake", {"protocolVersion": protocol_version}
        )

    # -- process control -------------------------------------------------

    def close_stdin(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()

    def wait_exit(self, timeout: float = READ_TIMEOUT_S) -> int:
        return self.proc.wait(timeout=timeout)

    def kill(self) -> None:
        """TerminateProcess on Windows — the practical SIGKILL equivalent."""
        self.proc.kill()

    def stderr_text(self) -> str:
        return "".join(self._stderr_lines)

    def close(self) -> None:
        if self.proc.poll() is None:
            self.kill()
        self.proc.wait(timeout=READ_TIMEOUT_S)


@pytest.fixture
def spawn() -> Any:
    """Factory fixture: every spawned worker is reaped at test end."""
    handles: list[WorkerHandle] = []

    def _spawn() -> WorkerHandle:
        handle = WorkerHandle()
        handles.append(handle)
        return handle

    yield _spawn
    for handle in handles:
        handle.close()


def _assert_ok(resp: dict[str, Any]) -> dict[str, Any]:
    assert resp["kind"] == "response"
    assert resp["error"] is None, resp
    return resp["payload"]


# -----------------------------------------------------------------------
# handshake / ping / unknown methods
# -----------------------------------------------------------------------


def test_handshake_reports_version_engine_and_capabilities(spawn: Any) -> None:
    w = spawn()
    payload = _assert_ok(w.handshake())
    assert payload["protocolVersion"] == 1
    info = payload["engineInfo"]
    assert info["name"] == "hornscribe-engine"
    assert isinstance(info["version"], str) and info["version"]
    assert info["python"].startswith("3.")
    caps = payload["capabilities"]
    assert "demoLongTask" in caps["jobKinds"]
    assert caps["cooperativeCancel"] is True
    assert caps["cancellationFallback"] == "terminate+restart"
    # #10: engine-view tool status — booleans, never missing keys.
    assert isinstance(caps["demucsAvailable"], bool)
    assert isinstance(caps["ffmpegAvailable"], bool)


def test_ping_echoes_and_correlates_ids(spawn: Any) -> None:
    w = spawn()
    r1 = w.request("engine.ping", {"echo": "alpha"})
    r2 = w.request("engine.ping", {"echo": {"nested": [1, 2]}})
    assert _assert_ok(r1)["echo"] == "alpha"
    assert _assert_ok(r2)["echo"] == {"nested": [1, 2]}
    assert r1["id"] != r2["id"]  # each response carried its own request id


def test_unknown_method_returns_structured_error(spawn: Any) -> None:
    w = spawn()
    resp = w.request("engine.teleport", {})
    assert resp["kind"] == "response"
    assert resp["error"]["code"] == "UNKNOWN_METHOD"
    assert resp["payload"] is None
    _assert_ok(w.request("engine.ping"))  # worker unaffected


# -----------------------------------------------------------------------
# malformed input containment
# -----------------------------------------------------------------------


@pytest.mark.parametrize("raw", ["{not json", "[1, 2, 3]", "42", '"text"', ""])
def test_malformed_json_is_contained(spawn: Any, raw: str) -> None:
    w = spawn()
    w.send_raw(raw)
    msg = w.read_message()
    assert msg["kind"] == "response"
    assert msg["error"]["code"] == "MALFORMED_MESSAGE"
    # Unrecoverable frame → the documented id:null error response.
    assert msg["id"] is None
    _assert_ok(w.request("engine.ping"))  # worker survives


@pytest.mark.parametrize(
    "frame",
    [
        {"id": "r1", "kind": "request", "method": "engine.ping"},  # missing v
        {"v": "1", "id": "r1", "kind": "request", "method": "engine.ping"},  # v type
        {"v": 1, "kind": "request", "method": "engine.ping"},  # missing id
        {"v": 1, "id": "r1", "kind": "request"},  # missing method
        {"v": 1, "id": "r1", "kind": "wat", "method": "engine.ping"},  # bad kind
        {"v": 1, "id": 7, "kind": "request", "method": "engine.ping"},  # id type
    ],
    ids=["missing-v", "v-wrong-type", "missing-id", "missing-method", "bad-kind", "id-int"],
)
def test_malformed_envelopes_are_contained(spawn: Any, frame: dict[str, Any]) -> None:
    w = spawn()
    w.send_frame(frame)
    msg = w.read_message()
    assert msg["error"]["code"] == "MALFORMED_MESSAGE"
    if isinstance(frame.get("id"), str):
        assert msg["id"] == frame["id"]  # id recovered for correlation
    _assert_ok(w.request("engine.ping"))


def test_unknown_fields_are_ignored(spawn: Any) -> None:
    w = spawn()
    w.send_frame(
        {
            "v": 1,
            "id": "req-x1",
            "kind": "request",
            "method": "engine.ping",
            "payload": {"echo": 7, "futureField": {"x": 1}},
            "newTopLevelField": "ignored",
        }
    )
    msg = w.read_message()
    assert _assert_ok(msg)["echo"] == 7


# -----------------------------------------------------------------------
# protocol version handling
# -----------------------------------------------------------------------


def test_envelope_version_mismatch_fails_clearly(spawn: Any) -> None:
    w = spawn()
    w.send_frame({"v": 2, "id": "req-v2", "kind": "request", "method": "engine.ping"})
    msg = w.read_message()
    assert msg["kind"] == "response"
    assert msg["id"] == "req-v2"
    assert msg["error"]["code"] == "PROTOCOL_VERSION_MISMATCH"
    assert msg["error"]["details"]["expected"] == 1


def test_handshake_rejects_incompatible_version_and_exits(spawn: Any) -> None:
    w = spawn()
    resp = w.request("engine.handshake", {"protocolVersion": 99})
    assert resp["error"]["code"] == "PROTOCOL_VERSION_MISMATCH"
    assert resp["error"]["details"]["supported"] == [1]
    # Refusal is explicit AND final: the worker exits rather than serve a
    # peer it cannot talk to. Exit is graceful (0) — refusal, not crash.
    assert w.wait_exit(timeout=READ_TIMEOUT_S) == 0


# -----------------------------------------------------------------------
# jobs: progress, cancel, failure, concurrency guard
# -----------------------------------------------------------------------


def test_demo_long_task_streams_progress_to_completion(spawn: Any) -> None:
    w = spawn()
    w.handshake()
    resp = _assert_ok(
        w.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 5, "stepDurationMs": 15}},
        )
    )
    job_id = resp["jobId"]
    phases: list[str] = []
    progresses: list[float] = []
    while True:
        ev = w.next_event()
        assert ev["id"] is None
        assert ev["kind"] == "event"
        assert ev["method"] == "job.event"
        p = ev["payload"]
        assert p["jobId"] == job_id and p["jobKind"] == "demoLongTask"
        phases.append(p["phase"])
        if p["phase"] == "progress":
            progresses.append(p["progress"])
        if p["phase"] in {"completed", "cancelled", "failed"}:
            break
    assert phases[0] == "started"
    assert phases[-1] == "completed"
    assert progresses == sorted(progresses)
    assert progresses[-1] == 1.0


def test_requests_are_answered_while_job_runs(spawn: Any) -> None:
    """Progress streaming must not block the request loop (UI stays live)."""
    w = spawn()
    w.handshake()
    _assert_ok(
        w.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 60, "stepDurationMs": 25}},
        )
    )
    t0 = time.monotonic()
    resp = _assert_ok(w.request("engine.ping", {"echo": "during-job"}))
    assert resp["echo"] == "during-job"
    assert time.monotonic() - t0 < 1.0  # ≪ the ~1.5s job runtime
    w.wait_for_phase("completed")


def test_job_cancel_is_cooperative_and_prompt(spawn: Any) -> None:
    w = spawn()
    w.handshake()
    job = _assert_ok(
        w.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 100, "stepDurationMs": 20}},
        )
    )
    job_id = job["jobId"]
    w.wait_for_phase("progress")
    t0 = time.monotonic()
    resp = _assert_ok(w.request("job.cancel", {"jobId": job_id}))
    assert resp["cancellation"] == "requested"
    term = w.wait_for_phase("cancelled")
    latency = time.monotonic() - t0
    assert term["payload"]["jobId"] == job_id
    # Cooperative cancel lands at the next step boundary (~20ms); 2s is a
    # generous bound that still proves promptness.
    assert latency < 2.0
    assert term["payload"]["progress"] < 1.0
    _assert_ok(w.request("engine.ping"))  # worker keeps serving


def test_cancel_unknown_or_finished_job(spawn: Any) -> None:
    w = spawn()
    resp = w.request("job.cancel", {"jobId": "job-9999"})
    assert resp["error"]["code"] == "JOB_NOT_FOUND"
    job = _assert_ok(
        w.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 2, "stepDurationMs": 5}},
        )
    )
    w.wait_for_phase("completed")
    resp = w.request("job.cancel", {"jobId": job["jobId"]})
    assert resp["error"]["code"] == "JOB_NOT_FOUND"  # already terminal


def test_second_job_is_rejected_while_one_runs(spawn: Any) -> None:
    w = spawn()
    first = _assert_ok(
        w.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 100, "stepDurationMs": 20}},
        )
    )
    resp = w.request("job.start", {"jobKind": "demoLongTask"})
    assert resp["error"]["code"] == "JOB_ALREADY_RUNNING"
    assert resp["error"]["details"]["activeJobId"] == first["jobId"]
    _assert_ok(w.request("job.cancel", {"jobId": first["jobId"]}))
    w.wait_for_phase("cancelled")


def test_unknown_job_kind_is_rejected(spawn: Any) -> None:
    w = spawn()
    resp = w.request("job.start", {"jobKind": "nonsense"})
    assert resp["error"]["code"] == "UNKNOWN_JOB_KIND"


def test_invalid_job_params_are_rejected(spawn: Any) -> None:
    w = spawn()
    resp = w.request(
        "job.start",
        {"jobKind": "demoLongTask", "params": {"steps": "many"}},
    )
    assert resp["error"]["code"] == "INVALID_PARAMS"


def test_engine_side_job_deadline_times_out(spawn: Any) -> None:
    """deadlineMs proves timeout handling inside the engine, not just the shell."""
    w = spawn()
    job = _assert_ok(
        w.request(
            "job.start",
            {
                "jobKind": "demoLongTask",
                "params": {"steps": 1000, "stepDurationMs": 50, "deadlineMs": 80},
            },
        )
    )
    term = w.wait_for_phase("failed")
    assert term["payload"]["jobId"] == job["jobId"]
    assert term["payload"]["error"]["code"] == "JOB_TIMEOUT"


def test_job_failure_emits_failed_event_not_worker_death(spawn: Any) -> None:
    w = spawn()
    job = _assert_ok(
        w.request(
            "job.start",
            {
                "jobKind": "demoLongTask",
                "params": {"steps": 5, "stepDurationMs": 10, "failAtStep": 3},
            },
        )
    )
    term = w.wait_for_phase("failed")
    assert term["payload"]["error"]["code"] == "JOB_FAILED"
    assert term["payload"]["jobId"] == job["jobId"]
    _assert_ok(w.request("engine.ping"))  # job failure ≠ worker failure


# -----------------------------------------------------------------------
# timeouts, crash detection, restart
# -----------------------------------------------------------------------


def test_unresponsive_worker_is_caught_by_supervisor_timeout(spawn: Any) -> None:
    """A wedged worker produces no frame; the supervisor-side read timeout
    is what detects it (the same thing a Tauri shell would enforce)."""
    w = spawn()
    w.handshake()
    w.send_frame(
        {
            "v": 1,
            "id": "req-hang",
            "kind": "request",
            "method": "debug.hang",
            "payload": {"seconds": 30},
        }
    )
    with pytest.raises(WorkerTimeout):
        w.read_message(timeout=0.75)
    assert w.proc.poll() is None  # alive but unresponsive → kill is the fix
    w.kill()
    assert w.wait_exit(timeout=READ_TIMEOUT_S) != 0


def test_crash_is_detected_and_restart_restores_service(spawn: Any) -> None:
    w1 = spawn()
    p1 = _assert_ok(w1.handshake())
    _assert_ok(
        w1.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 200, "stepDurationMs": 20}},
        )
    )
    w1.wait_for_phase("progress")  # mid-flight…
    w1.kill()  # TerminateProcess — Windows kill -9 equivalent
    rc = w1.wait_exit(timeout=READ_TIMEOUT_S)
    assert rc != 0  # crash detected via nonzero exit + stdout EOF

    # The in-flight job never reached a terminal event; per ADR-0002 the
    # supervisor marks it failed and never silently resubmits it.
    received = list(w1._pending)
    assert all(
        ev["payload"].get("phase") != "completed"
        for ev in received
        if ev.get("kind") == "event"
    )

    # Restart works without restarting the "UI" (this test process).
    w2 = spawn()
    p2 = _assert_ok(w2.handshake())
    assert p2["protocolVersion"] == p1["protocolVersion"]
    assert p2["engineInfo"]["name"] == p1["engineInfo"]["name"]
    # Engine workers are stateless: project state lives in the shell-side
    # store (FND-001), so nothing is lost by the restart. A fresh job on
    # the new worker completes normally.
    job2 = _assert_ok(
        w2.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 3, "stepDurationMs": 10}},
        )
    )
    done = w2.wait_for_phase("completed")
    assert done["payload"]["jobId"] == job2["jobId"]


# -----------------------------------------------------------------------
# shutdown paths
# -----------------------------------------------------------------------


def test_engine_shutdown_is_graceful(spawn: Any) -> None:
    w = spawn()
    w.handshake()
    resp = _assert_ok(w.request("engine.shutdown"))
    assert resp["ok"] is True
    assert w.wait_exit(timeout=READ_TIMEOUT_S) == 0


def test_stdin_eof_is_a_clean_shutdown(spawn: Any) -> None:
    w = spawn()
    w.handshake()
    w.close_stdin()
    assert w.wait_exit(timeout=READ_TIMEOUT_S) == 0


def test_shutdown_cancels_active_job(spawn: Any) -> None:
    w = spawn()
    w.handshake()
    job = _assert_ok(
        w.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 100, "stepDurationMs": 20}},
        )
    )
    resp = _assert_ok(w.request("engine.shutdown"))
    assert resp["activeJob"] == job["jobId"]
    assert w.wait_exit(timeout=READ_TIMEOUT_S) == 0


# -----------------------------------------------------------------------
# stream hygiene
# -----------------------------------------------------------------------


def test_stdout_carries_only_protocol_frames_and_stderr_gets_logs(spawn: Any) -> None:
    w = spawn()
    w.handshake()
    _assert_ok(
        w.request(
            "job.start",
            {"jobKind": "demoLongTask", "params": {"steps": 3, "stepDurationMs": 10}},
        )
    )
    w.wait_for_phase("completed")
    _assert_ok(w.request("engine.shutdown"))
    w.wait_exit(timeout=READ_TIMEOUT_S)
    time.sleep(0.3)  # let reader threads drain

    assert w.stdout_lines, "expected protocol frames on stdout"
    for line in w.stdout_lines:
        obj = json.loads(line)  # every stdout line must be a valid frame
        assert obj["v"] == 1
        assert obj["kind"] in {"response", "event"}
        assert set(obj) >= {"v", "id", "kind", "method", "payload", "error"}

    # Diagnostics live on stderr, separately capturable by the shell.
    assert "sidecar started" in w.stderr_text()
    assert "sidecar stopped" in w.stderr_text()


# -----------------------------------------------------------------------
# project.save (#100)
# -----------------------------------------------------------------------


def _project_doc(source_path: Path | None = None) -> dict[str, Any]:
    return {
        "schemaVersion": 1,
        "projectId": "prj-0123456789abcdef",
        "sourceAudio": (
            {"originalPath": str(source_path), "contentHash": ""}
            if source_path
            else None
        ),
        "transcription": {
            "backend": "basic_pitch",
            "backendVersion": "0.4.0",
            "settings": {"tempoBpm": 120},
            "revision": "tr-0123456789abcdef",
            "rawResultRef": "raw/tr-0123456789abcdef.json",
        },
        "score": {
            "revision": "rev-0123456789abcdef",
            "scoreRef": "scores/rev-0123456789abcdef.json",
            "quantizationSettings": {},
        },
        "userEdits": [],
        "reviewDecisions": [],
        "uiSession": None,
    }


def test_project_save_writes_valid_document(spawn: Any, tmp_path: Path) -> None:
    w = spawn()
    w.handshake()
    audio = tmp_path / "take.wav"
    audio.write_bytes(b"RIFFfake")
    target = tmp_path / "take.hornscribe.json"

    payload = _assert_ok(
        w.request(
            "project.save",
            {"path": str(target), "project": _project_doc(audio)},
        )
    )
    assert payload["path"] == str(target)
    assert payload["projectId"] == "prj-0123456789abcdef"

    saved = json.loads(target.read_text(encoding="utf-8"))
    assert saved["schemaVersion"] == 1
    # The worker computed the missing contentHash from the file.
    assert saved["sourceAudio"]["contentHash"] == hashlib.sha256(
        b"RIFFfake"
    ).hexdigest()
    assert saved["sourceAudio"]["originalPath"] == str(audio)


def test_project_save_rejects_bad_path_and_bad_document(
    spawn: Any, tmp_path: Path
) -> None:
    w = spawn()
    w.handshake()

    resp = w.request(
        "project.save",
        {"path": str(tmp_path / "x.json"), "project": _project_doc()},
    )
    assert resp["error"]["code"] == "INVALID_PARAMS"

    resp = w.request(
        "project.save",
        {
            "path": str(tmp_path / "x.hornscribe.json"),
            "project": {"schemaVersion": 99, "projectId": "prj-0123456789abcdef"},
        },
    )
    assert resp["error"]["code"] == "INVALID_PARAMS"
    assert not (tmp_path / "x.hornscribe.json").exists()


def test_project_save_advertised_in_handshake(spawn: Any) -> None:
    w = spawn()
    payload = _assert_ok(w.handshake())
    assert "project.save" in payload["capabilities"]["methods"]


def test_project_save_preserves_score_extras(
    spawn: Any, tmp_path: Path
) -> None:
    """#218: scoreDocument/musicXml/reviewIssues/meta ride along as
    extras — dropping them made saved scores unrestorable."""
    w = spawn()
    w.handshake()
    target = tmp_path / "take.hornscribe.json"
    doc = _project_doc()
    doc.update(
        {
            "scoreDocument": {"content": {"parts": []}},
            "musicXmlConcert": "<score-partwise/>",
            "musicXmlHornF": "<score-partwise horn/>",
            "reviewIssues": [{"id": "ri-000001", "status": "open"}],
            "meta": {"noteCount": 4},
        }
    )
    _assert_ok(
        w.request(
            "project.save",
            {"path": str(target), "project": doc},
        )
    )
    saved = json.loads(target.read_text(encoding="utf-8"))
    assert saved["scoreDocument"] == {"content": {"parts": []}}
    assert saved["musicXmlConcert"] == "<score-partwise/>"
    assert saved["musicXmlHornF"] == "<score-partwise horn/>"
    assert saved["reviewIssues"] == [{"id": "ri-000001", "status": "open"}]
    assert saved["meta"] == {"noteCount": 4}
    # Schema keys still win over a colliding extra.
    assert saved["schemaVersion"] == 1


# -----------------------------------------------------------------------
# project.open (#365) — the authoritative migrate+validate open funnel
# -----------------------------------------------------------------------


def test_project_open_by_path_normalizes_and_preserves_extras(
    spawn: Any, tmp_path: Path
) -> None:
    w = spawn()
    w.handshake()
    target = tmp_path / "take.hornscribe.json"
    doc = _project_doc()
    doc.update(
        {
            "musicXmlConcert": "<score-partwise/>",
            "musicXmlHornF": "<score-partwise horn/>",
            "reviewIssues": [{"id": "ri-000001", "status": "open"}],
            "scoreDocument": {"content": {"parts": []}},
        }
    )
    target.write_text(json.dumps(doc), encoding="utf-8")

    payload = _assert_ok(w.request("project.open", {"path": str(target)}))
    assert payload["path"] == str(target)
    project = payload["project"]
    # Schema keys validate + normalize through HornScribeProject.
    assert project["schemaVersion"] == 1
    assert project["projectId"] == "prj-0123456789abcdef"
    assert project["score"]["revision"] == "rev-0123456789abcdef"
    # Extras round-trip — the shell restores the score from them.
    assert project["musicXmlConcert"] == "<score-partwise/>"
    assert project["musicXmlHornF"] == "<score-partwise horn/>"
    assert project["reviewIssues"] == [{"id": "ri-000001", "status": "open"}]
    assert project["scoreDocument"] == {"content": {"parts": []}}


def test_project_open_document_base64_mode(spawn: Any) -> None:
    """Byte-opens (File drops, autosave snapshots) take the same
    migrate+validate path — no durable path required."""
    import base64

    w = spawn()
    w.handshake()
    doc = _project_doc()
    payload = _assert_ok(
        w.request(
            "project.open",
            {"documentBase64": base64.b64encode(json.dumps(doc).encode()).decode()},
        )
    )
    assert payload["path"] == ""
    assert payload["project"]["projectId"] == "prj-0123456789abcdef"


def test_project_open_fails_closed_on_bad_documents(
    spawn: Any, tmp_path: Path
) -> None:
    w = spawn()
    w.handshake()

    cases: list[dict[str, Any]] = [
        # malformed projectId — the TS parser used to accept this
        {**_project_doc(), "projectId": "foo"},
        # newer schema than this build understands
        {**_project_doc(), "schemaVersion": 99},
        # non-integer schemaVersion
        {**_project_doc(), "schemaVersion": "1"},
        # malformed transcription revision id
        {
            **_project_doc(),
            "transcription": {
                **_project_doc()["transcription"],
                "revision": "bogus",
            },
        },
        # malformed score revision id
        {**_project_doc(), "score": {"revision": "x"}},
    ]
    for doc in cases:
        target = tmp_path / "bad.hornscribe.json"
        target.write_text(json.dumps(doc), encoding="utf-8")
        resp = w.request("project.open", {"path": str(target)})
        assert resp["error"]["code"] == "INVALID_PARAMS", doc

    # Non-JSON content also fails closed.
    target.write_text("{corrupt", encoding="utf-8")
    resp = w.request("project.open", {"path": str(target)})
    assert resp["error"]["code"] == "INVALID_PARAMS"

    # Wrong suffix / missing file are rejected before parsing.
    resp = w.request("project.open", {"path": str(tmp_path / "x.json")})
    assert resp["error"]["code"] == "INVALID_PARAMS"
    resp = w.request(
        "project.open",
        {"path": str(tmp_path / "gone.hornscribe.json")},
    )
    assert resp["error"] is not None

    # Garbage base64 and a bare payload are rejected too.
    resp = w.request("project.open", {"documentBase64": "!!!"})
    assert resp["error"]["code"] == "INVALID_PARAMS"
    resp = w.request("project.open", {})
    assert resp["error"]["code"] == "INVALID_PARAMS"


def test_project_open_advertised_in_handshake(spawn: Any) -> None:
    w = spawn()
    payload = _assert_ok(w.handshake())
    assert "project.open" in payload["capabilities"]["methods"]


# -----------------------------------------------------------------------
# project.open .recovery fallback (#391) — the save protocol's sibling
# snapshot must actually serve the product open path.
# -----------------------------------------------------------------------


def test_project_open_recovers_from_recovery_sibling(
    spawn: Any, tmp_path: Path
) -> None:
    """Truncated main + valid recovery fixture: the open succeeds through
    the sibling and flags `recovered` so the shell can surface it."""
    w = spawn()
    w.handshake()
    target = tmp_path / "take.hornscribe.json"
    recovery = tmp_path / "take.hornscribe.json.recovery"
    recovery.write_text(json.dumps(_project_doc()), encoding="utf-8")
    target.write_text('{"schemaVersion": 1, "projectId": "prj-01234567', encoding="utf-8")

    payload = _assert_ok(w.request("project.open", {"path": str(target)}))
    assert payload["path"] == str(target)
    assert payload["recovered"] is True
    assert payload["project"]["projectId"] == "prj-0123456789abcdef"

    # The restored document can be saved straight back over the broken
    # main file — the acceptance path for repairing the project.
    _assert_ok(
        w.request(
            "project.save",
            {"path": str(target), "project": payload["project"]},
        )
    )
    repaired = json.loads(target.read_text(encoding="utf-8"))
    assert repaired["projectId"] == "prj-0123456789abcdef"


def test_project_open_valid_main_ignores_recovery(
    spawn: Any, tmp_path: Path
) -> None:
    """A readable main file always wins — the sibling never shadows it."""
    w = spawn()
    w.handshake()
    target = tmp_path / "take.hornscribe.json"
    recovery = tmp_path / "take.hornscribe.json.recovery"
    target.write_text(json.dumps(_project_doc()), encoding="utf-8")
    stale = _project_doc()
    stale["projectId"] = "prj-aaaaaaaaaaaaaaaa"
    recovery.write_text(json.dumps(stale), encoding="utf-8")

    payload = _assert_ok(w.request("project.open", {"path": str(target)}))
    assert "recovered" not in payload
    assert payload["project"]["projectId"] == "prj-0123456789abcdef"


def test_project_open_missing_main_uses_recovery(
    spawn: Any, tmp_path: Path
) -> None:
    """store.py load() semantics: an unreadable/absent main file falls
    back to the sibling the same way a corrupt one does."""
    w = spawn()
    w.handshake()
    target = tmp_path / "take.hornscribe.json"
    recovery = tmp_path / "take.hornscribe.json.recovery"
    recovery.write_text(json.dumps(_project_doc()), encoding="utf-8")

    payload = _assert_ok(w.request("project.open", {"path": str(target)}))
    assert payload["recovered"] is True


def test_project_open_broken_pair_surfaces_main_failure(
    spawn: Any, tmp_path: Path
) -> None:
    """A recovery sibling rides the identical validation funnel — when it
    is also broken the open still fails closed with the main error."""
    w = spawn()
    w.handshake()
    target = tmp_path / "take.hornscribe.json"
    recovery = tmp_path / "take.hornscribe.json.recovery"
    target.write_text("{corrupt", encoding="utf-8")
    # A schema-valid read but a version this build cannot serve.
    recovery.write_text(
        json.dumps({**_project_doc(), "schemaVersion": 99}),
        encoding="utf-8",
    )

    resp = w.request("project.open", {"path": str(target)})
    assert resp["error"]["code"] == "INVALID_PARAMS"
    assert "not valid JSON" in resp["error"]["message"]

def test_export_midi_returns_canonical_smf(spawn: Any) -> None:
    """#256: export.midi runs the engine's playback_midi_bytes — the
    desktop's MusicXML->MIDI rebuild loses velocity/bends/swing."""
    import base64

    from conftest import make_score

    w = spawn()
    w.handshake()
    resp = _assert_ok(
        w.request(
            "export.midi",
            {"scoreDocument": make_score([(60, 0, 1), (64, 1, 1)]).to_dict()},
        )
    )
    midi = base64.b64decode(resp["midiBase64"])
    assert midi[:4] == b"MThd"
    assert len(midi) > 14


def test_export_midi_rejects_bad_document(spawn: Any) -> None:
    w = spawn()
    w.handshake()
    resp = w.request("export.midi", {"scoreDocument": {"bogus": True}})
    assert resp["error"]["code"] == "INVALID_PARAMS"


def test_export_midi_advertised_in_handshake(spawn: Any) -> None:
    w = spawn()
    payload = _assert_ok(w.handshake())
    assert "export.midi" in payload["capabilities"]["methods"]
