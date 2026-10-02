/**
 * Deterministic fixture adapter for `ScoreDocumentPort` (UI-030).
 *
 * MusicXML source: the committed UI-005 sync fixtures — a 12-bar, 4/4,
 * 100 BPM single-part score with 40 canonical `sn-*` notes, three tie
 * chains (incl. a 3-fragment chain) and two rests; the concert and F管
 * documents share identical `hs-sn-*` ids, which is exactly what the
 * Concert↔F管 context-preservation path is verified against.
 *
 * Review issues are fixed (never randomized) so every run renders the same
 * 要確認 markers on the same canonical notes.
 *
 * Engine output slots in through the same seam (ENG-002): real job
 * results build an {@link XmlScoreDocument} over the returned MusicXML
 * (see `xmlDocument.ts`); this fixture remains the deterministic
 * fallback for dev sessions and the mock port.
 */
import concertXml from "./fixtures/score_concert.musicxml?raw";
import hornXml from "./fixtures/score_horn_in_f.musicxml?raw";
import bFlatXml from "./fixtures/score_b_flat.musicxml?raw";
import canonicalScaleJson from "./fixtures/canonical_scale_doc.json?raw";
import canonicalVoicesJson from "./fixtures/canonical_voices_doc.json?raw";
import type { ScoreDocumentPort } from "./document";
import type { ScoreReviewIssue } from "./review";
import { XmlScoreDocument } from "./xmlDocument";

/** Deterministic revision id for the bundled fixture document. */
const FIXTURE_REVISION = "rev-fixture0000001";

/* #398: the committed engine fixture — the real canonical payload the
 *  engine produced for the scale sample (parts/velocities/bends). It is
 *  the fixture document's default canonical data so dev sessions exercise
 *  the canonical-gated paths (mixer, velocity audition, note overlay)
 *  instead of the empty-document fallback. The first 8 canonical ids
 *  overlap the MusicXML fixture's sn-* ids; later notes simply have no
 *  canonical match. */
let fixtureCanonicalCache: unknown;
function fixtureCanonical(): unknown {
  if (fixtureCanonicalCache === undefined) {
    fixtureCanonicalCache = JSON.parse(canonicalScaleJson);
  }
  return fixtureCanonicalCache;
}

/* #123: two-voice companion fixture — the same scale with a harmony
 *  part a third below plus one intra-part chord tone. Lets dev states
 *  (#/dev/state/scoreReady-poly) exercise the voices/chords surfaces
 *  (collapseToMelody gating, multi-part rendering) without a job. */
let fixtureVoicesCanonicalCache: unknown;
export function fixtureVoicesCanonical(): unknown {
  if (fixtureVoicesCanonicalCache === undefined) {
    fixtureVoicesCanonicalCache = JSON.parse(canonicalVoicesJson);
  }
  return fixtureVoicesCanonicalCache;
}

const FIXTURE_ISSUES: readonly ScoreReviewIssue[] = [
  {
    id: "ri-000001",
    scoreRevision: FIXTURE_REVISION,
    canonicalNoteIds: ["sn-000012"],
    timeRange: { startSec: 6.6, endSec: 9.0 },
    reason: "quantization_ambiguous",
    severity: "caution",
    evidence: { confidence: 0.71 },
    status: "open",
  },
  {
    id: "ri-000002",
    scoreRevision: FIXTURE_REVISION,
    canonicalNoteIds: ["sn-000022"],
    timeRange: { startSec: 13.2, endSec: 13.8 },
    reason: "low_model_confidence",
    severity: "warning",
    evidence: { confidence: 0.58 },
    status: "open",
  },
  {
    id: "ri-000003",
    scoreRevision: FIXTURE_REVISION,
    canonicalNoteIds: ["sn-000034", "sn-000035"],
    timeRange: { startSec: 20.4, endSec: 21.6 },
    reason: "pitch_spelling_ambiguous",
    severity: "caution",
    evidence: {},
    status: "open",
  },
];

/** What a real job result may override on top of the fixture notation
 *  (score/jobResult.ts) — MusicXML itself stays fixture until the engine
 *  ships document bodies. */
export interface FixtureDocumentOverrides {
  /** Completed job's `scoreRevision`, when present. */
  readonly revisionId?: string;
  /** Review issues from the job result — `[]` honestly means "the engine
   *  found nothing to flag" (never fall back to fixture issues then). */
  readonly issues?: readonly ScoreReviewIssue[];
  /** Canonical engine payload — present on real job results; needed
   *  by paths gated on canonicalDocument() (engine edits, canonical
   *  MIDI export). */
  readonly canonicalDocument?: unknown;
}

/**
 * The deterministic score document used until the engine pipeline delivers
 * real `ScoreDocumentPort` data (UI-040+). Everything derived from it —
 * rendered pages, canonical ids, review markers — is byte-stable.
 *
 * `overrides` carries the UI-040 result handoff (score/jobResult.ts):
 * the job's `scoreRevision` and typed review issues flow through while the
 * notation body remains the committed fixture.
 */
export function createFixtureScoreDocument(
  overrides?: FixtureDocumentOverrides,
): ScoreDocumentPort {
  return new XmlScoreDocument({
    concertXml,
    hornXml,
    bFlatXml,
    revisionId: overrides?.revisionId ?? FIXTURE_REVISION,
    issues: overrides?.issues ?? FIXTURE_ISSUES,
    // Explicit overrides win — including an intentional null ("no
    // canonical payload"). Only an absent key takes the fixture default.
    canonicalDocument:
      overrides !== undefined && "canonicalDocument" in overrides
        ? overrides.canonicalDocument
        : fixtureCanonical(),
  });
}
