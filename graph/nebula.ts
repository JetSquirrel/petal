/**
 * NebulaGraph through its HTTP gateway (vesoft-inc/nebula-http-gateway, the one NebulaGraph Studio runs).
 *
 * graphd itself speaks Thrift over TCP, a binary protocol; the gateway turns it into JSON over HTTP:
 * `POST /api/db/connect` opens a session (a `common-nsid` cookie), `POST /api/db/exec` runs nGQL in it.
 * Each statement is sent as `USE <space>; <statement>`, so the space never depends on the session's state.
 *
 * The gateway gives vertices and edges in `_verticesParsedList` / `_edgesParsedList` beside each row, but
 * not those inside paths or lists, so every statement here returns vertices and edges as columns of their
 * own. Nebula has no element IDs: a vertex is its VID (an INT64 or a string, as the space says), an edge
 * its source, type, rank and destination.
 */
import { orient } from "./cypher";
import { fromPlain, type DbNode, type DbRel, type GraphResult, type Table, type Value } from "./model";
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

export interface NebulaConnection {
  /** The gateway's address: `http://localhost:8080`. */
  gateway: string;
  /** graphd's host and port, as the gateway reaches them: `graphd:9669`. */
  graphd: string;
  user: string;
  password: string;
  space: string;
}

export type VidType = "int" | "string";

/** A gateway row: the columns by name, and the vertices and edges found in them. */
export interface GatewayRow {
  [column: string]: unknown;
  _verticesParsedList?: GatewayVertex[];
  _edgesParsedList?: GatewayEdge[];
}

export interface GatewayVertex {
  vid: string | number;
  tags: string[];
  properties: Record<string, Record<string, unknown>>;
}

export interface GatewayEdge {
  srcID: string | number;
  dstID: string | number;
  edgeName: string;
  rank: number;
  properties: Record<string, unknown>;
}

export interface GatewayResult {
  headers: string[];
  tables: GatewayRow[];
}

const TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------------------------------------
// nGQL

/** Backticks a space, tag, edge type or property name. */
export const ngqlName = (name: string) => "`" + name.replace(/`/g, "") + "`";

/** A string literal: nGQL takes C escapes in double quotes. */
export function ngqlString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
}

/** A VID as nGQL writes it in this space. Petal keeps VIDs as text. */
export function vidLiteral(vid: string, type: VidType): string {
  if (type === "int") {
    if (!/^-?\d+$/.test(vid)) throw new SourceError(`${vid} is not a vertex ID of this space.`);
    return vid;
  }
  return ngqlString(vid);
}

const vidList = (ids: string[], type: VidType) => `[${ids.map((id) => vidLiteral(id, type)).join(", ")}]`;
const int = (n: number) => String(Math.max(1, Math.floor(n)));

function textFilter(v: string, term: string): string {
  return `any(k IN keys(${v}) WHERE toLower(toString(properties(${v})[k])) CONTAINS ${ngqlString(term.toLowerCase())})`;
}

function relPattern(v: string, type: string | undefined, direction: Direction): string {
  const inner = `[${v}${type ? ":" + ngqlName(type) : ""}]`;
  return direction === "out" ? `-${inner}->` : direction === "in" ? `<-${inner}-` : `-${inner}-`;
}

export function ngqlSearch(spec: SearchSpec, limit: number, schema: Schema): string {
  if (spec.kind === "raw") return spec.statement;
  if (spec.kind === "text") return `MATCH (n) WHERE ${textFilter("n", spec.term)} RETURN n LIMIT ${int(limit)}`;
  let pattern = "";
  const where: string[] = [];
  const columns: string[] = [];
  spec.nodes.forEach((step, i) => {
    pattern += `(n${i}${step.label ? ":" + ngqlName(step.label) : ""})`;
    columns.push(`n${i}`);
    if (step.text) where.push(textFilter(`n${i}`, step.text));
    if (i < spec.nodes.length - 1) {
      const type = spec.rels[i]?.type;
      pattern += relPattern(`r${i}`, type, orient(schema, step.label, type, spec.nodes[i + 1].label));
      columns.push(`r${i}`);
    }
  });
  return `MATCH ${pattern}${where.length ? " WHERE " + where.join(" AND ") : ""} RETURN ${columns.join(", ")} LIMIT ${int(limit)}`;
}

export function ngqlExpand(ids: string[], options: ExpandOptions, vid: VidType): string {
  return `MATCH (n)${relPattern("r", options.type, options.direction ?? "both")}(m) WHERE id(n) IN ${vidList(ids, vid)} RETURN n, r, m LIMIT ${int(options.limit)}`;
}

export function ngqlAmong(ids: string[], vid: VidType): string {
  const list = vidList(ids, vid);
  return `MATCH (a)-[r]->(b) WHERE id(a) IN ${list} AND id(b) IN ${list} RETURN r`;
}

export function ngqlNeighborhood(id: string, vid: VidType): string {
  return `MATCH (n)-[r]-() WHERE id(n) == ${vidLiteral(id, vid)} RETURN type(r) AS type, src(r) == id(n) AS outgoing, count(*) AS count ORDER BY count DESC`;
}

/** Whether text reads as nGQL to run as it is. */
export function looksLikeNgql(text: string): boolean {
  return /^\s*(MATCH|OPTIONAL\s+MATCH|GO|LOOKUP|FETCH|GET\s+SUBGRAPH|FIND|SHOW|DESCRIBE|UNWIND|WITH|RETURN|YIELD)\b/i.test(text);
}

// ---------------------------------------------------------------------------------------------------------
// The gateway's values

/** A gateway value: numbers and booleans as JSON, nulls as "NULL", dates and collections as nGQL text. */
export function gatewayValue(v: unknown): Value {
  if (v === "NULL" || v === "__NULL__" || v === null || v === undefined) return { type: "Null" };
  if (v === "_EMPTY_") return { type: "Null" };
  return fromPlain(v);
}

const vidText = (v: string | number) => String(v);

export function gatewayNode(v: GatewayVertex): DbNode {
  const properties: Record<string, Value> = {};
  const tags = v.tags ?? [];
  const seen = new Map<string, number>();
  for (const tag of tags) for (const k of Object.keys(v.properties?.[tag] ?? {})) seen.set(k, (seen.get(k) ?? 0) + 1);
  for (const tag of tags) {
    for (const [k, x] of Object.entries(v.properties?.[tag] ?? {})) {
      // A name two tags share keeps its tag, so neither hides the other.
      properties[(seen.get(k) ?? 0) > 1 ? `${tag}.${k}` : k] = gatewayValue(x);
    }
  }
  return { id: vidText(v.vid), labels: tags, properties };
}

export function gatewayRel(e: GatewayEdge): DbRel {
  const properties: Record<string, Value> = {};
  for (const [k, x] of Object.entries(e.properties ?? {})) properties[k] = gatewayValue(x);
  const src = vidText(e.srcID);
  const dst = vidText(e.dstID);
  return { id: `${src}|${e.edgeName}|${e.rank ?? 0}|${dst}`, type: e.edgeName, start: src, end: dst, properties };
}

export function gatewayGraph(result: GatewayResult): GraphResult {
  const nodes = new Map<string, DbNode>();
  const rels = new Map<string, DbRel>();
  for (const row of result.tables) {
    for (const v of row._verticesParsedList ?? []) {
      const n = gatewayNode(v);
      nodes.set(n.id, n);
    }
    for (const e of row._edgesParsedList ?? []) {
      const r = gatewayRel(e);
      rels.set(r.id, r);
    }
  }
  return { nodes: [...nodes.values()], rels: [...rels.values()], rows: result.tables.length, table: gatewayTable(result) };
}

/** The gateway's rows under its headers. */
export function gatewayTable(result: GatewayResult): Table {
  return { columns: result.headers, rows: result.tables.map((row) => result.headers.map((h) => gatewayValue(row[h]))) };
}

const column = (row: GatewayRow, name: string) => row[name];

// ---------------------------------------------------------------------------------------------------------

export class NebulaSource implements GraphSource {
  readonly kind = "nebula" as const;
  readonly language = "nGQL" as const;
  readonly label: string;
  readonly key: string;
  private schemaCache: Schema = EMPTY_SCHEMA;

  private constructor(
    private readonly base: string,
    private readonly conn: NebulaConnection,
    private cookie: string,
    readonly vid: VidType,
  ) {
    this.label = `${conn.graphd}/${conn.space}`;
    this.key = `nebula:${conn.graphd}/${conn.space}`;
  }

  /** Signs in through the gateway, then checks the space and reads its VID type. */
  static async connect(conn: NebulaConnection): Promise<NebulaSource> {
    const base = gatewayBase(conn.gateway);
    const [host, portText] = splitHostPort(conn.graphd);
    const res = await request(`${base}/api/db/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: conn.user, password: conn.password, address: host, port: portText }),
    });
    const body = await readGateway(res);
    const cookie = sessionCookie(res.headers.get("set-cookie"));
    if (!cookie) throw new SourceError(`The gateway at ${new URL(base).host} signed in but sent no session cookie (${String(body ?? "")}).`, "NO_SESSION");
    const space = conn.space.trim();
    const probe = new NebulaSource(base, { ...conn, space }, cookie, "string");
    const spaces = (await probe.exec("SHOW SPACES", false)).tables.map((r) => String(column(r, "Name")));
    if (!space) {
      throw new SourceError(spaces.length ? `Choose a graph space: ${spaces.join(", ")}.` : "This NebulaGraph has no graph spaces yet.", "NO_SPACE");
    }
    if (!spaces.includes(space)) {
      throw new SourceError(`There is no space “${space}”. ${spaces.length ? `Spaces: ${spaces.join(", ")}.` : ""}`.trim(), "NO_SPACE");
    }
    const described = await probe.exec(`DESCRIBE SPACE ${ngqlName(space)}`, false);
    const vidType = String(column(described.tables[0] ?? {}, "Vid Type") ?? "");
    return new NebulaSource(base, { ...conn, space }, cookie, /INT/i.test(vidType) ? "int" : "string");
  }

  /** Runs nGQL in the space. */
  async exec(statement: string, inSpace = true): Promise<GatewayResult> {
    const gql = inSpace ? `USE ${ngqlName(this.conn.space)}; ${statement}` : statement;
    const res = await request(`${this.base}/api/db/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: this.cookie },
      body: JSON.stringify({ gql }),
    });
    const data = (await readGateway(res)) as { headers?: string[]; tables?: GatewayRow[] } | null;
    return { headers: data?.headers ?? [], tables: data?.tables ?? [] };
  }

  async schema(): Promise<Schema> {
    const [tags, edges] = await Promise.all([this.exec("SHOW TAGS"), this.exec("SHOW EDGES")]);
    const tagNames = tags.tables.map((r) => String(column(r, "Name")));
    const edgeNames = edges.tables.map((r) => String(column(r, "Name")));
    // Counts come from the space's last STATS job, when one ran (`SUBMIT JOB STATS`).
    const counts = new Map<string, number>();
    try {
      for (const r of (await this.exec("SHOW STATS")).tables) {
        const type = String(column(r, "Type"));
        if (type === "Tag" || type === "Edge") counts.set(`${type}:${column(r, "Name")}`, Number(column(r, "Count")));
      }
    } catch {
      // no stats yet
    }
    // Nebula keeps no record of which tags an edge type joins: a few edges of each type show it.
    const patterns: Schema["patterns"] = [];
    const seen = new Set<string>();
    await Promise.all(
      edgeNames.slice(0, 40).map(async (t) => {
        try {
          const sample = await this.exec(`MATCH (a)-[e:${ngqlName(t)}]->(b) RETURN tags(a)[0] AS f, tags(b)[0] AS t LIMIT 25`);
          for (const r of sample.tables) {
            const from = String(column(r, "f"));
            const to = String(column(r, "t"));
            const key = `${from}|${t}|${to}`;
            if (from !== "NULL" && to !== "NULL" && !seen.has(key)) {
              seen.add(key);
              patterns.push({ from, type: t, to });
            }
          }
        } catch {
          // an edge type with no edges, or a server that refuses the scan
        }
      }),
    );
    const byCount = (a: { name: string; count?: number }, b: { name: string; count?: number }) =>
      (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name);
    this.schemaCache = {
      labels: tagNames.map((name) => ({ name, count: counts.get(`Tag:${name}`) })).sort(byCount),
      relTypes: edgeNames.map((name) => ({ name, count: counts.get(`Edge:${name}`) })).sort(byCount),
      patterns,
    };
    return this.schemaCache;
  }

  async search(spec: SearchSpec, limit: number): Promise<GraphResult> {
    return gatewayGraph(await this.exec(ngqlSearch(spec, limit, this.schemaCache)));
  }

  async expand(ids: string[], options: ExpandOptions): Promise<GraphResult> {
    return gatewayGraph(await this.exec(ngqlExpand(ids, options, this.vid)));
  }

  async relationshipsAmong(ids: string[]): Promise<DbRel[]> {
    if (!ids.length) return [];
    return gatewayGraph(await this.exec(ngqlAmong(ids, this.vid))).rels;
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const res = await this.exec(ngqlNeighborhood(id, this.vid));
    return res.tables.map((r) => {
      const out = column(r, "outgoing");
      return {
        type: String(column(r, "type")),
        direction: out === true || out === "true" ? "out" : "in",
        count: Number(column(r, "count")) || 0,
      };
    });
  }
}

// ---------------------------------------------------------------------------------------------------------

export function gatewayBase(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!url) throw new SourceError("Enter the gateway's address.");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/^(https?:\/\/[^/]+).*$/i, "$1");
}

export function splitHostPort(graphd: string): [string, number] {
  const m = /^\s*\[?([^\]\s]+?)\]?(?::(\d+))?\s*$/.exec(graphd);
  if (!m) throw new SourceError("Enter graphd's address, such as graphd:9669.");
  return [m[1], m[2] ? Number(m[2]) : 9669];
}

/** The `common-nsid` cookie the gateway's sign-in sets, as a `Cookie` header. */
export function sessionCookie(setCookie: string | null): string | null {
  const m = /common-nsid=([^;,\s]+)/.exec(setCookie ?? "");
  return m ? `common-nsid=${m[1]}` : null;
}

/** The gateway's envelope: `{ code: 0, data }`, or a code and a message. */
async function readGateway(res: Response): Promise<unknown> {
  const text = await res.text();
  let json: { code?: number; data?: unknown; message?: string } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (res.status === 404) throw new SourceError("No NebulaGraph gateway at this address (it answered 404).", "HTTP_404");
  if (!json) throw new SourceError(`The gateway answered ${res.status} without JSON.`, `HTTP_${res.status}`);
  if (json.code !== 0) {
    const msg = (json.message || `error ${json.code}`).trim();
    if (/password|authenticat|bad username/i.test(msg)) throw new SourceError("The user name or password is wrong.", "AUTH");
    if (/session|nsid|connection.*(closed|lost)/i.test(msg)) throw new SourceError("The gateway lost the session. Connect again.", "SESSION");
    throw new SourceError(msg.length > 400 ? `${msg.slice(0, 400)}…` : msg, `NEBULA_${json.code}`);
  }
  return json.data;
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
    throw new SourceError(`Couldn't reach the gateway at ${new URL(url).host}. Check the address and that it is running.`, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}
