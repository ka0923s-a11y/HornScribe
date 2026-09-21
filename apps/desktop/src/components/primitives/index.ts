/**
 * HornScribe component primitives — thin wrappers over Fluent UI v9 that
 * apply the --hs-* semantic tokens and enforce the Japanese copy contract
 * (required labels/aria-names). Feature components consume these instead of
 * raw Fluent controls or hard-coded styling.
 */
export { HsButton } from "./Button";
export type { HsButtonProps, HsButtonVariant } from "./Button";

export { HsIconButton } from "./IconButton";
export type { HsIconButtonProps } from "./IconButton";

export { SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlProps, SegmentedOption } from "./SegmentedControl";

export { HsTooltip } from "./Tooltip";
export type { HsTooltipProps } from "./Tooltip";

export { HsPopover } from "./Popover";
export type { HsPopoverProps } from "./Popover";

export { HsMenu } from "./Menu";
export type { HsMenuProps, HsMenuItem } from "./Menu";

export { HsSlider } from "./Slider";
export type { HsSliderProps } from "./Slider";

export { HsNumericField } from "./NumericField";
export type { HsNumericFieldProps } from "./NumericField";

export { HsSelect } from "./Select";
export type { HsSelectProps, HsSelectOption } from "./Select";

export { HsProgress } from "./Progress";
export type { HsProgressProps } from "./Progress";

export { StatusBadge, ReviewBadge } from "./StatusBadge";
export type {
  StatusBadgeProps,
  StatusTone,
  ReviewBadgeProps,
  ReviewStatus,
} from "./StatusBadge";

export { HsPanel } from "./Panel";
export type { HsPanelProps } from "./Panel";

export { HsDialog } from "./Dialog";
export type { HsDialogProps } from "./Dialog";

export { HsSheet } from "./Sheet";
export type { HsSheetProps } from "./Sheet";
