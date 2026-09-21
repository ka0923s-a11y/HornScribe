"""Deterministic timing/meter contracts for the HSQ-v1 quantizer (QNT-001).

Only the immutable contracts the quantizer consumes and produces live here —
no audio, GUI, or search logic. See ``docs/QUANTIZER_DESIGN.md``.
"""

from hornscribe.rhythm.beatmap import (
    BeatAnchor,
    BeatMap,
    BeatSource,
    InvalidBeatMapError,
)
from hornscribe.rhythm.contracts import (
    QUANTIZER_ID,
    QUANTIZER_VERSION,
    NormalizedNote,
    NotationRealization,
    QuantizationAlternative,
    QuantizationDiagnostics,
    QuantizedRhythmNote,
    RhythmAtom,
)
from hornscribe.rhythm.meter import (
    MeterError,
    MeterMap,
    MeterMapError,
    MeterSegment,
    MetricalLevel,
    MetricalNode,
    MetricalTree,
    UnsupportedMeterError,
)
from hornscribe.rhythm.profile import (
    QuantizationProfile,
    QuantizerWeights,
    TripletPolicy,
)
from hornscribe.rhythm.timewarp import (
    TimeWarp,
    TimeWarpMode,
    normalize_to_score_time,
)

__all__ = [
    "QUANTIZER_ID",
    "QUANTIZER_VERSION",
    "BeatAnchor",
    "BeatMap",
    "BeatSource",
    "InvalidBeatMapError",
    "MeterError",
    "MeterMap",
    "MeterMapError",
    "MeterSegment",
    "MetricalLevel",
    "MetricalNode",
    "MetricalTree",
    "NormalizedNote",
    "NotationRealization",
    "QuantizationAlternative",
    "QuantizationDiagnostics",
    "QuantizationProfile",
    "QuantizedRhythmNote",
    "QuantizerWeights",
    "RhythmAtom",
    "TimeWarp",
    "TimeWarpMode",
    "TripletPolicy",
    "UnsupportedMeterError",
    "normalize_to_score_time",
]
