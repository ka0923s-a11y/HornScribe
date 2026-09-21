import { forwardRef, type ReactNode } from "react";
import { mergeClasses } from "@fluentui/react-components";
import { Dismiss16Regular } from "@fluentui/react-icons";
import { HsIconButton } from "./IconButton";
import { ja } from "../../strings/ja";

/**
 * HsPanel — section container (プロパティ, 書き出しオプション, 設定群…).
 *
 * Persistent workspace surfaces stay flat (§8): separation is by border +
 * surface contrast. `elevated` is for floating panels only and switches to
 * --hs-surface-elevated + --hs-elevation-popover.
 */
export interface HsPanelProps {
  /** Japanese section title — shown in the panel header. */
  title?: string;
  /** Heading level for the title (default 3); pick to keep the outline. */
  titleLevel?: 2 | 3 | 4;
  /** Header actions (icon buttons etc.) rendered before the close button. */
  actions?: ReactNode;
  /** When set, renders a close button; label defaults to 閉じる. */
  onClose?: () => void;
  closeLabel?: string;
  /** Floating presentation (elevated surface + shadow). */
  elevated?: boolean;
  /** Accessible name; defaults to the title when present. */
  ariaLabel?: string;
  /** Remove the default body padding for flush content (lists, rulers). */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export const HsPanel = forwardRef<HTMLElement, HsPanelProps>(
  function HsPanel(
    {
      title,
      titleLevel = 3,
      actions,
      onClose,
      closeLabel,
      elevated = false,
      ariaLabel,
      flush = false,
      className,
      children,
    },
    ref,
  ) {
    const hasHeader = title != null || actions != null || onClose != null;
    const TitleTag = `h${titleLevel}` as const;
    return (
      <section
        ref={ref}
        className={mergeClasses(
          "hs-panel",
          elevated && "hs-panel--elevated",
          className,
        )}
        aria-label={ariaLabel ?? title}
      >
        {hasHeader ? (
          <header className="hs-panel__header">
            {title ? (
              <TitleTag className="hs-panel__title">{title}</TitleTag>
            ) : null}
            <span className="hs-panel__header-spacer" />
            {actions}
            {onClose ? (
              <HsIconButton
                label={closeLabel ?? ja.common.close}
                icon={<Dismiss16Regular />}
                size="small"
                onClick={onClose}
              />
            ) : null}
          </header>
        ) : null}
        <div
          className={mergeClasses(
            "hs-panel__body",
            flush && "hs-panel__body--flush",
          )}
        >
          {children}
        </div>
      </section>
    );
  },
);
