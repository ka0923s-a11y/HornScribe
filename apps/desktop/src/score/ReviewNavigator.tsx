/**
 * ReviewNavigator — the 一覧 popover for the 要確認 workspace (#361).
 *
 * The linear 前へ/次へ cursor stays the fast path; this panel adds the
 * missing overview: every ReviewIssue listed with position / reason /
 * severity / status, filterable to 未解決のみ・severity・reason, and any
 * row jumps the review cursor straight to it (score scroll + source seek
 * come along via the existing gotoIssue path).
 *
 * Keyboard: the list is a real role="listbox" — ↑↓/Home/End roam the
 * options, Enter jumps, Esc closes. The panel is a non-modal
 * role="dialog" so the global dispatcher leaves the keys to us while
 * focus is inside (isModalTarget); the I command opts back in via
 * allowInModal so it can toggle the panel shut too.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox, Select } from "@fluentui/react-components";
import { ja } from "../strings/ja";
import { HsButton } from "../components/primitives/Button";
import type { ReviewCopy } from "./inspector";
import type { ReviewSeverity, ScoreReviewIssue } from "./review";

export interface ReviewNavigatorProps {
  readonly issues: readonly ScoreReviewIssue[];
  /** Index (into `issues`) of the issue the review cursor is on — shown
   *  as the listbox's selected option. */
  readonly activeIndex: number;
  /** #272: issues the surfacing cap omitted (footer note; 0 = hide). */
  readonly omitted?: number;
  // #360: when the document carries the deferred issues, the footer
  //  offers the one-click expansion into the live review list.
  onExpandOmitted?(): void;
  readonly copy: ReviewCopy;
  onJump(index: number): void;
  onClose(): void;
}

interface Listed {
  readonly issue: ScoreReviewIssue;
  /** Absolute index into `issues` — the jump target. */
  readonly index: number;
}

/** m:ss source-time range label for an issue (null when the engine
 *  gave no audible span — whole-piece issues like meter_conflict). */
function timeLabel(issue: ScoreReviewIssue): string | null {
  const t = issue.timeRange;
  if (!t) return null;
  const fmt = (sec: number) =>
    `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  return `${fmt(t.startSec)}–${fmt(t.endSec)}`;
}

const SEVERITIES: readonly ReviewSeverity[] = ["warning", "caution", "info"];

export function ReviewNavigator({
  issues,
  activeIndex,
  omitted = 0,
  onExpandOmitted,
  copy,
  onJump,
  onClose,
}: ReviewNavigatorProps) {
  const t = ja.review.nav;
  // Default to 未解決のみ when any pending work exists; with the history
  // fully resolved the list would open empty, so start unfiltered then.
  const [openOnly, setOpenOnly] = useState(
    () => issues.some((i) => i.status === "open"),
  );
  const [severity, setSeverity] = useState("all");
  const [reason, setReason] = useState("all");

  // Reason options follow first-appearance order in the issue list —
  // chronological beats alphabetical for spotting problem passages.
  const reasons = useMemo(
    () => [...new Set(issues.map((i) => i.reason))],
    [issues],
  );

  const filtered = useMemo<Listed[]>(() => {
    const out: Listed[] = [];
    issues.forEach((issue, index) => {
      if (openOnly && issue.status !== "open") return;
      if (severity !== "all" && issue.severity !== severity) return;
      if (reason !== "all" && issue.reason !== reason) return;
      out.push({ issue, index });
    });
    return out;
  }, [issues, openOnly, severity, reason]);

  // The roaming listbox focus (aria-activedescendant — real DOM focus
  // stays on the <ul> so ↑↓ never leaves the list). Initialize on the
  // issue the review cursor is on when it survives the filter.
  const [focusPos, setFocusPos] = useState(() => {
    const p = filtered.findIndex((f) => f.index === activeIndex);
    return p >= 0 ? p : 0;
  });
  const pos = Math.min(focusPos, Math.max(0, filtered.length - 1));

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.focus();
  }, []);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-pos="${pos}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [pos]);

  const resetFocus = () => {
    const at = filtered.findIndex((f) => f.index === activeIndex);
    setFocusPos(at >= 0 ? at : 0);
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const n = filtered.length;
    if (n === 0) return;
    let next = pos;
    if (e.key === "ArrowDown") next = (pos + 1) % n;
    else if (e.key === "ArrowUp") next = (pos - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onJump(filtered[pos].index);
      return;
    } else return;
    e.preventDefault();
    setFocusPos(next);
  };

  const activeDescendant =
    filtered.length > 0
      ? `hs-reviewnav-opt-${filtered[pos].issue.id}`
      : undefined;

  return (
    <div
      className="hs-reviewnav"
      role="dialog"
      aria-label={t.regionLabel}
      onKeyDown={(e) => {
        // Esc anywhere in the panel closes the navigator only — the
        //  modal scope already keeps it from exiting the review.
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="hs-reviewnav__filters">
        <Checkbox
          size="medium"
          label={t.openOnly}
          checked={openOnly}
          onChange={(_, d) => {
            setOpenOnly(d.checked === true);
            resetFocus();
          }}
        />
        <label className="hs-reviewnav__filter">
          <span>{t.severityLabel}</span>
          <Select
            size="small"
            value={severity}
            aria-label={t.severityLabel}
            onChange={(_, d) => {
              setSeverity(d.value);
              resetFocus();
            }}
          >
            <option value="all">{t.all}</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {copy.severityLabel(s)}
              </option>
            ))}
          </Select>
        </label>
        <label className="hs-reviewnav__filter">
          <span>{t.reasonLabel}</span>
          <Select
            size="small"
            value={reason}
            aria-label={t.reasonLabel}
            onChange={(_, d) => {
              setReason(d.value);
              resetFocus();
            }}
          >
            <option value="all">{t.all}</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {copy.reasonTitle(r)}
              </option>
            ))}
          </Select>
        </label>
        <span className="hs-reviewnav__count" aria-live="polite">
          {t.filteredCount(filtered.length, issues.length)}
        </span>
        <span className="hs-reviewnav__spacer" />
        <HsButton size="small" onClick={onClose}>
          {ja.common.close}
        </HsButton>
      </div>
      {filtered.length === 0 ? (
        <p className="hs-reviewnav__empty">{t.empty}</p>
      ) : (
        <ul
          ref={listRef}
          className="hs-reviewnav__list"
          role="listbox"
          aria-label={t.listLabel}
          aria-activedescendant={activeDescendant}
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {filtered.map(({ issue, index }, p) => {
            const time = timeLabel(issue);
            return (
              <li
                key={issue.id}
                id={`hs-reviewnav-opt-${issue.id}`}
                role="option"
                data-pos={p}
                aria-selected={index === activeIndex}
                className={
                  "hs-reviewnav__item" +
                  (p === pos ? " hs-reviewnav__item--focus" : "") +
                  (index === activeIndex
                    ? " hs-reviewnav__item--selected"
                    : "")
                }
                onClick={() => onJump(index)}
                onMouseMove={() => {
                  if (p !== pos) setFocusPos(p);
                }}
              >
                <span className="hs-reviewnav__item-pos">{index + 1}</span>
                {time != null && (
                  <span className="hs-reviewnav__item-time">{time}</span>
                )}
                <span className="hs-reviewnav__item-reason">
                  {copy.reasonTitle(issue.reason)}
                </span>
                <span className="hs-reviewnav__item-meta">
                  {copy.severityLabel(issue.severity)}
                  {"・"}
                  {copy.statusLabel(issue.status)}
                  {"・"}
                  {t.notes(issue.canonicalNoteIds.length)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {omitted > 0 && (
        <p className="hs-reviewnav__omitted">
          {onExpandOmitted ? (
            <button
              type="button"
              className="hs-reviewnav__expand"
              onClick={onExpandOmitted}
            >
              {ja.review.expandOmitted(omitted)}
            </button>
          ) : (
            ja.review.omitted(omitted)
          )}
        </p>
      )}
    </div>
  );
}
