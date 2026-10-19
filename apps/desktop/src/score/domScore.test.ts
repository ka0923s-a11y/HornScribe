// @vitest-environment jsdom
/**
 * domScore tests (UI-030). jsdom has no getBBox, so geometry-dependent
 * helpers (hit ellipses, measure wash, caret, review marks) no-op here —
 * the tests cover the identity + class-toggle contract that drives
 * selection/highlight without SVG re-renders.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVE_CLASS,
  SELECTED_CLASS,
  buildElementIndex,
  markCanonical,
  markCanonicalSet,
  markMeasures,
  markReviewMarkers,
  measureElementOf,
  resolveHitElement,
  MEASURE_ACTIVE_CLASS,
  REVIEW_MARK_CLASS,
} from "./domScore";
import type { ReviewSeverity } from "./review";

/** #377: markReviewMarkers takes id → severity; tests default to warning
 *  (the loudest badge) unless exercising a specific severity. */
function warn(...ids: string[]): Map<string, ReviewSeverity> {
  return new Map(ids.map((id) => [id, "warning" as const]));
}

function scoreDom(): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `
    <svg><g class="system">
      <g class="measure" id="m1">
        <g class="note" id="hs-sn-000001"><g class="notehead"><use/></g></g>
        <g class="note" id="hs-sn-000002"><g class="notehead"><use/></g></g>
        <g class="rest" id="hs-rest-000001"><use/></g>
      </g>
      <g class="measure" id="m2">
        <g class="note" id="hs-sn-000002-2"><g class="notehead"><use/></g></g>
        <g class="note" id="d1e999"><g class="notehead"><use/></g></g>
      </g>
    </g></svg>`;
  return root;
}

describe("buildElementIndex", () => {
  it("indexes hs-* note/rest ids and groups fragments canonically", () => {
    const idx = buildElementIndex(scoreDom());
    expect(idx.byExportId.has("hs-sn-000001")).toBe(true);
    expect(idx.byExportId.has("hs-rest-000001")).toBe(true);
    // Random Verovio ids are not indexed as canonical targets (UI-003).
    expect(idx.byExportId.has("d1e999")).toBe(false);
    expect(idx.byCanonical.get("sn-000002")?.length).toBe(2);
    expect(idx.noteCount).toBe(3);
  });
});

describe("resolveHitElement", () => {
  it("walks up to the id-bearing group", () => {
    const root = scoreDom();
    const use = root.querySelector("#hs-sn-000001 use")!;
    const hit = resolveHitElement(use, root);
    expect(hit?.id).toBe("hs-sn-000001");
  });

  it("returns null for background hits and outside targets", () => {
    const root = scoreDom();
    expect(resolveHitElement(root.querySelector("svg"), root)).toBeNull();
    expect(resolveHitElement(document.body, root)).toBeNull();
    expect(resolveHitElement(null, root)).toBeNull();
  });
});

describe("class marks", () => {
  it("selection marks every fragment of the canonical note", () => {
    const root = scoreDom();
    const idx = buildElementIndex(root);
    markCanonical(idx, "sn-000002", SELECTED_CLASS);
    const f1 = idx.byExportId.get("hs-sn-000002")!;
    const f2 = idx.byExportId.get("hs-sn-000002-2")!;
    expect(f1.classList.contains(SELECTED_CLASS)).toBe(true);
    expect(f2.classList.contains(SELECTED_CLASS)).toBe(true);
    // Move the selection — previous marks are cleared first.
    markCanonical(idx, "sn-000001", SELECTED_CLASS);
    expect(f1.classList.contains(SELECTED_CLASS)).toBe(false);
    expect(f2.classList.contains(SELECTED_CLASS)).toBe(false);
    expect(
      idx.byExportId.get("hs-sn-000001")!.classList.contains(SELECTED_CLASS),
    ).toBe(true);
  });

  it("markCanonicalSet toggles the active set without touching selection", () => {
    const root = scoreDom();
    const idx = buildElementIndex(root);
    markCanonical(idx, "sn-000001", SELECTED_CLASS);
    markCanonicalSet(idx, new Set(["sn-000002"]), ACTIVE_CLASS);
    expect(
      idx.byExportId.get("hs-sn-000001")!.classList.contains(SELECTED_CLASS),
    ).toBe(true);
    expect(
      idx.byExportId.get("hs-sn-000002")!.classList.contains(ACTIVE_CLASS),
    ).toBe(true);
    markCanonicalSet(idx, new Set(), ACTIVE_CLASS);
    expect(
      idx.byExportId.get("hs-sn-000002")!.classList.contains(ACTIVE_CLASS),
    ).toBe(false);
    // Selection survives active-mark churn.
    expect(
      idx.byExportId.get("hs-sn-000001")!.classList.contains(SELECTED_CLASS),
    ).toBe(true);
  });
});

describe("measure marking", () => {
  it("resolves the containing measure group", () => {
    const root = scoreDom();
    const note = root.querySelector("#hs-sn-000001")!;
    expect(measureElementOf(note)?.id).toBe("m1");
  });

  it("marks measures containing the given elements", () => {
    const root = scoreDom();
    const idx = buildElementIndex(root);
    const els = idx.byCanonical.get("sn-000002") ?? [];
    const n = markMeasures(root, els, MEASURE_ACTIVE_CLASS, true);
    expect(n).toBe(2);
    expect(root.querySelector("#m1")!.classList.contains(MEASURE_ACTIVE_CLASS)).toBe(true);
    expect(root.querySelector("#m2")!.classList.contains(MEASURE_ACTIVE_CLASS)).toBe(true);
    markMeasures(root, els, MEASURE_ACTIVE_CLASS, false);
    expect(root.querySelector("#m1")!.classList.contains(MEASURE_ACTIVE_CLASS)).toBe(false);
  });
});

describe("markReviewMarkers", () => {
  it("no-ops cleanly when geometry is unavailable (jsdom)", () => {
    const root = scoreDom();
    const idx = buildElementIndex(root);
    expect(markReviewMarkers(root, idx, warn("sn-000001"))).toBe(0);
    // No markers left behind.
    expect(root.querySelectorAll(".hs-review-mark").length).toBe(0);
  });
});

describe("markReviewMarkers system-band grouping (#237)", () => {
  function withBboxes(root: HTMLElement): void {
    let x = 0;
    root.querySelectorAll("g.note").forEach((el) => {
      x += 100;
      Object.defineProperty(el, "getBBox", {
        value: () => ({ x, y: 50, width: 20, height: 30 }),
      });
    });
  }

  it("draws one badge per part-band per system, not per measure", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<svg><g class="system">',
      '<g class="measure" id="m1"><g class="staff" id="s1">',
      '<g class="note" id="hs-sn-000001"><g class="notehead"><use/></g></g>',
      '<g class="note" id="hs-sn-000002"><g class="notehead"><use/></g></g>',
      '<g class="note" id="hs-sn-000003"><g class="notehead"><use/></g></g>',
      "</g></g>",
      '<g class="measure" id="m2"><g class="staff" id="s2">',
      '<g class="note" id="hs-sn-000004"><g class="notehead"><use/></g></g>',
      "</g></g>",
      "</g></svg>",
    ].join("");
    withBboxes(root);
    const idx = buildElementIndex(root);
    const n = markReviewMarkers(
      root,
      idx,
      warn("sn-000001", "sn-000002", "sn-000003", "sn-000004"),
    );
    expect(n).toBe(4);
    // Both staves share the system and (no staff bbox -> band 0): the
    // whole system row carries ONE badge with the count.
    expect(
      root.querySelectorAll("." + REVIEW_MARK_CLASS + "__badge").length,
    ).toBe(1);
    expect(
      root.querySelectorAll("." + REVIEW_MARK_CLASS + "__line").length,
    ).toBe(4);
    const glyphs = Array.from(
      root.querySelectorAll("." + REVIEW_MARK_CLASS + "__glyph"),
    ).map((g) => g.textContent);
    expect(glyphs).toEqual(["4"]);
  });

  it("keeps separate badges for different part bands on one system", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<svg><g class="system">',
      '<g class="measure" id="m1"><g class="staff" id="s1">',
      '<g class="note" id="hs-sn-000001"><g class="notehead"><use/></g></g>',
      '</g><g class="staff" id="s2">',
      '<g class="note" id="hs-sn-000002"><g class="notehead"><use/></g></g>',
      "</g></g>",
      '<g class="measure" id="m2"><g class="staff" id="s3">',
      '<g class="note" id="hs-sn-000003"><g class="notehead"><use/></g></g>',
      '</g><g class="staff" id="s4">',
      '<g class="note" id="hs-sn-000004"><g class="notehead"><use/></g></g>',
      "</g></g>",
      "</g></svg>",
    ].join("");
    withBboxes(root);
    // s1/s3 = top staff (y 0), s2/s4 = lower part (y 200).
    for (const [id, y] of [
      ["s1", 0],
      ["s3", 0],
      ["s2", 200],
      ["s4", 200],
    ] as const) {
      Object.defineProperty(root.querySelector("#" + id), "getBBox", {
        value: () => ({ x: 0, y, width: 500, height: 100 }),
      });
    }
    const idx = buildElementIndex(root);
    const n = markReviewMarkers(
      root,
      idx,
      warn("sn-000001", "sn-000002", "sn-000003", "sn-000004"),
    );
    expect(n).toBe(4);
    expect(
      root.querySelectorAll("." + REVIEW_MARK_CLASS + "__badge").length,
    ).toBe(2);
    const glyphs = Array.from(
      root.querySelectorAll("." + REVIEW_MARK_CLASS + "__glyph"),
    ).map((g) => g.textContent);
    expect([...glyphs].sort()).toEqual(["2", "2"]);
  });

  it("keeps separate badges across different systems", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<svg>",
      '<g class="system"><g class="measure"><g class="staff">',
      '<g class="note" id="hs-sn-000001"><g class="notehead"><use/></g></g>',
      "</g></g></g>",
      '<g class="system"><g class="measure"><g class="staff">',
      '<g class="note" id="hs-sn-000002"><g class="notehead"><use/></g></g>',
      "</g></g></g>",
      "</svg>",
    ].join("");
    withBboxes(root);
    const idx = buildElementIndex(root);
    const n = markReviewMarkers(
      root,
      idx,
      warn("sn-000001", "sn-000002"),
    );
    expect(n).toBe(2);
    expect(
      root.querySelectorAll("." + REVIEW_MARK_CLASS + "__badge").length,
    ).toBe(2);
  });

  it("caps the badge radius and keeps the disc above the note box (#337)", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      "<svg>",
      '<g class="system"><g class="measure"><g class="staff">',
      '<g class="note" id="hs-sn-000001"><g class="notehead"><use/></g></g>',
      '<g class="note" id="hs-sn-000002"><g class="notehead"><use/></g></g>',
      "</g></g></g>",
      "</svg>",
    ].join("");
    // Tall boxes (chord/ledger spans) used to inflate the badge
    // without bound — the disc then swallowed staff regions.
    Object.defineProperty(root.querySelector("#hs-sn-000001"), "getBBox", {
      value: () => ({ x: 0, y: 50, width: 20, height: 200 }),
    });
    Object.defineProperty(root.querySelector("#hs-sn-000002"), "getBBox", {
      value: () => ({ x: 40, y: 50, width: 20, height: 30 }),
    });
    const idx = buildElementIndex(root);
    markReviewMarkers(root, idx, warn("sn-000001", "sn-000002"));
    const badge = root.querySelector(
      "." + REVIEW_MARK_CLASS + "__badge",
    ) as SVGCircleElement;
    const radius = parseFloat(badge.getAttribute("r")!);
    const cy = parseFloat(badge.getAttribute("cy")!);
    expect(radius).toBeLessThanOrEqual(12);
    // The disc's bottom edge clears the flagged note's top edge.
    expect(cy + radius).toBeLessThanOrEqual(50);
  });

  it("clears stale marks before regrouping", () => {
    const root = scoreDom();
    withBboxes(root);
    const idx = buildElementIndex(root);
    markReviewMarkers(root, idx, warn("sn-000001", "sn-000002"));
    markReviewMarkers(root, idx, warn("sn-000001"));
    expect(
      root.querySelectorAll("." + REVIEW_MARK_CLASS + "__line").length,
    ).toBe(1);
  });
});

describe("markReviewMarkers severity shapes (#377)", () => {
  function flaggedRoot(): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = [
      '<svg><g class="system"><g class="measure"><g class="staff">',
      '<g class="note" id="hs-sn-000001"><g class="notehead"><use/></g></g>',
      '<g class="note" id="hs-sn-000002"><g class="notehead"><use/></g></g>',
      "</g></g></g></svg>",
    ].join("");
    let x = 0;
    root.querySelectorAll("g.note").forEach((el) => {
      x += 100;
      Object.defineProperty(el, "getBBox", {
        value: () => ({ x, y: 50, width: 20, height: 30 }),
      });
    });
    return root;
  }

  it("warning keeps the filled disc + '!' glyph", () => {
    const root = flaggedRoot();
    markReviewMarkers(root, buildElementIndex(root), warn("sn-000001"));
    const mark = root.querySelector("g." + REVIEW_MARK_CLASS)!;
    expect(mark.classList.contains(REVIEW_MARK_CLASS + "--warning")).toBe(
      true,
    );
    const badge = mark.querySelector("." + REVIEW_MARK_CLASS + "__badge")!;
    expect(badge.tagName.toLowerCase()).toBe("circle");
    expect(
      mark.querySelector("." + REVIEW_MARK_CLASS + "__glyph")!.textContent,
    ).toBe("!");
  });

  it("caution draws a filled diamond instead of the disc", () => {
    const root = flaggedRoot();
    markReviewMarkers(
      root,
      buildElementIndex(root),
      new Map([["sn-000001", "caution" as const]]),
    );
    const mark = root.querySelector("g." + REVIEW_MARK_CLASS)!;
    expect(mark.classList.contains(REVIEW_MARK_CLASS + "--caution")).toBe(
      true,
    );
    const badge = mark.querySelector("." + REVIEW_MARK_CLASS + "__badge")!;
    expect(badge.tagName.toLowerCase()).toBe("polygon");
    expect(
      mark.querySelector("." + REVIEW_MARK_CLASS + "__glyph")!.textContent,
    ).toBe("!");
  });

  it("info drops to the ring badge and the quieter 'i' glyph", () => {
    const root = flaggedRoot();
    markReviewMarkers(
      root,
      buildElementIndex(root),
      new Map([["sn-000001", "info" as const]]),
    );
    const mark = root.querySelector("g." + REVIEW_MARK_CLASS)!;
    expect(mark.classList.contains(REVIEW_MARK_CLASS + "--info")).toBe(true);
    const badge = mark.querySelector("." + REVIEW_MARK_CLASS + "__badge")!;
    // Ring = circle element; the hollow stroke is the CSS modifier's job.
    expect(badge.tagName.toLowerCase()).toBe("circle");
    expect(
      mark.querySelector("." + REVIEW_MARK_CLASS + "__glyph")!.textContent,
    ).toBe("i");
  });

  it("a mixed-severity band carries the worst member severity", () => {
    const root = flaggedRoot();
    markReviewMarkers(
      root,
      buildElementIndex(root),
      new Map<string, ReviewSeverity>([
        ["sn-000001", "info"],
        ["sn-000002", "warning"],
      ]),
    );
    const marks = root.querySelectorAll("g." + REVIEW_MARK_CLASS);
    // One badge, warning severity, count glyph — the info flag's band
    // must not look quieter than the loudest thing inside it.
    expect(
      root.querySelectorAll("." + REVIEW_MARK_CLASS + "__badge").length,
    ).toBe(1);
    marks.forEach((m) =>
      expect(m.classList.contains(REVIEW_MARK_CLASS + "--warning")).toBe(
        true,
      ),
    );
    expect(
      root.querySelector("." + REVIEW_MARK_CLASS + "__glyph")!.textContent,
    ).toBe("2");
  });
});
