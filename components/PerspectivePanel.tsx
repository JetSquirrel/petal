/**
 * The perspective panel: the database's categories and relationship types, how many of each the scene
 * holds, and their look. Press a category to restyle it; the eye hides it from the canvas without
 * taking it out of the scene.
 */
import { computed, Scroll, Text, View, colorScheme } from "nsh";
import { useStore } from "../store/app";
import { paletteColor, PALETTE_SIZE, type SizeChoice } from "../store/perspective";
import { sceneCounts } from "../store/sceneGraph";
import { Button, Icon, IconButton, Popover, Row, SectionTitle, Segmented, Separator, Swatch } from "../ui";

const fmt = (n: number | undefined) => (n === undefined ? "" : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());

export function PerspectivePanel() {
  const store = useStore();
  const counts = computed(() => sceneCounts(store.scene.nodes(), store.scene.rels(), store.perspective));

  const categories = computed(() => {
    const schemaLabels = store.schema().labels;
    const names = new Set(schemaLabels.map((l) => l.name));
    const extra = store.perspective
      .state()
      .order.filter((l) => !names.has(l) && counts().categories.has(l))
      .map((name) => ({ name, count: undefined as number | undefined }));
    return [...schemaLabels, ...extra];
  });

  const types = computed(() => {
    const known = store.schema().relTypes;
    const names = new Set(known.map((t) => t.name));
    const extra = [...counts().types.keys()].filter((t) => !names.has(t)).map((name) => ({ name, count: undefined as number | undefined }));
    return [...known, ...extra];
  });

  return (
    <View class="w-64 border-r border-sidebar-border bg-sidebar" testID="perspective">
      <Scroll class="flex-1">
        <View class="gap-4 p-3">
        <View class="gap-1">
          <SectionTitle title="Categories" detail={categories().length ? String(categories().length) : undefined} />
          <If when={categories().length === 0}>
            <Text class="px-2 text-xs text-muted-foreground">{store.connection() === "connecting" ? "Reading the schema…" : "No labels in this database."}</Text>
          </If>
          <Each of={categories()} key={(c) => c.name}>
            {(c) => <CategoryRow name={c().name} total={c().count} inScene={counts().categories.get(c().name) ?? 0} />}
          </Each>
        </View>

        <View class="gap-1">
          <SectionTitle title="Relationships" detail={types().length ? String(types().length) : undefined} />
          <Each of={types()} key={(t) => t.name}>
            {(t) => {
              const hidden = () => store.perspective.state().hiddenTypes.includes(t().name);
              const inScene = () => counts().types.get(t().name) ?? 0;
              return (
                <View class="min-h-8 flex-row items-center gap-2 pl-2">
                  <Text
                    class={`flex-1 font-mono text-xs ${hidden() ? "text-muted-foreground line-through" : "text-sidebar-foreground"} line-clamp-1`}
                  >
                    {t().name}
                  </Text>
                  <Text class="text-xs text-muted-foreground tabular-nums">{inScene() ? `${inScene()} / ${fmt(t().count)}` : fmt(t().count)}</Text>
                  <IconButton
                    size="sm"
                    icon={hidden() ? "eyeOff" : "eye"}
                    label={hidden() ? `Show ${t().name}` : `Hide ${t().name}`}
                    onPress={() => store.perspective.toggleType(t().name)}
                    testID={`type-eye-${t().name}`}
                  />
                </View>
              );
            }}
          </Each>
        </View>

        <Separator />
        <Button
          size="sm"
          variant="ghost"
          icon="relayout"
          label="Reset styles"
          onPress={() => store.perspective.resetStyles()}
          class="self-start"
        />
        </View>
      </Scroll>
    </View>
  );
}

function CategoryRow(props: { name: string; total?: number; inScene: number }) {
  const store = useStore();
  const style = () => store.perspective.style(props.name);
  const color = () => paletteColor(style().color, colorScheme());
  return (
    <View class="flex-row items-center gap-0.5">
      <Popover
        testID={`category-${props.name}`}
        trigger={
          <Row class="flex-1" accessibilityLabel={`${props.name}: style`}>
            <Swatch color={color()} size={12} />
            <Text class={`flex-1 text-sm ${style().hidden ? "text-muted-foreground line-through" : "text-sidebar-foreground"} line-clamp-1`}>
              {props.name}
            </Text>
            <Text class="text-xs text-muted-foreground tabular-nums">
              {props.inScene ? `${props.inScene} / ${fmt(props.total)}` : fmt(props.total)}
            </Text>
          </Row>
        }
      >
        <CategoryEditor name={props.name} />
      </Popover>
      <IconButton
        size="sm"
        icon="plus"
        label={`Add ${props.name} nodes`}
        onPress={() => store.search({ kind: "pattern", nodes: [{ label: props.name }], rels: [] }, props.name)}
        testID={`category-add-${props.name}`}
      />
      <IconButton
        size="sm"
        icon={style().hidden ? "eyeOff" : "eye"}
        label={style().hidden ? `Show ${props.name}` : `Hide ${props.name}`}
        onPress={() => store.perspective.setStyle(props.name, { hidden: !style().hidden })}
        testID={`category-eye-${props.name}`}
      />
    </View>
  );
}

const SIZES: { value: SizeChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "small", label: "S" },
  { value: "medium", label: "M" },
  { value: "large", label: "L" },
];

function CategoryEditor(props: { name: string }) {
  const store = useStore();
  const style = () => store.perspective.style(props.name);
  /** The property keys of this category's nodes in the scene, most common first. */
  const keys = computed(() => {
    const seen = new Map<string, number>();
    for (const n of store.scene.nodes().values()) {
      if (store.perspective.categoryOf(n) !== props.name) continue;
      for (const k of Object.keys(n.properties)) seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    return [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k).slice(0, 12);
  });
  const slots = [...Array(PALETTE_SIZE).keys(), -1];

  return (
    <>
      <View class="flex-row items-center gap-2">
        <Icon name="tag" size={14} tone="muted-foreground" />
        <Text class="text-sm font-semibold text-popover-foreground">{props.name}</Text>
      </View>

      <View class="gap-1.5">
        <Text class="text-xs font-medium text-muted-foreground">Color</Text>
        <View class="flex-row flex-wrap gap-1.5" role="radiogroup" accessibilityLabel="Color">
          <Each of={slots}>
            {(slot) => (
              <View
                role="radio"
                accessibilityLabel={slot() < 0 ? "Neutral" : `Color ${slot() + 1}`}
                accessibilityState={{ selected: style().color === slot() }}
                onPress={() => store.perspective.setStyle(props.name, { color: slot() })}
                testID={`swatch-${slot()}`}
                class="h-7 w-7 items-center justify-center rounded-full hover:bg-accent"
              >
                <Swatch color={paletteColor(slot(), colorScheme())} size={18} ring={style().color === slot()} />
              </View>
            )}
          </Each>
        </View>
      </View>

      <View class="gap-1.5">
        <Text class="text-xs font-medium text-muted-foreground">Size</Text>
        <Segmented
          label="Size"
          value={style().size}
          options={SIZES}
          onChange={(size) => store.perspective.setStyle(props.name, { size })}
          testID="size"
        />
      </View>

      <View class="gap-1.5">
        <Text class="text-xs font-medium text-muted-foreground">Caption</Text>
        <If when={keys().length > 0} else={<Text class="text-xs text-muted-foreground">Add {props.name} nodes to the scene to pick a caption.</Text>}>
          <View class="flex-row flex-wrap gap-1">
            <Button
              size="sm"
              variant="outline"
              label="Auto"
              selected={!style().caption}
              onPress={() => store.perspective.setStyle(props.name, { caption: undefined })}
            />
            <Each of={keys()}>
              {(k) => (
                <Button
                  size="sm"
                  variant="outline"
                  label={k()}
                  selected={style().caption === k()}
                  onPress={() => store.perspective.setStyle(props.name, { caption: k() })}
                  testID={`caption-${k()}`}
                />
              )}
            </Each>
          </View>
        </If>
      </View>
    </>
  );
}
