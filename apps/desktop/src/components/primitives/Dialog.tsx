import type { ReactElement, ReactNode } from "react";
import {
  Dialog as FluentDialog,
  DialogTrigger as FluentDialogTrigger,
  DialogSurface as FluentDialogSurface,
  DialogBody as FluentDialogBody,
  DialogTitle as FluentDialogTitle,
  DialogContent as FluentDialogContent,
  DialogActions as FluentDialogActions,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useFocusRestoreOnClose } from "../../focus/useFocusRestoreOnClose";

/**
 * HsDialog — modal surface (§7 modal radius, §8 elevation, §20 error shape).
 *
 * Body copy follows the copy contract: title = what failed / what's asked,
 * content = impact, actions = recovery. Danger variants belong on the
 * caller's action buttons (HsButton variant="danger"), not on the dialog.
 *
 * `modalType` is Fluent's: "modal" (default, backdrop + focus trap),
 * "non-modal", or "alert" (no light-dismiss — reserve for destructive
 * confirmations per JAPANESE_UI_COPY §8).
 */
const useDialogStyles = makeStyles({
  surface: {
    borderRadius: "var(--hs-radius-modal)",
    boxShadow: tokens.shadow64,
    // §18 dialog motion tier; collapses to ~0 under reduced-motion tokens.
    transitionDuration: "var(--hs-motion-dialog)",
    transitionTimingFunction: "var(--hs-ease-decelerate)",
  },
});

export interface HsDialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Japanese title — required, dialogs always carry a heading. */
  title: string;
  /** Body content (DialogContent). */
  children: ReactNode;
  /** Footer actions (DialogActions), e.g. キャンセル + primary action. */
  actions?: ReactNode;
  /** Optional trigger element wrapped in DialogTrigger. */
  trigger?: ReactElement;
  /** Mount the surface into this node instead of document.body. */
  mountNode?: HTMLElement | null;
  modalType?: "modal" | "non-modal" | "alert";
}

export function HsDialog({
  open,
  onOpenChange,
  title,
  children,
  actions,
  trigger,
  mountNode,
  modalType = "modal",
}: HsDialogProps) {
  const styles = useDialogStyles();
  // §22: closing the dialog returns focus to the opener — the hook only
  // restores when focus would otherwise strand on <body>, so Fluent's own
  // trigger-restore keeps precedence and deliberate moves are respected.
  useFocusRestoreOnClose(open);
  return (
    <FluentDialog
      open={open}
      onOpenChange={(_, data) => onOpenChange?.(data.open)}
      modalType={modalType}
    >
      {trigger ? (
        <FluentDialogTrigger disableButtonEnhancement>
          {trigger}
        </FluentDialogTrigger>
      ) : (
        <></>
      )}
      <FluentDialogSurface className={styles.surface} mountNode={mountNode}>
        <FluentDialogBody>
          <FluentDialogTitle>{title}</FluentDialogTitle>
          <FluentDialogContent>{children}</FluentDialogContent>
          {actions ? (
            <FluentDialogActions>{actions}</FluentDialogActions>
          ) : null}
        </FluentDialogBody>
      </FluentDialogSurface>
    </FluentDialog>
  );
}
