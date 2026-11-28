/**
 * Petal's state and the work that changes it: the connection, the schema, the scene, the perspective
 * and the settings. Pages read the signals and call the functions; nothing here renders.
 */
import { batch, Clipboard, computed, context, signal, Storage, windowSize } from "nsh";
import { createGraphController, type GraphController, type LabelMode, type LayoutKind } from "nsh-graph";
import { DemoSource } from "../graph/demo";
import { GremlinSource } from "../graph/gremlin";
import { HawDbSource } from "../graph/hawdb";
import { hawDbState, installHelper, type HawDbState } from "../graph/hawdbHelper";
import { MemgraphSource } from "../graph/memgraph";
import { NebulaSource } from "../graph/nebula";
import { NeptuneSource } from "../graph/neptune";
import { PuppyGraphSource } from "../graph/puppygraph";
import { TigerGraphSource } from "../graph/tigergraph";
import { Neo4jSource } from "../graph/neo4j";
import { mergeResults, type DbNode, type GraphResult } from "../graph/model";
import { parsePhrase, phraseOf } from "../graph/phrase";
import { selectedIds, selectionNodes } from "./graphSelection";
import { createMcp } from "./mcp";
import { createNotebook, NOTEBOOK_LIMIT, type FrameAuthor } from "./notebook";
import { notebookFile, parseNotebookFile } from "./notebookFile";
import { EMPTY_SCHEMA, errorMessage, type Direction, type GraphSource, type Schema, type SearchSpec } from "../graph/source";
import { createPerspective } from "./perspective";
import { createScene } from "./scene";
import { createSavedScenes, layoutOf, parseSceneFile, sceneFile, type NodePlace, type SavedScene } from "./savedScenes";
import { exportFile, fileStamp, filesAvailable, pickJsonFile, safeFileName } from "./files";
import { migrateRemembered, newConnectionId, tidy, type ConnectionForm, type ConnectionSettings, type SavedConnection } from "./connections";

export type ConnectionState = "connecting" | "ready" | "error";

export type { ConnectionForm, SavedConnection } from "./connections";

export interface Notice {
  id: number;
  text: string;
  tone: "info" | "error";
}

/** Which neighbors an expansion brings in: Graph Explorer's expand panel. */
export interface ExpandFilter {
  type?: string;
  direction?: Direction;
  /** Only neighbors with this label. */
  label?: string;
  /** Only neighbors with a property containing these words. */
  text?: string;
  /** At most this many; the settings' limit when missing. */
  limit?: number;
}

/** What the main area shows: the scene to explore, or the notebook of queries. */
export type Mode = "explore" | "notebook";

export interface Settings {
  /** The most rows a search or expansion brings in. */
  limit: number;
  layout: LayoutKind;
  labelMode: LabelMode;
  edgeLabels: boolean;
  mode: Mode;
  /** The scene's table shows under the canvas. */
  table: boolean;
}

const SETTINGS_KEY = "settings";
const RECENT_KEY = "recent";
/** Petal 0.2's one connection per driver, read once to carry it over. */
const OLD_CONNECTION_KEY = "connection";
const CONNECTIONS_KEY = "connections";
/** The most nodes a scene holds (Bloom's default is 10 000): nsh-graph's Rust layout settles 5 000 in about 5 s. */
export const SCENE_LIMIT = 5000;

const DEFAULT_SETTINGS: Settings = { limit: 100, layout: "force", labelMode: "auto", edgeLabels: false, mode: "explore", table: false };

export interface AppStoreOptions {
  /** Starts on this source instead of the demo graph (tests). */
  source?: GraphSource;
}

export function createAppStore(options: AppStoreOptions = {}) {
  const graph: GraphController = createGraphController();
  const scene = createScene();
  const perspective = createPerspective();

  const source = signal<GraphSource>(options.source ?? new DemoSource());
  const schema = signal<Schema>(EMPTY_SCHEMA);
  const connection = signal<ConnectionState>("connecting");
  const connectionError = signal<string | null>(null);
  /** What is running, for the busy indicator: "Searching", "Expanding". */
  const busy = signal<string | null>(null);
  const notice = signal<Notice | null>(null);
  const recent = signal<string[]>([]);
  const settings = signal<Settings>(DEFAULT_SETTINGS);
  /** The saved connections, most recently used first. */
  const connections = signal<SavedConnection[]>([]);
  /** The saved connection in use; null on the demo graph or a source given to the store. */
  const activeConnection = signal<string | null>(null);
  /** Passwords typed this session, by saved connection. Never stored. */
  const passwords = new Map<string, string>();
  /** Shown while the connection dialog is open. */
  const connectOpen = signal(false);
  /** Shown while the MCP dialog (Connect an assistant) is open. */
  const mcpOpen = signal(false);
  const perspectiveDocked = () => windowSize().width >= 760;
  const dockedPerspectiveOpen = signal(true);
  const floatingPerspectiveOpen = signal(false);
  const perspectiveVisibility = () => (perspectiveDocked() ? dockedPerspectiveOpen : floatingPerspectiveOpen);
  const panelOpen = () => perspectiveVisibility()();
  const togglePerspective = () => perspectiveVisibility().update((open) => !open);
  const scenes = createSavedScenes();
  /** Where an opened scene's nodes start on the canvas, until it has drawn them. */
  const places = signal<Record<string, NodePlace> | null>(null);
  const notebook = createNotebook({
    source: () => source(),
    schema: () => schema(),
    limit: () => settings().limit,
    onResult: (r) => perspective.register(r.nodes.flatMap((n) => n.labels)),
  });

  /** Whether HawDB runs here, and while it downloads. */
  const hawDb = signal<HawDbState | "downloading">(hawDbState());

  /** Downloads HawDB's program (the desktops); resolves with an error message, or null once it runs. */
  async function installHawDb(): Promise<string | null> {
    if (hawDb() === "downloading") return null;
    hawDb.set("downloading");
    try {
      const version = await installHelper();
      hawDb.set(hawDbState());
      notify(`Downloaded HawDB ${version}.`);
      return null;
    } catch (e) {
      hawDb.set(hawDbState());
      return errorMessage(e);
    }
  }

  let noticeId = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function notify(text: string, tone: Notice["tone"] = "info") {
    clearTimeout(noticeTimer);
    const id = ++noticeId;
    notice.set({ id, text, tone });
    noticeTimer = setTimeout(() => {
      if (notice()?.id === id) notice.set(null);
    }, tone === "error" ? 7000 : 3500);
  }

  async function restore() {
    try {
      const [s, r, c, old] = await Promise.all([
        Storage.getItem(SETTINGS_KEY),
        Storage.getItem(RECENT_KEY),
        Storage.getItem(CONNECTIONS_KEY),
        Storage.getItem(OLD_CONNECTION_KEY),
      ]);
      if (s) settings.set({ ...DEFAULT_SETTINGS, ...JSON.parse(s) });
      if (r) recent.set(JSON.parse(r));
      if (c) connections.set(JSON.parse(c));
      else if (old) {
        setConnections(migrateRemembered(JSON.parse(old)));
        Storage.removeItem(OLD_CONNECTION_KEY).catch(() => {});
      }
    } catch {
      // damaged entries fall back to the defaults
    }
  }

  function updateSettings(patch: Partial<Settings>) {
    settings.update((s) => ({ ...s, ...patch }));
    Storage.setItem(SETTINGS_KEY, JSON.stringify(settings())).catch(() => {});
  }

  /** Switches to `next`: loads its schema and perspective, and empties the scene. */
  async function use(next: GraphSource) {
    const previous = source();
    if (previous !== next) previous.close?.();
    batch(() => {
      source.set(next);
      connection.set("connecting");
      connectionError.set(null);
      schema.set(EMPTY_SCHEMA);
      scene.reset();
      graph.clearSelection();
    });
    try {
      await Promise.all([perspective.load(next.key), notebook.load(next.key), scenes.load(next.key)]);
      const s = await next.schema();
      if (source() !== next) return;
      batch(() => {
        schema.set(s);
        perspective.register(s.labels.map((l) => l.name));
        connection.set("ready");
      });
    } catch (e) {
      if (source() !== next) return;
      connection.set("error");
      connectionError.set(errorMessage(e));
    }
  }

  async function start() {
    await restore();
    void mcp.restore();
    await use(source());
  }

  function setConnections(list: SavedConnection[]) {
    const sorted = [...list].sort((x, y) => (y.lastUsed ?? 0) - (x.lastUsed ?? 0));
    connections.set(sorted);
    Storage.setItem(CONNECTIONS_KEY, JSON.stringify(sorted)).catch(() => {});
  }

  /** Adds or replaces a saved connection; resolves with it (a new one gets its ID here). */
  function saveConnection(entry: Omit<SavedConnection, "id"> & { id?: string }, password?: string): SavedConnection {
    const id = entry.id ?? newConnectionId();
    const prev = connections().find((c) => c.id === id);
    const saved: SavedConnection = { ...prev, ...entry, id, name: entry.name.trim(), settings: tidy(entry.settings) };
    setConnections([...connections().filter((c) => c.id !== id), saved]);
    if (password !== undefined && saved.settings.kind !== "hawdb") passwords.set(id, password);
    return saved;
  }

  function deleteConnection(id: string) {
    setConnections(connections().filter((c) => c.id !== id));
    passwords.delete(id);
    if (activeConnection() === id) activeConnection.set(null);
  }

  /** The password typed for a saved connection this session, if any. */
  function passwordOf(id: string): string {
    return passwords.get(id) ?? "";
  }

  async function openSource(form: ConnectionForm): Promise<GraphSource> {
    switch (form.kind) {
      case "neo4j":
        return Neo4jSource.connect(form);
      case "memgraph":
        return MemgraphSource.connect(form);
      case "puppygraph":
        return PuppyGraphSource.connect(form);
      case "tigergraph":
        return TigerGraphSource.connect(form);
      case "neptune":
        return NeptuneSource.connect(form);
      case "gremlin":
        return GremlinSource.connect(form);
      case "nebula":
        return NebulaSource.connect(form);
      case "hawdb":
        // HawDB lets one handle own a folder: let go of the one in use before opening it again.
        if (source().kind === "hawdb") source().close?.();
        return HawDbSource.open(form.path, { loadDemo: form.loadDemo });
    }
  }

  /**
   * Opens a database without switching to it, reads its schema and lets go: the dialog's Test button.
   * Resolves with what it found, or the error.
   */
  async function testConnection(form: ConnectionForm): Promise<{ ok: boolean; message: string }> {
    if (form.kind === "hawdb" && source().kind === "hawdb") {
      return { ok: false, message: "A HawDB database is open now, and only one handle can hold a folder. Connect to test it." };
    }
    try {
      const probe = await openSource(form);
      try {
        const s = await probe.schema();
        const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
        return { ok: true, message: `Connected: ${n(s.labels.length, "label")}, ${n(s.relTypes.length, "relationship type")}.` };
      } finally {
        probe.close?.();
      }
    } catch (e) {
      return { ok: false, message: errorMessage(e) };
    }
  }

  /**
   * Opens a database and switches to it, saving the connection (under `id` when it is a saved one).
   * Resolves with an error message, or null once it is in use.
   */
  async function connect(form: ConnectionForm, entry: { id?: string; name?: string } = {}): Promise<string | null> {
    try {
      const next = await openSource(form);
      const { password: _p, loadDemo: _l, ...rest } = form as ConnectionForm & { password?: string; loadDemo?: boolean };
      const saved = saveConnection(
        { id: entry.id, name: entry.name ?? "", settings: rest as ConnectionSettings, lastUsed: Date.now() },
        "password" in form ? form.password : undefined,
      );
      activeConnection.set(saved.id);
      await use(next);
      notify(`Connected to ${next.label}.`);
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  }

  async function useDemo() {
    activeConnection.set(null);
    await use(new DemoSource());
    notify("Switched to the demo graph.");
  }

  function rememberSearch(phrase: string) {
    const list = [phrase, ...recent().filter((r) => r.toLowerCase() !== phrase.toLowerCase())].slice(0, 12);
    recent.set(list);
    Storage.setItem(RECENT_KEY, JSON.stringify(list)).catch(() => {});
  }

  /** Runs `work` with the busy indicator, reporting its failure as a notice. */
  async function task<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    const from = source();
    busy.set(label);
    try {
      return await work();
    } catch (e) {
      if (source() === from) notify(errorMessage(e), "error");
      return undefined;
    } finally {
      if (busy() === label) busy.set(null);
    }
  }

  /**
   * Brings a result into the scene with the relationships among its nodes and the ones already there, as
   * Bloom does, so a new node shows how it connects to what you were looking at.
   */
  async function bring(result: GraphResult): Promise<{ addedNodes: number; addedRels: number }> {
    const room = SCENE_LIMIT - scene.nodes().size;
    const fresh = result.nodes.filter((n) => !scene.nodes().has(n.id));
    if (fresh.length > room) {
      const keep = new Set(fresh.slice(0, Math.max(0, room)).map((n) => n.id));
      result = {
        ...result,
        nodes: result.nodes.filter((n) => scene.nodes().has(n.id) || keep.has(n.id)),
      };
      notify(`The scene holds ${SCENE_LIMIT} nodes at most; ${fresh.length - keep.size} were left out.`, "error");
    }
    perspective.register(result.nodes.flatMap((n) => n.labels));
    const ids = new Set([...scene.nodes().keys(), ...result.nodes.map((n) => n.id)]);
    let among: GraphResult = { nodes: [], rels: [], rows: 0 };
    if (result.nodes.length) {
      try {
        among = { nodes: [], rels: await source().relationshipsAmong([...ids]), rows: 0 };
      } catch {
        // the result itself still shows
      }
    }
    return scene.add(mergeResults(result, among));
  }

  function describeChange(c: { addedNodes: number; addedRels: number }, rows: number): string {
    if (!c.addedNodes && !c.addedRels) return rows ? "Everything it found is already in the scene." : "Nothing found.";
    const parts = [];
    if (c.addedNodes) parts.push(`${c.addedNodes} ${c.addedNodes === 1 ? "node" : "nodes"}`);
    if (c.addedRels) parts.push(`${c.addedRels} ${c.addedRels === 1 ? "relationship" : "relationships"}`);
    return `Added ${parts.join(" and ")}.`;
  }

  async function search(spec: SearchSpec, phrase = phraseOf(spec)) {
    rememberSearch(phrase);
    await task("Searching", async () => {
      const result = await source().search(spec, settings().limit);
      const change = await bring(result);
      if (spec.kind === "raw" && result.rows > 0 && result.nodes.length === 0) {
        notify(`The query returned ${result.rows} ${result.rows === 1 ? "row" : "rows"} but no nodes to show.`);
      } else notify(describeChange(change, result.rows));
    });
  }

  /**
   * Brings in the neighbors of `ids`: all of them, or only those across one relationship type and direction,
   * with a label, or with a property containing some words, up to `limit` (the settings' by default).
   */
  async function expand(ids: string[], opts: ExpandFilter = {}) {
    if (!ids.length) return;
    const filtered = !!(opts.label || opts.text);
    await task("Expanding", async () => {
      const result = await source().expand(ids, {
        type: opts.type,
        direction: opts.direction,
        label: opts.label || undefined,
        text: opts.text?.trim() || undefined,
        limit: opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : settings().limit,
      });
      const change = await bring(result);
      if (change.addedNodes || change.addedRels) notify(describeChange(change, result.rows));
      else notify(filtered && !result.rows ? "No neighbors match the filters." : "No more neighbors to show.");
    });
  }

  /** Brings a notebook frame's result, or an assistant's, into the scene, and says what it added. */
  async function showResult(result: GraphResult, by: FrameAuthor = "you") {
    const change = await bring(result);
    const text = describeChange(change, result.rows);
    notify(by === "assistant" ? `Assistant: ${text}` : text);
    return change;
  }

  function setMode(mode: Mode) {
    if (settings().mode !== mode) updateSettings({ mode });
  }

  const mcp = createMcp({
    source: () => source(),
    schema: () => schema(),
    ready: () => connection() === "ready",
    parse: (text) => parsePhrase(text, schema(), source().language),
    limit: () => settings().limit,
    scene: () => ({ nodes: [...scene.nodes().values()], rels: [...scene.rels().values()], selected: selectedIds(graph) }),
    show: (result) => showResult(result, "assistant"),
    notebook: async (text) => {
      notify("Assistant: added a frame to the notebook.");
      return notebook.run(text, "assistant");
    },
    allowWrites: () => mcp.settings().allowWrites,
  });

  function dismiss(ids: string[]) {
    const n = scene.dismiss(ids);
    if (n) notify(`Dismissed ${n} ${n === 1 ? "node" : "nodes"}.`);
  }

  function dismissOthers(ids: string[]) {
    const n = scene.keepOnly(ids);
    if (n) notify(`Dismissed ${n} other ${n === 1 ? "node" : "nodes"}.`);
  }

  function undo() {
    if (scene.undo()) notify("Undone.");
  }

  /** The scene as it is now, with where its nodes are: what saving and copying keep. */
  function snapshot(name: string): SavedScene {
    const ids = [...scene.nodes().keys()];
    return {
      name,
      savedAt: Date.now(),
      nodes: [...scene.nodes().values()],
      rels: [...scene.rels().values()],
      layout: layoutOf(ids, (id) => graph.position(id), (id) => graph.isPinned(id)),
    };
  }

  /** Saves the scene under `name` for this database. Resolves with null, or what went wrong. */
  async function saveScene(name: string): Promise<string | null> {
    const n = name.trim();
    if (!n) return "Give the scene a name.";
    if (scene.nodes().size === 0) return "The scene is empty.";
    const error = await scenes.save(snapshot(n), source().kind);
    if (!error) notify(`Saved the scene as “${n}”.`);
    return error;
  }

  /**
   * Replaces the scene with a saved one (undo brings the old one back), its nodes where they were. Relationships
   * whose ends are missing stay out.
   */
  function openScene(saved: Pick<SavedScene, "name" | "nodes" | "rels" | "layout">) {
    const nodes = saved.nodes.slice(0, SCENE_LIMIT);
    perspective.register(nodes.flatMap((n) => n.labels));
    batch(() => {
      places.set(saved.layout);
      graph.clearSelection();
      scene.replace({ nodes, rels: saved.rels });
    });
    // Once the canvas has the nodes where they start, let the layout own them again and pin the pinned ones.
    setTimeout(() => {
      places.set(null);
      for (const [id, p] of Object.entries(saved.layout)) if (p[2] === 1 && scene.nodes().has(id)) graph.setPinned(id, true);
      graph.fit();
    }, 60);
    const left = saved.nodes.length - nodes.length;
    notify(left > 0 ? `Opened “${saved.name}”; ${left} nodes past the scene's ${SCENE_LIMIT} were left out.` : `Opened “${saved.name || "the scene"}”.`);
  }

  async function deleteScene(name: string) {
    await scenes.remove(name);
    notify(`Deleted the saved scene “${name}”.`);
  }

  /** Puts the scene on the clipboard as JSON, for someone else on the same database. */
  async function copyScene() {
    if (scene.nodes().size === 0) return notify("The scene is empty.");
    try {
      await Clipboard.writeText(sceneFile(snapshot(""), source().kind));
      notify(`Copied the scene (${scene.nodes().size} nodes) to the clipboard.`);
    } catch {
      notify("Couldn't copy to the clipboard.", "error");
    }
  }

  /**
   * Writes `text` to a file in Downloads on the desktops (`what` says what it holds, for the notice), or puts it
   * on the clipboard where there are no files (the web).
   */
  async function exportText(fileName: string, text: string, what: string) {
    if (!filesAvailable()) {
      try {
        await Clipboard.writeText(text);
        notify(`Copied ${what} to the clipboard.`);
      } catch {
        notify("Couldn't copy to the clipboard.", "error");
      }
      return;
    }
    try {
      const path = await exportFile(safeFileName(fileName), text);
      notify(`Exported ${what} to ${path}`);
    } catch (e) {
      notify(`Couldn't write the file: ${errorMessage(e)}`, "error");
    }
  }

  /** Writes the scene to a JSON file (`petal-scene/1`), for someone else on the same database. */
  async function exportScene() {
    if (scene.nodes().size === 0) return notify("The scene is empty.");
    const n = scene.nodes().size;
    await exportText(`Petal scene ${fileStamp()}.json`, sceneFile(snapshot(""), source().kind), `the scene (${n} ${n === 1 ? "node" : "nodes"})`);
  }

  /** Writes the notebook's queries (not their results) to a file (`petal-notebook/1`). */
  async function saveNotebook() {
    const cells = notebook.cells();
    if (cells.length === 0) return notify("The notebook is empty.");
    const n = cells.length;
    const text = notebookFile(cells, source().kind, source().language ?? "");
    await exportText(`Petal notebook ${fileStamp()}.json`, text, `the notebook (${n} ${n === 1 ? "query" : "queries"})`);
  }

  /** Opens a notebook file the person picks, in place of the notebook's frames; its queries are not run yet. */
  async function openNotebook() {
    let picked: { name: string; text: string } | null;
    try {
      picked = await pickJsonFile("Petal notebook");
    } catch (e) {
      return notify(errorMessage(e), "error");
    }
    if (!picked) return;
    const parsed = parseNotebookFile(picked.text);
    if ("error" in parsed) return notify(parsed.error, "error");
    const { cells, source: from } = parsed.notebook;
    if (cells.length === 0) return notify("The notebook has no queries.", "error");
    notebook.open(cells);
    const n = Math.min(cells.length, NOTEBOOK_LIMIT);
    const dropped = cells.length > NOTEBOOK_LIMIT ? ` (the newest ${NOTEBOOK_LIMIT} of ${cells.length})` : "";
    if (from && from !== source().kind) {
      notify(`Opened ${n} ${n === 1 ? "query" : "queries"}${dropped} written for a ${from} database; they may not run here.`, "error");
    } else {
      notify(`Opened ${n} ${n === 1 ? "query" : "queries"}${dropped} from ${picked.name}. Run them to see their results.`);
    }
  }

  /** Opens a scene file the person picks. */
  async function importScene() {
    let picked: { name: string; text: string } | null;
    try {
      picked = await pickJsonFile();
    } catch (e) {
      return notify(errorMessage(e), "error");
    }
    if (!picked) return;
    openParsed(picked.text, picked.name.replace(/\.json$/i, ""), "The file isn't a Petal scene.");
  }

  function openParsed(text: string, fallbackName: string, notScene: string) {
    const parsed = parseSceneFile(text);
    if ("error" in parsed) return notify(parsed.error.replace("The clipboard doesn't hold a Petal scene.", notScene), "error");
    if (parsed.scene.source && parsed.scene.source !== source().kind) {
      notify(`This scene came from a ${parsed.scene.source} database; expanding its nodes may find nothing here.`, "error");
    }
    openScene({ ...parsed.scene, name: parsed.scene.name || fallbackName });
  }

  /** Opens a scene from the clipboard's JSON. */
  async function pasteScene() {
    let text = "";
    try {
      text = await Clipboard.readText();
    } catch {
      return notify("Couldn't read the clipboard.", "error");
    }
    openParsed(text, "the pasted scene", "The clipboard doesn't hold a Petal scene.");
  }

  function clearScene() {
    scene.clear();
    graph.clearSelection();
  }

  /** The nodes selected now, as the inspector shows them. */
  const selectedNode = computed<DbNode | null>(() => {
    const sel = graph.selection();
    if (!sel || sel.kind !== "node") return null;
    return scene.nodes().get(sel.node.id) ?? null;
  });

  /** Every selected node, in the order they were selected (the inspector's node last). */
  const selectedNodes = computed<DbNode[]>(() => {
    const sel = graph.selection();
    if (!sel || sel.kind !== "node") return [];
    const out: DbNode[] = [];
    for (const n of selectionNodes(sel)) {
      const d = scene.nodes().get(n.id);
      if (d) out.push(d);
    }
    return out;
  });

  const selectedRel = computed(() => {
    const sel = graph.selection();
    if (!sel || sel.kind !== "edge") return null;
    const id = sel.edge.id;
    return id ? scene.rels().get(id) ?? null : null;
  });

  return {
    hawDb,
    installHawDb,
    graph,
    scene,
    perspective,
    source,
    schema,
    connection,
    connectionError,
    busy,
    notice,
    recent,
    settings,
    connections,
    activeConnection,
    connectOpen,
    mcpOpen,
    panelOpen,
    perspectiveDocked,
    togglePerspective,
    notebook,
    mcp,
    scenes,
    places,
    saveScene,
    openScene,
    deleteScene,
    copyScene,
    pasteScene,
    exportScene,
    importScene,
    saveNotebook,
    openNotebook,
    exportText,
    filesAvailable,
    setMode,
    showResult,
    selectedNode,
    selectedNodes,
    selectedRel,
    start,
    use,
    connect,
    testConnection,
    saveConnection,
    deleteConnection,
    passwordOf,
    useDemo,
    updateSettings,
    notify,
    search,
    expand,
    dismiss,
    dismissOthers,
    undo,
    clearScene,
  };
}

export type AppStore = ReturnType<typeof createAppStore>;

export const AppContext = context<AppStore | null>(null);

export function useStore(): AppStore {
  const s = AppContext();
  if (!s) throw new Error("useStore outside <AppContext.Provider>");
  return s;
}
