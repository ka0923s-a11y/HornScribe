import type { ReactNode } from "react";
import {
  OverlayDrawer,
  DrawerHeader,
  DrawerHeaderTitle,
  DrawerBody,
  DrawerFooter,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import { HsIconButton } from "./IconButton";
import { ja } from "../../strings/ja";

/**
 * HsSheet — side sheet over Fluent v9 OverlayDrawer (書き出し, 採譜オプション
 * 拡張, 診断情報…). The floating-sheet elevation tier (§8) and panel-radius
 * geometry come from the Fluent theme + --hs-* motion tokens; the header
 * always carries a Japanese title and a labelled close button.
 */
const useSheetStyles = makeStyles({
  root: {
    borderStartStartRadius: "var(--hs-radius-panel)",
    borderEndStartRadius: "var(--hs-radius-panel)",
    boxShadow: tokens.shadow28,
    transitionDuration: "var(--hs-motion-panel)",
    transitionTimingFunction: "var(--hs-ease-decelerate)",
  },
});

export interface HsSheetProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Japanese title shown in the sheet header. */
  title: string;
  children: ReactNode;
  /** Sticky footer actions, e.g. キャンセル + 書き出す. */
  footer?: ReactNode;
  position?: "start" | "end";
  size?: "small" | "medium" | "large" | "full";
  modalType?: "modal" | "non-modal" | "alert";
  /** Mount the drawer into this node instead of document.body. */
  mountNode?: HTMLElement | null;
  closeLabel?: string;
}

export function HsSheet({
  open,
  onOpenChange,
  title,
  children,
  footer,
  position = "end",
  size = "medium",
  modalType = "modal",
  mountNode,
  closeLabel,
}: HsSheetProps) {
  const styles = useSheetStyles();
  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, data) => onOpenChange?.(data.open)}
      position={position}
      size={size}
      modalType={modalType}
      mountNode={mountNode}
      className={styles.root}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <HsIconButton
              label={closeLabel ?? ja.common.close}
              icon={<Dismiss24Regular />}
              onClick={() => onOpenChange?.(false)}
            />
          }
        >
          {title}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>{children}</DrawerBody>
      {footer ? <DrawerFooter>{footer}</DrawerFooter> : null}
    </OverlayDrawer>
  );
}
