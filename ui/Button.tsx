/**
 * Buttons: actions in the app. `variant` says how much the action matters, `size` where it sits; the look,
 * hover, press, focus and disabled states are all here, from theme tokens.
 */
import { Text, type JSX } from "nsh";
import { Button as BaseButton, Tooltip as BaseTooltip } from "nsh/base";
import { Icon, type IconName, type IconTone } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
export type ButtonSize = "sm" | "md";

const SURFACE: Record<ButtonVariant, string> = {
  primary: "bg-primary hover:bg-primary/90 active:bg-primary/80",
  secondary: "bg-secondary hover:bg-accent active:bg-accent selected:bg-accent",
  ghost: "hover:bg-accent active:bg-accent selected:bg-accent",
  outline: "border border-border bg-background hover:bg-accent active:bg-accent selected:bg-accent",
  danger: "bg-destructive hover:bg-destructive/90 active:bg-destructive/80",
};

const INK: Record<ButtonVariant, { text: string; icon: IconTone }> = {
  primary: { text: "text-primary-foreground", icon: "primary-foreground" },
  secondary: { text: "text-secondary-foreground", icon: "secondary-foreground" },
  ghost: { text: "text-foreground", icon: "foreground" },
  outline: { text: "text-foreground", icon: "foreground" },
  danger: { text: "text-destructive-foreground", icon: "destructive-foreground" },
};

const SIZE: Record<ButtonSize, { box: string; text: string; icon: number; square: string }> = {
  sm: { box: "h-7 px-2 gap-1.5 rounded-md", text: "text-xs", icon: 14, square: "h-7 w-7 rounded-md" },
  md: { box: "h-8 px-3 gap-2 rounded-(--radius)", text: "text-sm", icon: 16, square: "h-8 w-8 rounded-(--radius)" },
};

const BASE = "flex-row items-center justify-center focus-visible:ring-2 ring-ring disabled:opacity-50 transition-colors";

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** An icon after the label: a chevron for a menu, say. */
  trailingIcon?: IconName;
  disabled?: boolean;
  selected?: boolean;
  /** Layout from the caller: flex, width, margins. */
  class?: string;
  testID?: string;
  accessibilityLabel?: string;
}

export function Button(props: ButtonProps) {
  const v = () => props.variant ?? "secondary";
  const s = () => props.size ?? "md";
  return (
    <BaseButton
      onPress={props.onPress}
      disabled={props.disabled}
      selected={props.selected}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      class={`${BASE} ${SIZE[s()].box} ${SURFACE[v()]} ${props.class ?? ""}`}
    >
      <If when={props.icon}>{(name) => <Icon name={name()} size={SIZE[s()].icon} tone={INK[v()].icon} />}</If>
      <Text class={`${SIZE[s()].text} font-medium ${INK[v()].text} line-clamp-1`}>
        {props.label}
      </Text>
      <If when={props.trailingIcon}>{(name) => <Icon name={name()} size={SIZE[s()].icon - 2} tone={INK[v()].icon} />}</If>
    </BaseButton>
  );
}

export interface IconButtonProps {
  icon: IconName;
  /** What it does: its tooltip and what screen readers say. */
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  selected?: boolean;
  /** Its keyboard shortcut, shown in the tooltip: "⌘Z". */
  shortcut?: string;
  /** The icon's color, when it should be quieter than the variant's ink. */
  tone?: IconTone;
  class?: string;
  testID?: string;
}

export function IconButton(props: IconButtonProps) {
  const v = () => props.variant ?? "ghost";
  const s = () => props.size ?? "md";
  return (
    <BaseButton
      onPress={props.onPress}
      disabled={props.disabled}
      selected={props.selected}
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={<Tooltip text={props.shortcut ? `${props.label}  ${props.shortcut}` : props.label} />}
      class={`${BASE} ${SIZE[s()].square} ${SURFACE[v()]} ${props.class ?? ""}`}
    >
      <Icon name={props.icon} size={SIZE[s()].icon} tone={props.tone ?? INK[v()].icon} />
    </BaseButton>
  );
}

/** A tooltip's bubble: what a `tooltip` prop shows. */
export function Tooltip(props: { text: string }) {
  return (
    <TooltipBubble>
      <Text class="text-xs text-popover-foreground">{props.text}</Text>
    </TooltipBubble>
  );
}

function TooltipBubble(props: { children: JSX.Element }) {
  return (
    <BaseTooltip placement="bottom" offset={6} class="rounded-md border border-border bg-popover px-2 py-1 shadow-md">
      {props.children}
    </BaseTooltip>
  );
}
