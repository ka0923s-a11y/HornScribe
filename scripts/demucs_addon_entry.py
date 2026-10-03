"""Frozen entry point for the demucs separation addon (#190).

The console script ``demucs=demucs.separate:main`` cannot be a
PyInstaller entry (``separate.py`` has no ``__main__`` guard), so
the frozen build launches through this shim instead.

``freeze_support`` guards ``-j`` (multiprocessing spawn): without it
each worker child would re-run ``main`` on the parent's argv.
"""

from __future__ import annotations

import multiprocessing
import sys


def run() -> int:
    multiprocessing.freeze_support()
    # Lazy import so multiprocessing children exit through
    # freeze_support before touching torch.
    from demucs.separate import main

    rc = main()
    return int(rc) if isinstance(rc, int) else 0


if __name__ == "__main__":
    sys.exit(run())
