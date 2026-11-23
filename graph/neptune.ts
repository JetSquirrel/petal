/**
 * Amazon Neptune Database over its openCypher HTTPS endpoint (`POST /openCypher`, engine 1.1.1 and later).
 *
 * - **Authentication.** A cluster with IAM database authentication wants every request signed with
 *   Signature Version 4 (service `neptune-db`); Petal signs with an access key when one is given, and sends
 *   requests unsigned when not. The secret key (and a temporary session token) are kept only while Petal runs.
 * - **Reaching it.** Neptune answers only inside its VPC: connect from a machine there, through a VPN, or an
 *   SSH tunnel (with the cluster's name in the hosts file, so the signed `Host` matches).
 * - **Cypher.** `cypher.ts`'s statements in the Neptune dialect: IDs are strings read with `id()`, and there
 *   is no `toStringOrNull()`. Neptune keeps no count store and has no `db.labels()`, so the schema is read from
 *   up to `SCHEMA_SCAN` elements, as for Gremlin servers.
 * - **Results.** Plain JSON: `{ results: [{ column: value }] }`, with nodes and relationships as maps of
 *   `~id`, `~entityType`, `~labels` / `~type`, `~start`, `~end` and `~properties`.
 */
import { expandStatement, neighborhoodStatement, relationshipsAmongStatement, searchStatement, type Statement } from "./cypher";
import { asNumber, fromPlain, plainProps, valueText, type DbNode, type DbRel, type GraphResult, type Value } from "./model";
import { EMPTY_SCHEMA, SourceError, type ExpandOptions, type GraphSource, type NeighborhoodEntry, type Schema, type SearchSpec } from "./source";

export interface NeptuneConnection {
  /** The cluster or instance endpoint: `https://my-db.cluster-xxxx.us-east-1.neptune.amazonaws.com:8182`. */
  url: string;
  /** Its AWS Region; empty to read it from the address. */
  region: string;
  /** An IAM access key ID; empty when the cluster has IAM authentication off. */
  accessKeyId: string;
  /** The secret access key, then a session token on a line of its own for temporary credentials (`joinSecret`). */
  password: string;
}

export const SCHEMA_SCAN = 200_000;
const TIMEOUT_MS = 60_000;
const SERVICE = "neptune-db";

/** The secret key and session token as one string: what Petal keeps for the session in place of a password. */
export function joinSecret(secret: string, sessionToken: string): string {
  return sessionToken.trim() ? `${secret.trim()}\n${sessionToken.trim()}` : secret.trim();
}

export function splitSecret(password: string): { secret: string; sessionToken: string } {
  const at = password.indexOf("\n");
  return at < 0 ? { secret: password.trim(), sessionToken: "" } : { secret: password.slice(0, at).trim(), sessionToken: password.slice(at + 1).trim() };
}

/** The endpoint's base: `https://` added when missing, port 8182 when none is given, no path. */
export function neptuneBase(input: string): string {
  const url = input.trim();
  if (!url) throw new SourceError("Enter the cluster's endpoint.");
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]+)/i.exec(url);
  if (!m) throw new SourceError(`${input} is not an address.`);
  const scheme = (m[1] ?? "https").toLowerCase();
  if (scheme !== "https" && scheme !== "http") throw new SourceError(`Neptune's openCypher endpoint is reached over https://, not ${scheme}://.`);
  const host = /:\d+$/.test(m[2]) ? m[2] : `${m[2]}:8182`;
  return `${scheme}://${host}`;
}

/** The Region in a Neptune endpoint's name (`….us-east-1.neptune.amazonaws.com`), or null. */
export function regionOf(base: string): string | null {
  const host = base.replace(/^[a-z]+:\/\//i, "").replace(/:\d+$/, "");
  return /\.([a-z]{2}(?:-[a-z]+)+-\d+)\.neptune\.amazonaws\.com(?:\.cn)?$/i.exec(host)?.[1].toLowerCase() ?? null;
}

// ---------------------------------------------------------------------------------------------------------
// Signature Version 4

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

const sha256Hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (key: any, s: string): any => crypto.createHmac("sha256", key).update(s).digest();
const hmacHex = (key: any, s: string): string => crypto.createHmac("sha256", key).update(s).digest("hex");

/** RFC 3986 encoding, as SigV4's canonical request has it. */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** `20150830T123600Z`. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
}

/**
 * The request's headers with SigV4's added: `X-Amz-Date`, `X-Amz-Security-Token` for temporary credentials,
 * and `Authorization`. Every header given is signed, and `host` (as `fetch` will send it) with them.
 */
export function signV4(req: SignInput, creds: AwsCredentials, region: string, service: string, now: Date): Record<string, string> {
  const url = new URL(req.url);
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { ...req.headers, "X-Amz-Date": date };
  if (creds.sessionToken) headers["X-Amz-Security-Token"] = creds.sessionToken;

  const canonical = new Map<string, string>([["host", url.host]]);
  for (const [k, v] of Object.entries(headers)) canonical.set(k.toLowerCase(), v.trim().replace(/\s+/g, " "));
  const names = [...canonical.keys()].sort();
  const signedHeaders = names.join(";");
  const path = url.pathname.split("/").map((seg) => rfc3986(decodeURIComponent(seg))).join("/") || "/";
  const query = url.search
    .slice(1)
    .split("&")
    .filter(Boolean)
    .map((kv) => {
      const [k, v = ""] = kv.split("=");
      return [rfc3986(decodeURIComponent(k.replace(/\+/g, " "))), rfc3986(decodeURIComponent(v.replace(/\+/g, " ")))];
    })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    req.method.toUpperCase(),
    path,
    query,
    names.map((n) => `${n}:${canonical.get(n)}\n`).join(""),
    signedHeaders,
    sha256Hex(req.body),
  ].join("\n");

  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region), service), "aws4_request");
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmacHex(key, toSign)}`;
  return headers;
}

// ---------------------------------------------------------------------------------------------------------
// Results

interface NeptuneElement {
  "~id": string;
  "~entityType": "node" | "relationship";
  "~labels"?: string[];
  "~type"?: string;
  "~start"?: string;
  "~end"?: string;
  "~properties"?: Record<string, unknown>;
}

const isElement = (x: unknown): x is NeptuneElement => !!x && typeof x === "object" && !Array.isArray(x) && "~entityType" in (x as object) && "~id" in (x as object);
const isPath = (x: unknown[]) =>
  x.length >= 3 && x.length % 2 === 1 && x.every((e, i) => isElement(e) && e["~entityType"] === (i % 2 === 0 ? "node" : "relationship"));

/** A cell as a `Value`: nodes, relationships and paths as `Text`, the way the Neo4j driver shows them. */
export function neptuneValue(x: unknown): Value {
  if (isElement(x)) {
    return x["~entityType"] === "node"
      ? { type: "Text", kind: "Node", value: `(:${(x["~labels"] ?? []).join(":")})` }
      : { type: "Text", kind: "Relationship", value: `[:${x["~type"] ?? ""}]` };
  }
  if (Array.isArray(x)) return isPath(x) ? { type: "Text", kind: "Path", value: `path of ${(x.length - 1) / 2}` } : { type: "List", value: x.map(neptuneValue) };
  if (x && typeof x === "object") {
    const out: Record<string, Value> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[k] = neptuneValue(v);
    return { type: "Map", value: out };
  }
  return fromPlain(x);
}

/** Gathers the nodes and relationships anywhere in a cell. */
export function collectNeptune(x: unknown, nodes: Map<string, DbNode>, rels: Map<string, DbRel>) {
  if (isElement(x)) {
    const id = String(x["~id"]);
    const properties = plainProps(x["~properties"] ?? {});
    if (x["~entityType"] === "node") nodes.set(id, { id, labels: x["~labels"] ?? [], properties });
    else rels.set(id, { id, type: x["~type"] ?? "", start: String(x["~start"]), end: String(x["~end"]), properties });
    return;
  }
  if (Array.isArray(x)) for (const v of x) collectNeptune(v, nodes, rels);
  else if (x && typeof x === "object") for (const v of Object.values(x as Record<string, unknown>)) collectNeptune(v, nodes, rels);
}

export interface RunResult {
  fields: string[];
  rows: Value[][];
  nodes: DbNode[];
  rels: DbRel[];
}

export function fromNeptune(json: any): RunResult {
  const results: Record<string, unknown>[] = Array.isArray(json?.results) ? json.results : [];
  const fields = results.length ? Object.keys(results[0]) : [];
  const nodes = new Map<string, DbNode>();
  const rels = new Map<string, DbRel>();
  const rows = results.map((r) =>
    fields.map((f) => {
      collectNeptune(r[f], nodes, rels);
      return neptuneValue(r[f]);
    }),
  );
  return { fields, rows, nodes: [...nodes.values()], rels: [...rels.values()] };
}

/** The statements the schema is read with, each over at most `SCHEMA_SCAN` elements. */
export const NEPTUNE_SCHEMA = {
  labels: `MATCH (n) WITH n LIMIT ${SCHEMA_SCAN} UNWIND labels(n) AS name RETURN name, count(*) AS count`,
  types: `MATCH ()-[r]->() WITH r LIMIT ${SCHEMA_SCAN} RETURN type(r) AS name, count(*) AS count`,
  patterns: "MATCH (a)-[r]->(b) WITH a, r, b LIMIT 2000 RETURN DISTINCT labels(a) AS f, type(r) AS t, labels(b) AS e",
};

// ---------------------------------------------------------------------------------------------------------

export class NeptuneSource implements GraphSource {
  readonly kind = "neptune" as const;
  readonly language = "Cypher" as const;
  readonly label: string;
  readonly key: string;
  private schemaCache: Schema = EMPTY_SCHEMA;

  private constructor(
    private readonly base: string,
    private readonly region: string,
    private readonly creds: AwsCredentials | null,
  ) {
    this.label = base.replace(/^https?:\/\//, "").replace(/:8182$/, "");
    this.key = `neptune:${base}`;
  }

  /** Checks the endpoint and the credentials with `RETURN 1`. */
  static async connect(conn: NeptuneConnection): Promise<NeptuneSource> {
    const base = neptuneBase(conn.url);
    const keyId = conn.accessKeyId.trim();
    let creds: AwsCredentials | null = null;
    let region = conn.region.trim();
    if (keyId) {
      const { secret, sessionToken } = splitSecret(conn.password);
      if (!secret) throw new SourceError("Enter the secret access key of the access key.", "AUTH");
      region ||= regionOf(base) ?? "";
      if (!region) throw new SourceError("Enter the cluster's Region: its address doesn't name one.");
      creds = { accessKeyId: keyId, secretAccessKey: secret, sessionToken: sessionToken || undefined };
    }
    const source = new NeptuneSource(base, region, creds);
    await source.run({ statement: "RETURN 1 AS ok", parameters: {} });
    return source;
  }

  get endpoint(): string {
    return `${this.base}/openCypher`;
  }

  async run(st: Statement): Promise<RunResult> {
    const body = `query=${rfc3986(st.statement)}&parameters=${rfc3986(JSON.stringify(st.parameters))}`;
    let headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (this.creds) headers = signV4({ method: "POST", url: this.endpoint, headers, body }, this.creds, this.region, SERVICE, new Date());
    const res = await request(this.endpoint, { method: "POST", headers, body });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: a proxy's page
    }
    if (!res.ok) throw this.failure(res.status, json, text);
    return fromNeptune(json);
  }

  private failure(status: number, json: any, text: string): SourceError {
    const code: string = json?.code ?? "";
    const detail: string = (json?.detailedMessage ?? json?.message ?? "").trim();
    if (status === 403 || /AccessDenied|InvalidSignature|MissingAuthenticationToken|ExpiredToken|UnrecognizedClient/i.test(code)) {
      if (!this.creds) return new SourceError("The cluster wants signed requests: it has IAM authentication on. Enter an access key and its secret.", "AUTH");
      if (/expired/i.test(`${code} ${detail}`)) return new SourceError("The credentials have expired. Enter new ones.", "AUTH");
      return new SourceError(`Neptune refused the credentials${detail ? `: ${detail}` : "."} Check the access key, its secret, the Region and the role's neptune-db permissions.`, "AUTH");
    }
    if (status === 404) return new SourceError(`No openCypher endpoint at ${this.endpoint}. Petal needs Neptune engine 1.1.1 or later.`, "HTTP_404");
    const msg = detail || (text ? text.slice(0, 200) : `The database answered ${status}.`);
    return new SourceError(msg.length > 400 ? `${msg.slice(0, 400)}…` : msg, code || `HTTP_${status}`);
  }

  async schema(): Promise<Schema> {
    const counted = async (statement: string) => {
      const res = await this.run({ statement, parameters: {} });
      const [name, count] = [res.fields.indexOf("name"), res.fields.indexOf("count")];
      const entries = res.rows.map((r) => ({ name: valueText(r[name]), count: asNumber(r[count]) ?? 0 }));
      const exact = entries.reduce((a, e) => a + e.count, 0) < SCHEMA_SCAN;
      return entries
        .map((e) => ({ name: e.name, count: exact ? e.count : undefined }))
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
    };
    const [labels, relTypes, sample] = await Promise.all([
      counted(NEPTUNE_SCHEMA.labels),
      counted(NEPTUNE_SCHEMA.types),
      this.run({ statement: NEPTUNE_SCHEMA.patterns, parameters: {} }).catch(() => ({ fields: [], rows: [] }) as unknown as RunResult),
    ]);
    const [f, t, e] = ["f", "t", "e"].map((c) => sample.fields.indexOf(c));
    const seen = new Set<string>();
    const patterns: Schema["patterns"] = [];
    for (const row of sample.rows) {
      const list = (v: Value) => (v.type === "List" ? v.value.map(valueText) : [valueText(v)]);
      for (const from of list(row[f])) {
        for (const to of list(row[e])) {
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
    const res = await this.run(searchStatement(spec, limit, this.schemaCache, "neptune"));
    return { nodes: res.nodes, rels: res.rels, rows: res.rows.length, table: { columns: res.fields, rows: res.rows } };
  }

  async expand(ids: string[], options: ExpandOptions): Promise<GraphResult> {
    const res = await this.run(expandStatement(ids, options, "neptune"));
    return { nodes: res.nodes, rels: res.rels, rows: res.rows.length };
  }

  async relationshipsAmong(ids: string[]): Promise<DbRel[]> {
    if (!ids.length) return [];
    return (await this.run(relationshipsAmongStatement(ids, "neptune"))).rels;
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const res = await this.run(neighborhoodStatement(id, "neptune"));
    const [type, out, count] = ["type", "outgoing", "count"].map((c) => res.fields.indexOf(c));
    return res.rows.map((r) => ({
      type: valueText(r[type]),
      direction: r[out]?.type === "Boolean" && r[out].value ? "out" : "in",
      count: asNumber(r[count]) ?? 0,
    }));
  }
}

async function request(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const host = url.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e?.code === "ERR_ACCESS_DENIED") {
      throw new SourceError(`Petal isn't allowed to reach ${e.resource ?? url}. Add its host to capabilities.network in nsh.json.`, "ERR_ACCESS_DENIED");
    }
    if (e?.name === "AbortError") throw new SourceError(`${host} didn't answer within ${TIMEOUT_MS / 1000} seconds.`, "TIMEOUT");
    throw new SourceError(`Couldn't reach ${host}. Neptune answers only inside its VPC: check the endpoint, and connect from there, over a VPN or through a tunnel.`, "NETWORK");
  } finally {
    clearTimeout(timer);
  }
}
