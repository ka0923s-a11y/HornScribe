/**
 * WCAG 2.x contrast math + HornScribe token extraction (UI-070 §6 gate).
 *
 * Parses `src/theme/tokens.css` into per-theme token maps and computes
 * contrast ratios for semantic foreground/background pairs, including
 * rgba() overlays composited onto their surface. Pure functions — the same
 * module backs the vitest gate and can feed a reporting script.
 */

export interface Rgb {
  r: number; // 0-255
  g: number;
  b: number;
}

/** "#rgb" | "#rrggbb" | "rgb()" | "rgba()" → sRGB triple (alpha dropped). */
export function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return {
      rgb: {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
      },
      alpha: 1,
    };
  }
  const rgb =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*(\d*(?:\.\d+)?)\s*)?\)$/.exec(
      v,
    );
  if (rgb) {
    return {
      rgb: { r: +rgb[1], g: +rgb[2], b: +rgb[3] },
      alpha: rgb[4] === undefined ? 1 : +rgb[4],
    };
  }
  return null;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Alpha-composite `fg` over `bg`. */
export function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const a = Math.max(0, Math.min(1, alpha));
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** WCAG contrast ratio (1–21). */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

export type ThemeTokens = Map<string, string>;

export interface TokenThemes {
  light: ThemeTokens;
  dark: ThemeTokens;
}

/**
 * Splits tokens.css into the light block (`:root, [data-hs-theme="light"]`)
 * and the dark block (`[data-hs-theme="dark"]`). The shared `:root` block
 * (typography/spacing — no colors) is merged into both themes first so
 * lookup never misses non-color tokens.
 */
export function parseTokenThemes(css: string): TokenThemes {
  const light: ThemeTokens = new Map();
  const dark: ThemeTokens = new Map();
  const blockRe = /([^{}]+)\{([^{}]+)\}/g;
  for (const m of css.matchAll(blockRe)) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const body = m[2];
    const isDark = selector.includes('data-hs-theme="dark"');
    const isRootScope =
      /(^|,)\s*:root\b/.test(selector) || selector.includes("light");
    const target = isDark ? dark : isRootScope ? light : null;
    if (!target) continue;
    for (const decl of body.matchAll(/(--hs-[\w-]+)\s*:\s*([^;]+);/g)) {
      target.set(decl[1], decl[2].trim());
    }
  }
  return { light, dark };
}

export type PairKind = "text" | "large-text" | "non-text";

export interface ContrastPair {
  /** Token holding the foreground color (may be rgba → composited on bg). */
  fg: string;
  /** Token holding the background color. */
  bg: string;
  kind: PairKind;
  note?: string;
}

export const MIN_RATIO: Record<PairKind, number> = {
  text: 4.5,
  "large-text": 3,
  "non-text": 3,
};

/**
 * The semantic pair catalogue — the gate checks exactly the pairings the
 * design system documents (DESIGN_SYSTEM §3/§13/§16 + tokens.css pairing
 * comments), per theme.
 */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  // Standard text on each surface it lands on.
  { fg: "--hs-text-primary", bg: "--hs-surface-app", kind: "text" },
  { fg: "--hs-text-primary", bg: "--hs-surface-panel", kind: "text" },
  { fg: "--hs-text-primary", bg: "--hs-surface-elevated", kind: "text" },
  // NB: text tokens never land on --hs-surface-score — the paper carries
  // score-ink/staff tokens only (checked below).
  { fg: "--hs-text-secondary", bg: "--hs-surface-app", kind: "text" },
  { fg: "--hs-text-secondary", bg: "--hs-surface-panel", kind: "text" },
  { fg: "--hs-text-secondary", bg: "--hs-surface-elevated", kind: "text" },
  { fg: "--hs-text-muted", bg: "--hs-surface-app", kind: "text" },
  { fg: "--hs-text-muted", bg: "--hs-surface-panel", kind: "text" },
  // Accent text / on-accent text.
  { fg: "--hs-accent", bg: "--hs-surface-app", kind: "text" },
  { fg: "--hs-accent", bg: "--hs-surface-panel", kind: "text" },
  { fg: "--hs-accent", bg: "--hs-accent-subtle", kind: "text" },
  { fg: "--hs-accent-foreground", bg: "--hs-accent", kind: "text" },
  { fg: "--hs-accent-foreground", bg: "--hs-accent-hover", kind: "text" },
  // Status colors on their paired tinted surfaces (tokens.css contract).
  { fg: "--hs-status-info", bg: "--hs-status-info-subtle", kind: "text" },
  { fg: "--hs-status-warning", bg: "--hs-status-warning-subtle", kind: "text" },
  { fg: "--hs-status-error", bg: "--hs-status-error-subtle", kind: "text" },
  { fg: "--hs-status-success", bg: "--hs-status-success-subtle", kind: "text" },
  // Status text directly on chrome (error lines, status bar).
  { fg: "--hs-status-error", bg: "--hs-surface-app", kind: "text" },
  { fg: "--hs-status-warning", bg: "--hs-surface-app", kind: "text" },
  { fg: "--hs-status-success", bg: "--hs-surface-app", kind: "text" },
  { fg: "--hs-status-info", bg: "--hs-surface-app", kind: "text" },
  // Danger (destructive) button label.
  { fg: "--hs-danger-foreground", bg: "--hs-danger", kind: "text" },
  // Score ink/staff on the (always light) score paper.
  { fg: "--hs-score-ink", bg: "--hs-surface-score", kind: "text" },
  // Non-text interactive cues (≥3:1 per §6).
  { fg: "--hs-focus", bg: "--hs-surface-app", kind: "non-text" },
  { fg: "--hs-focus", bg: "--hs-surface-panel", kind: "non-text" },
  { fg: "--hs-focus", bg: "--hs-surface-elevated", kind: "non-text" },
  { fg: "--hs-border-strong", bg: "--hs-surface-app", kind: "non-text" },
  { fg: "--hs-border-strong", bg: "--hs-surface-panel", kind: "non-text" },
  { fg: "--hs-score-staff", bg: "--hs-surface-score", kind: "non-text" },
  // The playhead lives on the chrome (waveform strip), the caret on paper.
  { fg: "--hs-playhead", bg: "--hs-surface-app", kind: "non-text" },
  { fg: "--hs-score-caret", bg: "--hs-surface-score", kind: "non-text" },
  {
    fg: "--hs-review-marker",
    bg: "--hs-surface-score",
    kind: "non-text",
    note: "要確認 mark on score paper — shape+glyph",
  },
  {
    fg: "--hs-review-ink",
    bg: "--hs-review-tint",
    kind: "text",
    note: "issue-badge text/border on the review tint",
  },
  {
    fg: "--hs-review-ink",
    bg: "--hs-status-warning-subtle",
    kind: "non-text",
    note: "dotted underline on the warning badge",
  },
  { fg: "--hs-waveform", bg: "--hs-surface-elevated", kind: "non-text" },
  // Translucent overlays composite over their surface.
  {
    fg: "--hs-score-selection",
    bg: "--hs-surface-score",
    kind: "non-text",
    note: "selection wash composites onto paper",
  },
];

export interface ContrastResult {
  theme: "light" | "dark";
  pair: ContrastPair;
  fg: string;
  bg: string;
  fgEffective: string;
  ratio: number;
  required: number;
  pass: boolean;
}

function hex({ r, g, b }: Rgb): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Evaluates every catalogued pair for one theme. */
export function auditContrast(
  theme: "light" | "dark",
  tokens: ThemeTokens,
): ContrastResult[] {
  const results: ContrastResult[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const fgRaw = tokens.get(pair.fg);
    const bgRaw = tokens.get(pair.bg);
    if (!fgRaw || !bgRaw) {
      throw new Error(`Missing token(s) for pair ${pair.fg}/${pair.bg}`);
    }
    const bgParsed = parseColor(bgRaw);
    const fgParsed = parseColor(fgRaw);
    if (!bgParsed || !fgParsed) {
      throw new Error(`Unparseable color in pair ${pair.fg}/${pair.bg}`);
    }
    const fgEff =
      fgParsed.alpha < 1
        ? composite(fgParsed.rgb, fgParsed.alpha, bgParsed.rgb)
        : fgParsed.rgb;
    const ratio = contrastRatio(fgEff, bgParsed.rgb);
    const required = MIN_RATIO[pair.kind];
    results.push({
      theme,
      pair,
      fg: fgRaw,
      bg: bgRaw,
      fgEffective: hex(fgEff),
      ratio: Math.round(ratio * 100) / 100,
      required,
      pass: ratio >= required,
    });
  }
  return results;
}
