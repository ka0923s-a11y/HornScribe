/**
 * @vitest-environment node
 *
 * #116: drift guard between the canonical copy deck
 * (protocol/copy/ja-JP.json) and the runtime copy module
 * (strings/ja.ts).
 *
 * The deck is canonical for the *IPC-facing enum groups* — engine
 * stage ids, review reason codes, export error ids, and capture issue
 * ids land in sidecar payloads and must keep a copy entry on both
 * sides. Wording canon is ja.ts: the deck mirrors it for these
 * groups. Everything else lives in ja.ts only (the deck retains
 * spec-era vocabulary that is allowed to run ahead of the
 * implementation — see docs/UI_COPY_CONTRACT.md §4.1).
 */

import { describe, expect, it } from "vitest";
import deck from "../../../../protocol/copy/ja-JP.json";
import { ja } from "../strings/ja";
import { REVIEW_REASON_COPY_KEYS } from "../sidecar/review";

/** Flatten nested {group: {leaf: "…"}} objects to "a.b" → value pairs. */
function leafMap(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (node === null || typeof node !== "object") return out;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const p = prefix ? prefix + "." + k : k;
    if (v !== null && typeof v === "object") {
      for (const [p2, v2] of leafMap(v, p)) out.set(p2, v2);
    } else if (typeof v === "string") {
      out.set(p, v);
    }
  }
  return out;
}

function sorted<T>(xs: Iterable<T>): T[] {
  return [...xs].sort();
}

describe("copy deck drift guard (#116)", () => {
  it("transcription.stages mirrors the deck verbatim (stage ids are IPC)", () => {
    const deckStages = leafMap(deck.transcription.stages);
    const jaStages = leafMap(ja.transcription.stages);
    expect(sorted(jaStages.keys())).toEqual(sorted(deckStages.keys()));
    for (const [k, v] of deckStages) {
      expect(jaStages.get(k), "transcription.stages." + k).toBe(v);
    }
  });

  it("review.reasons keeps key parity and wording with ja.reviewReasons", () => {
    const deckReasons = leafMap(deck.review.reasons);
    const jaReasons = leafMap(ja.reviewReasons);
    expect(sorted(jaReasons.keys())).toEqual(sorted(deckReasons.keys()));
    for (const [k, v] of deckReasons) {
      expect(jaReasons.get(k), "reviewReasons." + k).toBe(v);
    }
  });

  it("every reason copy key resolves on both sides", () => {
    for (const code of REVIEW_REASON_COPY_KEYS) {
      expect(
        (ja.reviewReasons as Record<string, unknown>)[code],
        "ja.reviewReasons." + code,
      ).toBeDefined();
      expect(
        (deck.review.reasons as Record<string, unknown>)[code],
        "deck review.reasons." + code,
      ).toBeDefined();
    }
  });

  it("capture.issue keeps key parity (function leaves = {placeholder})", () => {
    const deckIssue = leafMap(deck.capture.issue);
    const jaIssue = ja.capture.issue as unknown as Record<string, unknown>;
    expect(sorted(Object.keys(jaIssue))).toEqual(sorted(deckIssue.keys()));
    for (const [k, v] of deckIssue) {
      const jv = jaIssue[k];
      if (typeof jv === "function") continue; // {detail} interpolation
      expect(jv, "capture.issue." + k).toBe(v);
    }
  });

  it("every implemented error id exists in the deck with matching copy", () => {
    const deckErrors = deck.errors as Record<string, unknown>;
    const missing: string[] = [];
    const mismatched: string[] = [];
    for (const [id, entry] of Object.entries(
      ja.errors as unknown as Record<string, unknown>,
    )) {
      if (entry === null || typeof entry !== "object") continue;
      /* Shared fragments like exportShared ({kept, keptPartial, …}) are
       * not error cards — the deck's errors group only carries
       * {title, body, actions} surfaces, so skip non-card entries. */
      const card = entry as Record<string, unknown>;
      if (!("title" in card) && !("body" in card)) continue;
      const d = deckErrors[id] as Record<string, unknown> | undefined;
      if (d === undefined) {
        missing.push(id);
        continue;
      }
      const dActions = (d.actions ?? {}) as Record<string, unknown>;
      /* Flatten ja's own 'actions' sub-object so both spellings —
       * legacy flat leaves and the deck's {actions:{…}} shape —
       * compare against the same deck leaves. */
      const jaFlat = new Map<string, unknown>();
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        if (k === "actions" && v !== null && typeof v === "object") {
          for (const [ak, av] of Object.entries(
            v as Record<string, unknown>,
          )) {
            jaFlat.set(ak, av);
          }
        } else {
          jaFlat.set(k, v);
        }
      }
      for (const [k, v] of jaFlat) {
        const dv =
          k === "title" || k === "body" ? d[k] : (dActions[k] ?? d[k]);
        if (typeof v === "function") {
          if (dv === undefined)
            mismatched.push(id + "." + k + " (deck leaf missing)");
        } else if (dv !== v) {
          mismatched.push(
            id + "." + k + ": deck=" + JSON.stringify(dv) +
              " ja=" + JSON.stringify(v),
          );
        }
      }
    }
    expect(missing).toEqual([]);
    expect(mismatched).toEqual([]);
  });
});
