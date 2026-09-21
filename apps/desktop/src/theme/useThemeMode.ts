import { useCallback, useEffect, useMemo, useState } from "react";
import type { ResolvedTheme, ThemeMode } from "./fluentTheme";

const STORAGE_KEY = "hornscribe.theme";

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") return mode;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

function readInitialMode(): ThemeMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "system" || v === "light" || v === "dark") return v;
  } catch {
    // localStorage may be unavailable under strict CSP contexts; default is fine.
  }
  return "system";
}

/**
 * light / dark / system theme selection.
 *
 * - "system" follows Windows via prefers-color-scheme (Tauri's webview
 *   exposes the OS theme through this media query) and re-resolves live.
 * - The resolved theme is published as data-hs-theme on <html> so the
 *   --hs-* semantic tokens (tokens.css) follow the same switch.
 */
export function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>(readInitialMode);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    resolve("system"),
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(mq.matches ? "dark" : "light");
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme = useMemo(
    () => (mode === "system" ? systemTheme : mode),
    [mode, systemTheme],
  );

  useEffect(() => {
    document.documentElement.dataset.hsTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const select = useCallback((next: ThemeMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* persistence is best-effort in the spike */
    }
  }, []);

  return { mode, resolved, select };
}
