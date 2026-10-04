// @vitest-environment jsdom
/** #210: staff visibility — dropping <part>/<score-part> elements keeps
 *  the remaining score valid and leaves kept parts' ids untouched. */
import { describe, expect, it } from "vitest";
import { filterScorePartsXml } from "./partFilter";

const XML = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Horn in F</part-name></score-part>
    <score-part id="P2"><part-name>伴奏 1</part-name></score-part>
    <score-part id="P3"><part-name>伴奏 2</part-name></score-part>
  </part-list>
  <part id="P1"><measure number="1"><note id="hs-sn-000001-1"/></measure></part>
  <part id="P2"><measure number="1"><note id="hs-sn-000010-1"/></measure></part>
  <part id="P3"><measure number="1"><note id="hs-sn-000020-1"/></measure></part>
</score-partwise>`;

describe("filterScorePartsXml (#210)", () => {
  it("drops hidden staves from both part-list and body", () => {
    const out = filterScorePartsXml(XML, [true, false, true]);
    const doc = new DOMParser().parseFromString(out, "application/xml");
    const names = [...doc.querySelectorAll("score-part part-name")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Horn in F", "伴奏 2"]);
    const parts = [...doc.documentElement.children].filter(
      (el) => el.tagName === "part",
    );
    expect(parts).toHaveLength(2);
    // Kept notes carry their original hs-* ids verbatim.
    expect(out).toContain("hs-sn-000001-1");
    expect(out).toContain("hs-sn-000020-1");
    expect(out).not.toContain("hs-sn-000010-1");
  });

  it("keeps only the lead staff for a horn-only printout", () => {
    const out = filterScorePartsXml(XML, [true, false, false]);
    const doc = new DOMParser().parseFromString(out, "application/xml");
    expect(doc.querySelectorAll("score-part")).toHaveLength(1);
    expect(out).toContain("hs-sn-000001-1");
  });

  it("is a no-op for all-visible, empty masks and invalid XML", () => {
    expect(filterScorePartsXml(XML, [true, true, true])).toBe(XML);
    expect(filterScorePartsXml(XML, [])).toBe(XML);
    expect(filterScorePartsXml("not xml", [true, false])).toBe("not xml");
  });

  it("never returns an empty score — all-hidden falls back", () => {
    expect(filterScorePartsXml(XML, [false, false, false])).toBe(XML);
  });

  it("bails on index misalignment rather than hiding wrongly", () => {
    expect(filterScorePartsXml(XML, [true, false])).toBe(XML);
  });
});
