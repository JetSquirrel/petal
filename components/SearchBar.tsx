/**
 * The search field: type a phrase (a label, a pattern, words, or Cypher) and pick one of the readings
 * offered below it. Up and Down move through them, Enter runs the highlighted one, Escape closes them.
 */
import { computed, Overlay, signal, Text, View, type InputRef, type ViewRef } from "nsh";
import { parsePhrase, suggest, type Suggestion, type SuggestionPart } from "../graph/phrase";
import { useStore } from "../store/app";
import { paletteColor } from "../store/perspective";
import { Icon, Row, Spinner, Swatch, TextField, type IconName } from "../ui";

const KIND_ICON: Record<Suggestion["kind"], IconName> = {
  pattern: "link",
  label: "tag",
  text: "search",
  raw: "code",
  recent: "clock",
};

let searchInput: InputRef | undefined;

/** Puts the keyboard focus in the search field (⌘K / Ctrl+K). */
export function focusSearch() {
  searchInput?.focus();
}

export function SearchBar(props: { class?: string }) {
  const store = useStore();
  const text = signal("");
  const open = signal(false);
  const active = signal(0);
  let anchor: ViewRef | undefined;

  const suggestions = computed(() => suggest(text(), store.schema(), store.recent(), store.source().language));
  const highlighted = () => suggestions()[Math.min(active(), suggestions().length - 1)];

  const run = (s: Suggestion) => {
    text.set(s.phrase);
    open.set(false);
    searchInput?.blur();
    store.search(s.spec, s.phrase);
  };

  const submit = () => {
    const h = open() ? highlighted() : undefined;
    if (h) return run(h);
    const spec = parsePhrase(text(), store.schema(), store.source().language);
    if (!spec) return;
    if (spec.kind === "raw" && !store.source().language) {
      store.notify("Queries need a database. Connect to Neo4j, NebulaGraph or HawDB to run one.", "error");
      return;
    }
    open.set(false);
    searchInput?.blur();
    store.search(spec, text().trim());
  };

  const move = (by: number) => {
    const n = suggestions().length;
    if (!n) return;
    open.set(true);
    active.set((Math.min(active(), n - 1) + by + n) % n);
  };

  return (
    <View
      ref={(r) => (anchor = r)}
      class={`relative ${props.class ?? ""}`}
      captureKeys={["up", "down", "escape"]}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Escape") {
          if (open()) open.set(false);
          else searchInput?.blur();
        }
      }}
    >
      <View class="h-9 flex-row items-center gap-2 rounded-(--radius) border border-input bg-background pl-3 pr-2 focus-within:border-ring">
        <Icon name="search" size={16} tone="muted-foreground" />
        <TextField
          bare
          ref={(r) => (searchInput = r)}
          value={text()}
          onChange={(v) => {
            text.set(v);
            active.set(0);
            open.set(true);
          }}
          onSubmit={submit}
          onFocus={() => open.set(true)}
          verbatim
          testID="search"
          accessibilityLabel="Search the graph"
          placeholder={store.source().language ? `Search: a label, a pattern, words, or ${store.source().language}` : "Search: a label, a pattern, or words"}
          class="flex-1"
        />
        <If when={store.busy()}>
          <Spinner />
        </If>
        <If when={text() !== ""}>
          <View
            role="button"
            accessibilityLabel="Clear the search"
            testID="search-clear"
            onPress={() => {
              text.set("");
              searchInput?.focus();
            }}
            class="h-6 w-6 items-center justify-center rounded-md hover:bg-accent"
          >
            <Icon name="x" size={14} tone="muted-foreground" />
          </View>
        </If>
      </View>

      <If when={open() && suggestions().length > 0}>
        <Overlay
          anchor={anchor}
          placement="bottom"
          align="start"
          offset={6}
          margin={12}
          onPressOutside={() => open.set(false)}
          onCancel={() => open.set(false)}
          testID="suggestions"
          class="rounded-lg border border-border bg-popover p-1 shadow-lg"
          style={{ width: 560, maxWidth: "100%" }}
        >
          <If when={text().trim() === ""}>
            <Text class="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
              {store.recent().length ? "Recent searches and suggestions" : "Try one of these"}
            </Text>
          </If>
          <Each of={suggestions()} key={(s) => s.phrase + s.kind}>
            {(s, i) => (
              <Row
                selected={i() === Math.min(active(), suggestions().length - 1)}
                onPress={() => run(s())}
                testID={`suggestion-${i()}`}
                accessibilityLabel={s().parts.map((p) => p.text).join(" ")}
                class="min-h-9"
              >
                <Icon name={KIND_ICON[s().kind]} size={14} tone="muted-foreground" />
                <View class="flex-1 flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <Each of={s().parts} key="index">
                    {(p) => <Part part={p()} />}
                  </Each>
                </View>
                <If when={i() === Math.min(active(), suggestions().length - 1)}>
                  <Text class="text-xs text-muted-foreground">Enter</Text>
                </If>
              </Row>
            )}
          </Each>
        </Overlay>
      </If>
    </View>
  );
}

const PART_TEXT: Record<SuggestionPart["role"], string> = {
  label: "text-xs font-medium text-secondary-foreground",
  type: "font-mono text-xs font-medium text-foreground",
  arrow: "text-xs text-muted-foreground",
  text: "text-sm text-foreground",
  hint: "text-sm text-muted-foreground",
};

function Part(props: { part: SuggestionPart }) {
  const store = useStore();
  return (
    <If when={props.part.role === "label"} else={<Text class={PART_TEXT[props.part.role]}>{props.part.text}</Text>}>
      <View class="flex-row items-center gap-1 rounded-full bg-secondary px-2 py-0.5">
        <Swatch color={paletteColor(store.perspective.style(props.part.text).color)} size={8} />
        <Text class={PART_TEXT.label}>{props.part.text}</Text>
      </View>
    </If>
  );
}
