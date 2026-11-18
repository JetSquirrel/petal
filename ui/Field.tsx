/** Text inputs and the field around them: label, control, description, error. */
import { Text, View, type InputRef, type JSX } from "nsh";
import { Input } from "nsh/base";

export interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  masked?: boolean;
  invalid?: boolean;
  autoFocus?: boolean;
  autoComplete?: "username" | "current-password" | "url" | "off";
  /** Code, an address, a name: no capitals or corrections. */
  verbatim?: boolean;
  mono?: boolean;
  size?: "sm" | "md";
  /** No border or fill of its own: the field sits inside a box that draws them (the search bar). */
  bare?: boolean;
  onFocus?: () => void;
  ref?: (r: InputRef) => void;
  class?: string;
  testID?: string;
  accessibilityLabel?: string;
}

export function TextField(props: TextFieldProps) {
  return (
    <Input
      ref={props.ref}
      value={props.value}
      onChange={(e) => props.onChange(e.value)}
      onSubmit={() => props.onSubmit?.()}
      onFocus={() => props.onFocus?.()}
      submitBehavior="submit"
      placeholder={props.placeholder}
      masked={props.masked}
      autoFocus={props.autoFocus}
      autoComplete={props.autoComplete}
      autoCapitalize={props.verbatim ? "none" : undefined}
      autoCorrect={props.verbatim ? false : undefined}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      class={
        props.bare
          ? `h-8 bg-transparent text-sm text-foreground placeholder:text-muted-foreground ${props.class ?? ""}`
          : `${props.size === "sm" ? "h-8 text-xs" : "h-9 text-sm"} rounded-(--radius) border bg-background px-3 text-foreground placeholder:text-muted-foreground focus:border-ring ${
              props.invalid ? "border-destructive" : "border-input"
            } ${props.mono ? "font-mono" : ""} ${props.class ?? ""}`
      }
    />
  );
}

export function Field(props: { label: string; description?: string; error?: string | null; children: JSX.Element; class?: string }) {
  return (
    <View class={`gap-1.5 ${props.class ?? ""}`}>
      <Text class="text-xs font-medium text-foreground">{props.label}</Text>
      {props.children}
      <If when={props.error}>{(e) => <Text class="text-xs text-destructive">{e()}</Text>}</If>
      <If when={!props.error && props.description}>
        <Text class="text-xs text-muted-foreground">{props.description}</Text>
      </If>
    </View>
  );
}
