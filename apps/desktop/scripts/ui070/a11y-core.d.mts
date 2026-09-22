/** Type declarations for a11y-core.mjs (UI-070 audit). */
export interface A11yViolation {
  rule:
    | "accessible-name"
    | "japanese-name"
    | "focusable"
    | "region-name"
    | "color-only";
  target: string;
  detail: string;
}

export interface A11yStats {
  interactive: number;
  named: number;
  regions: number;
  liveRegions: number;
  colorSignals: number;
}

export interface A11yReport {
  violations: A11yViolation[];
  stats: A11yStats;
}

export function auditAccessibility(root: Element | Document): A11yReport;
