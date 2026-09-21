"""HornScribe engine sidecar worker (UI-002 spike).

Speaks the NDJSON protocol in ``protocol/PROTOCOL.md`` over stdin/stdout:
stdout carries protocol frames only, all diagnostics go to stderr.

Lifecycle contract (ADR-0002):

- requests are dispatched sequentially on the stdin read loop
- jobs run on daemon threads so the loop stays responsive (progress
  events stream while ``engine.ping`` etc. keep answering)
- ``engine.shutdown`` replies, then the worker exits 0
- stdin EOF is an implicit graceful shutdown (also exit 0)
- an incompatible ``engine.handshake`` protocol version is refused with
  ``PROTOCOL_VERSION_MISMATCH`` and the worker exits — it will not serve
  a peer it cannot talk to
- at most one job is in flight (``JOB_ALREADY_RUNNING``); the spike does
  not need a pool before evidence requires it (issue non-goals)
"""

from __future__ import annotations

import argparse
import contextlib
import importlib.util
import logging
import os
import platform
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TextIO

import hornscribe
from hornscribe.worker import protocol
from hornscribe.worker.jobs import (
    JOB_KIND_DEMO_LONG_TASK,
    SUPPORTED_JOB_KINDS,
    DemoLongTaskParams,
    run_demo_long_task,
)

log = logging.getLogger("hornscribe.worker")

_SHUTDOWN_JOIN_TIMEOUT_S = 2.0


@dataclass
class _Job:
    """Handle for one in-flight job thread."""

    job_id: str
    kind: str
    cancel: threading.Event
    done: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None


class Worker:
    """The sidecar process: sequential requests, threaded jobs."""

    def __init__(self, stdin: TextIO, stdout: TextIO) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self._write_lock = threading.Lock()
        self._shutdown = threading.Event()
        self._exit_after_response = False
        self._job: _Job | None = None
        self._job_counter = 0
        self._started = time.monotonic()
        self._methods: dict[str, Callable[[Any], dict[str, Any]]] = {
            "engine.handshake": self._handle_handshake,
            "engine.ping": self._handle_ping,
            "engine.shutdown": self._handle_shutdown,
            "job.start": self._handle_job_start,
            "job.cancel": self._handle_job_cancel,
            # Spike-only supervisor test hook: wedges the dispatch loop so
            # the supervisor-side read timeout path can be exercised.
            # Not a stable API; gated on the "debug." prefix.
            "debug.hang": self._handle_debug_hang,
        }

    # ---- frame IO -----------------------------------------------------

    def _send(self, envelope: protocol.Envelope) -> None:
        line = protocol.encode_message(envelope)
        with self._write_lock:
            self._stdout.write(line + "\n")
            self._stdout.flush()

    def _respond(self, request_id: str, method: str | None, payload: Any) -> None:
        self._send(protocol.make_response(request_id, method, payload))

    def _respond_error(
        self,
        request_id: str | None,
        method: str | None,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        self._send(
            protocol.make_error_response(
                request_id, code, message, details=details, method=method
            )
        )

    def _emit_event(self, method: str, payload: dict[str, Any]) -> None:
        self._send(protocol.make_event(method, payload))

    # ---- main loop ----------------------------------------------------

    def serve(self) -> int:
        """Run the read/dispatch loop until shutdown or stdin EOF."""
        log.info(
            "sidecar started pid=%d protocol=v%d hornscribe=%s",
            os.getpid(),
            protocol.PROTOCOL_VERSION,
            hornscribe.__version__,
        )
        while not self._shutdown.is_set():
            line = self._stdin.readline()
            if line == "":
                log.info("stdin EOF; shutting down")
                break
            self._handle_line(line)
            if self._exit_after_response:
                break
        self._shutdown_gracefully()
        log.info("sidecar stopped")
        return 0

    def _shutdown_gracefully(self) -> None:
        job = self._job
        if job is not None and not job.done.is_set():
            log.info("cancelling active job %s for shutdown", job.job_id)
            job.cancel.set()
            if job.thread is not None:
                job.thread.join(timeout=_SHUTDOWN_JOIN_TIMEOUT_S)

    def _handle_line(self, line: str) -> None:
        try:
            msg = protocol.parse_message(line)
        except protocol.ProtocolError as exc:
            log.warning("rejected inbound frame: %s", exc)
            self._respond_error(exc.request_id, None, exc.code, exc.message, exc.details)
            return
        if msg.kind != protocol.KIND_REQUEST:
            # The peer only ever sends requests. Inbound responses/events
            # are logged and dropped — never answered — to avoid any
            # chance of a reply loop.
            log.warning("ignoring inbound %s frame id=%s", msg.kind, msg.id)
            return
        assert msg.id is not None
        assert msg.method is not None
        handler = self._methods.get(msg.method)
        if handler is None:
            self._respond_error(
                msg.id,
                msg.method,
                protocol.ERR_UNKNOWN_METHOD,
                f"unknown method {msg.method!r}",
                details={"methods": sorted(self._methods)},
            )
            return
        try:
            payload = handler(msg.payload)
        except protocol.ProtocolError as exc:
            self._respond_error(msg.id, msg.method, exc.code, exc.message, exc.details)
            return
        except Exception:
            # Errors are structured data, never raw tracebacks (ADR-0002);
            # the traceback stays on stderr where diagnostics belong.
            log.exception("handler failed for %s", msg.method)
            self._respond_error(
                msg.id, msg.method, protocol.ERR_INTERNAL, "internal worker error"
            )
            return
        self._respond(msg.id, msg.method, payload)

    # ---- method handlers ----------------------------------------------

    def _handle_handshake(self, payload: Any) -> dict[str, Any]:
        params = payload if isinstance(payload, dict) else {}
        client_v = params.get("protocolVersion", protocol.PROTOCOL_VERSION)
        if client_v != protocol.PROTOCOL_VERSION:
            # Refuse explicitly, then exit: a worker that cannot speak the
            # peer's version must not limp along (ADR-0002).
            self._exit_after_response = True
            raise protocol.ProtocolError(
                protocol.ERR_PROTOCOL_VERSION_MISMATCH,
                f"client requested protocol v{client_v!r}; "
                f"worker speaks v{protocol.PROTOCOL_VERSION}",
                details={
                    "requested": client_v,
                    "supported": [protocol.PROTOCOL_VERSION],
                },
            )
        return {
            "protocolVersion": protocol.PROTOCOL_VERSION,
            "engineInfo": {
                "name": "hornscribe-engine",
                "version": hornscribe.__version__,
                "python": platform.python_version(),
                "platform": sys.platform,
                "pid": os.getpid(),
            },
            "capabilities": {
                "methods": sorted(self._methods),
                "jobKinds": list(SUPPORTED_JOB_KINDS),
                "maxConcurrentJobs": 1,
                "cooperativeCancel": True,
                "cancellationFallback": "terminate+restart",
                "progressEvents": True,
                "basicPitchAvailable": importlib.util.find_spec("basic_pitch") is not None,
            },
        }

    def _handle_ping(self, payload: Any) -> dict[str, Any]:
        echo = payload.get("echo") if isinstance(payload, dict) else None
        return {
            "echo": echo,
            "workerPid": os.getpid(),
            "uptimeMs": round((time.monotonic() - self._started) * 1000.0, 1),
        }

    def _handle_shutdown(self, payload: Any) -> dict[str, Any]:
        self._exit_after_response = True
        active = self._active_job()
        return {"ok": True, "activeJob": active.job_id if active else None}

    def _handle_job_start(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise protocol.ProtocolError(
                protocol.ERR_INVALID_PARAMS, "job.start payload must be an object"
            )
        kind = payload.get("jobKind")
        if not isinstance(kind, str) or not kind:
            raise protocol.ProtocolError(
                protocol.ERR_INVALID_PARAMS, "job.start requires a string 'jobKind'"
            )
        if kind not in SUPPORTED_JOB_KINDS:
            raise protocol.ProtocolError(
                protocol.ERR_UNKNOWN_JOB_KIND,
                f"unsupported jobKind {kind!r}",
                details={"supported": list(SUPPORTED_JOB_KINDS)},
            )
        active = self._active_job()
        if active is not None:
            raise protocol.ProtocolError(
                protocol.ERR_JOB_ALREADY_RUNNING,
                "a job is already running",
                details={"activeJobId": active.job_id, "maxConcurrentJobs": 1},
            )
        try:
            params = DemoLongTaskParams.from_payload(payload.get("params"))
        except ValueError as exc:
            raise protocol.ProtocolError(
                protocol.ERR_INVALID_PARAMS, str(exc)
            ) from exc
        self._job_counter += 1
        job_id = f"job-{self._job_counter:04d}"
        self._job = self._start_demo_job(job_id, params)
        return {"jobId": job_id, "jobKind": kind, "state": "accepted"}

    def _handle_job_cancel(self, payload: Any) -> dict[str, Any]:
        job_id = payload.get("jobId") if isinstance(payload, dict) else None
        if not isinstance(job_id, str) or not job_id:
            raise protocol.ProtocolError(
                protocol.ERR_INVALID_PARAMS, "job.cancel requires a string 'jobId'"
            )
        job = self._job
        if job is None or job.done.is_set() or job.job_id != job_id:
            raise protocol.ProtocolError(
                protocol.ERR_JOB_NOT_FOUND, f"no active job {job_id!r}"
            )
        job.cancel.set()
        return {"jobId": job.job_id, "cancellation": "requested"}

    def _handle_debug_hang(self, payload: Any) -> dict[str, Any]:
        seconds = 5.0
        if isinstance(payload, dict):
            raw = payload.get("seconds")
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                seconds = float(raw)
        seconds = min(max(seconds, 0.0), 300.0)
        log.warning("debug.hang: wedging dispatch loop for %.1fs", seconds)
        time.sleep(seconds)
        return {"sleptSeconds": seconds}

    # ---- jobs ----------------------------------------------------------

    def _active_job(self) -> _Job | None:
        job = self._job
        if job is not None and not job.done.is_set():
            return job
        return None

    def _start_demo_job(self, job_id: str, params: DemoLongTaskParams) -> _Job:
        job = _Job(job_id=job_id, kind=JOB_KIND_DEMO_LONG_TASK, cancel=threading.Event())

        def emit(phase: str, **fields: Any) -> None:
            body: dict[str, Any] = {
                "jobId": job_id,
                "jobKind": JOB_KIND_DEMO_LONG_TASK,
                "phase": phase,
            }
            body.update(fields)
            self._emit_event("job.event", body)

        def run() -> None:
            try:
                run_demo_long_task(
                    job_id=job_id, params=params, emit=emit, cancel=job.cancel
                )
            except Exception:
                log.exception("job %s crashed", job_id)
                emit(
                    "failed",
                    error={
                        "code": protocol.ERR_INTERNAL,
                        "message": "job crashed unexpectedly",
                    },
                )
            finally:
                job.done.set()

        job.thread = threading.Thread(target=run, name=f"{job_id}", daemon=True)
        job.thread.start()
        return job


def _reconfigure_stream(stream: TextIO, **kwargs: Any) -> None:
    """Best-effort ``TextIOWrapper.reconfigure`` (absent on odd streams)."""
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure):
        with contextlib.suppress(OSError, ValueError):
            reconfigure(**kwargs)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="hornscribe.worker",
        description="HornScribe engine sidecar (NDJSON over stdio; logs on stderr)",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=(
            f"hornscribe-engine {hornscribe.__version__} "
            f"(protocol v{protocol.PROTOCOL_VERSION})"
        ),
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="debug-level diagnostics on stderr",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    # stdout is protocol-only: pin UTF-8 + '\n' so a Windows console
    # encoding or newline translation can never corrupt a frame.
    _reconfigure_stream(sys.stdout, encoding="utf-8", newline="\n", write_through=True)
    _reconfigure_stream(sys.stdin, encoding="utf-8")
    return Worker(sys.stdin, sys.stdout).serve()


if __name__ == "__main__":
    raise SystemExit(main())
