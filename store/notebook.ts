/**
 * The notebook: queries and search phrases run one after another, each kept as a frame with its result,
 * newest first, as a database's own browser keeps them. A frame shows its result as a graph, a table or the
 * raw rows; it can run again, change, or bring its result into the scene.
 *
 * What was run is remembered per database (the frames' text, not their results), so the notebook comes back
 * when Petal connects to the same database again.
 */
import { signal, Storage } from "nsh";
import { mergeResults, valueText, type GraphResult, type Table, type Value } from "../graph/model";
import { parsePhrase } from "../graph/phrase";
import { errorMessage, SourceError, type GraphSource, type Schema } from "../graph/source";

export type FrameView = "graph" | "table" | "raw";

/** Who ran a frame: the person, or an assistant connected over MCP. */
export type FrameAuthor = "you" | "assistant";

export interface Frame {
  id: number;
  /** The phrase or query, as typed. */
  text: string;
  /** `idle`: remembered from an earlier session and not run since. */
  status: "idle" | "running" | "done" | "error";
  result?: GraphResult;
  error?: string;
  /** How long the source took, in milliseconds. */
  ms?: number;
  view: FrameView;
  collapsed: boolean;
  by: FrameAuthor;
}

/** The most frames a notebook keeps; older ones drop off the end. */
export const NOTEBOOK_LIMIT = 50;
/** Relationships among a result's nodes are looked up for results up to this size. */
const AMONG_LIMIT = 1000;
const KEY_PREFIX = "notebook:";

export interface NotebookDeps {
  source: () => GraphSource;
  schema: () => Schema;
  /** The most rows a phrase brings in (a query brings what it returns). */
  limit: () => number;
  /** A frame finished with this result: the perspective gives its new categories their colors. */
  onResult?: (result: GraphResult) => void;
}

export function createNotebook(deps: NotebookDeps) {
  const frames = signal<Frame[]>([]);
  /** The editor's text at the top of the notebook. */
  const draft = signal("");
  let nextId = 1;
  let storageKey: string | null = null;

  const save = () => {
    if (!storageKey) return;
    const kept = frames().map((f) => ({ text: f.text, by: f.by }));
    Storage.setItem(storageKey, JSON.stringify(kept)).catch(() => {});
  };

  const patch = (id: number, change: Partial<Frame>) => frames.update((list) => list.map((f) => (f.id === id ? { ...f, ...change } : f)));

  /** Loads the frames remembered for a database (`source.key`), not run yet. */
  async function load(key: string) {
    storageKey = KEY_PREFIX + key;
    frames.set([]);
    try {
      const raw = await Storage.getItem(storageKey);
      if (storageKey !== KEY_PREFIX + key || !raw) return;
      const kept = JSON.parse(raw) as { text: string; by?: FrameAuthor }[];
      frames.set(
        kept
          .filter((k) => typeof k.text === "string" && k.text.trim())
          .slice(0, NOTEBOOK_LIMIT)
          .map((k) => ({ id: nextId++, text: k.text, status: "idle", view: "graph", collapsed: true, by: k.by === "assistant" ? "assistant" : "you" })),
      );
    } catch {
      // a damaged entry starts an empty notebook
    }
  }

  /** Runs `text` against the source: a query in its language, or a search phrase. */
  async function execute(text: string): Promise<{ result: GraphResult; ms: number }> {
    const source = deps.source();
    const spec = parsePhrase(text, deps.schema(), source.language);
    if (!spec) throw new SourceError("Type a query or a search phrase.");
    const started = Date.now();
    const result = await source.search(spec, deps.limit());
    const ms = Date.now() - started;
    // As the scene does, show how the nodes a result holds connect to each other.
    let among = result;
    if (result.nodes.length > 1 && result.nodes.length <= AMONG_LIMIT) {
      try {
        const rels = await source.relationshipsAmong(result.nodes.map((n) => n.id));
        const known = new Set(result.rels.map((r) => r.id));
        among = mergeResults(result, { nodes: [], rels: rels.filter((r) => !known.has(r.id)), rows: 0 });
        among.table = result.table;
      } catch {
        // the result itself still shows
      }
    }
    return { result: { ...among, rows: result.rows }, ms };
  }

  async function runFrame(id: number) {
    const frame = frames().find((f) => f.id === id);
    if (!frame) return;
    const from = deps.source();
    patch(id, { status: "running", error: undefined, collapsed: false });
    try {
      const { result, ms } = await execute(frame.text);
      if (deps.source() !== from) return;
      deps.onResult?.(result);
      const view: FrameView = result.nodes.length ? frame.view : frame.view === "graph" ? "table" : frame.view;
      patch(id, { status: "done", result, ms, view });
    } catch (e) {
      if (deps.source() !== from) return;
      patch(id, { status: "error", error: errorMessage(e), result: undefined });
    }
  }

  /** Adds a frame for `text` at the top and runs it; resolves with the frame once it finished. */
  async function run(text: string, by: FrameAuthor = "you"): Promise<Frame | undefined> {
    const t = text.trim();
    if (!t) return undefined;
    const id = nextId++;
    frames.update((list) => [{ id, text: t, status: "running" as const, view: "graph" as const, collapsed: false, by }, ...list].slice(0, NOTEBOOK_LIMIT));
    save();
    await runFrame(id);
    return frames().find((f) => f.id === id);
  }

  /** Runs the editor's text, and empties the editor. */
  function runDraft() {
    const t = draft().trim();
    if (!t) return;
    draft.set("");
    void run(t);
  }

  /** Runs a frame again, with new text when it was edited. */
  async function rerun(id: number, text?: string) {
    if (text !== undefined && text.trim()) {
      patch(id, { text: text.trim() });
      save();
    }
    await runFrame(id);
  }

  function close(id: number) {
    frames.update((list) => list.filter((f) => f.id !== id));
    save();
  }

  function clear() {
    frames.set([]);
    save();
  }

  const setView = (id: number, view: FrameView) => patch(id, { view });
  const toggleCollapsed = (id: number) => frames.update((list) => list.map((f) => (f.id === id ? { ...f, collapsed: !f.collapsed } : f)));

  return { frames, draft, load, run, runDraft, rerun, close, clear, setView, toggleCollapsed };
}

export type Notebook = ReturnType<typeof createNotebook>;

/**
 * The rows a frame's table shows: the source's own, or, from a source that keeps none (the demo graph),
 * one row per node and relationship found.
 */
export function frameTable(result: GraphResult): Table {
  if (result.table && result.table.columns.length) return result.table;
  const rows: Value[][] = [];
  const text = (s: string): Value => ({ type: "String", value: s });
  for (const n of result.nodes) rows.push([text("node"), text(n.id), text(n.labels.join(", ")), { type: "Map", value: n.properties }]);
  for (const r of result.rels) rows.push([text("relationship"), text(r.id), text(r.type), { type: "Map", value: r.properties }]);
  return { columns: ["kind", "id", "labels / type", "properties"], rows };
}

/** A value as plain JSON: what the Raw view shows and what MCP tools answer with. */
export function plainValue(v: Value): unknown {
  switch (v.type) {
    case "Null":
      return null;
    case "Boolean":
    case "String":
    case "Float":
      return v.value;
    case "Integer": {
      const n = Number(v.value);
      return Number.isSafeInteger(n) ? n : v.value;
    }
    case "Text":
      return v.value;
    case "List":
      return v.value.map(plainValue);
    case "Map": {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v.value)) out[k] = plainValue(x);
      return out;
    }
  }
}

/** The rows as JSON objects keyed by column. */
export function tableRecords(table: Table): Record<string, unknown>[] {
  return table.rows.map((row) => {
    const out: Record<string, unknown> = {};
    table.columns.forEach((c, i) => (out[c] = row[i] === undefined ? null : plainValue(row[i])));
    return out;
  });
}

/** A cell as one line of text, for the table. */
export function cellText(v: Value | undefined): string {
  if (!v) return "";
  const t = valueText(v);
  return t.length > 300 ? `${t.slice(0, 299)}…` : t;
}

/** "3 rows in 12 ms", "Nothing found in 4 ms". */
export function frameSummary(frame: Frame): string {
  const r = frame.result;
  if (!r) return "";
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (r.table && r.table.columns.length) parts.push(n(r.rows, "row"));
  if (r.nodes.length || r.rels.length) parts.push(`${n(r.nodes.length, "node")}, ${n(r.rels.length, "relationship")}`);
  if (!parts.length) parts.push("Nothing found");
  return `${parts.join(" · ")} in ${frame.ms ?? 0} ms`;
}
