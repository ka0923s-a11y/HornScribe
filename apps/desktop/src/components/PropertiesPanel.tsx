import { mergeClasses } from "@fluentui/react-components";
import { Dismiss16Regular } from "@fluentui/react-icons";
import { ja } from "../strings/ja";
import { HsIconButton } from "./primitives/IconButton";
import type { InspectorContent } from "../workspace/inspector";
import { startPointerResize } from "../workspace/layout";

/**
 * Properties inspector (GUI_UX_SPEC §6, §21; inspector contract in
 * workspace/inspector.ts).
 *
 * - Docked on the right at ≥1200px; below that it renders as a non-modal
 *   overlay drawer so the score keeps priority (§21).
 * - User-closable (acceptance: properties can be closed); the command-bar
 *   overflow menu reopens it. With no selection it shows only the
 *   placeholder body — feature inspectors (note/range) slot into the
 *   `content` contract, not into this file.
 * - Left-edge separator resizes within the breakpoint clamps.
 */
export function PropertiesPanel({
  content,
  width,
  min,
  max,
  overlay,
  onResize,
  onReset,
  onClose,
}: {
  content: InspectorContent;
  width: number;
  min: number;
  max: number;
  /** <1200px: overlay the score instead of docking beside it. */
  overlay: boolean;
  onResize(px: number): void;
  onReset(): void;
  onClose(): void;
}) {
  return (
    <aside
      className={mergeClasses(
        "hs-properties",
        overlay && "hs-properties--overlay",
      )}
      style={{ width }}
      aria-label={ja.properties.regionLabel}
      data-hs-focus-zone="properties"
      tabIndex={0}
    >
      <div className="hs-properties__frame">
        <header className="hs-properties__header">
          <h2 className="hs-properties__title">{ja.properties.title}</h2>
          <HsIconButton
            label={ja.properties.close}
            icon={<Dismiss16Regular />}
            size="small"
            onClick={onClose}
          />
        </header>
        <div className="hs-properties__body" data-inspector={content.kind}>
          {/* Inspector contract: `content` resolves the selection → body.
              kind "note"/"range" get their feature inspectors later; the
              shell guarantees the panel chrome either way. */}
          <p className="hs-properties__placeholder">
            {ja.properties.placeholder}
          </p>
        </div>
      </div>
      <div
        className="hs-properties__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={ja.properties.resizeHandle}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(e) => {
          const startW = width;
          const startX = e.clientX;
          // Panel is right-anchored: dragging left grows it.
          startPointerResize(e, onResize, (x) => startW + (startX - x));
        }}
        onKeyDown={(e) => {
          // ← grows (panel expands leftward), → shrinks.
          const step = e.key === "ArrowLeft" ? 8 : e.key === "ArrowRight" ? -8 : null;
          if (step != null) {
            e.preventDefault();
            onResize(width + step);
          }
        }}
        onDoubleClick={onReset}
      />
    </aside>
  );
}
