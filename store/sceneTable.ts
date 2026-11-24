/**
 * The scene as tables, as Graph Explorer's table view has it: a row per node or relationship, filtered by
 * words, sorted by a column, and written out as CSV or JSON. Plain functions of the scene, so tests check them.
 */
import { nodeCaption, valueText, type DbNode, type DbRel, type Value } from "../graph/model";

export type TableKind = "nodes" | "rels";

export interface NodeRow {
  id: string;
  caption: string;
  labels: string;
  category: string;
  /** Relationships it has in the scene. */
  degree: number;
  hidden: boolean;
}

export interface RelRow {
  id: string;
  type: string;
  from: string;
  to: string;
  start: string;
  end: string;
  hidden: boolean;
}

export interface SortBy {
  key: string;
  direction: "ascending" | "descending";
}

/** How the table sees the perspective: a node's category, its caption property, and what is hidden. */
export interface TableLens {
  categoryOf(n: DbNode): string;
  captionKey(category: string): string | undefined;
  categoryHidden(category: string): boolean;
  typeHidden(type: string): boolean;
}

export function nodeRows(nodes: Map<string, DbNode>, rels: Map<string, DbRel>, lens: TableLens): NodeRow[] {
  const degree = new Map<string, number>();
  for (const r of rels.values()) {
    degree.set(r.start, (degree.get(r.start) ?? 0) + 1);
    if (r.end !== r.start) degree.set(r.end, (degree.get(r.end) ?? 0) + 1);
  }
  const out: NodeRow[] = [];
  for (const n of nodes.values()) {
    const category = lens.categoryOf(n);
    out.push({
      id: n.id,
      caption: nodeCaption(n, lens.captionKey(category)),
      labels: n.labels.join(", "),
      category,
      degree: degree.get(n.id) ?? 0,
      hidden: lens.categoryHidden(category),
    });
  }
  return out;
}

export function relRows(nodes: Map<string, DbNode>, rels: Map<string, DbRel>, lens: TableLens): RelRow[] {
  const caption = (id: string) => {
    const n = nodes.get(id);
    return n ? nodeCaption(n, lens.captionKey(lens.categoryOf(n))) : id;
  };
  const hiddenNode = (id: string) => {
    const n = nodes.get(id);
    return !n || lens.categoryHidden(lens.categoryOf(n));
  };
  const out: RelRow[] = [];
  for (const r of rels.values()) {
    out.push({
      id: r.id,
      type: r.type,
      from: caption(r.start),
      to: caption(r.end),
      start: r.start,
      end: r.end,
      hidden: lens.typeHidden(r.type) || hiddenNode(r.start) || hiddenNode(r.end),
    });
  }
  return out;
}

/** Whether any of the row's columns, or a property of the element behind it, contains every word. */
export function matchesFilter(texts: string[], properties: Record<string, Value> | undefined, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [...texts, ...Object.values(properties ?? {}).map(valueText)].join("\u0000").toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function filterNodeRows(rows: NodeRow[], nodes: Map<string, DbNode>, filter: string): NodeRow[] {
  if (!filter.trim()) return rows;
  return rows.filter((r) => matchesFilter([r.caption, r.labels, r.id], nodes.get(r.id)?.properties, filter));
}

export function filterRelRows(rows: RelRow[], rels: Map<string, DbRel>, filter: string): RelRow[] {
  if (!filter.trim()) return rows;
  return rows.filter((r) => matchesFilter([r.type, r.from, r.to, r.id], rels.get(r.id)?.properties, filter));
}

/** Text as people read it: case aside, and runs of digits by their number ("item 9" before "item 10"). */
export function naturalCompare(a: string, b: string): number {
  const split = (s: string) => s.toLowerCase().match(/\d+|\D+/g) ?? [];
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    const digits = /^\d/.test(p) && /^\d/.test(q);
    if (digits) {
      const d = p.replace(/^0+/, "").length - q.replace(/^0+/, "").length || (p.replace(/^0+/, "") < q.replace(/^0+/, "") ? -1 : 1);
      if (d) return d;
    } else return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

/** The rows sorted by a column: numbers as numbers, text as people read it. A new array; ties keep their order. */
export function sortRows<T extends object>(rows: T[], by: SortBy | null): T[] {
  if (!by) return rows;
  const sign = by.direction === "descending" ? -1 : 1;
  const key = by.key as keyof T;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const x = a.row[key];
      const y = b.row[key];
      const c = typeof x === "number" && typeof y === "number" ? x - y : naturalCompare(String(x), String(y));
      return c * sign || a.i - b.i;
    })
    .map((e) => e.row);
}

// ---------------------------------------------------------------------------------------------------------
// Export

/** A CSV field, quoted when it must be (RFC 4180). */
export function csvField(text: string): string {
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n") + "\r\n";
}

/** Every property key of the elements, sorted: the CSV's property columns. */
function propertyKeys(elements: { properties: Record<string, Value> }[]): string[] {
  const keys = new Set<string>();
  for (const e of elements) for (const k of Object.keys(e.properties)) keys.add(k);
  return [...keys].sort((a, b) => a.localeCompare(b));
}

const cell = (v: Value | undefined) => (!v || v.type === "Null" ? "" : valueText(v));

/** The nodes as CSV: id, labels, then a column per property key. */
export function nodesCsv(nodes: DbNode[]): string {
  const keys = propertyKeys(nodes);
  return csv(
    ["id", "labels", ...keys],
    nodes.map((n) => [n.id, n.labels.join(";"), ...keys.map((k) => cell(n.properties[k]))]),
  );
}

/** The relationships as CSV: id, type, start and end ids, then a column per property key. */
export function relsCsv(rels: DbRel[]): string {
  const keys = propertyKeys(rels);
  return csv(
    ["id", "type", "start", "end", ...keys],
    rels.map((r) => [r.id, r.type, r.start, r.end, ...keys.map((k) => cell(r.properties[k]))]),
  );
}

/** A value as plain JSON: integers that fit stay numbers, larger ones keep their digits as text. */
export function plainValue(v: Value): unknown {
  switch (v.type) {
    case "Null":
      return null;
    case "Boolean":
    case "Float":
    case "String":
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

function plainProperties(props: Record<string, Value>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = plainValue(v);
  return out;
}

export function nodesJson(nodes: DbNode[]): string {
  return JSON.stringify(
    nodes.map((n) => ({ id: n.id, labels: n.labels, properties: plainProperties(n.properties) })),
    null,
    2,
  );
}

export function relsJson(rels: DbRel[]): string {
  return JSON.stringify(
    rels.map((r) => ({ id: r.id, type: r.type, start: r.start, end: r.end, properties: plainProperties(r.properties) })),
    null,
    2,
  );
}
