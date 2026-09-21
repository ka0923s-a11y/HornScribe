import type { ReactNode } from "react";

/**
 * AppShell — fixed workspace grid (GUI_UX_SPEC §2).
 * Row order = focus/scan order: title, command bar, waveform, workspace,
 * transport, status.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return <div className="hs-shell">{children}</div>;
}
