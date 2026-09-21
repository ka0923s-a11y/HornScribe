"""Demo job implementations for the UI-002 spike.

``demoLongTask`` is a synthetic multi-step job standing in for real
inference. It proves structured progress streaming, cooperative
cancellation *between* steps, engine-side deadlines, and every terminal
event phase (``completed`` / ``cancelled`` / ``failed``).

Real Basic Pitch inference is a single blocking ONNX Runtime call
(``docs/ENGINE_RUNTIME_MATRIX.md``, "Cancellation"): a cooperative cancel
flag cannot interrupt it mid-call, so the documented MVP fallback is
worker terminate/restart — exercised end-to-end by the lifecycle tests
in ``tests/python/test_worker.py``.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Protocol

from hornscribe.worker.protocol import ERR_JOB_FAILED, ERR_JOB_TIMEOUT

JOB_KIND_DEMO_LONG_TASK = "demoLongTask"
SUPPORTED_JOB_KINDS: tuple[str, ...] = (JOB_KIND_DEMO_LONG_TASK,)


class EventEmitter(Protocol):
    """Sink for ``job.event`` payloads; implemented by the worker."""

    def __call__(self, phase: str, **fields: Any) -> None: ...


@dataclass(frozen=True)
class DemoLongTaskParams:
    """Validated ``job.start`` params for ``demoLongTask``.

    - ``steps``: number of simulated work units (cancel checkpoints).
    - ``step_duration_ms``: blocking work per step.
    - ``deadline_ms``: engine-side timeout; job fails with ``JOB_TIMEOUT``
      when wall-clock elapsed exceeds it.
    - ``fail_at_step``: test hook — job fails with ``JOB_FAILED`` at that
      step (1-based). Never set by production callers.
    """

    steps: int = 10
    step_duration_ms: float = 20.0
    deadline_ms: float | None = None
    fail_at_step: int | None = None

    @classmethod
    def from_payload(cls, raw: Any) -> DemoLongTaskParams:
        if raw is None:
            return cls()
        if not isinstance(raw, dict):
            raise ValueError("params must be an object")
        steps = cls._opt_int(raw, "steps", 10, lo=1, hi=100_000)
        step_ms = cls._opt_float(raw, "stepDurationMs", 20.0, lo=0.0, hi=60_000.0)
        deadline_ms = cls._opt_float(raw, "deadlineMs", None, lo=1.0, hi=3_600_000.0)
        fail_at = cls._opt_int(raw, "failAtStep", None, lo=1, hi=100_000)
        return cls(
            steps=steps,
            step_duration_ms=step_ms,
            deadline_ms=deadline_ms,
            fail_at_step=fail_at,
        )

    @staticmethod
    def _opt_int(raw: dict[str, Any], name: str, default: int | None, *, lo: int, hi: int) -> Any:
        value = raw.get(name, default)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"params.{name} must be an integer")
        if not lo <= value <= hi:
            raise ValueError(f"params.{name} out of range [{lo}, {hi}]")
        return value

    @staticmethod
    def _opt_float(
        raw: dict[str, Any], name: str, default: float | None, *, lo: float, hi: float
    ) -> Any:
        value = raw.get(name, default)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"params.{name} must be a number")
        if not lo <= float(value) <= hi:
            raise ValueError(f"params.{name} out of range [{lo}, {hi}]")
        return float(value)


def run_demo_long_task(
    *,
    job_id: str,
    params: DemoLongTaskParams,
    emit: EventEmitter,
    cancel: threading.Event,
) -> None:
    """Run the synthetic long task, emitting a ``job.event`` per step.

    Cooperative cancellation is checked at step boundaries only — this
    mirrors what the engine can honestly offer for chunked work. Blocking
    single-call work (Basic Pitch) cannot honor ``cancel`` mid-step; that
    path is covered by the worker terminate/restart fallback.
    """
    started = time.monotonic()
    emit("started", step=0, progress=0.0, totalSteps=params.steps)
    for step in range(1, params.steps + 1):
        if cancel.is_set():
            emit(
                "cancelled",
                step=step - 1,
                progress=(step - 1) / params.steps,
                reason="cancel requested between steps",
            )
            return
        if (
            params.deadline_ms is not None
            and (time.monotonic() - started) * 1000.0 > params.deadline_ms
        ):
            emit(
                "failed",
                step=step - 1,
                progress=(step - 1) / params.steps,
                error={
                    "code": ERR_JOB_TIMEOUT,
                    "message": f"job exceeded deadlineMs={params.deadline_ms}",
                },
            )
            return
        time.sleep(params.step_duration_ms / 1000.0)
        if params.fail_at_step == step:
            emit(
                "failed",
                step=step,
                progress=(step - 1) / params.steps,
                error={
                    "code": ERR_JOB_FAILED,
                    "message": f"demoLongTask failed at step {step} (failAtStep hook)",
                },
            )
            return
        emit("progress", step=step, progress=step / params.steps, totalSteps=params.steps)
    elapsed_ms = (time.monotonic() - started) * 1000.0
    emit(
        "completed",
        step=params.steps,
        progress=1.0,
        elapsedMs=round(elapsed_ms, 1),
        result={"steps": params.steps},
    )
