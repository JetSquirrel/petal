/**
 * Petal's state and the work that changes it: the connection, the schema, the scene, the perspective
 * and the settings. Pages read the signals and call the functions; nothing here renders.
 */
import { batch, computed, context, signal, Storage } from "nsh";
import { createGraphController, type GraphController, type LabelMode, type LayoutKind } from "nsh-graph";
import { DemoSource } from "../graph/demo";
import { HawDbSource } from "../graph/hawdb";
import { NebulaSource, type NebulaConnection } from "../graph/nebula";
import { Neo4jSource, type Neo4jConnection } from "../graph/neo4j";
import { mergeResults, type DbNode, type GraphResult } from "../graph/model";
import { phraseOf } from "../graph/phrase";
import { EMPTY_SCHEMA, errorMessage, type Direction, type GraphSource, type Schema, type SearchSpec } from "../graph/source";
import { createPerspective } from "./perspective";
import { createScene } from "./scene";

export type ConnectionState = "connecting" | "ready" | "error";

/** What the connect dialog sends: a database to open, by kind. */
export type ConnectionForm =
  | ({ kind: "neo4j" } & Neo4jConnection)
  | ({ kind: "nebula" } & NebulaConnection)
  | { kind: "hawdb"; path: string; loadDemo: boolean };

/** The connections Petal remembers, one per kind, never with a password. */
export interface RememberedConnections {
  last?: ConnectionForm["kind"];
  neo4j?: Omit<Neo4jConnection, "password">;
  nebula?: Omit<NebulaConnection, "password">;
  hawdb?: { path: string };
}

export interface Notice {
  id: number;
  text: string;
  tone: "info" | "error";
}

export interface Settings {
  /** The most rows a search or expansion brings in. */
  limit: number;
  layout: LayoutKind;
  labelMode: LabelMode;
  edgeLabels: boolean;
}

const SETTINGS_KEY = "settings";
const RECENT_KEY = "recent";
const CONNECTION_KEY = "connection";
/** The most nodes a scene holds; Bloom's default is 10 000, a live force layout here stays smooth to a few hundred. */
export const SCENE_LIMIT = 1500;

const DEFAULT_SETTINGS: Settings = { limit: 100, layout: "force", labelMode: "auto", edgeLabels: false };

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
  const connections = signal<RememberedConnections>({});
  /** Shown while the connection dialog is open. */
  const connectOpen = signal(false);
  const panelOpen = signal(true);

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
      const [s, r, c] = await Promise.all([Storage.getItem(SETTINGS_KEY), Storage.getItem(RECENT_KEY), Storage.getItem(CONNECTION_KEY)]);
      if (s) settings.set({ ...DEFAULT_SETTINGS, ...JSON.parse(s) });
      if (r) recent.set(JSON.parse(r));
      if (c) {
        const kept = JSON.parse(c);
        // Petal 0.1 kept one Neo4j connection here.
        connections.set(kept && "url" in kept ? { last: "neo4j", neo4j: kept } : kept);
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
      await perspective.load(next.key);
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
    await use(source());
  }

  /** Opens a database; resolves with an error message, or null once it is in use. */
  async function connect(form: ConnectionForm): Promise<string | null> {
    try {
      let next: GraphSource;
      let kept: RememberedConnections;
      if (form.kind === "neo4j") {
        next = await Neo4jSource.connect(form);
        kept = { ...connections(), last: "neo4j", neo4j: { url: form.url.trim(), user: form.user, database: form.database.trim() || "neo4j" } };
      } else if (form.kind === "nebula") {
        next = await NebulaSource.connect(form);
        kept = {
          ...connections(),
          last: "nebula",
          nebula: { gateway: form.gateway.trim(), graphd: form.graphd.trim(), user: form.user, space: form.space.trim() },
        };
      } else {
        // HawDB lets one handle own a folder: let go of the one in use before opening it again.
        if (source().kind === "hawdb") source().close?.();
        next = await HawDbSource.open(form.path, { loadDemo: form.loadDemo });
        kept = { ...connections(), last: "hawdb", hawdb: { path: form.path.trim() } };
      }
      connections.set(kept);
      Storage.setItem(CONNECTION_KEY, JSON.stringify(kept)).catch(() => {});
      await use(next);
      notify(`Connected to ${next.label}.`);
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  }

  async function useDemo() {
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
    for (const n of sel.nodes) {
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
    connectOpen,
    panelOpen,
    selectedNode,
    selectedNodes,
    selectedRel,
    start,
    use,
    connect,
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
