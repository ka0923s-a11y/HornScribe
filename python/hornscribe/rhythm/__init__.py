"""Deterministic timing/meter contracts and the HSQ-v1 onset quantizer.

The immutable contracts the quantizer consumes and produces live here, plus
the QNT-002 onset search: binary candidate lattice, Huber onset/IOI costs,
deterministic top-K DP, global alignment-shift search, naive baselines, and
onset-metric benchmarks. No audio, GUI, or notation-backend logic — see
``docs/QUANTIZER_DESIGN.md``.
"""

from hornscribe.rhythm.baselines import (
    BASELINE_B0_GRID_QL,
    snap_candidate_lattice,
    snap_nearest_grid,
)
from hornscribe.rhythm.beatmap import (
    BeatAnchor,
    BeatMap,
    BeatSource,
    InvalidBeatMapError,
)
from hornscribe.rhythm.benchmark import OnsetMetrics, benchmark_onsets, onset_metrics
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
from hornscribe.rhythm.costs import (
    confidence_weight,
    huber,
    ioi_cost,
    onset_cost,
)
from hornscribe.rhythm.dp import OnsetPath, evaluate_onset_path_cost, kbest_onset_paths
from hornscribe.rhythm.lattice import (
    CandidateGrid,
    OnsetCandidate,
    generate_onset_candidates,
    grid_distance_ql,
    nearest_grid_index,
    snap_to_grid_ql,
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
from hornscribe.rhythm.quantizer import (
    AlignmentEstimate,
    estimate_alignment_shift,
    quantize_events,
    quantize_normalized,
)
from hornscribe.rhythm.timewarp import (
    TimeWarp,
    TimeWarpMode,
    normalize_to_score_time,
)

__all__ = [
    "QUANTIZER_ID",
    "QUANTIZER_VERSION",
    "AlignmentEstimate",
    "BASELINE_B0_GRID_QL",
    "BeatAnchor",
    "BeatMap",
    "BeatSource",
    "CandidateGrid",
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
    "OnsetCandidate",
    "OnsetMetrics",
    "OnsetPath",
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
    "benchmark_onsets",
    "confidence_weight",
    "estimate_alignment_shift",
    "evaluate_onset_path_cost",
    "generate_onset_candidates",
    "grid_distance_ql",
    "huber",
    "ioi_cost",
    "kbest_onset_paths",
    "nearest_grid_index",
    "normalize_to_score_time",
    "onset_cost",
    "onset_metrics",
    "quantize_events",
    "quantize_normalized",
    "snap_candidate_lattice",
    "snap_nearest_grid",
    "snap_to_grid_ql",
]
