/**
 * Memgraph over Bolt, through Petal's Rust crate (`BoltClient` of `petal/native`): Memgraph speaks Bolt only,
 * a binary protocol TSX can't send.
 *
 * Memgraph's Cypher is close to Neo4j's, so the statements are `cypher.ts`'s with its Memgraph dialect. It
 * has `elementId()` (the integer ID as text), `values()` and `toStringOrNull()`; it keeps no count store and
 * has no `db.labels()` without schema metadata, so the schema is counted with `labels()` and `type()`, a
 * scan that its in-memory storage makes quick.
 */
import { BoltClient } from "petal/native";
import { expandStatement, neighborhoodStatement, relationshipsAmongStatement, searchStatement, type Statement } from "./cypher";
import { decodeRows, type NativeResult } from "./encoded";
import { asNumber, valueText, type DbRel, type GraphResult } from "./model";
import { EMPTY_SCHEMA, SourceError, type ExpandOptions, type GraphSource, type NeighborhoodEntry, type Schema, type SearchSpec } from "./source";

export interface MemgraphConnection {
  /** `bolt://host:7687`, `bolt+s://…` for TLS, or `host:port`. */
  url: string;
  user: string;
  password: string;
  /** A database of a multi-tenant Memgraph; empty for the default. */
  database: string;
}

/** A Bolt URI: `bolt://` added when there is no scheme; `neo4j://` schemes become `bolt://`, Memgraph routes nothing. */
export function boltUri(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!url) throw new SourceError("Enter the database's address.");
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (!m) return `bolt://${url.includes(":") ? url : `${url}:7687`}`;
  const scheme = m[1].toLowerCase();
  const rest = m[2].replace(/\/.*$/, "");
  const map: Record<string, string> = { bolt: "bolt", "bolt+s": "bolt+s", "bolt+ssc": "bolt+ssc", neo4j: "bolt", "neo4j+s": "bolt+s", "neo4j+ssc": "bolt+ssc" };
  if (!map[scheme]) throw new SourceError(`Memgraph speaks Bolt: use a bolt:// address, not ${scheme}://.`);
  return `${map[scheme]}://${rest.includes(":") ? rest : `${rest}:7687`}`;
}

/** The statements Memgraph's schema is read with. */
export const MEMGRAPH_SCHEMA = {
  labels: "MATCH (n) UNWIND labels(n) AS name RETURN name, count(*) AS count",
  types: "MATCH ()-[r]->() RETURN type(r) AS name, count(*) AS count",
  patterns: "MATCH (a)-[r]->(b) RETURN DISTINCT labels(a) AS f, type(r) AS t, labels(b) AS e LIMIT 2000",
};

export class MemgraphSource implements GraphSource {
  readonly kind = "memgraph" as const;
  readonly language = "Cypher" as const;
  readonly label: string;
  readonly key: string;
  private client: BoltClient | null;
  private schemaCache: Schema = EMPTY_SCHEMA;

  private constructor(client: BoltClient, uri: string, database: string) {
    this.client = client;
    const host = uri.replace(/^[a-z+]+:\/\//, "");
    this.label = database ? `${host}/${database}` : host;
    this.key = `memgraph:${uri}/${database}`;
  }

  static async connect(conn: MemgraphConnection): Promise<MemgraphSource> {
    const uri = boltUri(conn.url);
    const client = new BoltClient();
    try {
      await client.connect(uri, conn.user, conn.password, conn.database.trim());
    } catch (e) {
      client.dispose();
      throw new SourceError(connectError(e, uri), "BOLT_CONNECT");
    }
    return new MemgraphSource(client, uri, conn.database.trim());
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

  async run(st: Statement): Promise<NativeResult> {
    if (!this.client) throw new SourceError("The connection is closed.", "CLOSED");
    try {
      return decodeRows(await this.client.query(st.statement, JSON.stringify(st.parameters)));
    } catch (e) {
      throw new SourceError(cleanError(e), "BOLT_QUERY");
    }
  }

  private column(res: NativeResult, name: string) {
    return res.columns.indexOf(name);
  }

  async schema(): Promise<Schema> {
    const counted = async (statement: string) => {
      const res = await this.run({ statement, parameters: {} });
      const [name, count] = [this.column(res, "name"), this.column(res, "count")];
      return res.rows
        .map((r) => ({ name: valueText(r[name]), count: asNumber(r[count]) }))
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
    };
    const [labels, relTypes, sample] = await Promise.all([
      counted(MEMGRAPH_SCHEMA.labels),
      counted(MEMGRAPH_SCHEMA.types),
      this.run({ statement: MEMGRAPH_SCHEMA.patterns, parameters: {} }),
    ]);
    const [f, t, e] = ["f", "t", "e"].map((c) => this.column(sample, c));
    const seen = new Set<string>();
    const patterns: Schema["patterns"] = [];
    for (const row of sample.rows) {
      const froms = row[f].type === "List" ? row[f].value.map(valueText) : [];
      const tos = row[e].type === "List" ? row[e].value.map(valueText) : [];
      for (const from of froms) {
        for (const to of tos) {
          const key = `${from}|${valueText(row[t])}|${to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          patterns.push({ from, type: valueText(row[t]), to });
        }
      }
    }
    this.schemaCache = { labels, relTypes, patterns };
    return this.schemaCache;
  }

  async search(spec: SearchSpec, limit: number): Promise<GraphResult> {
    const res = await this.run(searchStatement(spec, limit, this.schemaCache, "memgraph"));
    return { nodes: res.nodes, rels: res.rels, rows: res.cells.length };
  }

  async expand(ids: string[], options: ExpandOptions): Promise<GraphResult> {
    const res = await this.run(expandStatement(ids, options));
    return { nodes: res.nodes, rels: res.rels, rows: res.cells.length };
  }

  async relationshipsAmong(ids: string[]): Promise<DbRel[]> {
    if (!ids.length) return [];
    return (await this.run(relationshipsAmongStatement(ids))).rels;
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const res = await this.run(neighborhoodStatement(id));
    const [type, out, count] = ["type", "outgoing", "count"].map((c) => this.column(res, c));
    return res.rows.map((r) => ({
      type: valueText(r[type]),
      direction: r[out].type === "Boolean" && r[out].value ? "out" : "in",
      count: asNumber(r[count]) ?? 0,
    }));
  }
}

function connectError(e: unknown, uri: string): string {
  const msg = (e instanceof Error ? e.message : String(e)).trim();
  const host = uri.replace(/^[a-z+]+:\/\//, "");
  if (/authenticat|credentials|unauthori[sz]ed|password/i.test(msg)) return "The user name or password is wrong.";
  if (/refused|unreachable|resolve|No such host|timed out|didn't answer|connection/i.test(msg)) return `Couldn't reach ${host}. Check the address and that Memgraph is running. (${msg})`;
  if (/web version|desktop version/i.test(msg)) return msg;
  return `Couldn't connect to ${host}: ${msg}`;
}

function cleanError(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)).trim();
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}
