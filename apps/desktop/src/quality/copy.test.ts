/**
 * @vitest-environment node
 *
 * UI-070 §12 copy-QA gate: scans the Japanese copy deck (strings/ja.ts —
 * the single source of UI copy) for leaked English placeholder strings.
 * Any ASCII word that is not a known product/format/unit/key token is
 * reported; the canonical UI language is Japanese (docs/UX_VALIDATION.md).
 */

import { describe, expect, it } from "vitest";
import { ja } from "../strings/ja";

/** ASCII tokens allowed inside Japanese copy. */
const ALLOWED_WORDS = new Set(
  [
    "HornScribe",
    "MusicXML",
    "PDF",
    "MIDI",
    "BPM",
    "FFmpeg",
    "MuseScore",
    "Verovio",
    "WebView2",
    "WAV",
    "FLAC",
    "MP3",
    "AAC",
    "OGG",
    "M4A",
    "AIFF",
    "Ctrl",
    "Shift",
    "Alt",
    "Space",
    "Esc",
    "Enter",
    "Tab",
    "Home",
    "End",
    "Delete",
    "Backspace",
    "J",
    "K",
    "L",
    "O",
    "R",
    "OK",
    "Windows",
    "Python",
    "wavesurfer",
    /* #175/#181/#195: engine proper nouns and the documented install
     *  command — pip install hornscribe[engine] is the recovery path. */
    "pYIN",
    "Basic",
    "Pitch",
    "pip",
    "install",
    "engine",
    "hornscribe",
    /* #302: the optional heavier separation engine named in the vocal-
     *  isolation hint — pip install hornscribe[engine-vocal]. */
    "demucs",
    "vocal",
  ].map((w) => w.toLowerCase()),
);
const ALLOWED_WORDS_CI = new Set(
  [
    "wav",
    "flac",
    "mp3",
    "aac",
    "ogg",
    "m4a",
    "aiff",
    "ms",
    "khz",
    "hz",
    "db",
    "mb",
    "gb",
    "kb",
    "px",
    "pdf",
    "midi",
    "bpm",
    "f6",
    "png",
    "json",
    "musicxml",
    "xml",
  ],
);

const CJK_RE = /[ぁ-んァ-ヶ一-龯々〆〤ー・]/;

/** Collects every string leaf (calling string-producing formatters). */
function collectStrings(
  node: unknown,
  path: string,
  out: { path: string; value: string }[],
): void {
  if (typeof node === "string") {
    out.push({ path, value: node });
  } else if (typeof node === "function") {
    // Copy formatters like position(i, n) — call with small numbers.
    try {
      const v = (node as (...a: unknown[]) => unknown)(1, 2, 3);
      if (typeof v === "string") out.push({ path, value: v });
    } catch {
      /* formatter with a different signature — skip */
    }
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      collectStrings(v, path ? `${path}.${k}` : k, out);
    }
  }
}

function findEnglishWords(text: string): string[] {
  // {count}-style interpolations and file paths are not UI prose.
  const prose = text
    .replace(/\{[^}]*\}/g, " ")
    .replace(/[A-Za-z]:\\[^\s・。、]*/g, " ");
  const hits: string[] = [];
  for (const m of prose.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
    const w = m[0];
    if (
      !ALLOWED_WORDS.has(w.toLowerCase()) &&
      !ALLOWED_WORDS_CI.has(w.toLowerCase()) &&
      !/^[A-Z]$/.test(w) && // single letters = key names / F管
      !/^[A-Z]\d+$/.test(w) && // page/milestone ids (P1, F6, UI…)
      !/^[A-Z]{2,}$/.test(w) && // all-caps acronyms (PC, ID, UI)
      !/^v?\d/.test(w) // version strings like v0.1.0
    ) {
      hits.push(w);
    }
  }
  return hits;
}

describe("copy QA (§12)", () => {
  const strings: { path: string; value: string }[] = [];
  collectStrings(ja, "ja", strings);

  it("the deck is non-trivial (sanity)", () => {
    expect(strings.length).toBeGreaterThan(200);
  });

  it("no leaked English placeholder words", () => {
    const offenders = strings
      .map(({ path, value }) => ({ path, value, words: findEnglishWords(value) }))
      .filter((o) => o.words.length > 0)
      .map(
        (o) =>
          `${o.path}: "${o.value.slice(0, 80)}" → ${o.words.join(", ")}`,
      );
    expect(offenders).toEqual([]);
  });

  it("every copy leaf contains Japanese or is pure symbolic", () => {
    const offenders = strings
      .filter(({ value }) => {
        if (CJK_RE.test(value)) return false;
        const prose = value
          .replace(/\{[^}]*\}/g, " ")
          .replace(/[A-Za-z]:\\[^\s・。、]*/g, " ");
        // Symbolic values (numbers, shortcuts, units) are fine.
        const words = prose
          .split(/[\s・,。、()（）「」『』:：;；/\-–—…+\\]+/)
          .filter(Boolean);
        return words.some(
          (w) =>
            /^[A-Za-z][A-Za-z0-9.]*$/.test(w) &&
            !ALLOWED_WORDS.has(w.toLowerCase()) &&
            !ALLOWED_WORDS_CI.has(w.toLowerCase()) &&
            !/^[A-Z]$/.test(w) &&
            !/^[A-Z]{2,}$/.test(w),
        );
      })
      .map((o) => `${o.path}: "${o.value.slice(0, 80)}"`);
    expect(offenders).toEqual([]);
  });

  it("no TODO/FIXME/lorem markers in shipped copy", () => {
    const offenders = strings.filter(({ value }) =>
      /todo|fixme|lorem|placeholder/i.test(value),
    );
    expect(offenders).toEqual([]);
  });
});
