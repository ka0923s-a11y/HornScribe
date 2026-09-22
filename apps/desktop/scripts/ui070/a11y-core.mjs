/**
 * UI-070 accessibility audit core — dependency-free, dual-environment.
 *
 * The single exported function `auditAccessibility(root)` is deliberately
 * self-contained (all helpers are inner functions) so it can be:
 *
 * - imported by vitest specs (`src/quality/*.test.tsx`) for jsdom audits;
 * - passed verbatim to `page.evaluate()` in the puppeteer gates
 *   (scripts/ui070/*.mjs) — puppeteer serializes the function source, so a
 *   closure over module-scope helpers would not survive.
 *
 * Checks (docs/UX_VALIDATION.md §6, §8):
 * - every visible interactive element has a non-empty accessible name;
 * - accessible names are Japanese (canonical UI language) unless they are
 *   pure symbols/numbers or consist solely of allow-listed technical
 *   tokens (MusicXML, BPM, HornScribe, …);
 * - role-based widgets are keyboard-focusable (tabindex present) unless
 *   natively focusable;
 * - named regions/widgets (role=region/toolbar/dialog/navigation/main and
 *   data-hs-focus-zone roots) carry a programmatic label;
 * - color-independence: status/review badges and stage-list items must
 *   carry visible text (or a text-bearing child), never color alone.
 *
 * Returns { violations: [...], stats: {...} }; a green gate has
 * violations.length === 0.
 */

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="spinbutton"]',
  "[tabindex]",
].join(", ");

const NAMED_REGION_SELECTOR = [
  '[role="region"]',
  '[role="toolbar"]',
  '[role="navigation"]',
  '[role="main"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menubar"]',
  '[role="list"]',
  "[data-hs-focus-zone]",
].join(", ");

const NATIVE_FOCUSABLE = new Set([
  "BUTTON",
  "A",
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "SUMMARY",
]);

/**
 * Operable roles that must be keyboard-focusable themselves. Container
 * roles (toolbar, tablist, menu, …) are reached through their children.
 */
const OPERABLE_ROLES = new Set([
  "button",
  "link",
  "radio",
  "tab",
  "slider",
  "switch",
  "checkbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "spinbutton",
]);

/** Elements whose meaning must not depend on color alone (§6/§15). */
const COLOR_SIGNAL_SELECTOR = [
  ".hs-status-badge",
  ".hs-review-badge",
  ".hs-stage-list__item",
  "[data-state]",
].join(", ");

/**
 * ASCII words allowed inside accessible names (product/format/tool names,
 * units, and key names used in shortcut hints like 書き出し（Ctrl+E）).
 * Everything else must contain at least one non-ASCII (Japanese) char.
 */
const ALLOWED_ASCII_WORDS = new Set([
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
  "Windows",
  "Python",
]);

/** ASCII word-shaped tokens allowed even in lowercase (units/extensions). */
const ALLOWED_ASCII_WORDS_CI = new Set(["wav", "flac", "mp3", "aac", "ogg", "m4a", "aiff", "ms", "khz", "hz", "db", "mb", "gb", "kb", "px", "pdf", "midi", "bpm", "f6"]);

const CJK_RE =
  /[ぁ-んァ-ヶ一-龯々〆〤㐀-䶿ー・ｱ-ﾝ]/;

export function auditAccessibility(root) {
  const doc = root.ownerDocument ?? root;

  function isHidden(el) {
    if (!(el instanceof doc.defaultView.Element)) return true;
    if (el.closest("[hidden], [aria-hidden='true'], [inert]")) return true;
    const view = el.ownerDocument.defaultView;
    if (view && view.getComputedStyle) {
      const style = view.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        return true;
      }
    }
    return false;
  }

  function textOf(el) {
    // textContent includes aria-hidden children; strip them for the name.
    let text = "";
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          text += child.textContent;
        } else if (child.nodeType === 1) {
          const c = /** @type {Element} */ (child);
          if (c.closest("[aria-hidden='true']")) continue;
          if (c.tagName === "SVG" || c.tagName === "svg") continue;
          walk(c);
        }
      }
    };
    walk(el);
    return text.replace(/\s+/g, " ").trim();
  }

  function accessibleName(el) {
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map((n) => textOf(n))
        .join(" ")
        .trim();
      if (text) return text;
    }
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      const id = el.getAttribute("id");
      if (id) {
        const lab = doc.querySelector(`label[for="${id}"]`);
        if (lab) {
          const t = textOf(lab);
          if (t) return t;
        }
      }
      const wrap = el.closest("label");
      if (wrap) {
        const t = textOf(wrap);
        if (t) return t;
      }
    }
    const t = textOf(el);
    if (t) return t;
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return ph.trim();
    return "";
  }

  function describe(el) {
    const id = el.id ? `#${el.id}` : "";
    const cls = (el.getAttribute("class") || "")
      .split(/\s+/)
      .filter((c) => c.startsWith("hs-") || c.startsWith("fui-"))
      .slice(0, 2)
      .join(".");
    const zone = el.closest("[data-hs-focus-zone]");
    const zoneId = zone ? `[zone=${zone.getAttribute("data-hs-focus-zone")}]` : "";
    const text = textOf(el).slice(0, 40);
    return `<${el.tagName.toLowerCase()}${id}${cls ? "." + cls : ""}>${zoneId}${text ? ` "${text}"` : ""}`;
  }

  function isJapaneseName(name) {
    if (CJK_RE.test(name)) return true;
    const words = name.split(/[\s・,。、()（）「」『』:：;；/\-–—…+\\]+/).filter(Boolean);
    return words.every(
      (w) =>
        !/^[A-Za-z][A-Za-z0-9.]*$/.test(w) ||
        /^[A-Z]$/.test(w) || // key names, F管
        /^[A-Z]{2,}$/.test(w) || // all-caps acronyms (PC, ID, UI)
        ALLOWED_ASCII_WORDS.has(w) ||
        ALLOWED_ASCII_WORDS_CI.has(w.toLowerCase()),
    );
  }

  const violations = [];
  const stats = { interactive: 0, named: 0, regions: 0, liveRegions: 0, colorSignals: 0 };

  const push = (rule, el, detail) =>
    violations.push({ rule, target: describe(el), detail });

  const all = [
    ...(root instanceof doc.defaultView.Element ? [root] : []),
    ...root.querySelectorAll("*"),
  ].filter((el) => !isHidden(el));

  for (const el of all) {
    if (el.matches(INTERACTIVE_SELECTOR)) {
      stats.interactive += 1;
      const disabled =
        el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
      const name = accessibleName(el);
      if (!disabled) {
        if (!name) {
          push("accessible-name", el, "interactive element has no accessible name");
        } else {
          stats.named += 1;
          if (!isJapaneseName(name)) {
            push(
              "japanese-name",
              el,
              `accessible name is not Japanese: "${name.slice(0, 60)}"`,
            );
          }
        }
        // Operable role widgets need an explicit, non-negative tabindex to
        // be keyboard-reachable (native controls are focusable by default,
        // container roles are reached via their children).
        if (
          !NATIVE_FOCUSABLE.has(el.tagName) &&
          OPERABLE_ROLES.has(el.getAttribute("role") ?? "")
        ) {
          const ti = el.getAttribute("tabindex");
          if (ti === null || ti === "-1") {
            push(
              "focusable",
              el,
              "role widget is not keyboard-focusable (missing tabindex)",
            );
          }
        }
      }
    }

    if (el.matches(NAMED_REGION_SELECTOR)) {
      stats.regions += 1;
      const name = accessibleName(el);
      if (!name) {
        push("region-name", el, "landmark/zone has no accessible name");
      } else if (!isJapaneseName(name)) {
        push("japanese-name", el, `region name is not Japanese: "${name.slice(0, 60)}"`);
      }
    }

    if (el.matches(COLOR_SIGNAL_SELECTOR)) {
      stats.colorSignals += 1;
      const t = textOf(el);
      if (t.length === 0) {
        push(
          "color-only",
          el,
          "state/badge element conveys meaning without any text or labelled glyph",
        );
      }
    }

    const live = el.getAttribute("aria-live");
    if (
      live === "polite" ||
      live === "assertive" ||
      el.getAttribute("role") === "status" ||
      el.getAttribute("role") === "alert"
    ) {
      stats.liveRegions += 1;
    }
  }

  return { violations, stats };
}
