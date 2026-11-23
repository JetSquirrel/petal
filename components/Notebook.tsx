/**
 * Notebook mode: an editor at the top runs a query (or a search phrase), and each run becomes a frame below,
 * newest first. A frame shows its result as a graph, a table or the raw rows, says how long it took, and can
 * run again, be edited, bring its result into the scene, fold, or close. Ctrl/⌘ + Enter runs.
 */
import { colorScheme, computed, keymap, Scroll, signal, Text, View } from "nsh";
import { DataTable, Editor } from "nsh/base";
import { createGraphController, GraphView } from "nsh-graph";
import { nodeCaption, valueKind, valueText, type DbNode, type DbRel } from "../graph/model";
import type { QueryLanguage } from "../graph/source";
import { useStore } from "../store/app";
import { cellText, frameSummary, frameTable, tableRecords, type Frame, type FrameView } from "../store/notebook";
import { paletteColor } from "../store/perspective";
import { sceneGraphData } from "../store/sceneGraph";
import { Badge, Button, Icon, IconButton, Segmented, Spinner, Surface } from "../ui";
import { Notice } from "./Scene";

const VIEWS: { value: FrameView; label: string; icon: "graph" | "table" | "code" }[] = [
  { value: "graph", label: "Graph", icon: "graph" },
  { value: "table", label: "Table", icon: "table" },
  { value: "raw", label: "Raw", icon: "code" },
];

/** The rows the Raw view shows; past them it says how many more there are. */
const RAW_ROWS = 500;
const FRAME_HEIGHT = 380;

/** The editor's language name for a source's query language: its highlighting. */
function editorLanguage(language: QueryLanguage): string | null {
  if (language === "Cypher") return "cypher";
  if (language === "Gremlin") return "groovy";
  return null;
}

const runKeys = (e: { key: string; modifiers: { control: boolean; platform: boolean } }) => e.key === "Enter" && (e.modifiers.control || e.modifiers.platform);

export function Notebook() {
  const store = useStore();
  const nb = store.notebook;
  return (
    <View class="relative flex-1 bg-background" testID="notebook">
      <Scroll class="flex-1">
        <View class="w-full max-w-[1120px] gap-3 self-center p-4">
          <QueryEditor />
          <If when={nb.frames().length === 0}>
            <EmptyNotebook />
          </If>
          <Each of={nb.frames()} key={(f) => f.id}>
            {(f, i) => <FrameCard frame={f()} index={i()} />}
          </Each>
          <If when={nb.frames().length > 1}>
            <View class="items-center pb-2">
              <Button size="sm" variant="ghost" icon="trash" label="Clear the notebook" onPress={() => nb.clear()} testID="notebook-clear" />
            </View>
          </If>
        </View>
      </Scroll>
      <View class="absolute left-0 right-0 top-3 items-center" style={{ pointerEvents: "box-none" }}>
        <Notice />
      </View>
    </View>
  );
}

function QueryEditor() {
  const store = useStore();
  const nb = store.notebook;
  const language = () => store.source().language;
  const hint = () => (language() ? `A ${language()} query or a search phrase` : "A search phrase: a label, a pattern, or words");
  return (
    <Surface class="flex-row items-start gap-2 p-2" testID="notebook-editor">
      <Text class="pl-1 pt-[3px] font-mono text-sm text-muted-foreground">petal$</Text>
      <View
        class="flex-1"
        captureKeys={["mod+enter"]}
        onKeyDown={(e) => {
          if (runKeys(e)) nb.runDraft();
        }}
      >
        <Editor
          value={nb.draft()}
          onChange={(e) => nb.draft.set(e.value)}
          language={editorLanguage(language())}
          placeholder={hint()}
          lineNumbers={nb.draft().includes("\n")}
          folding={false}
          activeLine={false}
          indentGuides={false}
          minRows={1}
          maxRows={14}
          softWrap
          accessibilityLabel="Query"
          testID="notebook-input"
          class="flex-1"
        />
      </View>
      <IconButton
        icon="play"
        label="Run"
        shortcut={keymap.label("mod+enter")}
        disabled={!nb.draft().trim()}
        onPress={() => nb.runDraft()}
        testID="notebook-run"
      />
    </Surface>
  );
}

function EmptyNotebook() {
  const store = useStore();
  const examples = computed(() => {
    const s = store.schema();
    const out: string[] = [];
    if (store.source().language === "Cypher") out.push("MATCH (n) RETURN labels(n) AS label, count(*) AS nodes ORDER BY nodes DESC");
    out.push(...s.labels.slice(0, 2).map((l) => l.name));
    for (const p of s.patterns.slice(0, 2)) out.push(`${p.from} ${p.type} ${p.to}`);
    return out;
  });
  return (
    <View class="items-center gap-3 px-6 py-10" testID="notebook-empty">
      <Icon name="notebook" size={28} tone="muted-foreground" />
      <Text class="text-base font-semibold text-foreground">Run a query to start the notebook</Text>
      <Text class="max-w-[520px] text-center text-sm text-muted-foreground">
        {store.source().language
          ? `Each ${store.source().language} query or search phrase you run is kept here with its result as a graph, a table and raw rows. Press ${keymap.label("mod+enter")} to run.`
          : `Each search phrase you run is kept here with its result as a graph, a table and raw rows. Connect a database to run queries in its own language.`}
      </Text>
      <View class="flex-row flex-wrap justify-center gap-2">
        <Each of={examples()}>
          {(text) => <Button size="sm" variant="outline" icon="play" label={text()} onPress={() => store.notebook.run(text())} testID={`notebook-example-${text()}`} />}
        </Each>
      </View>
    </View>
  );
}

function FrameCard(props: { frame: Frame; index: number }) {
  const store = useStore();
  const nb = store.notebook;
  const f = () => props.frame;
  const editing = signal(false);
  const text = signal(f().text);
  const tid = (part: string) => `frame-${props.index}-${part}`;

  const startEdit = () => {
    text.set(f().text);
    editing.set(true);
  };
  const runEdited = () => {
    editing.set(false);
    void nb.rerun(f().id, text());
  };

  return (
    <Surface class="overflow-hidden p-0" testID={`frame-${props.index}`}>
      <View class="flex-row items-start gap-2 border-b border-border px-3 py-2">
        <If when={f().by === "assistant"}>
          <Badge text="Assistant" variant="outline" class="mt-0.5" />
        </If>
        <If
          when={editing()}
          else={
            <View role="button" accessibilityLabel={`Edit: ${f().text}`} onPress={startEdit} class="flex-1 rounded-md px-1 py-0.5 hover:bg-accent" testID={tid("query")}>
              <Text class="font-mono text-sm text-foreground line-clamp-3">{f().text}</Text>
            </View>
          }
        >
          <View
            class="flex-1"
            captureKeys={["mod+enter", "escape"]}
            onKeyDown={(e) => {
              if (runKeys(e)) runEdited();
              else if (e.key === "Escape") editing.set(false);
            }}
          >
            <Editor
              value={text()}
              onChange={(e) => text.set(e.value)}
              language={editorLanguage(store.source().language)}
              lineNumbers={false}
              folding={false}
              minRows={1}
              maxRows={10}
              softWrap
              autoFocus
              accessibilityLabel="Edit the query"
              testID={tid("edit")}
            />
          </View>
          <IconButton size="sm" icon="play" label="Run the edited query" onPress={runEdited} testID={tid("run-edited")} />
        </If>
        <View class="flex-row items-center gap-0.5">
          <IconButton size="sm" icon="relayout" label="Run again" disabled={f().status === "running"} onPress={() => nb.rerun(f().id)} testID={tid("rerun")} />
          <IconButton
            size="sm"
            icon="plus"
            label="Add to the scene"
            disabled={!f().result || f().result!.nodes.length === 0}
            onPress={() => f().result && store.showResult(f().result!)}
            testID={tid("to-scene")}
          />
          <IconButton
            size="sm"
            icon={f().collapsed ? "chevronDown" : "chevronUp"}
            label={f().collapsed ? "Show the result" : "Fold the result"}
            onPress={() => nb.toggleCollapsed(f().id)}
            testID={tid("fold")}
          />
          <IconButton size="sm" icon="x" label="Close the frame" onPress={() => nb.close(f().id)} testID={tid("close")} />
        </View>
      </View>
      <If when={!f().collapsed}>
        <FrameBody frame={f()} tid={tid} />
      </If>
    </Surface>
  );
}

function FrameBody(props: { frame: Frame; tid: (part: string) => string }) {
  const store = useStore();
  const f = () => props.frame;
  return (
    <>
      <If when={f().status === "running"}>
        <View class="flex-row items-center gap-2 px-4 py-6">
          <Spinner />
          <Text class="text-sm text-muted-foreground">Running…</Text>
        </View>
      </If>
      <If when={f().status === "idle"}>
        <View class="flex-row items-center gap-3 px-4 py-4">
          <Text class="flex-1 text-sm text-muted-foreground">Not run since Petal started.</Text>
          <Button size="sm" variant="outline" icon="play" label="Run" onPress={() => store.notebook.rerun(f().id)} testID={props.tid("run")} />
        </View>
      </If>
      <If when={f().status === "error"}>
        <View class="flex-row items-start gap-2 px-4 py-4">
          <Icon name="alert" size={14} tone="destructive" class="mt-0.5" />
          <Text class="flex-1 text-sm text-destructive" testID={props.tid("error")}>
            {f().error ?? "The query failed."}
          </Text>
        </View>
      </If>
      <If when={f().status === "done" && f().result !== undefined}>
        <View class="flex-row items-center gap-3 px-3 py-2">
          <Segmented label="Result view" value={f().view} options={VIEWS} onChange={(v) => store.notebook.setView(f().id, v)} testID={props.tid("view")} />
          <Text class="flex-1 text-right text-xs text-muted-foreground tabular-nums" testID={props.tid("summary")}>
            {frameSummary(f())}
          </Text>
        </View>
        <View style={{ height: FRAME_HEIGHT }} class="border-t border-border">
          <If when={f().view === "graph"}>
            <FrameGraph frame={f()} tid={props.tid} />
          </If>
          <If when={f().view === "table"}>
            <FrameTable frame={f()} tid={props.tid} />
          </If>
          <If when={f().view === "raw"}>
            <FrameRaw frame={f()} tid={props.tid} />
          </If>
        </View>
      </If>
    </>
  );
}

function FrameGraph(props: { frame: Frame; tid: (part: string) => string }) {
  const store = useStore();
  const controller = createGraphController();
  const maps = computed(() => {
    const r = props.frame.result;
    return {
      nodes: new Map<string, DbNode>((r?.nodes ?? []).map((n) => [n.id, n])),
      rels: new Map<string, DbRel>((r?.rels ?? []).map((x) => [x.id, x])),
    };
  });
  const data = computed(() => sceneGraphData(maps().nodes, maps().rels, store.perspective, colorScheme()));
  const selected = computed<DbNode | null>(() => {
    const sel = controller.selection();
    return sel && sel.kind === "node" ? maps().nodes.get(sel.node.id) ?? null : null;
  });
  return (
    <If
      when={maps().nodes.size > 0}
      else={
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-sm text-muted-foreground">No nodes to draw. The table has the rows.</Text>
        </View>
      }
    >
      <View class="relative flex-1">
        <GraphView<DbNode, DbRel>
          data={data()}
          controller={controller}
          layout={store.settings().layout}
          labelMode={store.settings().labelMode}
          edgeLabels={store.settings().edgeLabels}
          accessibilityLabel="Result graph"
          testID={props.tid("graph")}
          style={{ flex: 1 }}
        />
        <View class="absolute bottom-2 right-2 flex-row gap-0.5">
          <Surface class="flex-row p-0.5">
            <IconButton size="sm" icon="zoomOut" label="Zoom out" onPress={() => controller.zoomOut()} />
            <IconButton size="sm" icon="zoomIn" label="Zoom in" onPress={() => controller.zoomIn()} />
            <IconButton size="sm" icon="fit" label="Fit" onPress={() => controller.fit()} />
          </Surface>
        </View>
        <If when={selected()}>
          {(n) => (
            <Surface class="absolute bottom-2 left-2 max-w-[360px] gap-1 p-2.5" testID={props.tid("selected")}>
              <View class="flex-row flex-wrap items-center gap-1">
                <Each of={n().labels}>{(l) => <Badge text={l()} dot={paletteColor(store.perspective.style(l()).color, colorScheme())} />}</Each>
                <Text class="text-sm font-medium text-foreground">{nodeCaption(n(), store.perspective.style(store.perspective.categoryOf(n())).caption)}</Text>
              </View>
              <Each of={Object.entries(n().properties).slice(0, 8)} key={([k]) => k}>
                {(entry) => (
                  <View class="flex-row gap-2">
                    <Text class="w-24 text-xs text-muted-foreground line-clamp-1">{entry()[0]}</Text>
                    <Text class="flex-1 text-xs text-foreground line-clamp-2">{valueText(entry()[1])}</Text>
                    <Text class="text-[10px] text-muted-foreground">{valueKind(entry()[1])}</Text>
                  </View>
                )}
              </Each>
            </Surface>
          )}
        </If>
      </View>
    </If>
  );
}

function FrameTable(props: { frame: Frame; tid: (part: string) => string }) {
  const table = computed(() => frameTable(props.frame.result!));
  const rows = computed(() =>
    table().rows.map((row) => {
      const out: Record<string, string> = {};
      table().columns.forEach((_, i) => (out[`c${i}`] = cellText(row[i])));
      return out;
    }),
  );
  // Each column as wide as its title or the longest of its first rows, within bounds.
  const columns = computed(() =>
    table().columns.map((title, i) => {
      const longest = rows()
        .slice(0, 100)
        .reduce((n, r) => Math.max(n, r[`c${i}`].length), title.length);
      return { key: `c${i}`, title, width: Math.max(80, Math.min(360, longest * 7.5 + 28)) };
    }),
  );
  return (
    <DataTable
      columns={columns()}
      data={rows()}
      stripe
      rowHeader
      rowSelectable={false}
      fontSize={13}
      accessibilityLabel="Result rows"
      testID={props.tid("table")}
      style={{ flex: 1 }}
      empty={
        <View class="flex-1 items-center justify-center p-6">
          <Text class="text-sm text-muted-foreground">No rows.</Text>
        </View>
      }
    />
  );
}

function FrameRaw(props: { frame: Frame; tid: (part: string) => string }) {
  const text = computed(() => {
    const records = tableRecords(frameTable(props.frame.result!));
    const shown = JSON.stringify(records.slice(0, RAW_ROWS), null, 2);
    return records.length > RAW_ROWS ? `${shown}\n// …and ${records.length - RAW_ROWS} more rows` : shown;
  });
  return (
    <Editor
      value={text()}
      language="json"
      readOnly
      lineNumbers
      activeLine={false}
      scrollBeyondLastLine={false}
      accessibilityLabel="Raw result"
      testID={props.tid("raw")}
      style={{ flex: 1 }}
    />
  );
}
