/**
 * PuppyGraph (puppygraph.com): a graph query engine over relational tables and lakes, queried in openCypher
 * over Bolt, through the same `BoltClient` as Memgraph.
 *
 * PuppyGraph's openCypher is a subset, and these statements keep to what its documentation lists:
 * - IDs are text such as `person[v1]` (the label and the ID column), read with `elementId()`;
 * - `startNode()` and `endNode()` don't work on matched relationships, so outgoing and incoming
 *   relationships are counted apart;
 * - the schema is declared, not inferred: `db.labels()`, `db.relationshipTypes()` and
 *   `db.schema.visualization()` read it without scanning the tables;
 * - `toLower()`, `toString()` and `any()` aren't documented, so text search reads candidates and Petal
 *   checks their properties itself, as it does for HawDB.
 */
import { BoltClient } from "petal/native";
import { labelCountsStatement, orient, relCountsStatement } from "./cypher";
import { decodeRows, graphOf, plainRows, type NativeResult } from "./encoded";
import { filterRows } from "./hawdb";
import { asNumber, cypherName, valueText, type DbRel, type GraphResult } from "./model";
import { boltUri } from "./memgraph";
import { EMPTY_SCHEMA, SourceError, type Direction, type ExpandOptions, type GraphSource, type NeighborhoodEntry, type Schema, type SearchSpec } from "./source";

export interface PuppyGraphConnection {
  /** `bolt://host:7687`, or `host:port`. */
  url: string;
  user: string;
  password: string;
}

/** How many candidates a text search reads before Petal checks them. */
export const PUPPY_TEXT_SCAN = 5000;

export interface PuppyStatement {
  statement: string;
  parameters: Record<string, unknown>;
  /** Per pattern node (`n0`, `n1`, …): words one of its properties must contain, which Petal checks itself. */
  text?: (string | undefined)[];
}

const int = (n: number) => String(Math.max(1, Math.floor(n)));

function relPattern(v: string, type: string | undefined, direction: Direction): string {
  const inner = `[${v}${type ? ":" + cypherName(type) : ""}]`;
  return direction === "out" ? `-${inner}->` : direction === "in" ? `<-${inner}-` : `-${inner}-`;
}

export function puppySearch(spec: SearchSpec, limit: number, schema: Schema): PuppyStatement {
  if (spec.kind === "raw") return { statement: spec.statement, parameters: {} };
  if (spec.kind === "text") return { statement: `MATCH (n0) RETURN n0 LIMIT ${PUPPY_TEXT_SCAN}`, parameters: {}, text: [spec.term] };
  let pattern = "";
  const columns: string[] = [];
  spec.nodes.forEach((step, i) => {
    pattern += `(n${i}${step.label ? ":" + cypherName(step.label) : ""})`;
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
    statement: `MATCH ${pattern} RETURN ${columns.join(", ")} LIMIT ${filtered ? PUPPY_TEXT_SCAN : int(limit)}`,
    parameters: {},
    text: filtered ? text : undefined,
  };
}

export function puppyExpand(ids: string[], options: ExpandOptions): PuppyStatement {
  const m = `(n1${options.label ? ":" + cypherName(options.label) : ""})`;
  const match = `MATCH (n0)${relPattern("r0", options.type, options.direction ?? "both")}${m} WHERE elementId(n0) IN $ids`;
  if (!options.text) return { statement: `${match} RETURN n0, r0, n1 LIMIT ${int(options.limit)}`, parameters: { ids } };
  return { statement: `${match} RETURN n0, r0, n1 LIMIT ${PUPPY_TEXT_SCAN}`, parameters: { ids }, text: [undefined, options.text] };
}

export function puppyAmong(ids: string[]): PuppyStatement {
  return { statement: "MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids AND elementId(b) IN $ids RETURN r", parameters: { ids } };
}

export function puppyNeighborhood(id: string, direction: "out" | "in"): PuppyStatement {
  const arrow = direction === "out" ? "-[r]->" : "<-[r]-";
  return { statement: `MATCH (n)${arrow}() WHERE elementId(n) = $id RETURN type(r) AS type, count(*) AS count`, parameters: { id } };
}

/** The statements PuppyGraph's declared schema is read with. */
export const PUPPY_SCHEMA = {
  labels: "CALL db.labels()",
  types: "CALL db.relationshipTypes()",
  patterns: "CALL db.schema.visualization()",
  /** If the procedure isn't there: a sample of the data. */
  samplePatterns: "MATCH (a)-[r]->(b) RETURN DISTINCT labels(a) AS f, type(r) AS t, labels(b) AS e LIMIT 2000",
};

/** The `from type to` patterns of `db.schema.visualization()`'s nodes (one per label) and relationships. */
export function schemaPatterns(res: NativeResult): Schema["patterns"] {
  const labelOf = new Map<string, string>();
  for (const n of res.nodes) {
    const name = n.properties.name;
    labelOf.set(n.id, n.labels[0] ?? (name ? valueText(name) : ""));
  }
  const seen = new Set<string>();
  const out: Schema["patterns"] = [];
  for (const r of res.rels) {
    const from = labelOf.get(r.start);
    const to = labelOf.get(r.end);
    if (!from || !to) continue;
    const key = `${from}|${r.type}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, type: r.type, to });
  }
  return out;
}

export class PuppyGraphSource implements GraphSource {
  readonly kind = "puppygraph" as const;
  readonly language = "Cypher" as const;
  readonly label: string;
  readonly key: string;
  private client: BoltClient | null;
  private schemaCache: Schema = EMPTY_SCHEMA;

  private constructor(client: BoltClient, uri: string) {
    this.client = client;
    this.label = uri.replace(/^[a-z+]+:\/\//, "");
    this.key = `puppygraph:${uri}`;
  }

  static async connect(conn: PuppyGraphConnection): Promise<PuppyGraphSource> {
    const uri = boltUri(conn.url, "PuppyGraph");
    const client = new BoltClient();
    try {
      await client.connect(uri, conn.user, conn.password, "");
    } catch (e) {
      client.dispose();
      throw new SourceError(connectError(e, uri), "BOLT_CONNECT");
    }
    return new PuppyGraphSource(client, uri);
  }

  close() {
    try {
      this.client?.close();
      this.client?.dispose();
    } catch {
      // already gone
    }
    this.client = null;
  }

  async run(st: { statement: string; parameters: Record<string, unknown> }): Promise<NativeResult> {
    if (!this.client) throw new SourceError("The connection is closed.", "CLOSED");
    try {
      return decodeRows(await this.client.query(st.statement, JSON.stringify(st.parameters)));
    } catch (e) {
      throw new SourceError(queryError(e), "BOLT_QUERY");
    }
  }

  async schema(): Promise<Schema> {
    const names = async (statement: string) => (await this.run({ statement, parameters: {} })).rows.map((r) => valueText(r[0])).filter(Boolean);
    const [labelNames, typeNames] = await Promise.all([names(PUPPY_SCHEMA.labels), names(PUPPY_SCHEMA.types)]);
    // Counting reads every table, which can take long on a lake: the schema stands without counts.
    const counts = async (statement: { statement: string; parameters: Record<string, unknown> } | null) => {
      const out = new Map<string, number>();
      if (!statement) return out;
      try {
        for (const r of (await this.run(statement)).rows) out.set(valueText(r[0]), asNumber(r[1]) ?? 0);
      } catch {
        // no counts
      }
      return out;
    };
    const [labelCounts, typeCounts] = await Promise.all([
      counts(labelNames.length ? labelCountsStatement(labelNames) : null),
      counts(typeNames.length ? relCountsStatement(typeNames) : null),
    ]);
    const counted = (list: string[], c: Map<string, number>) =>
      list.map((name) => ({ name, count: c.get(name) })).sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));

    let patterns: Schema["patterns"] = [];
    try {
      patterns = schemaPatterns(await this.run({ statement: PUPPY_SCHEMA.patterns, parameters: {} }));
    } catch {
      patterns = [];
    }
    if (!patterns.length && typeNames.length) {
      try {
        const sample = await this.run({ statement: PUPPY_SCHEMA.samplePatterns, parameters: {} });
        const seen = new Set<string>();
        for (const [f, t, e] of sample.rows) {
          const froms = f.type === "List" ? f.value.map(valueText) : [];
          const tos = e.type === "List" ? e.value.map(valueText) : [];
          for (const from of froms) {
            for (const to of tos) {
              const key = `${from}|${valueText(t)}|${to}`;
              if (seen.has(key)) continue;
              seen.add(key);
              patterns.push({ from, type: valueText(t), to });
            }
          }
        }
      } catch {
        // no patterns: searches go both ways
      }
    }
    this.schemaCache = { labels: counted(labelNames, labelCounts), relTypes: counted(typeNames, typeCounts), patterns };
    return this.schemaCache;
  }

  async search(spec: SearchSpec, limit: number): Promise<GraphResult> {
    const st = puppySearch(spec, limit, this.schemaCache);
    const res = await this.run(st);
    if (!st.text) return { nodes: res.nodes, rels: res.rels, rows: res.cells.length, table: { columns: res.columns, rows: res.rows } };
    const rows = filterRows(res.cells, res.columns, st.text, limit);
    return { ...graphOf(rows), rows: rows.length, table: { columns: res.columns, rows: plainRows(rows) } };
  }

  async expand(ids: string[], options: ExpandOptions): Promise<GraphResult> {
    const st = puppyExpand(ids, options);
    const res = await this.run(st);
    if (!st.text) return { nodes: res.nodes, rels: res.rels, rows: res.cells.length };
    const rows = filterRows(res.cells, res.columns, st.text, options.limit);
    return { ...graphOf(rows), rows: rows.length };
  }

  async relationshipsAmong(ids: string[]): Promise<DbRel[]> {
    if (!ids.length) return [];
    return (await this.run(puppyAmong(ids))).rels;
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const entries: NeighborhoodEntry[] = [];
    for (const direction of ["out", "in"] as const) {
      for (const r of (await this.run(puppyNeighborhood(id, direction))).rows) {
        entries.push({ type: valueText(r[0]), direction, count: asNumber(r[1]) ?? 0 });
      }
    }
    return entries.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }
}

function connectError(e: unknown, uri: string): string {
  const msg = (e instanceof Error ? e.message : String(e)).trim();
  const host = uri.replace(/^[a-z+]+:\/\//, "");
  if (/authenticat|credentials|unauthori[sz]ed|password/i.test(msg)) return "The user name or password is wrong.";
  if (/refused|unreachable|resolve|No such host|timed out|didn't answer|connection/i.test(msg)) return `Couldn't reach ${host}. Check the address and that PuppyGraph is running. (${msg})`;
  if (/web version|desktop version/i.test(msg)) return msg;
  return `Couldn't connect to ${host}: ${msg}`;
}

function queryError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)).trim();
  // PuppyGraph answers for a minute or so after it starts before its Cypher engine is ready.
  if (/engine unavailable/i.test(msg)) return "PuppyGraph's Cypher engine is still starting. Try again in a minute.";
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}
