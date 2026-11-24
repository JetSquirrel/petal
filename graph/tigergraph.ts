/**
 * TigerGraph over HTTP, through its GSQL server's port (14240 on TigerGraph 4, which also proxies REST++ under
 * `/restpp`; `https://…i.tgcloud.io` on TigerGraph Cloud).
 *
 * - **Schema.** The graph's declared schema (`GET /gsql/v1/schema/graphs/{graph}`; `/gsqlserver/gsql/schema`
 *   on TigerGraph 3), counted with REST++'s `stat_vertex_number` and `stat_edge_number`. A directed edge type's
 *   reverse type (`REVERSE_EDGE`) is how its incoming edges are read, so it isn't a type of its own here.
 * - **IDs.** A vertex's ID is unique only within its type, so Petal's ID is `type:id`. An edge is its type and
 *   its ends (TigerGraph edges have no ID of their own).
 * - **Exploring.** Categories and words read vertices with REST++ (`/restpp/graph/{graph}/vertices/{type}`) and
 *   Petal checks their attributes itself; neighbors are a vertex's edges (`…/edges/{type}/{id}`), kept for the
 *   session, and the vertices at their other ends.
 * - **Queries.** Patterns and the notebook's queries are openCypher, run as interpreted queries
 *   (`INTERPRET OPENCYPHER QUERY () FOR GRAPH g { … }`, `POST /gsql/v1/queries/interpret`). Anonymous
 *   interpreted queries take no parameters, so words go into the query as escaped string literals, and only
 *   for a pattern step with a category, whose string attributes the schema lists.
 * - **Sign-in.** Basic authentication with a TigerGraph user. When REST++ wants a token, Petal asks the GSQL
 *   server for one (`POST /gsql/v1/tokens`) with the same user.
 */
import { orient } from "./cypher";
import { asNumber, plainProps, valueText, type DbNode, type DbRel, type GraphResult, type Table, type Value } from "./model";
import { EMPTY_SCHEMA, SourceError, type Direction, type ExpandOptions, type GraphSource, type NeighborhoodEntry, type Schema, type SearchSpec } from "./source";

export interface TigerGraphConnection {
  /** The GSQL server: `http://host:14240`, or `https://…i.tgcloud.io`. */
  url: string;
  /** The graph to explore. */
  graph: string;
  user: string;
  password: string;
}

const TIMEOUT_MS = 60_000;
/** How many vertices a text search reads before Petal checks them. */
export const TG_TEXT_SCAN = 5000;
/** How many of a vertex's edges Petal reads. */
export const TG_EDGE_SCAN = 2000;
/** How many requests run at once when Petal reads vertices or edges one at a time. */
const PARALLEL = 8;

/** The server's base: `http://` added when missing, port 14240 when none is given (but not for TigerGraph Cloud), no path. */
export function tigerBase(input: string): string {
  const url = input.trim();
  if (!url) throw new SourceError("Enter the GSQL server's address.");
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]+)/i.exec(url);
  if (!m) throw new SourceError(`${input} is not an address.`);
  const scheme = (m[1] ?? (/\.tgcloud\.io$/i.test(m[2]) ? "https" : "http")).toLowerCase();
  if (scheme !== "https" && scheme !== "http") throw new SourceError(`TigerGraph is reached over http:// or https://, not ${scheme}://.`);
  const host = /:\d+$/.test(m[2]) || scheme === "https" ? m[2] : `${m[2]}:14240`;
  return `${scheme}://${host}`;
}

/** A vertex or edge type, or an attribute: TigerGraph names are letters, digits and _. */
export function tigerName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new SourceError(`TigerGraph can't query “${name}”: its names are letters, digits and _ only.`, "TG_NAME");
  return name;
}

/** Text as a GSQL string literal. */
export const tigerString = (s: string) => JSON.stringify(s);

// ---------------------------------------------------------------------------------------------------------
// Vertices and edges

/** Petal's ID of a vertex: its type and its ID, which is unique only within the type. */
export const vertexId = (type: string, id: string) => `${type}:${id}`;

export function splitVertexId(id: string): { type: string; id: string } {
  const at = id.indexOf(":");
  if (at <= 0) throw new SourceError(`${id} is not a TigerGraph vertex.`, "TG_ID");
  return { type: id.slice(0, at), id: id.slice(at + 1) };
}

interface TgVertex {
  v_id: string | number;
  v_type: string;
  attributes?: Record<string, unknown>;
}

interface TgEdge {
  e_type: string;
  from_id: string | number;
  from_type: string;
  to_id: string | number;
  to_type: string;
  directed?: boolean;
  attributes?: Record<string, unknown>;
}

const isVertex = (v: unknown): v is TgVertex => !!v && typeof v === "object" && "v_id" in v && "v_type" in v;
const isEdge = (v: unknown): v is TgEdge => !!v && typeof v === "object" && "e_type" in v && "from_id" in v && "to_id" in v;

export function toNode(v: TgVertex): DbNode {
  return { id: vertexId(v.v_type, String(v.v_id)), labels: [v.v_type], properties: plainProps(v.attributes ?? {}) };
}

/** What Petal knows of the schema's edge types to read edges: which are undirected, and the reverse types. */
export interface EdgeTypes {
  undirected: Set<string>;
  /** A reverse type → the type it reverses. */
  reverseOf: Map<string, string>;
  /** A directed type → its reverse type. */
  reverse: Map<string, string>;
}

export const NO_EDGE_TYPES: EdgeTypes = { undirected: new Set(), reverseOf: new Map(), reverse: new Map() };

/**
 * An edge as Petal's relationship: a reverse edge as the edge it reverses, and an undirected edge with its
 * ends in one order, so it is the same relationship from either end.
 */
export function toRel(e: TgEdge, types: EdgeTypes): DbRel {
  let type = e.e_type;
  let start = vertexId(e.from_type, String(e.from_id));
  let end = vertexId(e.to_type, String(e.to_id));
  const reversed = types.reverseOf.get(type);
  if (reversed) {
    type = reversed;
    [start, end] = [end, start];
  } else if ((e.directed === false || types.undirected.has(type)) && end < start) {
    [start, end] = [end, start];
  }
  return { id: `${type}:${start}>${end}`, type, start, end, properties: plainProps(e.attributes ?? {}) };
}

/** Every vertex and edge anywhere in a result, however the query printed them. */
export function collectGraph(value: unknown, types: EdgeTypes): { nodes: DbNode[]; rels: DbRel[] } {
  const nodes = new Map<string, DbNode>();
  const rels = new Map<string, DbRel>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (isVertex(v)) {
      const n = toNode(v);
      nodes.set(n.id, n);
    } else if (isEdge(v)) {
      const r = toRel(v, types);
      rels.set(r.id, r);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(value);
  return { nodes: [...nodes.values()], rels: [...rels.values()] };
}

/** A result value in a table cell: a vertex or edge as its type, as other databases' rows show them. */
function cell(v: unknown): Value {
  if (isVertex(v)) return { type: "Text", kind: "Node", value: `(:${v.v_type} ${v.v_id})` };
  if (isEdge(v)) return { type: "Text", kind: "Relationship", value: `[:${v.e_type}]` };
  if (Array.isArray(v)) return { type: "List", value: v.map(cell) };
  if (v && typeof v === "object") return { type: "Map", value: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cell(x)])) };
  return plainProps({ v }).v;
}

/**
 * The rows of an interpreted query's `results`: one object per row, or (as `PRINT` gives them) one object
 * holding a single list of rows.
 */
export function resultTable(results: unknown): Table {
  let rows: unknown[] = Array.isArray(results) ? results : [results];
  if (rows.length === 1 && rows[0] && typeof rows[0] === "object" && !Array.isArray(rows[0])) {
    const values = Object.values(rows[0] as object);
    if (values.length === 1 && Array.isArray(values[0]) && values[0].every((r) => r && typeof r === "object" && !Array.isArray(r) && !isVertex(r) && !isEdge(r))) rows = values[0];
  }
  const columns: string[] = [];
  for (const r of rows) if (r && typeof r === "object" && !Array.isArray(r)) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  if (!columns.length) return { columns: ["value"], rows: rows.map((r) => [cell(r)]) };
  return { columns, rows: rows.map((r) => columns.map((c) => cell(r && typeof r === "object" ? (r as Record<string, unknown>)[c] : undefined))) };
}

// ---------------------------------------------------------------------------------------------------------
// Schema

interface TgAttribute {
  AttributeName: string;
  AttributeType?: { Name?: string };
}

export interface TgSchema {
  VertexTypes?: { Name: string; Attributes?: TgAttribute[] }[];
  EdgeTypes?: {
    Name: string;
    FromVertexTypeName?: string;
    ToVertexTypeName?: string;
    IsDirected?: boolean;
    Config?: Record<string, unknown>;
    EdgePairs?: { From: string; To: string }[];
  }[];
}

export interface ReadSchema {
  schema: Schema;
  edgeTypes: EdgeTypes;
  /** Each vertex type's string attributes: what words are looked for in, in a pattern. */
  textAttributes: Map<string, string[]>;
}

/** Petal's schema from TigerGraph's, without counts; reverse edge types left out. */
export function readSchema(tg: TgSchema): ReadSchema {
  const edgeTypes: EdgeTypes = { undirected: new Set(), reverseOf: new Map(), reverse: new Map() };
  for (const e of tg.EdgeTypes ?? []) {
    const rev = e.Config?.REVERSE_EDGE;
    if (e.IsDirected === false) edgeTypes.undirected.add(e.Name);
    else if (typeof rev === "string" && rev) {
      edgeTypes.reverseOf.set(rev, e.Name);
      edgeTypes.reverse.set(e.Name, rev);
    }
  }
  const textAttributes = new Map<string, string[]>();
  for (const v of tg.VertexTypes ?? []) {
    textAttributes.set(
      v.Name,
      (v.Attributes ?? []).filter((a) => /^STRING/i.test(a.AttributeType?.Name ?? "")).map((a) => a.AttributeName),
    );
  }
  const patterns: Schema["patterns"] = [];
  const relTypes: Schema["relTypes"] = [];
  for (const e of tg.EdgeTypes ?? []) {
    if (edgeTypes.reverseOf.has(e.Name)) continue;
    relTypes.push({ name: e.Name });
    const pairs = e.EdgePairs?.length ? e.EdgePairs : e.FromVertexTypeName && e.ToVertexTypeName ? [{ From: e.FromVertexTypeName, To: e.ToVertexTypeName }] : [];
    for (const p of pairs) {
      // `*` is any vertex type.
      if (p.From === "*" || p.To === "*") continue;
      patterns.push({ from: p.From, type: e.Name, to: p.To });
    }
  }
  return {
    schema: { labels: (tg.VertexTypes ?? []).map((v) => ({ name: v.Name })), relTypes, patterns },
    edgeTypes,
    textAttributes,
  };
}

// ---------------------------------------------------------------------------------------------------------
// openCypher

/** An openCypher query as an interpreted query on `graph`; a query that already starts with INTERPRET runs as written. */
export function interpretText(query: string, graph: string): string {
  if (/^\s*INTERPRET\b/i.test(query)) return query;
  return `INTERPRET OPENCYPHER QUERY () FOR GRAPH ${tigerName(graph)} {\n${query.trim().replace(/;\s*$/, "")}\n}`;
}

/** `any string attribute of v contains the words`, ignoring case: the attributes `v`'s type has. */
function textWhere(v: string, words: string, attributes: string[]): string {
  if (!attributes.length) return "false";
  const w = tigerString(words.toLowerCase());
  return `(${attributes.map((a) => `toLower(${v}.${tigerName(a)}) CONTAINS ${w}`).join(" OR ")})`;
}

/** The openCypher of a pattern of several steps. */
export function tigerPattern(spec: Extract<SearchSpec, { kind: "pattern" }>, limit: number, read: ReadSchema): string {
  const where: string[] = [];
  const columns: string[] = [];
  let pattern = "";
  spec.nodes.forEach((step, i) => {
    pattern += `(n${i}${step.label ? ":" + tigerName(step.label) : ""})`;
    columns.push(`n${i}`);
    if (step.text) {
      if (!step.label) throw new SourceError("On TigerGraph, words in a pattern need a category before them, such as “Person Ada”.", "TG_TEXT");
      where.push(textWhere(`n${i}`, step.text, read.textAttributes.get(step.label) ?? []));
    }
    if (i < spec.nodes.length - 1) {
      const type = spec.rels[i]?.type;
      const direction: Direction = type && read.edgeTypes.undirected.has(type) ? "both" : orient(read.schema, step.label, type, spec.nodes[i + 1].label);
      const inner = `[r${i}${type ? ":" + tigerName(type) : ""}]`;
      pattern += direction === "out" ? `-${inner}->` : direction === "in" ? `<-${inner}-` : `-${inner}-`;
      columns.push(`r${i}`);
    }
  });
  return `MATCH ${pattern}${where.length ? " WHERE " + where.join(" AND ") : ""} RETURN ${columns.join(", ")} LIMIT ${Math.max(1, Math.floor(limit))}`;
}

// ---------------------------------------------------------------------------------------------------------
// The source

function containsText(n: DbNode, words: string): boolean {
  const t = words.toLowerCase();
  return Object.values(n.properties).some((v) => v.type !== "Null" && valueText(v).toLowerCase().includes(t));
}

async function inParallel<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return out;
}

export class TigerGraphSource implements GraphSource {
  readonly kind = "tigergraph" as const;
  readonly language = "Cypher" as const;
  readonly label: string;
  readonly key: string;
  private read: ReadSchema = { schema: EMPTY_SCHEMA, edgeTypes: NO_EDGE_TYPES, textAttributes: new Map() };
  private token: string | null = null;
  /** Each vertex's edges, as read this session. */
  private edges = new Map<string, Promise<DbRel[]>>();
  /** Vertices read this session, by Petal's ID. */
  private vertices = new Map<string, DbNode>();

  private constructor(
    private readonly base: string,
    private readonly conn: TigerGraphConnection,
  ) {
    this.label = `${base.replace(/^[a-z]+:\/\//, "").replace(/:14240$/, "")}/${conn.graph}`;
    this.key = `tigergraph:${base}/${conn.graph}`;
  }

  static async connect(conn: TigerGraphConnection): Promise<TigerGraphSource> {
    const base = tigerBase(conn.url);
    const graph = conn.graph.trim();
    if (!graph) throw new SourceError("Enter the graph to explore.");
    tigerName(graph);
    const source = new TigerGraphSource(base, { ...conn, graph });
    await source.schema();
    return source;
  }

  private basic(): string {
    return "Basic " + Buffer.from(`${this.conn.user}:${this.conn.password}`, "utf8").toString("base64");
  }

  private async request(path: string, init: { method?: string; body?: string; contentType?: string; bearer?: boolean } = {}): Promise<{ status: number; json: any }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const host = this.base.replace(/^[a-z]+:\/\//, "");
    const headers: Record<string, string> = { Accept: "application/json", Authorization: init.bearer && this.token ? `Bearer ${this.token}` : this.basic() };
    if (init.body !== undefined) headers["Content-Type"] = init.contentType ?? "application/json";
    let res: Response;
    try {
      res = await fetch(this.base + path, { method: init.method ?? "GET", headers, body: init.body, signal: controller.signal });
    } catch (e: any) {
      if (e?.code === "ERR_ACCESS_DENIED") throw new SourceError(`Petal isn't allowed to reach ${e.resource ?? host}. Add its host to capabilities.network in nsh.json.`, "ERR_ACCESS_DENIED");
      if (e?.name === "AbortError") throw new SourceError(`${host} didn't answer within ${TIMEOUT_MS / 1000} seconds.`, "TIMEOUT");
      throw new SourceError(`Couldn't reach ${host}. Check the address, and that TigerGraph is running.`, "NETWORK");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: true, message: text.slice(0, 300) };
    }
    return { status: res.status, json };
  }

  /** A GSQL server request; its `error` and status become a SourceError. */
  private async gsql(path: string, init: { method?: string; body?: string; contentType?: string } = {}): Promise<any> {
    const { status, json } = await this.request(path, init);
    if (status === 401 || status === 403) throw new SourceError("The user name or password is wrong.", "TG_AUTH");
    if (status === 404) throw new SourceError("Not found", "TG_404");
    if (status >= 400 || json?.error) throw new SourceError(cleanMessage(json?.message) || `The server answered ${status}.`, `TG_${status}`);
    return json;
  }

  /** A REST++ request (under `/restpp`), with a token when REST++ wants one. */
  private async restpp(path: string, init: { method?: string; body?: string } = {}): Promise<any> {
    let { status, json } = await this.request(`/restpp${path}`, { ...init, bearer: !!this.token });
    if ((status === 401 || status === 403 || /token/i.test(json?.message ?? "")) && json?.error !== false && !this.token) {
      await this.requestToken();
      ({ status, json } = await this.request(`/restpp${path}`, { ...init, bearer: true }));
    }
    if (status === 401 || status === 403) throw new SourceError("REST++ turned Petal away: the user needs read access to the graph.", "TG_AUTH");
    if (status >= 400 || json?.error) throw new SourceError(cleanMessage(json?.message) || `REST++ answered ${status}.`, `TG_${status}`);
    return json;
  }

  private async requestToken() {
    const json = await this.gsql("/gsql/v1/tokens", { method: "POST", body: JSON.stringify({ graph: this.conn.graph }) });
    const token = json?.token ?? json?.results?.token;
    if (typeof token !== "string") throw new SourceError("REST++ wants a token, and the GSQL server gave none.", "TG_TOKEN");
    this.token = token;
  }

  async schema(): Promise<Schema> {
    const graph = encodeURIComponent(this.conn.graph);
    let tg: TgSchema;
    try {
      tg = (await this.gsql(`/gsql/v1/schema/graphs/${graph}`)).results;
    } catch (e) {
      if (!(e instanceof SourceError) || e.code !== "TG_404") throw await this.graphError(e);
      // TigerGraph 3
      tg = (await this.gsql(`/gsqlserver/gsql/schema?graph=${graph}`).catch(async (e3) => Promise.reject(await this.graphError(e3)))).results;
    }
    if (!tg || !Array.isArray(tg.VertexTypes)) throw await this.graphError(new SourceError("No schema", "TG_SCHEMA"));
    const read = readSchema(tg);
    const counts = async (fn: string, key: string) => {
      const out = new Map<string, number>();
      try {
        const json = await this.restpp(`/builtins/${graph}`, { method: "POST", body: JSON.stringify({ function: fn, type: "*" }) });
        for (const r of json?.results ?? []) out.set(String(r[key]), asNumber(plainProps({ c: r.count }).c) ?? 0);
      } catch {
        // the schema stands without counts
      }
      return out;
    };
    const [vc, ec] = await Promise.all([counts("stat_vertex_number", "v_type"), counts("stat_edge_number", "e_type")]);
    const sorted = (list: { name: string }[], c: Map<string, number>) =>
      list.map((x) => ({ name: x.name, count: c.get(x.name) })).sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
    read.schema = { ...read.schema, labels: sorted(read.schema.labels, vc), relTypes: sorted(read.schema.relTypes, ec) };
    this.read = read;
    return read.schema;
  }

  /** Why the graph couldn't be read: a missing graph names the ones there are. */
  private async graphError(e: unknown): Promise<SourceError> {
    if (e instanceof SourceError && e.code === "TG_AUTH") return e;
    try {
      const json = await this.gsql("/gsql/v1/schema/graphs");
      const names: string[] = (json?.graphs ?? []).map((g: { graphName: string }) => g.graphName);
      if (names.length && !names.includes(this.conn.graph)) return new SourceError(`There is no graph named ${this.conn.graph}. The graphs are: ${names.join(", ")}.`, "TG_GRAPH");
    } catch {
      // keep the first error
    }
    return e instanceof SourceError && e.code !== "TG_404" ? e : new SourceError(`Couldn't read the schema of ${this.conn.graph}.`, "TG_SCHEMA");
  }

  /** Runs an openCypher (or GSQL `INTERPRET`) query; its result as a graph and rows. */
  async interpret(query: string): Promise<GraphResult> {
    const body = interpretText(query, this.conn.graph);
    let json: any;
    try {
      json = await this.gsql(`/gsql/v1/queries/interpret?graph=${encodeURIComponent(this.conn.graph)}`, { method: "POST", body, contentType: "text/plain" });
    } catch (e) {
      if (!(e instanceof SourceError) || e.code !== "TG_404") throw e;
      // TigerGraph 3
      json = await this.gsql("/gsqlserver/interpreted_query", { method: "POST", body, contentType: "text/plain" });
    }
    const results = json?.results ?? [];
    const graph = collectGraph(results, this.read.edgeTypes);
    for (const n of graph.nodes) this.vertices.set(n.id, n);
    const table = resultTable(results);
    return { ...graph, rows: table.rows.length, table };
  }

  /** Up to `limit` vertices of `type` whose attributes contain `words` (all of them without words). */
  private async verticesOf(type: string, limit: number, words?: string): Promise<DbNode[]> {
    const json = await this.restpp(`/graph/${encodeURIComponent(this.conn.graph)}/vertices/${encodeURIComponent(tigerName(type))}?limit=${words ? TG_TEXT_SCAN : limit}`);
    const out: DbNode[] = [];
    for (const v of json?.results ?? []) {
      if (!isVertex(v)) continue;
      const n = toNode(v);
      if (words && !containsText(n, words)) continue;
      this.vertices.set(n.id, n);
      out.push(n);
      if (out.length >= limit) break;
    }
    return out;
  }

  private async vertex(id: string): Promise<DbNode | null> {
    const known = this.vertices.get(id);
    if (known) return known;
    const { type, id: vid } = splitVertexId(id);
    try {
      const json = await this.restpp(`/graph/${encodeURIComponent(this.conn.graph)}/vertices/${encodeURIComponent(type)}/${encodeURIComponent(vid)}`);
      const v = (json?.results ?? []).find(isVertex);
      if (!v) return null;
      const n = toNode(v);
      this.vertices.set(n.id, n);
      return n;
    } catch {
      return null;
    }
  }

  /** A vertex's edges (up to `TG_EDGE_SCAN`), reverse edges as the ones they reverse; read once a session. */
  private edgesOf(id: string): Promise<DbRel[]> {
    let kept = this.edges.get(id);
    if (!kept) {
      const { type, id: vid } = splitVertexId(id);
      kept = this.restpp(`/graph/${encodeURIComponent(this.conn.graph)}/edges/${encodeURIComponent(type)}/${encodeURIComponent(vid)}?limit=${TG_EDGE_SCAN}`).then((json) =>
        (json?.results ?? []).filter(isEdge).map((e: TgEdge) => toRel(e, this.read.edgeTypes)),
      );
      kept.catch(() => this.edges.delete(id));
      this.edges.set(id, kept);
    }
    return kept;
  }

  async search(spec: SearchSpec, limit: number): Promise<GraphResult> {
    if (spec.kind === "raw") return this.interpret(spec.statement);
    if (spec.kind === "text" || (spec.kind === "pattern" && spec.nodes.length === 1)) {
      const step = spec.kind === "text" ? { label: undefined, text: spec.term } : spec.nodes[0];
      const types = step.label ? [step.label] : this.read.schema.labels.map((l) => l.name);
      const nodes: DbNode[] = [];
      for (const type of types) {
        if (nodes.length >= limit) break;
        nodes.push(...(await this.verticesOf(type, limit - nodes.length, step.text)));
      }
      return { nodes, rels: [], rows: nodes.length };
    }
    if (spec.kind !== "pattern") return { nodes: [], rels: [], rows: 0 };
    return this.interpret(tigerPattern(spec, limit, this.read));
  }

  async expand(ids: string[], options: ExpandOptions): Promise<GraphResult> {
    const direction = options.direction ?? "both";
    const lists = await inParallel(ids, (id) => this.edgesOf(id).catch(() => [] as DbRel[]));
    const picked: { rel: DbRel; other: string; self: string }[] = [];
    ids.forEach((self, i) => {
      for (const rel of lists[i]) {
        if (options.type && rel.type !== options.type) continue;
        const undirected = this.read.edgeTypes.undirected.has(rel.type);
        const out = rel.start === self;
        if (!undirected && direction === "out" && !out) continue;
        if (!undirected && direction === "in" && out) continue;
        const other = out ? rel.end : rel.start;
        if (options.label && splitVertexId(other).type !== options.label) continue;
        picked.push({ rel, other, self });
      }
    });
    // Read the vertices at the other ends: as many as the limit, more when words must be checked.
    const others = [...new Set(picked.map((p) => p.other))].slice(0, options.text ? TG_TEXT_SCAN : options.limit);
    const found = new Map<string, DbNode>();
    for (const n of await inParallel(others, (id) => this.vertex(id))) if (n && (!options.text || containsText(n, options.text))) found.set(n.id, n);
    const nodes = new Map<string, DbNode>();
    const rels = new Map<string, DbRel>();
    let rows = 0;
    for (const p of picked) {
      const other = found.get(p.other);
      if (!other) continue;
      if (rows >= options.limit) break;
      rows++;
      const self = await this.vertex(p.self);
      if (self) nodes.set(self.id, self);
      nodes.set(other.id, other);
      rels.set(p.rel.id, p.rel);
    }
    return { nodes: [...nodes.values()], rels: [...rels.values()], rows };
  }

  async relationshipsAmong(ids: string[]): Promise<DbRel[]> {
    const set = new Set(ids);
    const rels = new Map<string, DbRel>();
    const lists = await inParallel(ids, (id) => this.edgesOf(id).catch(() => [] as DbRel[]));
    for (const list of lists) for (const r of list) if (set.has(r.start) && set.has(r.end)) rels.set(r.id, r);
    return [...rels.values()];
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const counts = new Map<string, NeighborhoodEntry>();
    for (const r of await this.edgesOf(id)) {
      const direction = r.start === id ? "out" : "in";
      const key = `${r.type}|${direction}`;
      const e = counts.get(key) ?? { type: r.type, direction, count: 0 };
      e.count++;
      counts.set(key, e);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }
}

function cleanMessage(m: unknown): string {
  const msg = typeof m === "string" ? m.trim() : "";
  return msg.length > 400 ? `${msg.slice(0, 400)}…` : msg;
}
