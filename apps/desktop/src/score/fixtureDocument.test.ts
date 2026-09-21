// @vitest-environment jsdom
/**
 * Fixture ScoreDocumentPort tests (UI-030). The bundled fixture is the
 * deterministic stand-in for engine output — these tests pin the contract
 * the Concert↔F管 context-preservation path depends on: identical `hs-sn-*`
 * export ids in both presentations.
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

  it("serves MusicXML for both presentations", () => {
    expect(doc.musicXml("concert")).toContain("score-partwise");
    expect(doc.musicXml("hornF")).toContain("score-partwise");
  });

  it("uses identical hs-sn-* export ids in both presentations", () => {
    const concert = parseScoreDoc(doc.musicXml("concert"));
    const horn = parseScoreDoc(doc.musicXml("hornF"));
    const concertIds = concert.notes.map((n) => n.exportId);
    const hornIds = horn.notes.map((n) => n.exportId);
    expect(hornIds).toEqual(concertIds);
    // Canonical id sets are identical — selection survives a view switch.
    const canon = (ids: typeof concert.notes) =>
      new Set(ids.map((n) => n.canonicalId).filter(Boolean));
    expect(canon(horn.notes)).toEqual(canon(concert.notes));
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
