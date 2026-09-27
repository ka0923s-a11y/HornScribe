import type { ReactElement } from "react";
import {
  Menu as FluentMenu,
  MenuTrigger as FluentMenuTrigger,
  MenuPopover as FluentMenuPopover,
  MenuList as FluentMenuList,
  MenuItem as FluentMenuItem,
  MenuDivider as FluentMenuDivider,
  makeStyles,
  tokens,
} from "@fluentui/react-components";

/**
 * HsMenu — command/overflow menu over Fluent v9 Menu (§8 elevation tier).
 *
 * Declarative item list; each item carries its Japanese label. Dividers are
 * expressed with the literal item `{ key, divider: true }` — or interleave
 * real elements via `children` when the simple shape is not enough.
 */
const useMenuStyles = makeStyles({
  popover: {
    borderRadius: "var(--hs-radius-panel)",
    boxShadow: tokens.shadow8,
  },
});

export interface HsMenuItem {
  key: string;
  /** Japanese label (omit only for divider items). */
  label?: string;
  icon?: ReactElement;
  disabled?: boolean;
  /** Render a divider instead of an item. */
  divider?: boolean;
  /** #42: keep the menu open when the item is chosen (device pickers,
   *  monitor toggles — multi-step menus must not collapse mid-flow). */
  persistOnClick?: boolean;
  /** Trailing content rendered via MenuItem's secondaryContent slot
   *  (live level meter, hints). */
  suffix?: ReactElement;
}

export interface HsMenuProps {
  /** Trigger element — wrapped in MenuTrigger (keep it a real button). */
  trigger: ReactElement;
  items: readonly HsMenuItem[];
  onSelect?: (key: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Mount the popover into this node instead of document.body. */
  mountNode?: HTMLElement | null;
  /** Accessible name for the menu list. */
  ariaLabel?: string;
  positioning?: "below" | "above" | "before" | "after";
}

export function HsMenu({
  trigger,
  items,
  onSelect,
  open,
  onOpenChange,
  mountNode,
  ariaLabel,
  positioning = "below",
}: HsMenuProps) {
  const styles = useMenuStyles();
  return (
    <FluentMenu
      open={open}
      onOpenChange={(_, data) => onOpenChange?.(data.open)}
      mountNode={mountNode}
      positioning={positioning}
    >
      <FluentMenuTrigger disableButtonEnhancement>
        {trigger}
      </FluentMenuTrigger>
      <FluentMenuPopover className={styles.popover}>
        <FluentMenuList aria-label={ariaLabel}>
          {items.map((item) =>
            item.divider ? (
              <FluentMenuDivider key={item.key} />
            ) : (
              <FluentMenuItem
                key={item.key}
                icon={item.icon}
                disabled={item.disabled}
                persistOnClick={item.persistOnClick}
                secondaryContent={item.suffix}
                onClick={() => onSelect?.(item.key)}
              >
                {item.label}
              </FluentMenuItem>
            ),
          )}
        </FluentMenuList>
      </FluentMenuPopover>
    </FluentMenu>
  );
}
