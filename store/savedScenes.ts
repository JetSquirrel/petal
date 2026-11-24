/**
 * Saved scenes, as Graph Explorer's Save Graph and Load Graph and Bloom's scenes: a scene's nodes,
 * relationships and layout under a name, kept per database, to open again later. A scene also goes to a JSON
 * file (or the clipboard) and comes back from one, so it can be passed to someone using the same database.
 */
import { signal, Storage } from "nsh";
import type { DbNode, DbRel } from "../graph/model";
import { filesAvailable, readJsonFiles, removeFileIn, safeFileName, scenesFolder, writeFileIn } from "./files";

/** Where a node was, and whether it was pinned: `[x, y]` or `[x, y, 1]`. */
export type NodePlace = [number, number] | [number, number, 1];

export interface SavedScene {
  name: string;
  /** When it was saved, in ms since the epoch. */
  savedAt: number;
  nodes: DbNode[];
  rels: DbRel[];
  layout: Record<string, NodePlace>;
}

/** What goes to the clipboard: a saved scene, marked so Petal knows it again. */
export interface SceneFile extends SavedScene {
  format: typeof SCENE_FORMAT;
  /** The kind of database it came from (`neo4j`): IDs mean something only there. */
  source: string;
}

export const SCENE_FORMAT = "petal-scene/1";
/** The most a saved scene may weigh, as JSON, in a file (nsh writes up to 8 MiB at once). */
export const SCENE_MAX_BYTES = 8_000_000;
/** …and in Storage, the web build's, which holds 5 MB for everything Petal keeps. */
export const STORAGE_SCENE_MAX_BYTES = 1_500_000;

const storageKey = (sourceKey: string) => `scenes:${sourceKey}`;

/** A scene's layout from where the canvas has its nodes now. */
export function layoutOf(ids: Iterable<string>, place: (id: string) => { x: number; y: number } | undefined, pinned: (id: string) => boolean) {
  const out: Record<string, NodePlace> = {};
  for (const id of ids) {
    const p = place(id);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const x = Math.round(p.x * 10) / 10;
    const y = Math.round(p.y * 10) / 10;
    out[id] = pinned(id) ? [x, y, 1] : [x, y];
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Reads a scene back from JSON, checking its shape: the scene, or a message saying what is wrong. */
export function parseSceneFile(text: string): { scene: SceneFile } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "The clipboard doesn't hold a Petal scene." };
  }
  if (!isObject(data) || data.format !== SCENE_FORMAT) return { error: "The clipboard doesn't hold a Petal scene." };
  const nodes = Array.isArray(data.nodes) ? data.nodes : null;
  const rels = Array.isArray(data.rels) ? data.rels : null;
  if (!nodes || !rels) return { error: "The scene is damaged: it has no nodes or relationships." };
  const nodeOk = (n: unknown) => isObject(n) && typeof n.id === "string" && Array.isArray(n.labels) && isObject(n.properties);
  const relOk = (r: unknown) =>
    isObject(r) && typeof r.id === "string" && typeof r.type === "string" && typeof r.start === "string" && typeof r.end === "string" && isObject(r.properties);
  if (!nodes.every(nodeOk) || !rels.every(relOk)) return { error: "The scene is damaged: some of its nodes or relationships are incomplete." };
  const layout: Record<string, NodePlace> = {};
  if (isObject(data.layout)) {
    for (const [id, p] of Object.entries(data.layout)) {
      if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") layout[id] = p[2] === 1 ? [p[0], p[1], 1] : [p[0], p[1]];
    }
  }
  return {
    scene: {
      format: SCENE_FORMAT,
      source: typeof data.source === "string" ? data.source : "",
      name: typeof data.name === "string" ? data.name : "",
      savedAt: typeof data.savedAt === "number" ? data.savedAt : Date.now(),
      nodes: nodes as DbNode[],
      rels: rels as DbRel[],
      layout,
    },
  };
}

export function sceneFile(scene: SavedScene, source: string): string {
  const file: SceneFile = { format: SCENE_FORMAT, source, ...scene };
  return JSON.stringify(file);
}

/** The file a saved scene is kept in: its name, made safe, and a short hash so names that clean alike differ. */
export function sceneFileName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return `${safeFileName(name).slice(0, 80)}-${(h >>> 0).toString(36)}.json`;
}

const sorted = (list: SavedScene[]) => [...list].sort((a, b) => b.savedAt - a.savedAt);

/**
 * The saved scenes of the database in use. On the desktops each is a file in Petal's data folder
 * (`scenes/<database>/<name>.json`, the same JSON as a scene file); on the web, one Storage entry holds them.
 */
export function createSavedScenes(options: { files?: boolean } = {}) {
  const files = options.files ?? filesAvailable();
  /** Most recent first. */
  const list = signal<SavedScene[]>([]);
  let key = "";

  async function load(sourceKey: string) {
    key = sourceKey;
    list.set([]);
    try {
      let found: SavedScene[] = [];
      if (files) {
        for (const { text } of await readJsonFiles(scenesFolder(sourceKey))) {
          const parsed = parseSceneFile(text);
          if ("scene" in parsed) found.push(parsed.scene);
        }
      } else {
        const raw = await Storage.getItem(storageKey(sourceKey));
        const parsed = raw ? JSON.parse(raw) : [];
        found = Array.isArray(parsed) ? parsed : [];
      }
      if (key === sourceKey) list.set(sorted(found));
    } catch {
      // an unreadable folder or a damaged entry starts the list empty
    }
  }

  /**
   * Saves `scene`, replacing one of the same name. Resolves with null, or a message when it is too big or
   * can't be written (nothing is changed then).
   */
  async function save(scene: SavedScene, source = ""): Promise<string | null> {
    const max = files ? SCENE_MAX_BYTES : STORAGE_SCENE_MAX_BYTES;
    const text = sceneFile(scene, source);
    if (text.length > max) {
      return `This scene is too big to save (${Math.ceil(text.length / 1000)} kB; Petal keeps up to ${max / 1000} kB). Dismiss some nodes, or export it to a file instead.`;
    }
    const next = sorted([...list().filter((s) => s.name !== scene.name), scene]);
    try {
      if (files) await writeFileIn(scenesFolder(key), sceneFileName(scene.name), text);
      else await Storage.setItem(storageKey(key), JSON.stringify(next));
      list.set(next);
      return null;
    } catch (e) {
      return files ? `Couldn't save the scene: ${e instanceof Error ? e.message : String(e)}` : "Petal's storage is full. Delete some saved scenes, then save again.";
    }
  }

  async function remove(name: string) {
    const next = list().filter((s) => s.name !== name);
    try {
      if (files) await removeFileIn(scenesFolder(key), sceneFileName(name));
      else await Storage.setItem(storageKey(key), JSON.stringify(next));
      list.set(next);
    } catch {
      // the list stays as it was
    }
  }

  return { list, load, save, remove, files };
}

export type SavedScenes = ReturnType<typeof createSavedScenes>;
