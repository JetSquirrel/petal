/**
 * The scene: the nodes and relationships on the canvas, and the steps that changed them, so each can be
 * undone. Maps are replaced, never mutated, so signals readers see every change.
 */
import { computed, signal } from "nsh";
import type { DbNode, DbRel, GraphResult } from "../graph/model";

interface Snapshot {
  nodes: Map<string, DbNode>;
  rels: Map<string, DbRel>;
}

export interface SceneChange {
  addedNodes: number;
  addedRels: number;
}

const HISTORY = 40;

export function createScene() {
  const nodes = signal<Map<string, DbNode>>(new Map());
  const rels = signal<Map<string, DbRel>>(new Map());
  const history = signal<Snapshot[]>([]);

  const remember = () => history.update((h) => [...h.slice(-(HISTORY - 1)), { nodes: nodes(), rels: rels() }]);

  /** Adds what a query found; relationships whose ends are not in the scene stay out. */
  function add(result: Pick<GraphResult, "nodes" | "rels">, options: { record?: boolean } = {}): SceneChange {
    const n = new Map(nodes());
    const r = new Map(rels());
    let addedNodes = 0;
    let addedRels = 0;
    for (const node of result.nodes) {
      if (!n.has(node.id)) addedNodes++;
      n.set(node.id, node);
    }
    for (const rel of result.rels) {
      if (!n.has(rel.start) || !n.has(rel.end)) continue;
      if (!r.has(rel.id)) addedRels++;
      r.set(rel.id, rel);
    }
    if (addedNodes || addedRels) {
      if (options.record !== false) remember();
      nodes.set(n);
      rels.set(r);
    }
    return { addedNodes, addedRels };
  }

  /** Takes nodes out of the scene, with their relationships. */
  function dismiss(ids: Iterable<string>) {
    const gone = new Set(ids);
    if (![...gone].some((id) => nodes().has(id))) return 0;
    remember();
    const n = new Map(nodes());
    for (const id of gone) n.delete(id);
    const r = new Map([...rels()].filter(([, rel]) => !gone.has(rel.start) && !gone.has(rel.end)));
    nodes.set(n);
    rels.set(r);
    return gone.size;
  }

  function dismissRel(id: string) {
    if (!rels().has(id)) return;
    remember();
    const r = new Map(rels());
    r.delete(id);
    rels.set(r);
  }

  /** Keeps `ids` and drops every other node. */
  function keepOnly(ids: Iterable<string>) {
    const keep = new Set(ids);
    return dismiss([...nodes().keys()].filter((id) => !keep.has(id)));
  }

  function clear() {
    if (nodes().size === 0) return;
    remember();
    nodes.set(new Map());
    rels.set(new Map());
  }

  function undo(): boolean {
    const h = history();
    const last = h[h.length - 1];
    if (!last) return false;
    history.set(h.slice(0, -1));
    nodes.set(last.nodes);
    rels.set(last.rels);
    return true;
  }

  /** Drops the undo steps: a new database, say. */
  function reset() {
    history.set([]);
    nodes.set(new Map());
    rels.set(new Map());
  }

  const canUndo = computed(() => history().length > 0);

  return { nodes, rels, add, dismiss, dismissRel, keepOnly, clear, undo, reset, canUndo };
}

export type Scene = ReturnType<typeof createScene>;
