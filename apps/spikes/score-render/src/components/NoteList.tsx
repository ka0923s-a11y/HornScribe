import { useCallback, useRef } from 'react';
import { describeNote, type ParsedNote } from '../lib/scoreDoc';

interface NoteListProps {
  heading: string;
  notes: ParsedNote[];
  selectedExportId: string | null;
  selectedCanonical: string | null;
  activeCanonicals: ReadonlySet<string>;
  onSelect: (exportId: string) => void;
}

/**
 * Parallel accessible representation of the score: a real `listbox` of notes
 * and rests grouped by measure, independent of the SVG. Arrow keys move,
 * Enter/Space selects — this is the keyboard/screen-reader path that GUI_UX_PLAN
 * §40 requires so a11y never relies on the raw SVG tree.
 */
export function NoteList({
  heading,
  notes,
  selectedExportId,
  selectedCanonical,
  activeCanonicals,
  onSelect,
}: NoteListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const items = notes;

  const isSelected = (n: ParsedNote) =>
    n.exportId === selectedExportId ||
    (n.canonicalId !== null && n.canonicalId === selectedCanonical);
  const isActive = (n: ParsedNote) => n.canonicalId !== null && activeCanonicals.has(n.canonicalId);

  const focusIndex = useCallback((idx: number) => {
    const el = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[idx];
    el?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const current = document.activeElement;
      const options = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
      );
      const idx = options.indexOf(current as HTMLElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        focusIndex(Math.min(options.length - 1, idx + 1));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        focusIndex(Math.max(0, idx <= 0 ? 0 : idx - 1));
      } else if ((e.key === 'Enter' || e.key === ' ') && idx >= 0) {
        e.preventDefault();
        onSelect(items[idx].exportId);
      }
    },
    [focusIndex, items, onSelect],
  );

  return (
    <section className="hs-notelist" aria-label={heading}>
      <h2 className="hs-panel-title">{heading}</h2>
      <ul
        ref={listRef}
        role="listbox"
        aria-label={heading}
        className="hs-notelist-ul"
        onKeyDown={onKeyDown}
      >
        {items.map((n, i) => {
          const selected = isSelected(n);
          const active = isActive(n);
          return (
            <li
              key={n.exportId}
              role="option"
              aria-selected={selected}
              tabIndex={i === 0 || selected ? 0 : -1}
              className={
                'hs-note-option' +
                (selected ? ' is-selected' : '') +
                (active ? ' is-active' : '')
              }
              onClick={() => onSelect(n.exportId)}
            >
              <span className="hs-note-option-text">
                {active ? '▶ ' : ''}
                {describeNote(n)}
              </span>
              <code className="hs-note-option-id">{n.exportId}</code>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
