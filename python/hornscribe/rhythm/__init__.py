"""Deterministic timing/meter contracts and the HSQ-v1 quantizer.

The immutable contracts the quantizer consumes and produces live here, plus
the QNT-002 onset search (binary candidate lattice, Huber onset/IOI costs,
deterministic top-K DP, global alignment-shift search, naive baselines, and
onset-metric benchmarks) and the QNT-003 joint duration/rest realization
(span decomposition into notation atoms, rest generation, tie splitting,
notation-complexity costs), the QNT-004 meter expansion (3/4, 2/4
and compound 6/8 measures, manual ``measure_phase_ql`` anacrusis,
meter-aware rest grouping, and the ``assemble_score_document`` MusicXML
bridge), and the QNT-005 triplet model (region-gated triplet grid, grid-mode
switch cost, tuplet notation cost, notation-sensitive ambiguity and
``generate_review_issues``). No audio, GUI, or notation-backend logic — see
``docs/QUANTIZER_DESIGN.md``.
"""

from hornscribe.rhythm._output import assemble_score_document
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
from hornscribe.rhythm.benchmark import (
    ABLATION_ARMS,
    BASELINE_ARMS,
    DEFAULT_ARMS,
    MethodRun,
    OnsetMetrics,
    benchmark_methods,
    benchmark_onsets,
    onset_metrics,
)
from hornscribe.rhythm.contracts import (
    QUANTIZER_ID,
    QUANTIZER_VERSION,
    NormalizedNote,
    NotationRealization,
    QuantizationAlternative,
    QuantizationDiagnostics,
    QuantizedRhythmNote,
    RealizedRest,
    RhythmAtom,
)
from hornscribe.rhythm.costs import (
    confidence_weight,
    huber,
    ioi_cost,
    onset_cost,
)
from hornscribe.rhythm.dp import OnsetPath, evaluate_onset_path_cost, kbest_onset_paths
from hornscribe.rhythm.issues import generate_review_issues
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
from hornscribe.rhythm.realize import (
    IntervalRealization,
    SpanRealizer,
    realize_interval,
)
from hornscribe.rhythm.timewarp import (
    TimeWarp,
    TimeWarpMode,
    normalize_to_score_time,
)
from hornscribe.rhythm.triplet import (
    TripletRegion,
    TripletRegionEvidence,
    enabled_triplet_regions,
    region_evidence,
    simple_meter_regions,
    strict_triplet_regions,
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
    "IntervalRealization",
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
    "RealizedRest",
    "RhythmAtom",
    "SpanRealizer",
    "TimeWarp",
    "TimeWarpMode",
    "TripletPolicy",
    "TripletRegion",
    "TripletRegionEvidence",
    "UnsupportedMeterError",
    "ABLATION_ARMS",
    "BASELINE_ARMS",
    "DEFAULT_ARMS",
    "MethodRun",
    "assemble_score_document",
    "benchmark_methods",
    "benchmark_onsets",
    "confidence_weight",
    "enabled_triplet_regions",
    "estimate_alignment_shift",
    "evaluate_onset_path_cost",
    "generate_onset_candidates",
    "generate_review_issues",
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
    "realize_interval",
    "region_evidence",
    "simple_meter_regions",
    "snap_candidate_lattice",
    "snap_nearest_grid",
    "snap_to_grid_ql",
    "strict_triplet_regions",
]
