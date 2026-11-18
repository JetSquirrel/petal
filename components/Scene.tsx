/**
 * The scene: the canvas, with the toolbar floating under it, the notice above it, and the starting
 * suggestions while it is empty. Double-click a node to expand it; right-click for its actions.
 */
import { colorScheme, computed, platform, Text, View } from "nsh";
import { isAvailable as desktopMenus, Menu, type MenuItem } from "nsh/desktop";
import { GraphView, type HitTarget, type LayoutKind } from "nsh-graph";
import type { DbNode, DbRel } from "../graph/model";
import { useStore } from "../store/app";
import { sceneGraphData } from "../store/sceneGraph";
import { Button, Icon, IconButton, PetalMark, Segmented, Separator, Spinner, Surface } from "../ui";

const LAYOUTS: { value: LayoutKind; label: string }[] = [
  { value: "force", label: "Force" },
  { value: "hierarchical", label: "Tree" },
  { value: "circular", label: "Circle" },
  { value: "grid", label: "Grid" },
];

export function Scene() {
  const store = useStore();
  const data = computed(() => sceneGraphData(store.scene.nodes(), store.scene.rels(), store.perspective, colorScheme()));
  const empty = () => store.scene.nodes().size === 0;

  const onContextMenu = (target: HitTarget<DbNode, DbRel>, e: { pagePosition: { x: number; y: number } }) => {
    if (!desktopMenus) return;
    Menu.popup(contextItems(store, target), e.pagePosition);
  };

  return (
    <View class="relative flex-1 bg-background">
      <GraphView<DbNode, DbRel>
        data={data()}
        controller={store.graph}
        layout={store.settings().layout}
        labelMode={store.settings().labelMode}
        edgeLabels={store.settings().edgeLabels}
        onNodeActivate={(node) => store.expand([node.id])}
        onContextMenu={onContextMenu}
        accessibilityLabel="Scene"
        testID="scene"
        style={{ flex: 1 }}
      />

      <If when={empty()}>
        <EmptyScene />
      </If>

      <View class="absolute left-0 right-0 top-3 items-center" style={{ pointerEvents: "box-none" }}>
        <Notice />
      </View>

      <View class="absolute bottom-4 left-0 right-0 items-center" style={{ pointerEvents: "box-none" }}>
        <SceneToolbar />
      </View>

      <View class="absolute left-4 top-3 pointer-events-none">
        <Text class="text-xs text-muted-foreground tabular-nums" testID="scene-stats">
          {`${data().nodes.length} ${data().nodes.length === 1 ? "node" : "nodes"} · ${data().edges.length} ${
            data().edges.length === 1 ? "relationship" : "relationships"
          }`}
        </Text>
      </View>
    </View>
  );
}

function SceneToolbar() {
  const store = useStore();
  const s = () => store.settings();
  return (
    <Surface class="flex-row items-center gap-1 p-1" testID="toolbar">
      <IconButton icon="zoomOut" label="Zoom out" onPress={() => store.graph.zoomOut()} testID="zoom-out" />
      <Text class="w-11 text-center text-xs text-muted-foreground tabular-nums" testID="zoom">
        {`${Math.round(store.graph.zoom() * 100)}%`}
      </Text>
      <IconButton icon="zoomIn" label="Zoom in" onPress={() => store.graph.zoomIn()} testID="zoom-in" />
      <IconButton icon="fit" label="Fit to the scene" onPress={() => store.graph.fit()} testID="fit" />
      <Separator vertical class="mx-1 my-1.5" />
      <Segmented label="Layout" value={s().layout} options={LAYOUTS} onChange={(layout) => store.updateSettings({ layout })} testID="layout" />
      <IconButton icon="relayout" label="Lay out again" onPress={() => store.graph.relayout()} testID="relayout" />
      <IconButton
        icon="tag"
        label={s().edgeLabels ? "Hide relationship types" : "Show relationship types"}
        selected={s().edgeLabels}
        onPress={() => store.updateSettings({ edgeLabels: !s().edgeLabels })}
        testID="edge-labels"
      />
      <Separator vertical class="mx-1 my-1.5" />
      <IconButton icon="undo" label="Undo" shortcut={shortcutText("Z")} disabled={!store.scene.canUndo()} onPress={() => store.undo()} testID="undo" />
      <IconButton icon="trash" label="Clear the scene" disabled={store.scene.nodes().size === 0} onPress={() => store.clearScene()} testID="clear" />
    </Surface>
  );
}

function Notice() {
  const store = useStore();
  return (
    <If when={store.notice()}>
      {(n) => (
        <Surface class="max-w-[560px] flex-row items-center gap-2 px-3 py-2" testID="notice">
          <Icon name={n().tone === "error" ? "alert" : "check"} size={14} tone={n().tone === "error" ? "destructive" : "success"} />
          <Text class={`text-sm ${n().tone === "error" ? "text-destructive" : "text-card-foreground"}`} testID="notice-text">
            {n().text}
          </Text>
          <IconButton size="sm" icon="x" label="Dismiss the notice" onPress={() => store.notice.set(null)} />
        </Surface>
      )}
    </If>
  );
}

function EmptyScene() {
  const store = useStore();
  const examples = computed(() => {
    const s = store.schema();
    const out: string[] = s.labels.slice(0, 3).map((l) => l.name);
    for (const p of s.patterns.slice(0, 2)) out.push(`${p.from} ${p.type} ${p.to}`);
    return out;
  });
  return (
    <View class="absolute inset-0 items-center justify-center p-6" style={{ pointerEvents: "box-none" }}>
      <View class="max-w-[460px] items-center gap-4" testID="empty">
        <PetalMark size={44} />
        <If when={store.connection() === "connecting"}>
          <View class="flex-row items-center gap-2">
            <Spinner />
            <Text class="text-sm text-muted-foreground">Reading the database's schema…</Text>
          </View>
        </If>
        <If when={store.connection() === "error"}>
          <View class="items-center gap-3">
            <Text class="text-base font-semibold text-foreground">Couldn't read the database</Text>
            <Text class="text-center text-sm text-muted-foreground">{store.connectionError()}</Text>
            <View class="flex-row gap-2">
              <Button variant="outline" label="Try again" onPress={() => store.use(store.source())} />
              <Button variant="primary" label="Connect…" onPress={() => store.connectOpen.set(true)} />
            </View>
          </View>
        </If>
        <If when={store.connection() === "ready"}>
          <View class="items-center gap-1.5">
            <Text class="text-lg font-semibold text-foreground">Explore your graph, one connection at a time</Text>
            <Text class="text-center text-sm text-muted-foreground">
              Search for a category, a pattern such as “Person WORKS_AT Company”, or any words. Double-click a node to bring in its
              neighbors.
            </Text>
          </View>
          <View class="flex-row flex-wrap justify-center gap-2">
            <Each of={examples()}>
              {(phrase) => (
                <Button
                  size="sm"
                  variant="outline"
                  icon="search"
                  label={phrase()}
                  onPress={() => {
                    const words = phrase().split(" ");
                    const spec =
                      words.length === 3
                        ? { kind: "pattern" as const, nodes: [{ label: words[0] }, { label: words[2] }], rels: [{ type: words[1] }] }
                        : { kind: "pattern" as const, nodes: [{ label: phrase() }], rels: [] };
                    store.search(spec, phrase());
                  }}
                  testID={`example-${phrase()}`}
                />
              )}
            </Each>
          </View>
          <If when={store.source().kind === "demo"}>
            <Text class="text-center text-xs text-muted-foreground">
              This is Petal's demo graph, a fictional open-source ecosystem. Connect to your own Neo4j, NebulaGraph or HawDB database from the top right.
            </Text>
          </If>
        </If>
      </View>
    </View>
  );
}

export function shortcutText(key: string): string {
  return platform.os === "macos" || platform.os === "ios" ? `⌘${key}` : `Ctrl+${key}`;
}

function contextItems(store: ReturnType<typeof useStore>, target: HitTarget<DbNode, DbRel>): MenuItem[] {
  if (target.kind === "node") {
    const id = target.node.id;
    // A menu over one of several selected nodes acts on them all (nsh-graph kept them selected).
    const ids = store.graph.selectedIds();
    if (ids.length > 1 && ids.includes(id)) {
      const pinned = ids.every((i) => store.graph.isPinned(i));
      const n = ids.length;
      return [
        { label: `Expand ${n} nodes`, onSelect: () => store.expand(ids) },
        { label: `Focus on these ${n} nodes`, onSelect: () => store.dismissOthers(ids) },
        { type: "separator" },
        { label: pinned ? `Unpin ${n} nodes` : `Pin ${n} nodes`, onSelect: () => ids.forEach((i) => store.graph.setPinned(i, !pinned)) },
        { label: "Fit to the selection", onSelect: () => store.graph.fitSelection() },
        { type: "separator" },
        { label: `Dismiss ${n} nodes`, onSelect: () => store.dismiss(ids) },
      ];
    }
    const pinned = store.graph.isPinned(id);
    return [
      { label: "Expand", onSelect: () => store.expand([id]) },
      { label: "Focus on this node", onSelect: () => store.dismissOthers([id]) },
      { type: "separator" },
      { label: pinned ? "Unpin" : "Pin", onSelect: () => store.graph.setPinned(id, !pinned) },
      { label: "Center", onSelect: () => store.graph.select(id, { center: true }) },
      { type: "separator" },
      { label: "Dismiss", onSelect: () => store.dismiss([id]) },
    ];
  }
  if (target.kind === "edge") {
    const rel = target.edge.data;
    return [
      { label: "Select start node", onSelect: () => rel && store.graph.select(rel.start, { center: true }) },
      { label: "Select end node", onSelect: () => rel && store.graph.select(rel.end, { center: true }) },
      { type: "separator" },
      { label: "Dismiss relationship", onSelect: () => rel && store.scene.dismissRel(rel.id) },
    ];
  }
  return [
    { label: "Fit to the scene", onSelect: () => store.graph.fit() },
    { label: "Lay out again", onSelect: () => store.graph.relayout() },
    { label: "Select all nodes", onSelect: () => store.graph.selectAll() },
    { label: "Unpin all", onSelect: () => store.graph.unpinAll() },
    { type: "separator" },
    { label: "Undo", disabled: !store.scene.canUndo(), onSelect: () => store.undo() },
    { label: "Clear the scene", disabled: store.scene.nodes().size === 0, onSelect: () => store.clearScene() },
  ];
}
