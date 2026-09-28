"""Compatibility shim — the swing census moved to the rhythm layer (#88).

``hornscribe.rhythm.swing`` owns the detector so the quantizer can snap
swung offbeats onto the straight-eighth grid before committing positions.
This module re-exports the public names for the transcription pipeline
and older imports.
"""

from hornscribe.rhythm.swing import SwingEstimate, detect_swing

__all__ = ["SwingEstimate", "detect_swing"]
