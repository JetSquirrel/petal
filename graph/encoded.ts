/**
 * Rows as Petal's Rust crate (`petal/native`) returns them, from HawDB and from Bolt databases: JSON in Petal's
 * value encoding, with nodes and relationships as values of their own.
 */
import type { DbNode, DbRel, Value } from "./model";

/** A value as `petal/native` encodes it: Petal's `Value`, plus nodes and relationships. */
export type Encoded =
  | Value
  | { type: "Node"; id: string; labels: string[]; properties: Record<string, Encoded> }
  | { type: "Relationship"; id: string; start: string; end: string; relType: string; properties: Record<string, Encoded> };

export interface NativeResult {
  columns: string[];
  /** The rows as `petal/native` gave them, nodes and relationships included. */
  cells: Encoded[][];
  /** The rows as values: a node or relationship shows as text. */
  rows: Value[][];
  nodes: DbNode[];
  rels: DbRel[];
}

function props(p: Record<string, Encoded>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(p)) out[k] = plain(v);
  return out;
}

function plain(v: Encoded): Value {
  switch (v.type) {
    case "Node":
      return { type: "Text", kind: "Node", value: `(:${v.labels.join(":")})` };
    case "Relationship":
      return { type: "Text", kind: "Relationship", value: `[:${v.relType}]` };
    case "List":
      return { type: "List", value: (v.value as Encoded[]).map(plain) };
    case "Map":
      return { type: "Map", value: props(v.value as Record<string, Encoded>) };
    default:
      return v;
  }
}

export const toNode = (v: Extract<Encoded, { type: "Node" }>): DbNode => ({ id: v.id, labels: v.labels, properties: props(v.properties) });
const toRel = (v: Extract<Encoded, { type: "Relationship" }>): DbRel => ({
  id: v.id,
  type: v.relType,
  start: v.start,
  end: v.end,
  properties: props(v.properties),
});

function collect(v: Encoded, nodes: Map<string, DbNode>, rels: Map<string, DbRel>) {
  if (v.type === "Node") nodes.set(v.id, toNode(v));
  else if (v.type === "Relationship") rels.set(v.id, toRel(v));
  else if (v.type === "List") for (const x of v.value as Encoded[]) collect(x, nodes, rels);
  else if (v.type === "Map") for (const x of Object.values(v.value as Record<string, Encoded>)) collect(x, nodes, rels);
}

/** Reads what `HawDb.query` and `BoltClient.query` return. */
export function decodeRows(json: string): NativeResult {
  const parsed = JSON.parse(json) as { columns: string[]; rows: Encoded[][] };
  return { columns: parsed.columns, cells: parsed.rows, ...graphOf(parsed.rows), rows: plainRows(parsed.rows) };
}

/** Rows as values: a node or relationship shows as text. */
export function plainRows(cells: Encoded[][]): Value[][] {
  return cells.map((r) => r.map(plain));
}

export function graphOf(cells: Encoded[][]): { nodes: DbNode[]; rels: DbRel[] } {
  const nodes = new Map<string, DbNode>();
  const rels = new Map<string, DbRel>();
  for (const row of cells) for (const cell of row) collect(cell, nodes, rels);
  return { nodes: [...nodes.values()], rels: [...rels.values()] };
}
