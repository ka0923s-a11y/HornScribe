import { forwardRef, type ReactElement } from "react";
import { mergeClasses } from "@fluentui/react-components";
import {
  CheckmarkCircle16Regular,
  DismissCircle16Regular,
  Flag16Regular,
  Wrench16Regular,
} from "@fluentui/react-icons";
import { ja } from "../../strings/ja";

/**
 * StatusBadge — compact status pill (検出済み, 見つかりません, 要確認…).
 *
 * Each tone pairs a --hs-status-* text color with its --hs-status-*-subtle
 * tint so text contrast stays ≥4.5:1 in both themes (§4). The meaning never
 * relies on color alone: callers should supply `icon`, or use ReviewBadge
 * which always renders a status glyph.
 */
export type StatusTone = "neutral" | "info" | "success" | "warning" | "error";

export interface StatusBadgeProps {
  tone: StatusTone;
  /** Japanese status label. */
  label: string;
  icon?: ReactElement;
  className?: string;
}

export const StatusBadge = forwardRef<HTMLSpanElement, StatusBadgeProps>(
  function StatusBadge({ tone, label, icon, className }, ref) {
    return (
      <span
        ref={ref}
        className={mergeClasses("hs-badge", `hs-badge--${tone}`, className)}
      >
        {icon ? (
          <span className="hs-badge__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="hs-badge__label">{label}</span>
      </span>
    );
  },
);

/**
 * ReviewBadge — 要確認 state marker (DESIGN_SYSTEM §15, GUI_UX_SPEC §12).
 *
 * §15 forbids treating low confidence as an error: "needs review" uses the
 * warning tint + flag glyph + dotted underline on the label, not red.
 * `count` renders 要確認（12）-style labels from the copy deck pattern.
 */
export type ReviewStatus = "needsReview" | "accepted" | "dismissed" | "fixed";

const REVIEW_META: Record<
  ReviewStatus,
  { tone: StatusTone; icon: ReactElement; label: () => string }
> = {
  needsReview: {
    tone: "warning",
    icon: <Flag16Regular />,
    label: () => ja.reviewBadge.needsReview,
  },
  accepted: {
    tone: "success",
    icon: <CheckmarkCircle16Regular />,
    label: () => ja.reviewBadge.accepted,
  },
  dismissed: {
    tone: "neutral",
    icon: <DismissCircle16Regular />,
    label: () => ja.reviewBadge.dismissed,
  },
  fixed: {
    tone: "success",
    icon: <Wrench16Regular />,
    label: () => ja.reviewBadge.fixed,
  },
};

export interface ReviewBadgeProps {
  status: ReviewStatus;
  /** Rendered as 要確認（{count}） for the needsReview status. */
  count?: number;
  className?: string;
}

export const ReviewBadge = forwardRef<HTMLSpanElement, ReviewBadgeProps>(
  function ReviewBadge({ status, count, className }, ref) {
    const meta = REVIEW_META[status];
    const label =
      status === "needsReview" && count != null
        ? `${meta.label()}（${count}）`
        : meta.label();
    return (
      <StatusBadge
        ref={ref}
        tone={meta.tone}
        label={label}
        icon={meta.icon}
        className={mergeClasses(
          "hs-badge--review",
          status === "needsReview" && "hs-badge--needs-review",
          className,
        )}
      />
    );
  },
);
