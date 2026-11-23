/**
 * Notebook mode: an editor at the top runs a query (or a search phrase), and each run becomes a frame below,
 * newest first. A frame shows its result as a graph, a table or the raw rows, says how long it took, and can
 * run again, be edited, bring its result into the scene, fold, or close. Ctrl/⌘ + Enter runs.
 */
import { colorScheme, computed, keymap, Scroll, signal, Text, View } from "nsh";
import { DataTable, Editor, type EditorDecoration, type EditorRef, type EditorToken } from "nsh/base";
import { createGraphController, GraphView } from "nsh-graph";
import { nodeCaption, valueKind, valueText, type DbNode, type DbRel } from "../graph/model";
import { completionsAt, lineStarts, positionOf, tokenizeQuery, type TokenKind } from "../graph/queryLang";
import type { QueryLanguage, Schema } from "../graph/source";
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

/** The editor's language name for a source's query language: its comments, brackets and indentation (Petal colors the text itself). */
function editorLanguage(language: QueryLanguage): string | null {
  if (language === "Cypher" || language === "nGQL") return "cypher";
  if (language === "Gremlin") return "groovy";
  return null;
}

/** How the editor colors each kind of Petal's tokens. */
const TOKEN_COLORS: Record<TokenKind, { token: EditorToken; class?: string }> = {
  keyword: { token: "keyword", class: "font-semibold" },
  function: { token: "built" },
  label: { token: "title" },
  property: { token: "attr" },
  string: { token: "string" },
  number: { token: "number" },
  comment: { token: "comment", class: "italic" },
  parameter: { token: "attr", class: "italic" },
};

/** The decorations that color `text` as a query in `language` (a search phrase without one). */
function highlight(text: string, language: QueryLanguage, schema: Schema): EditorDecoration[] {
  const starts = lineStarts(text);
  return tokenizeQuery(text, language, schema).map((t) => ({
    range: { start: positionOf(starts, t.start), end: positionOf(starts, t.end) },
    ...TOKEN_COLORS[t.kind],
  }));
}

/** The property keys of what the scene and the notebook's results hold: what completes after `.`. */
const KEY_SCAN = 2000;
function usePropertyKeys() {
  const store = useStore();
  return computed(() => {
    const keys = new Set<string>();
    let seen = 0;
    const take = (props: Record<string, unknown>) => {
      for (const k of Object.keys(props)) keys.add(k);
    };
    for (const n of store.scene.nodes().values()) {
      if (seen++ > KEY_SCAN) break;
      take(n.properties);
    }
    for (const f of store.notebook.frames()) {
      for (const n of f.result?.nodes ?? []) {
        if (seen++ > KEY_SCAN) break;
        take(n.properties);
      }
      for (const r of f.result?.rels ?? []) {
        if (seen++ > KEY_SCAN) break;
        take(r.properties);
      }
    }
    return [...keys].sort();
  });
}

/**
 * The notebook's code editor: Petal's highlighting for the source's language and, while editable, completion
 * of keywords, functions, the schema's labels and types, and property keys.
 */
function QueryCode(props: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  lineNumbers?: boolean;
  minRows?: number;
  maxRows?: number;
  autoFocus?: boolean;
  accessibilityLabel: string;
  testID?: string;
  class?: string;
}) {
  const store = useStore();
  const keys = usePropertyKeys();
  const language = () => store.source().language;
  const decorations = computed(() => highlight(props.value, language(), store.schema()));
  let editor: EditorRef | undefined;
  const triggers = () => (language() === "Gremlin" ? ["."] : language() ? [":", "."] : []);
  return (
    <Editor
      ref={(r) => (editor = r)}
      value={props.value}
      onChange={(e) => props.onChange?.(e.value)}
      readOnly={props.readOnly}
      language={editorLanguage(language())}
      highlighting={false}
      decorations={decorations()}
      placeholder={props.placeholder}
      lineNumbers={props.lineNumbers ?? false}
      folding={false}
      activeLine={false}
      indentGuides={false}
      scrollBeyondLastLine={false}
      minRows={props.minRows ?? 1}
      maxRows={props.maxRows}
      softWrap
      autoFocus={props.autoFocus}
      completion={!props.readOnly}
      completionTriggerCharacters={triggers()}
      onCompletionRequest={(req) => {
        const items = completionsAt(props.value, req.offset, req.queryStart, { language: language(), schema: store.schema(), propertyKeys: keys() });
        // A bare word with nothing typed yet (a space typed after a word) asks for nothing.
        if (req.trigger === "typing" && req.query === "") return editor?.hideCompletions();
        editor?.presentCompletions(req.id, items);
      }}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      class={props.class}
    />
  );
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
        <QueryCode
          value={nb.draft()}
          onChange={(v) => nb.draft.set(v)}
          placeholder={hint()}
          lineNumbers={nb.draft().includes("\n")}
          maxRows={14}
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
      <View class="flex-row items-start gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <Text class="pt-[3px] font-mono text-sm text-muted-foreground">$</Text>
        <If
          when={editing()}
          else={
            <View class="flex-1" testID={tid("query")}>
              <QueryCode value={f().text} readOnly maxRows={6} accessibilityLabel={`Query: ${f().text}`} testID={tid("code")} class="bg-transparent" />
            </View>
          }
        >
          <View
            class="flex-1 rounded-md border border-ring"
            captureKeys={["mod+enter", "escape"]}
            onKeyDown={(e) => {
              if (runKeys(e)) runEdited();
              else if (e.key === "Escape") editing.set(false);
            }}
          >
            <QueryCode value={text()} onChange={(v) => text.set(v)} maxRows={10} autoFocus accessibilityLabel="Edit the query" testID={tid("edit")} />
          </View>
          <IconButton size="sm" icon="play" label="Run the edited query" onPress={runEdited} testID={tid("run-edited")} />
        </If>
        <View class="flex-row items-center gap-0.5">
          <If when={f().by === "assistant"}>
            <Badge text="Assistant" variant="outline" class="mr-1" />
          </If>
          <If when={!editing()}>
            <IconButton size="sm" icon="pencil" label="Edit the query" onPress={startEdit} testID={tid("edit-start")} />
          </If>
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
