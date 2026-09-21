/**
 * ENG-001 fixtures are imported with `?raw` — bundled at build time, so the
 * spike runs fully offline and exercises the exact committed bytes.
 * `multisystem` is a spike-local deterministic fixture (see
 * `scripts/gen-multisystem.mjs`) that adds multi-system + multi-page layout.
 */
import goldenConcert from '../../../../fixtures/musicxml/golden_v1_concert.musicxml?raw';
import goldenHorn from '../../../../fixtures/musicxml/golden_v1_horn_in_f.musicxml?raw';
import minimalConcert from '../../../../fixtures/musicxml/minimal_v1_concert.musicxml?raw';
import minimalHorn from '../../../../fixtures/musicxml/minimal_v1_horn_in_f.musicxml?raw';
import multisystemConcert from '../fixtures/multisystem_concert.musicxml?raw';

export type FixtureSetId = 'golden' | 'minimal' | 'multisystem';
export type PitchView = 'concert' | 'horn';

export interface FixtureSet {
  id: FixtureSetId;
  concert: string;
  /** undefined for spike-local sets with no Horn presentation yet. */
  horn?: string;
}

export const FIXTURE_SETS: Record<FixtureSetId, FixtureSet> = {
  golden: { id: 'golden', concert: goldenConcert, horn: goldenHorn },
  minimal: { id: 'minimal', concert: minimalConcert, horn: minimalHorn },
  multisystem: { id: 'multisystem', concert: multisystemConcert },
};

export function fixtureXml(set: FixtureSetId, view: PitchView): string {
  const f = FIXTURE_SETS[set];
  return view === 'horn' && f.horn ? f.horn : f.concert;
}

export function supportsHorn(set: FixtureSetId): boolean {
  return FIXTURE_SETS[set].horn !== undefined;
}
