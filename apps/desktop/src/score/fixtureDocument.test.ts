// @vitest-environment jsdom
/**
 * Fixture ScoreDocumentPort tests (UI-030). The bundled fixture is the
 * deterministic stand-in for engine output — these tests pin the contract
 * the Concert↔F管↔B♭管 context-preservation path depends on: identical
 * `hs-sn-*` export ids in every presentation.
 */
import { describe, expect, it } from "vitest";
import { createFixtureScoreDocument } from "./fixtureDocument";
import { parseScoreDoc } from "./scoreDoc";
import { markedCanonicalIds, openIssues } from "./review";

describe("fixture score document", () => {
  const doc = createFixtureScoreDocument();

  it("reports deterministic meta", () => {
    expect(doc.revisionId).toMatch(/^rev-/);
    expect(doc.meta.title).toBeTruthy();
    expect(doc.meta.tempoBpm).toBe(100);
    expect(doc.meta.meter).toBe("4/4");
    expect(doc.meta.measureCount).toBe(12);
    expect(doc.meta.noteCount).toBe(40);
  });

  it("serves MusicXML for all three presentations", () => {
    expect(doc.musicXml("concert")).toContain("score-partwise");
    expect(doc.musicXml("hornF")).toContain("score-partwise");
    expect(doc.musicXml("bFlat")).toContain("score-partwise");
    expect(doc.supportsPitchView?.("bFlat")).toBe(true);
  });

  it("uses identical hs-sn-* export ids in all presentations", () => {
    const concert = parseScoreDoc(doc.musicXml("concert"));
    const horn = parseScoreDoc(doc.musicXml("hornF"));
    const bFlat = parseScoreDoc(doc.musicXml("bFlat"));
    const concertIds = concert.notes.map((n) => n.exportId);
    const hornIds = horn.notes.map((n) => n.exportId);
    expect(hornIds).toEqual(concertIds);
    expect(bFlat.notes.map((n) => n.exportId)).toEqual(concertIds);
    // Canonical id sets are identical — selection survives a view switch.
    const canon = (ids: typeof concert.notes) =>
      new Set(ids.map((n) => n.canonicalId).filter(Boolean));
    expect(canon(horn.notes)).toEqual(canon(concert.notes));
    expect(canon(bFlat.notes)).toEqual(canon(concert.notes));
  });

  it("spells written pitch a fifth above concert for the same note", () => {
    const concert = parseScoreDoc(doc.musicXml("concert"));
    const horn = parseScoreDoc(doc.musicXml("hornF"));
    const first = concert.notes[0];
    const written = horn.notes.find((n) => n.exportId === first.exportId);
    expect(written).toBeDefined();
    // Concert C → written G for Horn in F.
    if (first.step === "C") expect(written!.step).toBe("G");
  });

  it("spells written pitch a major second above concert for B♭", () => {
    const concert = parseScoreDoc(doc.musicXml("concert"));
    const bFlat = parseScoreDoc(doc.musicXml("bFlat"));
    const first = concert.notes[0];
    const written = bFlat.notes.find((n) => n.exportId === first.exportId);
    expect(written).toBeDefined();
    // Concert C → written D for Horn in B♭ (+M2 projection, #156).
    if (first.step === "C") expect(written!.step).toBe("D");
    // The part declares its transposition so readers recover sounding
    // pitch — B♭ is written -M2 from sounding.
    expect(doc.musicXml("bFlat")).toContain("<chromatic>-2</chromatic>");
    expect(doc.musicXml("bFlat")).toContain("<fifths>2</fifths>");
  });

  it("carries fixed open review issues on real canonical ids", () => {
    const issues = openIssues(doc.reviewIssues());
    expect(issues.length).toBeGreaterThan(0);
    const concert = parseScoreDoc(doc.musicXml("concert"));
    const known = new Set(
      concert.notes.map((n) => n.canonicalId).filter(Boolean),
    );
    for (const id of markedCanonicalIds(doc.reviewIssues())) {
      expect(known.has(id)).toBe(true);
    }
  });
});
