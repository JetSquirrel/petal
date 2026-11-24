/**
 * Gremlin servers: Apache TinkerPop's Gremlin Server and the databases built on it or speaking its protocol,
 * such as JanusGraph, Apache HugeGraph and Amazon Neptune. Petal sends Gremlin scripts and reads GraphSON 3.
 *
 * - **Transport.** `ws://` and `wss://` addresses use the WebSocket protocol every Gremlin Server speaks;
 *   `http://` and `https://` use `POST` (Neptune, and Gremlin Server with its HTTP channelizer).
 * - **Elements.** Since TinkerPop 3.5 a server returns vertices and edges as references, an ID and a label
 *   and no properties, so every traversal here ends in `elementMap()`. Results of your own Gremlin that hold
 *   references are filled in with a second traversal.
 * - **Literals.** Neptune takes no bindings, so values are written into the script as escaped literals, and
 *   IDs keep the type the server gave them (`123L`, `'abc'`, a UUID).
 * - **Text search.** Gremlin has no case-insensitive "any property contains", so Petal reads up to
 *   `TEXT_SCAN` candidates and filters them itself.
 */
import { connect as connectSocket, type WebSocketConnection } from "websocket";
import { orient } from "./cypher";
import { fromPlain, valueText, type DbNode, type DbRel, type GraphResult, type Value } from "./model";
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

export interface GremlinConnection {
  /** `ws://host:8182/gremlin`, `wss://…`, or `https://…:8182/gremlin` for HTTP. */
  url: string;
  user: string;
  password: string;
  /** The server's name for the traversal source; `g` unless the server names it otherwise (HugeGraph: `__g_hugegraph`). */
  traversal: string;
}

export const TEXT_SCAN = 5_000;
/** How many elements the schema reads; counts past it are left out rather than shown wrong. */
export const SCHEMA_SCAN = 200_000;
const TIMEOUT_MS = 60_000;
const MIME = "application/vnd.gremlin-v3.0+json";

// ---------------------------------------------------------------------------------------------------------
// GraphSON 3

/** An integer as the server typed it, kept exact. */
export class GInt {
  constructor(readonly text: string) {}
}
/** A value of a type Petal shows as text: a UUID, a date, a JanusGraph edge ID. */
export class GText {
  constructor(
    readonly kind: string,
    readonly text: string,
  ) {}
}
/** `T.id`, `T.label`, `Direction.IN`, `Direction.OUT`: map keys of `elementMap()`. */
export class GToken {
  constructor(readonly name: string) {}
}
/** A vertex or edge reference, with no properties. */
export interface GElement {
  element: "vertex" | "edge";
  id: unknown;
  label: string;
  outV?: unknown;
  inV?: unknown;
}

export type GValue = null | boolean | number | string | GInt | GText | GToken | GElement | GValue[] | Map<unknown, GValue>;

const isTyped = (x: unknown): x is { "@type": string; "@value": any } => !!x && typeof x === "object" && "@type" in (x as object);

export function decodeGraphSON(x: unknown): GValue {
  if (Array.isArray(x)) return x.map(decodeGraphSON);
  if (!isTyped(x)) {
    if (x && typeof x === "object") {
      const m = new Map<unknown, GValue>();
      for (const [k, v] of Object.entries(x)) m.set(k, decodeGraphSON(v));
      return m;
    }
    return x as GValue;
  }
  const v = x["@value"];
  switch (x["@type"]) {
    case "g:List":
    case "g:Set":
    case "g:BulkSet":
      return (v as unknown[]).map(decodeGraphSON);
    case "g:Map": {
      const m = new Map<unknown, GValue>();
      const flat = v as unknown[];
      for (let i = 0; i + 1 < flat.length; i += 2) m.set(mapKey(decodeGraphSON(flat[i])), decodeGraphSON(flat[i + 1]));
      return m;
    }
    case "g:Int32":
    case "g:Int64":
    case "gx:BigInteger":
    case "gx:Int16":
    case "gx:Byte":
      return new GInt(String(v));
    case "g:Double":
    case "g:Float":
    case "gx:BigDecimal":
      return Number(v);
    case "g:T":
    case "g:Direction":
      return new GToken(String(v));
    case "g:UUID":
      return new GText("UUID", String(v));
    case "g:Date":
    case "g:Timestamp":
      return new GText("DateTime", new Date(Number(v)).toISOString());
    case "g:Vertex":
      return { element: "vertex", id: decodeGraphSON(v.id), label: String(v.label ?? "") };
    case "g:Edge":
      return { element: "edge", id: decodeGraphSON(v.id), label: String(v.label ?? ""), outV: decodeGraphSON(v.outV), inV: decodeGraphSON(v.inV) };
    case "g:VertexProperty":
    case "g:Property":
      return decodeGraphSON(v.value);
    case "janusgraph:RelationIdentifier":
      return new GText("Edge ID", String(v?.relationId ?? JSON.stringify(v)));
    default:
      return new GText(x["@type"].replace(/^\w+:/, ""), typeof v === "string" ? v : JSON.stringify(v));
  }
}

/** Map keys as strings: tokens as `~id`, `~label`, `~IN`, `~OUT`. */
function mapKey(k: GValue): string {
  if (k instanceof GToken) return `~${k.name}`;
  if (k instanceof GInt || k instanceof GText) return k.text;
  return typeof k === "string" ? k : JSON.stringify(k);
}

export function gValue(v: GValue): Value {
  if (v === null || v === undefined) return { type: "Null" };
  if (v instanceof GInt) return { type: "Integer", value: v.text };
  if (v instanceof GText) return { type: "Text", kind: v.kind, value: v.text };
  if (v instanceof GToken) return { type: "String", value: v.name };
  if (Array.isArray(v)) return { type: "List", value: v.map(gValue) };
  if (v instanceof Map) {
    const out: Record<string, Value> = {};
    for (const [k, x] of v) out[String(k)] = gValue(x);
    return { type: "Map", value: out };
  }
  if (typeof v === "object") return { type: "Text", kind: v.element === "vertex" ? "Vertex" : "Edge", value: `${v.label}` };
  if (typeof v === "number") return { type: "Float", value: v };
  return fromPlain(v);
}

/** An ID as Petal keeps it (text) and as a script writes it (a typed literal). */
export function idText(id: GValue): string {
  if (id instanceof GInt || id instanceof GText) return id.text;
  return typeof id === "string" ? id : JSON.stringify(id);
}

export function idLiteral(id: GValue): string {
  if (id instanceof GInt) return `${id.text}L`;
  if (id instanceof GText && id.kind === "UUID") return `UUID.fromString(${gremlinString(id.text)})`;
  if (id instanceof GText) return gremlinString(id.text);
  if (typeof id === "number") return String(id);
  return gremlinString(String(id));
}

const isVertexMap = (m: Map<unknown, GValue>) => m.has("~id") && m.has("~label") && !m.has("~IN") && !m.has("~OUT");
const isEdgeMap = (m: Map<unknown, GValue>) => m.has("~id") && m.has("~label") && m.has("~IN") && m.has("~OUT");
const end = (v: GValue) => (v instanceof Map ? v.get("~id") ?? null : null);

/** What a result holds: the vertices and edges of `elementMap()`s, and the references to look up. */
export interface Collected {
  nodes: Map<string, DbNode>;
  rels: Map<string, DbRel>;
  /** Vertex references seen without their properties, by ID text. */
  vertexRefs: Map<string, GValue>;
  /** Each ID's literal, so later scripts write it with its type. */
  literals: Map<string, string>;
}

export function newCollected(): Collected {
  return { nodes: new Map(), rels: new Map(), vertexRefs: new Map(), literals: new Map() };
}

export function collectGraph(v: GValue, out: Collected) {
  if (v instanceof Map) {
    if (isVertexMap(v)) {
      const id = v.get("~id") ?? null;
      const properties: Record<string, Value> = {};
      for (const [k, x] of v) if (k !== "~id" && k !== "~label") properties[String(k)] = gValue(Array.isArray(x) && x.length === 1 ? x[0] : x);
      out.nodes.set(idText(id), { id: idText(id), labels: [String(v.get("~label"))], properties });
      out.literals.set(idText(id), idLiteral(id));
      out.vertexRefs.delete(idText(id));
      return;
    }
    if (isEdgeMap(v)) {
      const id = v.get("~id") ?? null;
      const from = end(v.get("~OUT") ?? null);
      const to = end(v.get("~IN") ?? null);
      const properties: Record<string, Value> = {};
      for (const [k, x] of v) if (!["~id", "~label", "~IN", "~OUT"].includes(String(k))) properties[String(k)] = gValue(x);
      out.rels.set(idText(id), { id: idText(id), type: String(v.get("~label")), start: idText(from), end: idText(to), properties });
      for (const e of [from, to]) {
        out.literals.set(idText(e), idLiteral(e));
        if (!out.nodes.has(idText(e))) out.vertexRefs.set(idText(e), e);
      }
      return;
    }
    for (const x of v.values()) collectGraph(x, out);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectGraph(x, out);
    return;
  }
  if (v && typeof v === "object" && "element" in v) {
    const ref = v as GElement;
    if (ref.element === "vertex") {
      if (!out.nodes.has(idText(ref.id as GValue))) out.vertexRefs.set(idText(ref.id as GValue), ref.id as GValue);
      out.literals.set(idText(ref.id as GValue), idLiteral(ref.id as GValue));
    } else {
      const from = ref.outV as GValue;
      const to = ref.inV as GValue;
      out.rels.set(idText(ref.id as GValue), { id: idText(ref.id as GValue), type: ref.label, start: idText(from), end: idText(to), properties: {} });
      for (const e of [from, to]) {
        out.literals.set(idText(e), idLiteral(e));
        if (!out.nodes.has(idText(e))) out.vertexRefs.set(idText(e), e);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Scripts

/** A Groovy single-quoted string: no interpolation; backslashes and quotes escaped. */
export function gremlinString(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r") + "'";
}

const int = (n: number) => String(Math.max(1, Math.floor(n)));

function step(direction: Direction, type: string | undefined, as: string): string {
  const t = type ? gremlinString(type) : "";
  if (direction === "out") return `.outE(${t}).as('${as}').inV()`;
  if (direction === "in") return `.inE(${t}).as('${as}').outV()`;
  return `.bothE(${t}).as('${as}').otherV()`;
}

export interface GremlinQuery {
  script: string;
  /** Per pattern vertex: words one of its properties must contain, which Petal checks itself. */
  text?: (string | undefined)[];
}

export function gremlinSearch(spec: SearchSpec, limit: number, schema: Schema): GremlinQuery {
  if (spec.kind === "raw") return { script: spec.statement };
  if (spec.kind === "text") return { script: `g.V().limit(${TEXT_SCAN}).elementMap()`, text: [spec.term] };
  const text = spec.nodes.map((n) => n.text);
  const filtered = text.some(Boolean);
  const cap = filtered ? TEXT_SCAN : int(limit);
  const has = (label?: string) => (label ? `.hasLabel(${gremlinString(label)})` : "");
  if (spec.nodes.length === 1) return { script: `g.V()${has(spec.nodes[0].label)}.limit(${cap}).elementMap()`, text: filtered ? text : undefined };
  let script = `g.V()${has(spec.nodes[0].label)}.as('n0')`;
  const keys = ["'n0'"];
  for (let i = 1; i < spec.nodes.length; i++) {
    const type = spec.rels[i - 1]?.type;
    script += step(orient(schema, spec.nodes[i - 1].label, type, spec.nodes[i].label), type, `r${i - 1}`);
    script += `${has(spec.nodes[i].label)}.as('n${i}')`;
    keys.push(`'r${i - 1}'`, `'n${i}'`);
  }
  script += `.limit(${cap}).select(${keys.join(", ")}).by(elementMap())`;
  return { script, text: filtered ? text : undefined };
}

const idList = (ids: string[], literals: Map<string, string>) => ids.map((id) => literals.get(id) ?? gremlinString(id)).join(", ");

/**
 * The neighbors of `ids`. A label is a `hasLabel` step; words a neighbor must contain are checked by Petal
 * (`GremlinSource.expand`), so with them the script reads up to `TEXT_SCAN` rows.
 */
export function gremlinExpand(ids: string[], options: ExpandOptions, literals: Map<string, string>): string {
  const has = options.label ? `.hasLabel(${gremlinString(options.label)})` : "";
  const cap = options.text ? TEXT_SCAN : int(options.limit);
  return `g.V(${idList(ids, literals)}).as('n')${step(options.direction ?? "both", options.type, "r")}${has}.as('m').limit(${cap}).select('n', 'r', 'm').by(elementMap())`;
}

export function gremlinAmong(ids: string[], literals: Map<string, string>): string {
  const list = idList(ids, literals);
  return `g.V(${list}).outE().where(inV().hasId(within(${list}))).elementMap()`;
}

export function gremlinNeighborhood(id: string, literals: Map<string, string>): string {
  return `g.V(${idList([id], literals)}).project('out', 'in').by(outE().groupCount().by(T.label)).by(inE().groupCount().by(T.label))`;
}

export function gremlinHydrate(ids: string[], literals: Map<string, string>): string {
  return `g.V(${idList(ids, literals)}).elementMap()`;
}

export const GREMLIN_SCHEMA = {
  labels: `g.V().limit(${SCHEMA_SCAN}).groupCount().by(T.label)`,
  types: `g.E().limit(${SCHEMA_SCAN}).groupCount().by(T.label)`,
  patterns: "g.E().limit(2000).project('f', 't', 'e').by(outV().label()).by(T.label).by(inV().label()).dedup()",
};

/** Whether text reads as a Gremlin traversal to run as it is. */
export function looksLikeGremlin(text: string): boolean {
  return /^\s*[A-Za-z_]\w*\s*\.\s*(V|E|addV|addE|inject|io|call|union)\s*\(/.test(text);
}

// ---------------------------------------------------------------------------------------------------------
// Transports

/** The envelope of a Gremlin Server response, over either transport. */
interface Envelope {
  requestId?: string;
  status: { code: number; message?: string; attributes?: Record<string, unknown> };
  result?: { data?: unknown };
}

export interface Transport {
  submit(script: string): Promise<GValue[]>;
  close(): void;
}

function envelopeError(e: Envelope): SourceError {
  const code = e.status.code;
  const msg = (e.status.message || "").trim();
  if (code === 401 || code === 407) return new SourceError("The user name or password is wrong.", "AUTH");
  if (code === 598) return new SourceError(`The server stopped the traversal: it ran too long. ${msg}`.trim(), "TIMEOUT");
  return new SourceError(msg ? (msg.length > 400 ? `${msg.slice(0, 400)}…` : msg) : `The server answered ${code}.`, `GREMLIN_${code}`);
}

function dataOf(e: Envelope): GValue[] {
  const d = e.result?.data;
  if (d === undefined || d === null) return [];
  const v = decodeGraphSON(d);
  return Array.isArray(v) ? v : [v];
}

function requestBody(script: string, traversal: string) {
  const args: Record<string, unknown> = { gremlin: script, bindings: {}, language: "gremlin-groovy" };
  if (traversal && traversal !== "g") args.aliases = { g: traversal };
  return args;
}

const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export class HttpTransport implements Transport {
  constructor(
    private readonly url: string,
    private readonly conn: GremlinConnection,
  ) {}

  async submit(script: string): Promise<GValue[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: MIME };
    if (this.conn.user) headers.Authorization = "Basic " + Buffer.from(`${this.conn.user}:${this.conn.password}`, "utf8").toString("base64");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(requestBody(script, this.conn.traversal)), signal: controller.signal });
    } catch (e: any) {
      throw networkError(e, this.url);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let env: Envelope | null = null;
    try {
      env = text ? (JSON.parse(text) as Envelope) : null;
    } catch {
      // not JSON
    }
    if (res.status === 401 || res.status === 403) throw new SourceError("The user name or password is wrong.", "AUTH");
    if (!env?.status) {
      if (res.status === 404) throw new SourceError(`No Gremlin endpoint at ${this.url}. Gremlin Server answers HTTP only with its HTTP channelizer; try a ws:// address.`, "HTTP_404");
      // Neptune's errors: { code, detailedMessage }
      const neptune = (() => {
        try {
          return JSON.parse(text) as { detailedMessage?: string; code?: string };
        } catch {
          return null;
        }
      })();
      throw new SourceError(neptune?.detailedMessage ?? `The server answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}.`, `HTTP_${res.status}`);
    }
    if (env.status.code >= 300) throw envelopeError(env);
    return dataOf(env);
  }

  close() {}
}

interface Pending {
  data: GValue[];
  resolve: (data: GValue[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WebSocketTransport implements Transport {
  private socket: WebSocketConnection | null = null;
  private opening: Promise<WebSocketConnection> | null = null;
  private pending = new Map<string, Pending>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly url: string,
    private readonly conn: GremlinConnection,
  ) {}

  private async open(): Promise<WebSocketConnection> {
    if (this.socket) return this.socket;
    if (!this.opening) {
      this.opening = connectSocket(this.url)
        .then((s) => {
          this.socket = s;
          this.readLoop(s);
          return s;
        })
        .catch((e) => {
          this.opening = null;
          throw networkError(e, this.url);
        });
    }
    return this.opening;
  }

  /** A request as Gremlin Server reads it: a binary frame of the MIME type's length, the type, then the JSON. */
  private frame(message: unknown): Uint8Array {
    const mime = this.encoder.encode(MIME);
    const body = this.encoder.encode(JSON.stringify(message));
    const out = new Uint8Array(1 + mime.length + body.length);
    out[0] = mime.length;
    out.set(mime, 1);
    out.set(body, 1 + mime.length);
    return out;
  }

  private async readLoop(s: WebSocketConnection) {
    try {
      for (;;) {
        const msg = await s.read();
        if (msg === null) break;
        const env = JSON.parse(typeof msg === "string" ? msg : this.decoder.decode(msg)) as Envelope;
        const id = env.requestId ?? "";
        const p = this.pending.get(id);
        if (!p) continue;
        const code = env.status.code;
        if (code === 407) {
          // SASL PLAIN: "\0user\0password"
          const sasl = Buffer.from(`\0${this.conn.user}\0${this.conn.password}`, "utf8").toString("base64");
          await s.write(this.frame({ requestId: id, op: "authentication", processor: "", args: { sasl, saslMechanism: "PLAIN" } }));
          continue;
        }
        if (code === 206) {
          p.data.push(...dataOf(env));
          continue;
        }
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (code === 200 || code === 204) p.resolve([...p.data, ...dataOf(env)]);
        else p.reject(envelopeError(env));
      }
      this.fail(new SourceError("The server closed the connection.", "CLOSED"));
    } catch (e) {
      this.fail(e instanceof SourceError ? e : new SourceError(`The connection failed: ${e instanceof Error ? e.message : String(e)}`, "CLOSED"));
    }
  }

  private fail(e: SourceError) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this.socket = null;
    this.opening = null;
  }

  async submit(script: string): Promise<GValue[]> {
    const s = await this.open();
    const requestId = uuid();
    const done = new Promise<GValue[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new SourceError(`The server didn't answer within ${TIMEOUT_MS / 1000} seconds.`, "TIMEOUT"));
      }, TIMEOUT_MS);
      this.pending.set(requestId, { data: [], resolve, reject, timer });
    });
    await s.write(this.frame({ requestId, op: "eval", processor: "", args: requestBody(script, this.conn.traversal) }));
    return done;
  }

  close() {
    const s = this.socket;
    this.fail(new SourceError("The connection is closed.", "CLOSED"));
    s?.close().catch(() => {});
  }
}

function networkError(e: any, url: string): SourceError {
  if (e?.code === "ERR_ACCESS_DENIED") return new SourceError(`Petal isn't allowed to reach ${e.resource ?? url}. Add its host to capabilities.network in nsh.json.`, "ERR_ACCESS_DENIED");
  if (e?.name === "AbortError" || e?.code === "ETIMEDOUT") return new SourceError(`${hostOf(url)} didn't answer in time.`, "TIMEOUT");
  return new SourceError(`Couldn't reach ${hostOf(url)}. Check the address and that the server is running.`, "NETWORK");
}

const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");

/** The endpoint: a scheme added when missing (`ws://`), and `/gremlin` when there is no path. */
export function gremlinEndpoint(input: string): string {
  let url = input.trim();
  if (!url) throw new SourceError("Enter the server's address.");
  if (!/^[a-z]+:\/\//i.test(url)) url = `ws://${url}`;
  const m = /^([a-z]+):\/\/([^/]+)(\/.*)?$/i.exec(url);
  if (!m) throw new SourceError(`${input} is not an address.`);
  const scheme = m[1].toLowerCase();
  if (!["ws", "wss", "http", "https"].includes(scheme)) throw new SourceError(`Gremlin servers are reached over ws://, wss://, http:// or https://, not ${scheme}://.`);
  const host = m[2].includes(":") ? m[2] : `${m[2]}:8182`;
  const path = m[3] && m[3] !== "/" ? m[3] : "/gremlin";
  return `${scheme}://${host}${path}`;
}

// ---------------------------------------------------------------------------------------------------------

function containsText(n: DbNode, term: string): boolean {
  const t = term.toLowerCase();
  return Object.values(n.properties).some((v) => v.type !== "Null" && valueText(v).toLowerCase().includes(t));
}

export class GremlinSource implements GraphSource {
  readonly kind = "gremlin" as const;
  readonly language = "Gremlin" as const;
  readonly label: string;
  readonly key: string;
  /** Each ID Petal has seen, as a typed literal. */
  private literals = new Map<string, string>();
  private schemaCache: Schema = EMPTY_SCHEMA;

  private constructor(
    private readonly transport: Transport,
    endpoint: string,
    traversal: string,
  ) {
    this.label = hostOf(endpoint);
    this.key = `gremlin:${endpoint}/${traversal}`;
  }

  /** Connects and checks the server with a first traversal. */
  static async connect(conn: GremlinConnection, transport?: Transport): Promise<GremlinSource> {
    const endpoint = gremlinEndpoint(conn.url);
    const t = transport ?? (/^wss?:/i.test(endpoint) ? new WebSocketTransport(endpoint, conn) : new HttpTransport(endpoint, conn));
    const source = new GremlinSource(t, endpoint, conn.traversal.trim() || "g");
    try {
      await t.submit("g.inject(1)");
    } catch (e) {
      t.close();
      throw e;
    }
    return source;
  }

  close() {
    this.transport.close();
  }

  /** Runs a script and gathers its vertices and edges, filling in the vertices it only referenced. */
  async run(script: string): Promise<{ data: GValue[]; graph: Collected }> {
    const data = await this.transport.submit(script);
    const graph = newCollected();
    for (const v of data) collectGraph(v, graph);
    for (const [id, literal] of graph.literals) this.literals.set(id, literal);
    if (graph.vertexRefs.size) {
      const ids = [...graph.vertexRefs.keys()].slice(0, 2000);
      const more = newCollected();
      for (const v of await this.transport.submit(gremlinHydrate(ids, this.literals))) collectGraph(v, more);
      for (const [id, n] of more.nodes) graph.nodes.set(id, n);
    }
    return { data, graph };
  }

  async schema(): Promise<Schema> {
    const counts = async (script: string) => {
      const [m] = await this.transport.submit(script);
      if (!(m instanceof Map)) return [];
      const entries = [...m].map(([k, v]) => ({ name: String(k), count: v instanceof GInt ? Number(v.text) : Number(v) }));
      const total = entries.reduce((a, e) => a + e.count, 0);
      const exact = total < SCHEMA_SCAN;
      return entries
        .map((e) => ({ name: e.name, count: exact ? e.count : undefined }))
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
    };
    const [labels, relTypes, sample] = await Promise.all([
      counts(GREMLIN_SCHEMA.labels),
      counts(GREMLIN_SCHEMA.types),
      this.transport.submit(GREMLIN_SCHEMA.patterns).catch(() => [] as GValue[]),
    ]);
    const patterns = sample
      .filter((r): r is Map<unknown, GValue> => r instanceof Map)
      .map((r) => ({ from: String(r.get("f")), type: String(r.get("t")), to: String(r.get("e")) }));
    this.schemaCache = { labels, relTypes, patterns };
    return this.schemaCache;
  }

  async search(spec: SearchSpec, limit: number): Promise<GraphResult> {
    const q = gremlinSearch(spec, limit, this.schemaCache);
    const { data, graph } = await this.run(q.script);
    if (!q.text) return { nodes: [...graph.nodes.values()], rels: [...graph.rels.values()], rows: data.length };
    // Keep the rows whose vertices contain their words.
    const kept = newCollected();
    let rows = 0;
    for (const row of data) {
      const one = newCollected();
      collectGraph(row, one);
      const ok = q.text.every((t, i) => {
        if (!t) return true;
        const v = row instanceof Map && row.has(`n${i}`) ? row.get(`n${i}`) : row;
        const probe = newCollected();
        collectGraph(v ?? null, probe);
        const n = [...probe.nodes.values()][0];
        return !!n && containsText(n, t);
      });
      if (!ok) continue;
      for (const [id, n] of one.nodes) kept.nodes.set(id, n);
      for (const [id, r] of one.rels) kept.rels.set(id, r);
      if (++rows >= limit) break;
    }
    return { nodes: [...kept.nodes.values()], rels: [...kept.rels.values()], rows };
  }

  async expand(ids: string[], options: ExpandOptions): Promise<GraphResult> {
    const { data, graph } = await this.run(gremlinExpand(ids, options, this.literals));
    if (!options.text) return { nodes: [...graph.nodes.values()], rels: [...graph.rels.values()], rows: data.length };
    // Keep the rows whose neighbor contains the words.
    const kept = newCollected();
    let rows = 0;
    for (const row of data) {
      const probe = newCollected();
      collectGraph(row instanceof Map ? row.get("m") ?? null : null, probe);
      const m = [...probe.nodes.values()][0];
      if (!m || !containsText(m, options.text)) continue;
      const one = newCollected();
      collectGraph(row, one);
      for (const [id, n] of one.nodes) kept.nodes.set(id, graph.nodes.get(id) ?? n);
      for (const [id, r] of one.rels) kept.rels.set(id, r);
      if (++rows >= options.limit) break;
    }
    return { nodes: [...kept.nodes.values()], rels: [...kept.rels.values()], rows };
  }

  async relationshipsAmong(ids: string[]): Promise<DbRel[]> {
    if (!ids.length) return [];
    const { graph } = await this.run(gremlinAmong(ids, this.literals));
    return [...graph.rels.values()];
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const [m] = await this.transport.submit(gremlinNeighborhood(id, this.literals));
    if (!(m instanceof Map)) return [];
    const entries: NeighborhoodEntry[] = [];
    for (const direction of ["out", "in"] as const) {
      const counts = m.get(direction);
      if (!(counts instanceof Map)) continue;
      for (const [type, c] of counts) entries.push({ type: String(type), direction, count: c instanceof GInt ? Number(c.text) : Number(c) });
    }
    return entries.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }
}
