import {
  createLightTheme,
  createDarkTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

/**
 * Fluent v9 theme mapping for HornScribe (docs/DESIGN_SYSTEM.md §3).
 *
 * The brand ramp is Fluent's blue ramp: the accent deliberately tracks the
 * Windows/Fluent system feel rather than a fixed custom brand color.
 * HornScribe-specific semantics live in the --hs-* CSS tokens (tokens.css);
 * the Fluent theme below governs v9 component internals.
 */
const hornscribeBrand: BrandVariants = {
  10: "#061724",
  20: "#082338",
  30: "#0a2e4a",
  40: "#0c3b5e",
  50: "#0e4775",
  60: "#0f548c",
  70: "#115ea3",
  80: "#0f6cbd",
  90: "#2886de",
  100: "#479ef5",
  110: "#62abf5",
  120: "#77b7f7",
  130: "#96c6fa",
  140: "#b4d6fa",
  150: "#cfe4fa",
  160: "#ebf3fc",
};

/**
 * §5 typography: the same stack as --hs-font-family so Fluent component
 * internals render Japanese text through Yu Gothic UI / Meiryo too.
 */
const hsFontStack =
  '"Segoe UI Variable","Segoe UI","Yu Gothic UI","Meiryo",sans-serif';

export const hsLightTheme: Theme = {
  ...createLightTheme(hornscribeBrand),
  fontFamilyBase: hsFontStack,
  fontFamilyNumeric: hsFontStack,
};

export const hsDarkTheme: Theme = {
  ...createDarkTheme(hornscribeBrand),
  fontFamilyBase: hsFontStack,
  fontFamilyNumeric: hsFontStack,
};

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
