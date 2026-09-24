"""Audio -> score transcription pipeline (ENG-002).

End-to-end job that turns an audio file into a canonical
ScoreDocument plus MusicXML renderings:

    audio -> backend note events -> monophonic clean-up -> beat map /
    time warp -> HSQ quantization -> ScoreRevisionPayload -> MusicXML

The heavy third-party dependencies (basic_pitch, librosa) are optional
and imported lazily inside the stage functions so the worker can start
— and report basicPitchAvailable: false in the handshake — without
them installed.

Submodules:

* options — validated job.start params for the transcription job kind.
* backend — Basic Pitch backend (lazy import; EngineDependencyError
  when missing).
* clean — raw events -> monophonic canonical-note evidence.
* tempo — beat tracking -> BeatMap / TimeWarp, tempo map derivation.
* key — Krumhansl-Schmuckler key estimation from quantized pitches.
* scorebuild — quantization output -> ScoreRevisionPayload / ScoreDocument.
* pipeline — the staged job runner the worker dispatches.
"""

from hornscribe.transcription.backend import EngineDependencyError
from hornscribe.transcription.options import TranscriptionParams
from hornscribe.transcription.pipeline import (
    JOB_KIND_TRANSCRIPTION,
    run_transcription_job,
)

__all__ = [
    "JOB_KIND_TRANSCRIPTION",
    "EngineDependencyError",
    "TranscriptionParams",
    "run_transcription_job",
]
