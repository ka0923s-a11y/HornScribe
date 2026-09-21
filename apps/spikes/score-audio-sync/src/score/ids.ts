/**
 * TypeScript mirror of the FND-001 identity rules
 * (`python/hornscribe/domain/ids.py`, `docs/CONTRACTS.md` §1).
 *
 *   canonical note        sn-<6 digits>
 *   MusicXML note/@id     hs-sn-<6 digits>
 *   MusicXML tied fragment hs-sn-<6 digits>-<k>   (k > 1)
 *   MusicXML rest          hs-rest-<6 digits>     (presentation-only)
 *
 * Every `hs-sn-*` export id — fragment or not — resolves back to exactly one
 * `sn-*` canonical note id. `hs-rest-*` deliberately has no canonical target.
 */

const SCORE_NOTE_RE = /^sn-\d{6}$/;
const MUSICXML_NOTE_RE = /^hs-sn-\d{6}(?:-\d+)?$/;
const MUSICXML_REST_RE = /^hs-rest-\d{6}$/;
const CANONICAL_PART_RE = /^hs-(sn-\d{6})/;

export function isScoreNoteId(value: string): boolean {
  return SCORE_NOTE_RE.test(value);
}

export function isMusicxmlNoteId(value: string): boolean {
  return MUSICXML_NOTE_RE.test(value);
}

export function isMusicxmlRestId(value: string): boolean {
  return MUSICXML_REST_RE.test(value);
}

/** `sn-000042` -> `hs-sn-000042` (fragment 1), `hs-sn-000042-2` (fragment 2), … */
export function musicxmlNoteId(canonicalId: string, fragment = 1): string {
  if (!isScoreNoteId(canonicalId)) {
    throw new Error(`not a canonical score note id: ${canonicalId}`);
  }
  if (fragment < 1) {
    throw new Error(`fragment must be >= 1, got ${fragment}`);
  }
  return fragment === 1 ? `hs-${canonicalId}` : `hs-${canonicalId}-${fragment}`;
}

/**
 * `hs-sn-000042` -> `sn-000042`; `hs-sn-000042-3` -> `sn-000042`.
 * Returns null for anything that is not a canonical-backed export id
 * (e.g. `hs-rest-*`, or a Verovio-generated id like `d1e123`).
 */
export function canonicalNoteIdFromMusicxml(exportId: string): string | null {
  if (!isMusicxmlNoteId(exportId)) return null;
  const match = CANONICAL_PART_RE.exec(exportId);
  return match ? match[1] : null;
}
