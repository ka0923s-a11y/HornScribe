/**
 * Properties inspector contract (docs/GUI_UX_SPEC.md §6, §10;
 * DESIGN_SYSTEM.md §21 "Inspector" inventory).
 *
 * The properties panel is a *contextual* inspector: it renders whatever the
 * current selection resolves to and stays closed while nothing is selected
 * (§6: 何も選択していない時、プロパティは原則閉じる). Feature teams supply
 * the selection → content mapping; the shell owns only visibility, sizing
 * and region placement — it must never hard-code feature inspectors here.
 */
export type InspectorContent =
  /** Nothing selected → panel closed by default; manual open shows the
      placeholder body. */
  | { kind: "none" }
  /** A canonical note is selected (UI-003 note IDs). Feature fields
      (pitch / spelling / onset / duration / measure / confidence /
      source position — protocol/copy properties.fields) are filled in by
      the note-inspector feature, not by this shell. */
  | { kind: "note"; noteId: string }
  /** A waveform/score range is selected. */
  | { kind: "range"; startSec: number; endSec: number };

export const NO_SELECTION: InspectorContent = { kind: "none" };

/** Whether the selection warrants auto-opening the panel (§6). */
export function inspectorHasContent(content: InspectorContent): boolean {
  return content.kind !== "none";
}
