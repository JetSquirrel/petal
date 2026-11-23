/**
 * Petal's data model: what a graph database gives back, independent of where it came from.
 *
 * Property values keep their database type, so an Integer past 2^53 stays exact and a Date shows as a
 * date rather than a bare string.
 */

export type Value =
  | { type: "Null" }
  | { type: "Boolean"; value: boolean }
  /** Exact decimal digits: Neo4j integers are 64-bit. */
  | { type: "Integer"; value: string }
  | { type: "Float"; value: number }
  | { type: "String"; value: string }
  | { type: "List"; value: Value[] }
  | { type: "Map"; value: Record<string, Value> }
  /** Date, Time, LocalTime, DateTime, LocalDateTime, Duration, Point, Base64 and the rest: their text form. */
  | { type: "Text"; kind: string; value: string };

export interface DbNode {
  id: string;
  labels: string[];
  properties: Record<string, Value>;
}

export interface DbRel {
  id: string;
  type: string;
  start: string;
  end: string;
  properties: Record<string, Value>;
}

/** A query's rows as the database returned them, nodes and relationships in them as `Text` values. */
export interface Table {
  columns: string[];
  rows: Value[][];
}

/** The graph part of a query's result. */
export interface GraphResult {
  nodes: DbNode[];
  rels: DbRel[];
  /** Rows the query returned, graph or not. */
  rows: number;
  /** The rows themselves, when the source keeps them: the notebook's table, and what MCP tools answer with. */
  table?: Table;
}

export const EMPTY_RESULT: GraphResult = { nodes: [], rels: [], rows: 0 };

export function mergeResults(a: GraphResult, b: GraphResult): GraphResult {
  return { nodes: [...a.nodes, ...b.nodes], rels: [...a.rels, ...b.rels], rows: a.rows + b.rows };
}

/** A plain JSON value (as Neo4j's transactional API and Petal's demo data give them) as a `Value`. */
export function fromPlain(v: unknown): Value {
  if (v === null || v === undefined) return { type: "Null" };
  if (typeof v === "boolean") return { type: "Boolean", value: v };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "Integer", value: String(v) } : { type: "Float", value: v };
  if (typeof v === "string") return { type: "String", value: v };
  if (Array.isArray(v)) return { type: "List", value: v.map(fromPlain) };
  if (typeof v === "object") {
    const out: Record<string, Value> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = fromPlain(x);
    return { type: "Map", value: out };
  }
  return { type: "String", value: String(v) };
}

export function plainProps(props: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(props)) out[k] = fromPlain(v);
  return out;
}

/** The value as one line of text: what a caption, a search or a copy uses. */
export function valueText(v: Value): string {
  switch (v.type) {
    case "Null":
      return "null";
    case "Boolean":
      return v.value ? "true" : "false";
    case "Integer":
      return v.value;
    case "Float":
      return formatFloat(v.value);
    case "String":
    case "Text":
      return v.value;
    case "List":
      return `[${v.value.map(valueText).join(", ")}]`;
    case "Map":
      return `{${Object.entries(v.value)
        .map(([k, x]) => `${k}: ${valueText(x)}`)
        .join(", ")}}`;
  }
}

function formatFloat(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return `${n}.0`;
  return String(Math.round(n * 1e6) / 1e6);
}

/** A short name for the value's type, shown beside it in the inspector. */
export function valueKind(v: Value): string {
  switch (v.type) {
    case "Text":
      return v.kind;
    case "List":
      return v.value.length ? `List of ${v.value.length}` : "List";
    default:
      return v.type;
  }
}

export function asNumber(v: Value | undefined): number | undefined {
  if (!v) return undefined;
  if (v.type === "Integer") return Number(v.value);
  if (v.type === "Float") return v.value;
  return undefined;
}

/** Property keys that usually name a node, best first. */
const CAPTION_KEYS = ["name", "title", "caption", "label", "displayName", "fullName", "username", "login", "code", "key", "id", "uid"];

/** The property a node is captioned with when its category does not choose one. */
export function defaultCaptionKey(props: Record<string, Value>): string | undefined {
  const keys = Object.keys(props);
  for (const k of CAPTION_KEYS) {
    const hit = keys.find((x) => x.toLowerCase() === k.toLowerCase());
    if (hit && props[hit].type !== "Null") return hit;
  }
  return keys.find((k) => props[k].type === "String");
}

export function nodeCaption(node: DbNode, key?: string): string {
  const k = key && node.properties[key] ? key : defaultCaptionKey(node.properties);
  const text = k ? valueText(node.properties[k]) : node.labels[0] ?? node.id;
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

/** Backticks a label, relationship type or property key for Cypher. */
export function cypherName(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}
