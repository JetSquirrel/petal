/** Choice controls and small pieces: a segmented control, a switch, badges, swatches, surfaces. */
import { Text, View, type JSX } from "nsh";
import { Button as BaseButton, Switch as BaseSwitch } from "nsh/base";
import { Icon, type IconName } from "./Icon";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

/** One choice among a few, shown together. */
export function Segmented<T extends string>(props: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
  class?: string;
  testID?: string;
}) {
  return (
    <View role="radiogroup" accessibilityLabel={props.label} class={`flex-row gap-0.5 rounded-(--radius) bg-muted p-0.5 ${props.class ?? ""}`}>
      <Each of={props.options} key={(o) => o.value}>
        {(o) => (
          <BaseButton
            role="radio"
            selected={props.value === o().value}
            onPress={() => props.onChange(o().value)}
            testID={props.testID ? `${props.testID}-${o().value}` : undefined}
            accessibilityLabel={o().label}
            class="h-7 flex-1 flex-row items-center justify-center gap-1.5 rounded-md px-2.5 hover:bg-background/60 selected:bg-background selected:shadow-xs focus-visible:ring-2 ring-ring"
          >
            <If when={o().icon}>{(i) => <Icon name={i()} size={14} tone={props.value === o().value ? "foreground" : "muted-foreground"} />}</If>
            <Text class={`text-xs font-medium ${props.value === o().value ? "text-foreground" : "text-muted-foreground"}`}>{o().label}</Text>
          </BaseButton>
        )}
      </Each>
    </View>
  );
}

export function Switch(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; testID?: string; class?: string }) {
  return (
    <BaseSwitch
      checked={props.checked}
      onChange={(e) => props.onChange(e.checked)}
      testID={props.testID}
      accessibilityLabel={props.label}
      class={`flex-row items-center justify-between gap-3 ${props.class ?? ""}`}
      trackClass="w-8 rounded-full bg-input p-0.5 transition-colors checked:bg-primary"
      thumbClass="size-4 rounded-full bg-background shadow-sm transition-transform checked:translate-x-3"
    >
      <Text class="text-sm text-foreground">{props.label}</Text>
    </BaseSwitch>
  );
}

/** A short count or classification. Neutral unless it is a category, which shows its color as a dot. */
export function Badge(props: { text: string; dot?: string; variant?: "neutral" | "outline"; class?: string }) {
  return (
    <View
      class={`flex-row items-center gap-1.5 self-start rounded-full px-2 py-0.5 ${
        props.variant === "outline" ? "border border-border" : "bg-secondary"
      } ${props.class ?? ""}`}
    >
      <If when={props.dot}>{(c) => <Swatch color={c()} size={8} />}</If>
      <Text class="text-xs font-medium text-secondary-foreground">{props.text}</Text>
    </View>
  );
}

/**
 * A category's color: data, not decoration, so it is the palette value itself. `ring` outlines it
 * (the chosen one in a picker).
 */
export function Swatch(props: { color: string; size?: number; ring?: boolean }) {
  const s = () => props.size ?? 12;
  return (
    <View
      class={props.ring ? "border-2 border-foreground" : "border border-foreground/15"}
      style={{ width: s(), height: s(), borderRadius: s() / 2, backgroundColor: props.color }}
    />
  );
}

/**
 * A raised surface over the canvas: toolbars, the inspector's cards, popups. `flat` is a card that sits in the
 * page instead (the notebook's editor and frames): its border carries it, with only a hint of shadow.
 */
export function Surface(props: { children: JSX.Element; class?: string; testID?: string; flat?: boolean }) {
  return (
    <View testID={props.testID} class={`rounded-lg border border-border bg-card ${props.flat ? "shadow-xs" : "shadow-md"} ${props.class ?? ""}`}>
      {props.children}
    </View>
  );
}

export function Separator(props: { vertical?: boolean; class?: string }) {
  return <View class={`${props.vertical ? "w-px self-stretch" : "h-px"} bg-border ${props.class ?? ""}`} />;
}

/** A section heading in a panel, with an optional action at its end. */
export function SectionTitle(props: { title: string; detail?: string; action?: JSX.Element }) {
  return (
    <View class="h-7 flex-row items-center justify-between gap-2">
      <View class="flex-row items-baseline gap-2">
        <Text class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</Text>
        <If when={props.detail}>
          <Text class="text-xs text-muted-foreground tabular-nums">{props.detail}</Text>
        </If>
      </View>
      {props.action}
    </View>
  );
}

export function Spinner(props: { size?: number }) {
  return (
    <View class="motion-safe:animate-spin" accessibilityLabel="Working">
      <Icon name="loader" size={props.size ?? 14} tone="muted-foreground" />
    </View>
  );
}

/** A pressable row: a list entry in a panel or a popup. */
export function Row(props: {
  children: JSX.Element;
  onPress?: () => void;
  selected?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  class?: string;
}) {
  return (
    <BaseButton
      onPress={props.onPress}
      selected={props.selected}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      class={`min-h-8 flex-row items-center gap-2 rounded-md px-2 hover:bg-accent active:bg-accent selected:bg-accent focus-visible:ring-2 ring-ring ${props.class ?? ""}`}
    >
      {props.children}
    </BaseButton>
  );
}

/** A choice among several that wrap: a filter's options (any, or one label). */
export function Chip(props: { label: string; selected: boolean; onPress: () => void; dot?: string; testID?: string; accessibilityLabel?: string }) {
  return (
    <BaseButton
      role="radio"
      selected={props.selected}
      onPress={props.onPress}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      class="h-6 flex-row items-center gap-1.5 rounded-full border border-border px-2 hover:bg-accent selected:border-primary selected:bg-primary/10 focus-visible:ring-2 ring-ring"
    >
      <If when={props.dot}>{(c) => <View class="size-2 rounded-full" style={{ backgroundColor: c() }} />}</If>
      <Text class={`text-xs ${props.selected ? "font-medium text-foreground" : "text-muted-foreground"}`}>{props.label}</Text>
    </BaseButton>
  );
}
