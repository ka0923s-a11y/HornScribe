import type { ReactNode } from "react";

/**
 * AppShell — fixed workspace grid (GUI_UX_SPEC §2).
 * Row order = focus/scan order: title, command bar, waveform, workspace,
 * transport, status.
 *
 * F6 / Shift+F6 region cycling is owned by the UI-012 architecture: regions
 * self-identify via `data-hs-focus-zone` (src/focus/zones.ts) and the
 * nav.nextRegion / nav.previousRegion commands drive the cycle through the
 * central keyboard dispatcher. This component owns no keydown handler.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return <div className="hs-shell">{children}</div>;
}
