/**
 * HawDB (hawdb.ai): an embedded graph database, linked into Petal through its Rust crate (`src/lib.rs`,
 * imported as `petal/native`). There is no server: Petal opens a folder on this computer and owns it
 * while it is open.
 *
 * HawDB runs a subset of openCypher, which these statements keep to (each form was checked against the
 * engine, `src/tests.rs`):
 * - paths can't be returned, so patterns return their nodes and relationships as columns;
 * - there are no schema procedures, so the schema is counted with `labels()` and `type()`;
 * - names can't be backticked, so labels and types must be plain identifiers;
 * - there is no `keys()` or `any()`, so text search reads candidates and Petal filters them itself;
 * - `startNode(r) = n` isn't an expression, so outgoing and incoming relationships are counted apart.
 */
import { HawDb } from "petal/native";
import { orient } from "./cypher";
import { demoGraph } from "./demoData";
import { decodeRows, graphOf, plainRows, toNode, type Encoded, type NativeResult } from "./encoded";
import { asNumber, valueText, type DbNode, type DbRel, type GraphResult } from "./model";
import {
  EMPTY_SCHEMA,
  SourceError,
  type Direction,
  type ExpandOptions,
  type GraphSource,
  type NeighborhoodEntry,
  type Schema,
  type SearchSpec,
} from "./source";

/** Reads what `HawDb.query` returns. */
export const decodeHawDb = decodeRows;
export type { Encoded };

/** How many candidates a text search reads before Petal filters them. */
export const TEXT_SCAN = 20_000;

// ---------------------------------------------------------------------------------------------------------
// Statements

export interface HawStatement {
  statement: string;
  parameters: Record<string, unknown>;
  /** Per pattern node (`n0`, `n1`, …): words one of its properties must contain, which Petal checks itself. */
  text?: (string | undefined)[];
}

/** A label, type or property name: HawDB takes plain identifiers only. */
export function hawName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new SourceError(`HawDB can't query “${name}”: its Cypher takes names made of letters, digits and _ only.`, "HAWDB_NAME");
  }
  return name;
}

const int = (n: number) => String(Math.max(1, Math.floor(n)));
const ids = (list: string[]) => list.map((id) => Number(id)).filter((n) => Number.isSafeInteger(n));

function relPattern(v: string, type: string | undefined, direction: Direction): string {
  const inner = `[${v}${type ? ":" + hawName(type) : ""}]`;
  return direction === "out" ? `-${inner}->` : direction === "in" ? `<-${inner}-` : `-${inner}-`;
}

export function hawSearch(spec: SearchSpec, limit: number, schema: Schema): HawStatement {
  if (spec.kind === "raw") return { statement: spec.statement, parameters: {} };
  if (spec.kind === "text") return { statement: `MATCH (n0) RETURN n0 LIMIT ${TEXT_SCAN}`, parameters: {}, text: [spec.term] };
  let pattern = "";
  const columns: string[] = [];
  spec.nodes.forEach((step, i) => {
    pattern += `(n${i}${step.label ? ":" + hawName(step.label) : ""})`;
    columns.push(`n${i}`);
    if (i < spec.nodes.length - 1) {
      const type = spec.rels[i]?.type;
      pattern += relPattern(`r${i}`, type, orient(schema, step.label, type, spec.nodes[i + 1].label));
      columns.push(`r${i}`);
    }
  });
  const text = spec.nodes.map((n) => n.text);
  const filtered = text.some(Boolean);
  return {
    statement: `MATCH ${pattern} RETURN ${columns.join(", ")} LIMIT ${filtered ? TEXT_SCAN : int(limit)}`,
    parameters: {},
    text: filtered ? text : undefined,
  };
}

export function hawExpand(nodeIds: string[], options: ExpandOptions): HawStatement {
  const label = options.label ? ":" + hawName(options.label) : "";
  const pattern = (n: string, r: string, m: string) => `MATCH (${n})${relPattern(r, options.type, options.direction ?? "both")}(${m}${label}) WHERE id(${n}) IN $ids`;
  if (!options.text) return { statement: `${pattern("n", "r", "m")} RETURN n, r, m LIMIT ${int(options.limit)}`, parameters: { ids: ids(nodeIds) } };
  // No `keys()` to filter with: read candidates, named as a pattern's columns, and let `filterRows` check `n1`.
  return {
    statement: `${pattern("n0", "r0", "n1")} RETURN n0, r0, n1 LIMIT ${TEXT_SCAN}`,
    parameters: { ids: ids(nodeIds) },
    text: [undefined, options.text],
  };
}

export function hawAmong(nodeIds: string[]): HawStatement {
  return { statement: "MATCH (a)-[r]->(b) WHERE id(a) IN $ids AND id(b) IN $ids RETURN r", parameters: { ids: ids(nodeIds) } };
}

export function hawNeighborhood(id: string, direction: "out" | "in"): HawStatement {
  const arrow = direction === "out" ? "-[r]->" : "<-[r]-";
  return { statement: `MATCH (n)${arrow}() WHERE id(n) = $id RETURN type(r) AS type, count(*) AS count`, parameters: { id: Number(id) } };
}

/** `UNWIND $rows … CREATE` for nodes of one label whose rows set the same keys. */
export function hawCreateNodes(label: string, keys: string[]): string {
  const map = keys.map((k) => `${hawName(k)}: row.${hawName(k)}`).join(", ");
  return `UNWIND $rows AS row CREATE (n:${hawName(label)} {${map}})`;
}

/** `UNWIND $rows … CREATE` for relationships of one type between two labels, found by their `key`. */
export function hawCreateRels(type: string, from: string, to: string, keys: string[]): string {
  const map = keys.length ? ` {${keys.map((k) => `${hawName(k)}: row.p_${hawName(k)}`).join(", ")}}` : "";
  return `UNWIND $rows AS row MATCH (a:${hawName(from)}) WHERE a.key = row.from MATCH (b:${hawName(to)}) WHERE b.key = row.to CREATE (a)-[r:${hawName(type)}${map}]->(b)`;
}

// ---------------------------------------------------------------------------------------------------------

function containsText(n: DbNode, term: string): boolean {
  const t = term.toLowerCase();
  return Object.values(n.properties).some((v) => v.type !== "Null" && valueText(v).toLowerCase().includes(t));
}

/** The rows of a pattern whose nodes contain their words, at most `limit`. */
export function filterRows(cells: Encoded[][], columns: string[], text: (string | undefined)[], limit: number): Encoded[][] {
  const at = text.map((_, i) => columns.indexOf(`n${i}`));
  const out: Encoded[][] = [];
  for (const row of cells) {
    const keep = text.every((t, i) => {
      if (!t) return true;
      const cell = row[at[i]];
      return cell?.type === "Node" && containsText(toNode(cell), t);
    });
    if (keep) out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** The last part of a folder path: what the connection button shows. */
const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

export class HawDbSource implements GraphSource {
  readonly kind = "hawdb" as const;
  readonly language = "Cypher" as const;
  readonly label: string;
  readonly key: string;
  private db: HawDb | null;
  private schemaCache: Schema = EMPTY_SCHEMA;

  private constructor(
    db: HawDb,
    readonly path: string,
  ) {
    this.db = db;
    this.label = path ? folderName(path) : "HawDB in memory";
    this.key = `hawdb:${path}`;
  }

  /** Opens (or creates) the database in `path` (`""`: in memory); `loadDemo` fills a new, empty one with the demo graph. */
  static async open(path: string, options: { loadDemo?: boolean } = {}): Promise<HawDbSource> {
    const folder = path.trim();
    let db: HawDb;
    try {
      db = new HawDb(folder);
    } catch (e) {
      throw new SourceError(openError(e, folder), "HAWDB_OPEN");
    }
    const source = new HawDbSource(db, folder);
    if (options.loadDemo && source.isEmpty()) source.loadDemo();
    return source;
  }

  close() {
    try {
      this.db?.close();
      this.db?.dispose();
    } catch {
      // already gone
    }
    this.db = null;
  }

  run(st: { statement: string; parameters: Record<string, unknown> }): NativeResult {
    if (!this.db) throw new SourceError("The database is closed.", "CLOSED");
    try {
      return decodeRows(this.db.query(st.statement, JSON.stringify(st.parameters)));
    } catch (e) {
      throw new SourceError(cleanError(e), "HAWDB_QUERY");
    }
  }

  private write(statement: string, parameters: Record<string, unknown>) {
    if (!this.db) throw new SourceError("The database is closed.", "CLOSED");
    try {
      this.db.execute(statement, JSON.stringify(parameters));
    } catch (e) {
      throw new SourceError(cleanError(e), "HAWDB_WRITE");
    }
  }

  isEmpty(): boolean {
    return this.run({ statement: "MATCH (n) RETURN n LIMIT 1", parameters: {} }).cells.length === 0;
  }

  /**
   * Writes the demo graph: nodes by label (each node keeps its first label, since a HawDB node takes one in
   * a statement), then relationships by type, found by the nodes' `key`. Rows are grouped by the keys they
   * set, so no property is written as null.
   */
  loadDemo() {
    const g = demoGraph();
    const labelOf = new Map<string, string>();
    const nodeGroups = new Map<string, { label: string; keys: string[]; rows: Record<string, unknown>[] }>();
    for (const n of g.nodes) {
      const label = n.labels[0];
      labelOf.set(n.id, label);
      const row: Record<string, unknown> = { key: n.id };
      for (const [k, v] of Object.entries(n.props)) if (v !== null && v !== undefined) row[k] = demoValue(v);
      const keys = Object.keys(row).sort();
      const id = `${label}|${keys.join(",")}`;
      const group = nodeGroups.get(id) ?? { label, keys, rows: [] };
      group.rows.push(row);
      nodeGroups.set(id, group);
    }
    for (const group of nodeGroups.values()) this.write(hawCreateNodes(group.label, group.keys), { rows: group.rows });

    const relGroups = new Map<string, { type: string; from: string; to: string; keys: string[]; rows: Record<string, unknown>[] }>();
    for (const r of g.rels) {
      const from = labelOf.get(r.from)!;
      const to = labelOf.get(r.to)!;
      const row: Record<string, unknown> = { from: r.from, to: r.to };
      const keys = Object.keys(r.props ?? {}).sort();
      for (const k of keys) row[`p_${k}`] = demoValue((r.props ?? {})[k]);
      const id = `${r.type}|${from}|${to}|${keys.join(",")}`;
      const group = relGroups.get(id) ?? { type: r.type, from, to, keys, rows: [] };
      group.rows.push(row);
      relGroups.set(id, group);
    }
    for (const group of relGroups.values()) this.write(hawCreateRels(group.type, group.from, group.to, group.keys), { rows: group.rows });
  }

  async schema(): Promise<Schema> {
    const count = (statement: string) =>
      this.run({ statement, parameters: {} })
        .rows.map((r) => ({ name: valueText(r[0]), count: asNumber(r[1]) }))
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
    const labels = count("MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS c");
    const relTypes = count("MATCH ()-[r]->() RETURN type(r) AS t, count(*) AS c");
    const patterns: Schema["patterns"] = [];
    const seen = new Set<string>();
    const res = this.run({ statement: "MATCH (a)-[r]->(b) RETURN DISTINCT labels(a) AS f, type(r) AS t, labels(b) AS e", parameters: {} });
    for (const [f, t, e] of res.rows) {
      const froms = f.type === "List" ? f.value.map(valueText) : [];
      const tos = e.type === "List" ? e.value.map(valueText) : [];
      for (const from of froms) {
        for (const to of tos) {
          const key = `${from}|${valueText(t)}|${to}`;
          if (!seen.has(key)) {
            seen.add(key);
            patterns.push({ from, type: valueText(t), to });
          }
        }
      }
    }
    this.schemaCache = { labels, relTypes, patterns };
    return this.schemaCache;
  }

  async search(spec: SearchSpec, limit: number): Promise<GraphResult> {
    const st = hawSearch(spec, limit, this.schemaCache);
    const res = this.run(st);
    if (!st.text) return { nodes: res.nodes, rels: res.rels, rows: res.cells.length, table: { columns: res.columns, rows: res.rows } };
    const rows = filterRows(res.cells, res.columns, st.text, limit);
    return { ...graphOf(rows), rows: rows.length, table: { columns: res.columns, rows: plainRows(rows) } };
  }

  async expand(nodeIds: string[], options: ExpandOptions): Promise<GraphResult> {
    const st = hawExpand(nodeIds, options);
    const res = this.run(st);
    if (!st.text) return { nodes: res.nodes, rels: res.rels, rows: res.cells.length };
    const rows = filterRows(res.cells, res.columns, st.text, options.limit);
    return { ...graphOf(rows), rows: rows.length };
  }

  async relationshipsAmong(nodeIds: string[]): Promise<DbRel[]> {
    if (!nodeIds.length) return [];
    return this.run(hawAmong(nodeIds)).rels;
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const entries: NeighborhoodEntry[] = [];
    for (const direction of ["out", "in"] as const) {
      for (const r of this.run(hawNeighborhood(id, direction)).rows) {
        entries.push({ type: valueText(r[0]), direction, count: asNumber(r[1]) ?? 0 });
      }
    }
    return entries.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }
}

/** A demo value as a HawDB parameter: dates as their text. */
function demoValue(v: unknown): unknown {
  return v && typeof v === "object" && "$date" in (v as object) ? (v as { $date: string }).$date : v;
}

function openError(e: unknown, folder: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/lease|lock|already|in use|being used/i.test(msg)) return `Another app has ${folder} open. HawDB lets one app use a database at a time.`;
  if (/web version/i.test(msg)) return msg;
  return `Couldn't open ${folder || "an in-memory database"}: ${msg}`;
}

function cleanError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)).trim();
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}
