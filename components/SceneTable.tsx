/**
 * The scene as a table, under the canvas (Graph Explorer's table view): its nodes or its relationships, one
 * row each, filtered by words and sorted by a column. A press selects the row's node or relationship on the
 * canvas; the table's rows go to the clipboard as CSV or JSON.
 */
import { computed, signal, Text, View } from "nsh";
import { fileStamp } from "../store/files";
import { DataTable, type DataTableColumn } from "nsh/base";
import type { DbNode, DbRel } from "../graph/model";
import { useStore } from "../store/app";
import {
  filterNodeRows,
  filterRelRows,
  nodeRows,
  nodesCsv,
  nodesJson,
  relRows,
  relsCsv,
  relsJson,
  sortRows,
  type SortBy,
  type TableKind,
  type TableLens,
} from "../store/sceneTable";
import { Button, IconButton, Segmented, TextField } from "../ui";

const TABLE_CLASSES = { headerCell: "px-2.5", cell: "px-2.5" };

const NODE_COLUMNS: DataTableColumn[] = [
  { key: "caption", title: "Caption", width: 220, sortable: true },
  { key: "labels", title: "Labels", width: 160, sortable: true },
  { key: "degree", title: "Relationships", width: 132, sortable: true, align: "end" },
  { key: "shown", title: "Shown", width: 92, sortable: true },
  { key: "id", title: "ID", width: 200, sortable: true },
];

const REL_COLUMNS: DataTableColumn[] = [
  { key: "type", title: "Type", width: 160, sortable: true },
  { key: "from", title: "From", width: 200, sortable: true },
  { key: "to", title: "To", width: 200, sortable: true },
  { key: "shown", title: "Shown", width: 92, sortable: true },
  { key: "id", title: "ID", width: 200, sortable: true },
];

export function SceneTable() {
  const store = useStore();
  const kind = signal<TableKind>("nodes");
  const filter = signal("");
  const sort = signal<SortBy | null>(null);

  const lens: TableLens = {
    categoryOf: (n) => store.perspective.categoryOf(n),
    captionKey: (c) => store.perspective.style(c).caption,
    categoryHidden: (c) => store.perspective.style(c).hidden,
    typeHidden: (t) => store.perspective.state().hiddenTypes.includes(t),
  };

  // Reading the perspective's state makes captions and hidden flags follow its changes.
  const nodes = computed(() => (store.perspective.state(), nodeRows(store.scene.nodes(), store.scene.rels(), lens)));
  const rels = computed(() => (store.perspective.state(), relRows(store.scene.nodes(), store.scene.rels(), lens)));

  const shownNodes = computed(() =>
    sortRows(
      filterNodeRows(nodes(), store.scene.nodes(), filter()).map((r) => ({ ...r, shown: r.hidden ? "Hidden" : "Yes" })),
      kind() === "nodes" ? sort() : null,
    ),
  );
  const shownRels = computed(() =>
    sortRows(
      filterRelRows(rels(), store.scene.rels(), filter()).map((r) => ({ ...r, shown: r.hidden ? "Hidden" : "Yes" })),
      kind() === "rels" ? sort() : null,
    ),
  );

  const count = () => (kind() === "nodes" ? shownNodes().length : shownRels().length);
  const total = () => (kind() === "nodes" ? nodes().length : rels().length);

  /** The elements the table shows now, in its order: what Copy writes. */
  const elements = (): { nodes: DbNode[]; rels: DbRel[] } => {
    if (kind() === "nodes") return { nodes: shownNodes().map((r) => store.scene.nodes().get(r.id)!).filter(Boolean), rels: [] };
    return { nodes: [], rels: shownRels().map((r) => store.scene.rels().get(r.id)!).filter(Boolean) };
  };

  /** Writes the rows the table shows to a file in Downloads (the clipboard on the web). */
  const exportRows = (format: "csv" | "json") => {
    const e = elements();
    const text =
      kind() === "nodes" ? (format === "csv" ? nodesCsv(e.nodes) : nodesJson(e.nodes)) : format === "csv" ? relsCsv(e.rels) : relsJson(e.rels);
    const n = kind() === "nodes" ? e.nodes.length : e.rels.length;
    const what = kind() === "nodes" ? (n === 1 ? "node" : "nodes") : n === 1 ? "relationship" : "relationships";
    const file = `Petal ${kind() === "nodes" ? "nodes" : "relationships"} ${fileStamp()}.${format}`;
    return store.exportText(file, text, `${n} ${what} as ${format.toUpperCase()}`);
  };
  const exportLabel = (format: string) => (store.filesAvailable() ? `Export as ${format} to Downloads` : `Copy as ${format}`);

  const press = (row: number) => {
    if (kind() === "nodes") {
      const r = shownNodes()[row];
      if (r && !r.hidden) store.graph.select(r.id, { center: true });
      else if (r) store.notify("Its category is hidden. Show it from the perspective panel to select it.");
    } else {
      const r = shownRels()[row];
      if (r && !r.hidden) store.graph.selectEdge(r.id);
      else if (r) store.notify("It's hidden. Show its type and categories from the perspective panel to select it.");
    }
  };

  return (
    <View class="h-64 border-t border-border bg-background" testID="scene-table">
      <View class="flex-row items-center gap-2 px-3 py-2">
        <Segmented
          label="Table"
          value={kind()}
          options={[
            { value: "nodes", label: `Nodes ${nodes().length}` },
            { value: "rels", label: `Relationships ${rels().length}` },
          ]}
          onChange={(k) => {
            kind.set(k);
            sort.set(null);
          }}
          testID="table-kind"
        />
        <TextField
          size="sm"
          value={filter()}
          onChange={(v) => filter.set(v)}
          placeholder="Filter by any text or property"
          accessibilityLabel="Filter the table"
          class="max-w-[320px] flex-1"
          testID="table-filter"
        />
        <Text class="text-xs text-muted-foreground tabular-nums" testID="table-count">
          {filter().trim() ? `${count()} of ${total()}` : ""}
        </Text>
        <View class="flex-1" />
        <Button size="sm" variant="ghost" icon="download" label="CSV" accessibilityLabel={exportLabel("CSV")} disabled={count() === 0} onPress={() => exportRows("csv")} testID="table-export-csv" />
        <Button size="sm" variant="ghost" icon="download" label="JSON" accessibilityLabel={exportLabel("JSON")} disabled={count() === 0} onPress={() => exportRows("json")} testID="table-export-json" />
        <IconButton size="sm" icon="x" label="Close the table" onPress={() => store.updateSettings({ table: false })} testID="table-close" />
      </View>
      <If
        when={kind() === "nodes"}
        else={
          <DataTable
            columns={REL_COLUMNS}
            classes={TABLE_CLASSES}
            data={shownRels()}
            sort={kind() === "rels" ? sort() : null}
            onSortChange={(e) => sort.set(e.sort ? { key: e.sort.key, direction: e.sort.direction ?? "ascending" } : null)}
            onRowPress={(e) => press(e.row)}
            rowClasses={shownRels().map((r) => (r.hidden ? "opacity-50" : ""))}
            stripe
            columnSelectable={false}
            fontSize={13}
            rowHeight={28}
            accessibilityLabel="Relationships in the scene"
            testID="table-rels"
            style={{ flex: 1 }}
            empty={<Empty text={total() ? "No relationships match the filter." : "No relationships in the scene."} />}
          />
        }
      >
        <DataTable
          columns={NODE_COLUMNS}
          classes={TABLE_CLASSES}
          data={shownNodes()}
          sort={kind() === "nodes" ? sort() : null}
          onSortChange={(e) => sort.set(e.sort ? { key: e.sort.key, direction: e.sort.direction ?? "ascending" } : null)}
          onRowPress={(e) => press(e.row)}
          rowClasses={shownNodes().map((r) => (r.hidden ? "opacity-50" : ""))}
          stripe
          columnSelectable={false}
          fontSize={13}
          rowHeight={28}
          accessibilityLabel="Nodes in the scene"
          testID="table-nodes"
          style={{ flex: 1 }}
          empty={<Empty text={total() ? "No nodes match the filter." : "No nodes in the scene."} />}
        />
      </If>
    </View>
  );
}

function Empty(props: { text: string }) {
  return (
    <View class="flex-1 items-center justify-center p-6">
      <Text class="text-sm text-muted-foreground">{props.text}</Text>
    </View>
  );
}
