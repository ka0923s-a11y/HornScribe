import { forwardRef, useCallback } from 'react';
import type { RenderedPage } from '../lib/verovio';
import { resolveHitElement } from '../lib/domScore';

interface ScoreViewProps {
  pages: RenderedPage[];
  /** Called with the MusicXML export id (`hs-*`) of the clicked note/rest. */
  onElementClick: (exportId: string) => void;
  ariaLabel: string;
}

/**
 * Renders Verovio's per-page SVG. The raw SVG is `aria-hidden`: the parallel
 * listbox (NoteList) is the accessible representation, so hit-testing and
 * semantics never depend on SVG internals alone (GUI_UX_PLAN §40).
 */
export const ScoreView = forwardRef<HTMLDivElement, ScoreViewProps>(function ScoreView(
  { pages, onElementClick, ariaLabel },
  ref,
) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const container = e.currentTarget;
      const hit = resolveHitElement(e.target, container);
      if (hit?.id) onElementClick(hit.id);
    },
    [onElementClick],
  );

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
