import { forwardRef, useEffect } from "react";
import type { RenderedPage } from "./verovio";
import { resolveHitElement } from "./domScore";

interface ScoreViewProps {
  pages: RenderedPage[];
  /** Called with the MusicXML export id (`hs-*`) of the clicked note/rest. */
  onElementClick: (exportId: string) => void;
  /** Click on the score paper background (deselect). */
  onBackgroundClick?: () => void;
  /**
   * User manually navigated the score (wheel / background-drag / scrollbar)
   * — the app treats this as "manual score navigation" and suspends follow.
   * Note clicks (`hs-*` targets) are selection, not navigation.
   */
  onUserNavigate?: () => void;
  ariaLabel: string;
}

/**
 * Renders Verovio's per-page SVG inside a scroll container. The raw SVG is
 * `aria-hidden` — selection details are mirrored in the properties panel so
 * the a11y path never depends on raw SVG alone (GUI_UX_SPEC §24).
 *
 * Highlighting is DOM class toggles on `hs-*` groups; this component never
 * re-renders for playback marks (UI-005: zero renderToSVG on the frame path).
 */
export const ScoreView = forwardRef<HTMLDivElement, ScoreViewProps>(function ScoreView(
  { pages, onElementClick, onBackgroundClick, onUserNavigate, ariaLabel },
  ref,
) {
  useEffect(() => {
    const container = (ref as React.RefObject<HTMLDivElement>).current;
    if (!container || !onUserNavigate) return;
    const onWheel = () => onUserNavigate();
    const onPointerDown = (e: PointerEvent) => {
      // Scrollbar / paper background = navigation; a note hit = selection.
      const target = e.target as Element | null;
      if (target?.closest?.('[id^="hs-"]')) return;
      onUserNavigate();
    };
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointerDown);
    };
  }, [ref, onUserNavigate]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const hit = resolveHitElement(e.target, container);
    if (hit?.id) {
      onElementClick(hit.id);
    } else {
      onBackgroundClick?.();
    }
  };

  return (
    <div
      ref={ref}
      className="hs-score-scroll"
      role="region"
      aria-label={ariaLabel}
      onClick={handleClick}
    >
      <div className="hs-score-pages" aria-hidden="true">
        {pages.map((p) => (
          <div
            key={p.page}
            className="hs-score-page"
            data-page={p.page}
            dangerouslySetInnerHTML={{ __html: p.svg }}
          />
        ))}
      </div>
    </div>
  );
});
