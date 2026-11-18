/** A popup next to what opened it: a style editor, a menu of choices. */
import type { JSX } from "nsh";
import { Popover as BasePopover } from "nsh/base";

export function Popover(props: {
  trigger: JSX.Element;
  children: JSX.Element;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  width?: number;
  testID?: string;
}) {
  return (
    <BasePopover
      open={props.open}
      onOpenChange={(e) => props.onOpenChange?.(e.open)}
      placement={props.placement ?? "right"}
      align={props.align ?? "start"}
      offset={6}
      margin={12}
      testID={props.testID}
      trigger={props.trigger}
      popupClass="gap-3 rounded-lg border border-border bg-popover p-3 shadow-lg transition-all duration-150 ease-out"
      popupStartingClass="opacity-0 scale-95"
      popupEndingClass="opacity-0 scale-95"
      popupStyle={{ width: props.width ?? 260 }}
    >
      {props.children}
    </BasePopover>
  );
}
