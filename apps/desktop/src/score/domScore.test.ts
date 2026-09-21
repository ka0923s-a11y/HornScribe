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
} from "./domScore";

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
    expect(markReviewMarkers(root, idx, new Set(["sn-000001"]))).toBe(0);
    // No markers left behind.
    expect(root.querySelectorAll(".hs-review-mark").length).toBe(0);
  });
});
