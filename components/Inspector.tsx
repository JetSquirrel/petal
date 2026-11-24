/**
 * The inspector: what is selected, its properties, and what to do with it. For a node, its relationships
 * by type and direction, each one press away from the scene.
 */
import { Clipboard, colorScheme, resource, Scroll, signal, Text, View } from "nsh";
import { nodeCaption, valueKind, valueText, type DbNode, type DbRel, type Value } from "../graph/model";
import { useStore } from "../store/app";
import { fitSelection } from "../store/graphSelection";
import { paletteColor } from "../store/perspective";
import { Badge, Button, Chip, Field, Icon, IconButton, Row, SectionTitle, Separator, Spinner, Swatch, TextField } from "../ui";

export function Inspector() {
  const store = useStore();
  return (
    <View class="w-80 border-l border-sidebar-border bg-sidebar" testID="inspector">
      <If when={store.selectedNodes().length > 1 ? null : store.selectedNode()}>{(n) => <NodeDetails node={n()} />}</If>
      <If when={store.selectedNodes().length > 1}>
        <SelectionDetails />
      </If>
      <If when={store.selectedRel()}>{(r) => <RelDetails rel={r()} />}</If>
    </View>
  );
}

/** The most selected nodes the list shows; the actions still take them all. */
const LIST_MAX = 100;

/** Several nodes selected: what to do with all of them, and the list, each one press from being the only one. */
function SelectionDetails() {
  const store = useStore();
  const pinTick = signal(0);
  const nodes = () => store.selectedNodes();
  const ids = () => nodes().map((n) => n.id);
  const allPinned = () => (pinTick(), ids().every((id) => store.graph.isPinned(id)));
  const caption = (n: DbNode) => nodeCaption(n, store.perspective.style(store.perspective.categoryOf(n)).caption);
  const color = (n: DbNode) => paletteColor(store.perspective.style(store.perspective.categoryOf(n)).color, colorScheme());

  return (
    <Scroll class="flex-1">
      <View class="gap-4 p-4">
        <View class="flex-row items-center gap-2">
          <Text class="flex-1 text-base font-semibold text-sidebar-foreground" testID="inspector-title">
            {`${nodes().length} nodes selected`}
          </Text>
          <IconButton size="sm" icon="x" label="Clear the selection" onPress={() => store.graph.clearSelection()} testID="inspector-close" />
        </View>

        <View class="flex-row flex-wrap gap-1.5">
          <Button size="sm" variant="primary" icon="expand" label="Expand all" onPress={() => store.expand(ids())} testID="expand" />
          <Button size="sm" icon="focus" label="Focus" onPress={() => store.dismissOthers(ids())} testID="focus" />
          <IconButton size="sm" variant="secondary" icon="fit" label="Fit to the selection" onPress={() => fitSelection(store.graph)} testID="fit-selection" />
          <IconButton
            size="sm"
            variant="secondary"
            icon="pin"
            label={allPinned() ? "Unpin all" : "Pin all"}
            selected={allPinned()}
            onPress={() => {
              const pin = !allPinned();
              for (const id of ids()) store.graph.setPinned(id, pin);
              pinTick.update((t) => t + 1);
            }}
            testID="pin"
          />
          <IconButton size="sm" variant="secondary" icon="trash" label="Dismiss all" onPress={() => store.dismiss(ids())} testID="dismiss" />
        </View>

        <ExpandFilters ids={ids()} labels={[...new Set(nodes().flatMap((n) => n.labels))]} hood={[]} />

        <Separator />

        <View class="gap-1">
          <SectionTitle title="Selected" detail={nodes().length > LIST_MAX ? `first ${LIST_MAX} of ${nodes().length}` : undefined} />
          <Each of={nodes().slice(0, LIST_MAX)}>
            {(n) => (
              <Row onPress={() => store.graph.select(n().id, { center: true })} accessibilityLabel={`Select only ${caption(n())}`}>
                <Swatch color={color(n())} size={10} />
                <Text class="flex-1 text-sm text-sidebar-foreground line-clamp-1">{caption(n())}</Text>
              </Row>
            )}
          </Each>
        </View>
        <Text class="text-xs text-muted-foreground">Shift-click a node to add or remove it, or Shift-drag on the canvas to select with a box.</Text>
      </View>
    </Scroll>
  );
}

function NodeDetails(props: { node: DbNode }) {
  const store = useStore();
  const pinTick = signal(0);
  const category = () => store.perspective.categoryOf(props.node);
  const color = () => paletteColor(store.perspective.style(category()).color, colorScheme());
  const pinned = () => (pinTick(), store.graph.isPinned(props.node.id));
  const hood = resource(
    () => props.node.id,
    (id) => store.source().neighborhood(id),
  );
  const inScene = () => {
    // Relationships of this node already in the scene, by type and direction.
    const m = new Map<string, number>();
    for (const r of store.scene.rels().values()) {
      if (r.start === props.node.id) m.set(`${r.type}|out`, (m.get(`${r.type}|out`) ?? 0) + 1);
      if (r.end === props.node.id && r.start !== r.end) m.set(`${r.type}|in`, (m.get(`${r.type}|in`) ?? 0) + 1);
    }
    return m;
  };

  return (
    <Scroll class="flex-1">
      <View class="gap-4 p-4">
        <View class="gap-2">
          <View class="flex-row items-start gap-2">
            <View class="pt-1.5">
              <Swatch color={color()} size={12} />
            </View>
            <Text class="flex-1 text-base font-semibold text-sidebar-foreground" testID="inspector-title">
              {nodeCaption(props.node, store.perspective.style(category()).caption)}
            </Text>
            <IconButton size="sm" icon="x" label="Close" onPress={() => store.graph.clearSelection()} testID="inspector-close" />
          </View>
          <View class="flex-row flex-wrap gap-1">
            <Each of={props.node.labels}>{(l) => <Badge text={l()} dot={paletteColor(store.perspective.style(l()).color, colorScheme())} />}</Each>
          </View>
        </View>

        <View class="flex-row flex-wrap gap-1.5">
          <Button size="sm" variant="primary" icon="expand" label="Expand" onPress={() => store.expand([props.node.id])} testID="expand" />
          <Button size="sm" icon="focus" label="Focus" onPress={() => store.dismissOthers([props.node.id])} testID="focus" />
          <IconButton
            size="sm"
            variant="secondary"
            icon="pin"
            label={pinned() ? "Unpin" : "Pin"}
            selected={pinned()}
            onPress={() => {
              store.graph.setPinned(props.node.id, !pinned());
              pinTick.update((t) => t + 1);
            }}
            testID="pin"
          />
          <IconButton size="sm" variant="secondary" icon="trash" label="Dismiss" onPress={() => store.dismiss([props.node.id])} testID="dismiss" />
        </View>

        <Separator />

        <View class="gap-1">
          <SectionTitle title="Relationships" action={hood.loading() ? <Spinner size={12} /> : undefined} />
          <If when={hood.error() !== undefined}>
            <Text class="text-xs text-destructive">Couldn't read this node's relationships.</Text>
          </If>
          <If when={hood() && hood()!.length === 0}>
            <Text class="text-xs text-muted-foreground">No relationships.</Text>
          </If>
          <Each of={hood() ?? []} key={(e) => `${e.type}|${e.direction}`}>
            {(e) => {
              const shown = () => inScene().get(`${e().type}|${e().direction}`) ?? 0;
              return (
                <Row
                  onPress={() => store.expand([props.node.id], { type: e().type, direction: e().direction })}
                  accessibilityLabel={`Expand ${e().direction === "out" ? "outgoing" : "incoming"} ${e().type}`}
                  testID={`expand-${e().type}-${e().direction}`}
                >
                  <Icon name={e().direction === "out" ? "arrowOut" : "arrowIn"} size={14} tone="muted-foreground" />
                  <Text class="flex-1 font-mono text-xs text-sidebar-foreground line-clamp-1">
                    {e().type}
                  </Text>
                  <Text class="text-xs text-muted-foreground tabular-nums">{shown() ? `${shown()} of ${e().count}` : String(e().count)}</Text>
                </Row>
              );
            }}
          </Each>
        </View>

        <ExpandFilters ids={[props.node.id]} labels={props.node.labels} hood={hood() ?? []} />

        <Separator />
        <Properties properties={props.node.properties} id={props.node.id} />
      </View>
    </Scroll>
  );
}

/** The most labels the neighbor filter offers as choices. */
const LABEL_CHOICES = 16;

/**
 * Expand with filters, as Graph Explorer's expand panel: one relationship type and direction, neighbors of one
 * label, neighbors with a property containing some words, and how many at most. Folded until opened.
 */
function ExpandFilters(props: { ids: string[]; labels: string[]; hood: { type: string; direction: "out" | "in"; count: number }[] }) {
  const store = useStore();
  const open = signal(false);
  /** `type|direction`, or "" for any. */
  const rel = signal("");
  const label = signal("");
  const text = signal("");
  const limit = signal(String(store.settings().limit));

  const parsedLimit = () => {
    const n = Number(limit().trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  /** Labels a neighbor across the chosen relationship can have, as the schema says; every label when it can't tell. */
  const labelChoices = () => {
    const s = store.schema();
    const [type, direction] = rel() ? rel().split("|") : [undefined, undefined];
    const mine = new Set(props.labels);
    const out = new Set<string>();
    for (const p of s.patterns) {
      if (type && p.type !== type) continue;
      if (direction !== "in" && mine.has(p.from)) out.add(p.to);
      if (direction !== "out" && mine.has(p.to)) out.add(p.from);
    }
    const list = out.size ? [...out] : s.labels.map((l) => l.name);
    return list.slice(0, LABEL_CHOICES);
  };
  const run = () => {
    const n = parsedLimit();
    if (n === null) return;
    const [type, direction] = rel() ? (rel().split("|") as [string, "out" | "in"]) : [undefined, undefined];
    store.expand(props.ids, { type, direction, label: label() || undefined, text: text(), limit: n });
  };
  const color = (l: string) => paletteColor(store.perspective.style(l).color, colorScheme());

  return (
    <View class="gap-2">
      <Row onPress={() => open.update((o) => !o)} accessibilityLabel="Expand with filters" testID="expand-filters-toggle" class="-mx-2">
        <Icon name={open() ? "chevronDown" : "chevronRight"} size={14} tone="muted-foreground" />
        <Text class="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Expand with filters</Text>
        <Icon name="sliders" size={14} tone="muted-foreground" />
      </Row>
      <If when={open()}>
        <View class="gap-3" testID="expand-filters">
          <If when={props.hood.length > 0}>
            <View class="gap-1.5">
              <Text class="text-xs font-medium text-sidebar-foreground">Relationship</Text>
              <View role="radiogroup" accessibilityLabel="Relationship" class="flex-row flex-wrap gap-1">
                <Chip label="Any" selected={rel() === ""} onPress={() => rel.set("")} testID="filter-rel-any" />
                <Each of={props.hood} key={(e) => `${e.type}|${e.direction}`}>
                  {(e) => (
                    <Chip
                      label={`${e().direction === "out" ? "→" : "←"} ${e().type}`}
                      accessibilityLabel={`${e().direction === "out" ? "Outgoing" : "Incoming"} ${e().type}`}
                      selected={rel() === `${e().type}|${e().direction}`}
                      onPress={() => rel.set(`${e().type}|${e().direction}`)}
                      testID={`filter-rel-${e().type}-${e().direction}`}
                    />
                  )}
                </Each>
              </View>
            </View>
          </If>
          <View class="gap-1.5">
            <Text class="text-xs font-medium text-sidebar-foreground">Neighbor label</Text>
            <View role="radiogroup" accessibilityLabel="Neighbor label" class="flex-row flex-wrap gap-1">
              <Chip label="Any" selected={label() === ""} onPress={() => label.set("")} testID="filter-label-any" />
              <Each of={labelChoices()}>
                {(l) => <Chip label={l()} dot={color(l())} selected={label() === l()} onPress={() => label.set(l())} testID={`filter-label-${l()}`} />}
              </Each>
            </View>
          </View>
          <Field label="Property contains">
            <TextField size="sm" value={text()} onChange={(v) => text.set(v)} onSubmit={run} placeholder="Any words" testID="filter-text" />
          </Field>
          <Field label="At most" error={parsedLimit() === null ? "Enter a whole number above 0." : null}>
            <TextField size="sm" value={limit()} onChange={(v) => limit.set(v)} onSubmit={run} invalid={parsedLimit() === null} verbatim testID="filter-limit" />
          </Field>
          <Button size="sm" variant="primary" icon="expand" label="Expand" class="self-start" disabled={parsedLimit() === null} onPress={run} testID="filter-expand" />
        </View>
      </If>
    </View>
  );
}

function RelDetails(props: { rel: DbRel }) {
  const store = useStore();
  const end = (id: string) => {
    const n = store.scene.nodes().get(id);
    return n ? nodeCaption(n, store.perspective.style(store.perspective.categoryOf(n)).caption) : id;
  };
  return (
    <Scroll class="flex-1">
      <View class="gap-4 p-4">
        <View class="flex-row items-center gap-2">
          <Text class="flex-1 font-mono text-sm font-semibold text-sidebar-foreground" testID="inspector-title">
            {props.rel.type}
          </Text>
          <IconButton size="sm" icon="x" label="Close" onPress={() => store.graph.clearSelection()} />
        </View>
        <View class="gap-1">
          <Row onPress={() => store.graph.select(props.rel.start, { center: true })} accessibilityLabel={`Select ${end(props.rel.start)}`}>
            <Text class="w-10 text-xs text-muted-foreground">From</Text>
            <Text class="flex-1 text-sm text-sidebar-foreground line-clamp-1">
              {end(props.rel.start)}
            </Text>
          </Row>
          <Row onPress={() => store.graph.select(props.rel.end, { center: true })} accessibilityLabel={`Select ${end(props.rel.end)}`}>
            <Text class="w-10 text-xs text-muted-foreground">To</Text>
            <Text class="flex-1 text-sm text-sidebar-foreground line-clamp-1">
              {end(props.rel.end)}
            </Text>
          </Row>
        </View>
        <Button
          size="sm"
          variant="secondary"
          icon="trash"
          label="Dismiss relationship"
          class="self-start"
          onPress={() => {
            store.graph.clearSelection();
            store.scene.dismissRel(props.rel.id);
          }}
        />
        <Separator />
        <Properties properties={props.rel.properties} id={props.rel.id} />
      </View>
    </Scroll>
  );
}

function Properties(props: { properties: Record<string, Value>; id: string }) {
  const store = useStore();
  const entries = () => Object.entries(props.properties).sort(([a], [b]) => a.localeCompare(b));
  const copy = async () => {
    const plain: Record<string, string> = {};
    for (const [k, v] of entries()) plain[k] = valueText(v);
    try {
      await Clipboard.writeText(JSON.stringify(plain, null, 2));
      store.notify("Copied the properties.");
    } catch {
      store.notify("Couldn't copy to the clipboard.", "error");
    }
  };
  return (
    <View class="gap-2">
      <SectionTitle
        title="Properties"
        detail={String(entries().length)}
        action={<IconButton size="sm" icon="copy" label="Copy as JSON" onPress={copy} testID="copy-properties" />}
      />
      <If when={entries().length === 0}>
        <Text class="text-xs text-muted-foreground">No properties.</Text>
      </If>
      <Each of={entries()} key={([k]) => k}>
        {(entry) => (
          <View class="gap-0.5">
            <View class="flex-row items-baseline justify-between gap-2">
              <Text class="text-xs font-medium text-muted-foreground line-clamp-1">
                {entry()[0]}
              </Text>
              <Text class="text-xs text-muted-foreground/70">{valueKind(entry()[1])}</Text>
            </View>
            <Text class="text-sm text-sidebar-foreground select-text">
              {valueText(entry()[1])}
            </Text>
          </View>
        )}
      </Each>
      <View class="gap-0.5 pt-1">
        <Text class="text-xs font-medium text-muted-foreground">Element ID</Text>
        <Text class="font-mono text-xs text-muted-foreground select-text">
          {props.id}
        </Text>
      </View>
    </View>
  );
}
