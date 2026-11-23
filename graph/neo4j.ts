/**
 * A Neo4j database over HTTP: the Query API (`/db/{name}/query/v2`, Neo4j 5.19 and later, Aura) with typed
 * JSON results, else the transactional endpoint (`/db/{name}/tx/commit`) of earlier 5.x servers.
 *
 * NSH's `fetch` has no CORS, so the app talks to the database directly; nothing sits in between.
 */
import {
  expandStatement,
  labelCountsStatement,
  neighborhoodStatement,
  relCountsStatement,
  relationshipsAmongStatement,
  searchStatement,
  type Statement,
} from "./cypher";
import { asNumber, fromPlain, plainProps, valueText, type DbNode, type DbRel, type GraphResult, type Value } from "./model";
import {
  EMPTY_SCHEMA,
  SourceError,
  type ExpandOptions,
  type GraphSource,
  type NeighborhoodEntry,
  type Schema,
  type SearchSpec,
} from "./source";

export interface Neo4jConnection {
  /** `http://localhost:7474`, `https://xxxx.databases.neo4j.io`, or a Bolt URI (`neo4j+s://…`), which maps to HTTP. */
  url: string;
  user: string;
  password: string;
  /** Default `neo4j`. */
  database: string;
}

/** What a statement returned: its rows (graph elements in them as `Text` values) and the graph elements found anywhere in them. */
export interface RunResult {
  fields: string[];
  rows: Value[][];
  nodes: DbNode[];
  rels: DbRel[];
}

const TIMEOUT_MS = 30_000;

/**
 * The HTTP base of what the person typed: a scheme added when missing, Bolt schemes mapped to HTTP
 * (`neo4j+s://host` → `https://host`, `bolt://host:7687` → `http://host:7474`), no trailing slash.
 */
export function httpBase(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!url) throw new SourceError("Enter the database's address.");
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  let scheme = m ? m[1].toLowerCase() : "";
  let rest = m ? m[2] : url;
  if (!scheme) scheme = /^(localhost|127\.|\[::1\])/i.test(rest) ? "http" : "https";
  if (scheme === "neo4j+s" || scheme === "bolt+s" || scheme === "neo4j+ssc" || scheme === "bolt+ssc") scheme = "https";
  else if (scheme === "neo4j" || scheme === "bolt") scheme = "http";
  else if (scheme !== "http" && scheme !== "https") throw new SourceError(`Petal can't connect over ${scheme}://. Use an http or https address.`);
  rest = rest.replace(/\/.*$/, "");
  if (m && /^(neo4j|bolt)/i.test(m[1])) rest = rest.replace(/:7687$/, scheme === "http" ? ":7474" : "");
  return `${scheme}://${rest}`;
}

function basicAuth(user: string, password: string): string {
  return "Basic " + Buffer.from(`${user}:${password}`, "utf8").toString("base64");
}

// ---------------------------------------------------------------------------------------------------------
// Typed JSON (application/vnd.neo4j.query)

type Typed = { $type: string; _value: unknown };

const isTyped = (x: unknown): x is Typed => !!x && typeof x === "object" && "$type" in (x as object);

export function decodeTyped(t: unknown): Value {
  if (!isTyped(t)) return fromPlain(t);
  const v = t._value;
  switch (t.$type) {
    case "Null":
      return { type: "Null" };
    case "Boolean":
      return { type: "Boolean", value: !!v };
    case "Integer":
      return { type: "Integer", value: String(v) };
    case "Float":
      return { type: "Float", value: Number(v) };
    case "String":
      return { type: "String", value: String(v) };
    case "List":
      return { type: "List", value: (v as unknown[]).map(decodeTyped) };
    case "Map": {
      const out: Record<string, Value> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = decodeTyped(x);
      return { type: "Map", value: out };
    }
    case "Node": {
      const n = v as { _labels: string[] };
      return { type: "Text", kind: "Node", value: `(:${n._labels.join(":")})` };
    }
    case "Relationship":
      return { type: "Text", kind: "Relationship", value: `[:${(v as { _type: string })._type}]` };
    case "Path":
      return { type: "Text", kind: "Path", value: `path of ${Math.floor((v as unknown[]).length / 2)}` };
    case "Vector": {
      const vec = v as { coordinates: string[] };
      return { type: "Text", kind: "Vector", value: `[${vec.coordinates.join(", ")}]` };
    }
    default:
      return { type: "Text", kind: t.$type, value: typeof v === "string" ? v : JSON.stringify(v) };
  }
}

function typedProps(p: Record<string, unknown> | undefined): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, x] of Object.entries(p ?? {})) out[k] = decodeTyped(x);
  return out;
}

/** Gathers the nodes and relationships anywhere in a typed value: a column, a list, a map, a path. */
export function collectTyped(t: unknown, nodes: Map<string, DbNode>, rels: Map<string, DbRel>) {
  if (!isTyped(t)) return;
  const v = t._value as any;
  switch (t.$type) {
    case "Node":
      nodes.set(v._element_id, { id: v._element_id, labels: v._labels ?? [], properties: typedProps(v._properties) });
      return;
    case "Relationship":
      rels.set(v._element_id, {
        id: v._element_id,
        type: v._type,
        start: v._start_node_element_id,
        end: v._end_node_element_id,
        properties: typedProps(v._properties),
      });
      return;
    case "Path":
    case "List":
      for (const x of v as unknown[]) collectTyped(x, nodes, rels);
      return;
    case "Map":
      for (const x of Object.values(v as Record<string, unknown>)) collectTyped(x, nodes, rels);
      return;
  }
}

// ---------------------------------------------------------------------------------------------------------

type Mode = "query" | "tx";

export class Neo4jSource implements GraphSource {
  readonly kind = "neo4j" as const;
  readonly language = "Cypher" as const;
  readonly label: string;
  readonly key: string;
  private schemaCache: Schema = EMPTY_SCHEMA;

  private constructor(
    private readonly base: string,
    private readonly conn: Neo4jConnection,
    private mode: Mode,
  ) {
    const host = base.replace(/^https?:\/\//, "");
    this.label = `${host}/${conn.database}`;
    this.key = `neo4j:${base}/${conn.database}`;
  }

  /** Finds the server's HTTP API and checks the credentials with `RETURN 1`. */
  static async connect(conn: Neo4jConnection): Promise<Neo4jSource> {
    const base = httpBase(conn.url);
    const database = conn.database.trim() || "neo4j";
    const c = { ...conn, database };
    let mode: Mode = "query";
    try {
      const res = await request(`${base}/`, { method: "GET", headers: { Accept: "application/json" } });
      if (res.ok) {
        const info = (await res.json()) as Record<string, unknown>;
        if (!info.query && info.transaction) mode = "tx";
      }
    } catch (e) {
      // A server behind a proxy may hide its root; the probe below says what is wrong.
      if (e instanceof SourceError && e.code === "ERR_ACCESS_DENIED") throw e;
    }
    const source = new Neo4jSource(base, c, mode);
    try {
      await source.run({ statement: "RETURN 1 AS ok", parameters: {} });
    } catch (e) {
      if (mode === "query" && e instanceof SourceError && e.code === "HTTP_404") {
        source.mode = "tx";
        await source.run({ statement: "RETURN 1 AS ok", parameters: {} });
      } else throw e;
    }
    return source;
  }

  get endpoint(): string {
    const db = encodeURIComponent(this.conn.database);
    return this.mode === "query" ? `${this.base}/db/${db}/query/v2` : `${this.base}/db/${db}/tx/commit`;
  }

  async run(st: Statement): Promise<RunResult> {
    const headers: Record<string, string> = {
      Authorization: basicAuth(this.conn.user, this.conn.password),
      "Content-Type": "application/json",
      Accept: this.mode === "query" ? "application/vnd.neo4j.query" : "application/json",
    };
    const body =
      this.mode === "query"
        ? { statement: st.statement, parameters: st.parameters }
        : { statements: [{ statement: st.statement, parameters: st.parameters, resultDataContents: ["row", "graph"] }] };
    const res = await request(this.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: an HTML error page from a proxy, say
    }
    const errors: { code?: string; message?: string }[] = json?.errors ?? [];
    if (res.status === 401 || errors.some((e) => e.code?.includes("Security.Unauthorized"))) {
      throw new SourceError("The user name or password is wrong.", "AUTH");
    }
    if (errors.length) throw new SourceError(cleanError(errors[0]), errors[0].code);
    if (res.status === 404) throw new SourceError(`No Neo4j HTTP API at ${this.endpoint}.`, "HTTP_404");
    if (!res.ok) throw new SourceError(`The database answered ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}.`, `HTTP_${res.status}`);
    return this.mode === "query" ? fromQueryApi(json) : fromTx(json);
  }

  async schema(): Promise<Schema> {
    const [labelsRes, typesRes] = await Promise.all([
      this.run({ statement: "CALL db.labels() YIELD label RETURN label ORDER BY label", parameters: {} }),
      this.run({ statement: "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType", parameters: {} }),
    ]);
    const labels = labelsRes.rows.map((r) => valueText(r[0]));
    const types = typesRes.rows.map((r) => valueText(r[0]));
    const [labelCounts, relCounts, patterns] = await Promise.all([
      labels.length && labels.length <= 120 ? this.counts(labelCountsStatement(labels)) : Promise.resolve(new Map<string, number>()),
      types.length && types.length <= 120 ? this.counts(relCountsStatement(types)) : Promise.resolve(new Map<string, number>()),
      this.patterns(),
    ]);
    const byCount = (a: { name: string; count?: number }, b: { name: string; count?: number }) =>
      (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name);
    this.schemaCache = {
      labels: labels.map((name) => ({ name, count: labelCounts.get(name) })).sort(byCount),
      relTypes: types.map((name) => ({ name, count: relCounts.get(name) })).sort(byCount),
      patterns,
    };
    return this.schemaCache;
  }

  private async counts(st: Statement): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    try {
      for (const row of (await this.run(st)).rows) out.set(valueText(row[0]), asNumber(row[1]) ?? 0);
    } catch {
      // counts are a nicety
    }
    return out;
  }

  private async patterns(): Promise<{ from: string; type: string; to: string }[]> {
    try {
      const res = await this.run({ statement: "CALL db.schema.visualization()", parameters: {} });
      const labelOf = new Map(res.nodes.map((n) => [n.id, n.labels[0] ?? valueText(n.properties.name ?? { type: "Null" })]));
      const seen = new Set<string>();
      const out: { from: string; type: string; to: string }[] = [];
      for (const r of res.rels) {
        const from = labelOf.get(r.start);
        const to = labelOf.get(r.end);
        const key = `${from}|${r.type}|${to}`;
        if (from && to && !seen.has(key)) {
          seen.add(key);
          out.push({ from, type: r.type, to });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async search(spec: SearchSpec, limit: number): Promise<GraphResult> {
    const res = await this.run(searchStatement(spec, limit, this.schemaCache));
    return { nodes: res.nodes, rels: res.rels, rows: res.rows.length, table: { columns: res.fields, rows: res.rows } };
  }

  async expand(ids: string[], options: ExpandOptions): Promise<GraphResult> {
    const res = await this.run(expandStatement(ids, options));
    return { nodes: res.nodes, rels: res.rels, rows: res.rows.length };
  }

  async relationshipsAmong(ids: string[]): Promise<DbRel[]> {
    if (ids.length === 0) return [];
    return (await this.run(relationshipsAmongStatement(ids))).rels;
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const res = await this.run(neighborhoodStatement(id));
    return res.rows.map((r) => ({
      type: valueText(r[0]),
      direction: r[1].type === "Boolean" && r[1].value ? "out" : "in",
      count: asNumber(r[2]) ?? 0,
    }));
  }
}

function cleanError(e: { code?: string; message?: string }): string {
  const msg = (e.message ?? "The query failed.").trim();
  if (/Unknown function 'elementId'|Unknown function 'toStringOrNull'/i.test(msg)) return "Petal needs Neo4j 5 or later.";
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e?.code === "ERR_ACCESS_DENIED") {
      throw new SourceError(`Petal isn't allowed to reach ${e.resource ?? url}. Add its host to capabilities.network in nsh.json.`, "ERR_ACCESS_DENIED");
    }
    if (e?.name === "AbortError") throw new SourceError(`${new URL(url).host} didn't answer within ${TIMEOUT_MS / 1000} seconds.`, "TIMEOUT");
    throw new SourceError(`Couldn't reach ${new URL(url).host}. Check the address and that the database is running.`, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}

function fromQueryApi(json: any): RunResult {
  const fields: string[] = json?.data?.fields ?? [];
  const values: unknown[][] = json?.data?.values ?? [];
  const nodes = new Map<string, DbNode>();
  const rels = new Map<string, DbRel>();
  const rows = values.map((row) =>
    row.map((cell) => {
      collectTyped(cell, nodes, rels);
      return decodeTyped(cell);
    }),
  );
  return { fields, rows, nodes: [...nodes.values()], rels: [...rels.values()] };
}

function fromTx(json: any): RunResult {
  const result = json?.results?.[0] ?? { columns: [], data: [] };
  const nodes = new Map<string, DbNode>();
  const rels = new Map<string, DbRel>();
  const rows: Value[][] = [];
  for (const d of result.data ?? []) {
    rows.push((d.row ?? []).map(fromPlain));
    for (const n of d.graph?.nodes ?? []) {
      const id = n.elementId ?? String(n.id);
      nodes.set(id, { id, labels: n.labels ?? [], properties: plainProps(n.properties ?? {}) });
    }
    for (const r of d.graph?.relationships ?? []) {
      const id = r.elementId ?? String(r.id);
      rels.set(id, {
        id,
        type: r.type,
        start: r.startNodeElementId ?? String(r.startNode),
        end: r.endNodeElementId ?? String(r.endNode),
        properties: plainProps(r.properties ?? {}),
      });
    }
  }
  return { fields: result.columns ?? [], rows, nodes: [...nodes.values()], rels: [...rels.values()] };
}
