/**
 * Petal's state and the work that changes it: the connection, the schema, the scene, the perspective
 * and the settings. Pages read the signals and call the functions; nothing here renders.
 */
import { batch, computed, context, signal, Storage } from "nsh";
import { createGraphController, type GraphController, type LabelMode, type LayoutKind } from "nsh-graph";
import { DemoSource } from "../graph/demo";
import { GremlinSource } from "../graph/gremlin";
import { HawDbSource } from "../graph/hawdb";
import { MemgraphSource } from "../graph/memgraph";
import { NebulaSource } from "../graph/nebula";
import { NeptuneSource } from "../graph/neptune";
import { Neo4jSource } from "../graph/neo4j";
import { mergeResults, type DbNode, type GraphResult } from "../graph/model";
import { parsePhrase, phraseOf } from "../graph/phrase";
import { selectedIds, selectionNodes } from "./graphSelection";
import { createMcp } from "./mcp";
import { createNotebook, type FrameAuthor } from "./notebook";
import { EMPTY_SCHEMA, errorMessage, type Direction, type GraphSource, type Schema, type SearchSpec } from "../graph/source";
import { createPerspective } from "./perspective";
import { createScene } from "./scene";
import { migrateRemembered, newConnectionId, tidy, type ConnectionForm, type ConnectionSettings, type SavedConnection } from "./connections";

export type ConnectionState = "connecting" | "ready" | "error";

export type { ConnectionForm, SavedConnection } from "./connections";

export interface Notice {
  id: number;
  text: string;
  tone: "info" | "error";
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
}

const SETTINGS_KEY = "settings";
const RECENT_KEY = "recent";
/** Petal 0.2's one connection per driver, read once to carry it over. */
const OLD_CONNECTION_KEY = "connection";
const CONNECTIONS_KEY = "connections";
/** The most nodes a scene holds (Bloom's default is 10 000): nsh-graph's Rust layout settles 5 000 in about 5 s. */
export const SCENE_LIMIT = 5000;

const DEFAULT_SETTINGS: Settings = { limit: 100, layout: "force", labelMode: "auto", edgeLabels: false, mode: "explore" };

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
  const panelOpen = signal(true);
  const notebook = createNotebook({
    source: () => source(),
    schema: () => schema(),
    limit: () => settings().limit,
    onResult: (r) => perspective.register(r.nodes.flatMap((n) => n.labels)),
  });

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
      await Promise.all([perspective.load(next.key), notebook.load(next.key)]);
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

  async function expand(ids: string[], opts: { type?: string; direction?: Direction } = {}) {
    if (!ids.length) return;
    await task("Expanding", async () => {
      const result = await source().expand(ids, { ...opts, limit: settings().limit });
      const change = await bring(result);
      notify(change.addedNodes || change.addedRels ? describeChange(change, result.rows) : "No more neighbors to show.");
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
    notebook,
    mcp,
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
