/**
 * The tools Petal offers an assistant over MCP: read the schema, search with phrases, run the database's own
 * query language, expand nodes, see the scene the person is looking at, and show results there or in the
 * notebook. They work on whatever database Petal is connected to, through `GraphSource`, as the UI does.
 *
 * Queries are refused when they look like they write (`looksLikeWrite`) unless the person allowed writes.
 * That check reads keywords: it keeps an assistant from changing data by mistake, not a determined one.
 */
import type { DbNode, DbRel, GraphResult } from "../graph/model";
import type { Direction, GraphSource, Schema, SearchSpec } from "../graph/source";
import { plainValue, tableRecords, type Frame } from "../store/notebook";
import type { ToolDefinition, ToolResult } from "./protocol";

/** What the tools need of the app. */
export interface ToolHost {
  source(): GraphSource;
  schema(): Schema;
  ready(): boolean;
  /** A phrase as the search bar reads it. */
  parse(text: string): SearchSpec | null;
  /** The most rows a phrase or expansion brings in, as Petal's settings say. */
  limit(): number;
  scene(): { nodes: DbNode[]; rels: DbRel[]; selected: string[] };
  /** Brings a result into the scene; what it added. */
  show(result: GraphResult): Promise<{ addedNodes: number; addedRels: number }>;
  /** Runs text in a new notebook frame. */
  notebook(text: string): Promise<Frame | undefined>;
  allowWrites(): boolean;
}

const ROW_CAP = 200;
const NODE_CAP = 200;
const REL_CAP = 400;

const SHOW = {
  type: "boolean",
  description: "Also bring what was found into the scene Petal shows, so the person sees it. Default false.",
};

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "get_schema",
      title: "Database schema",
      description:
        "What the database Petal is connected to holds: its kind and query language, its labels (node categories) and relationship types with counts, and which labels each relationship type joins. Read it before writing queries.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "run_query",
      title: "Run a query",
      description:
        "Runs a query in the database's own language (Cypher on Neo4j, Memgraph and HawDB, openCypher on Amazon Neptune, nGQL on NebulaGraph, Gremlin on Gremlin servers; get_schema says which) and returns its columns and rows, plus the nodes and relationships in them. At most 200 rows come back, so use LIMIT. Queries that write are refused unless the person allowed writes in Petal.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The query, as the database runs it." },
          show: SHOW,
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "search",
      title: "Search with a phrase",
      description:
        'Finds nodes with one of Petal\'s search phrases, which work on every database: a label ("Person"), a label and words ("Person Ines"), a pattern ("Person WORKS_AT Company"), or quoted words matched against any property ("\\"Sparrow DB\\""). Returns the nodes and relationships found.',
      inputSchema: {
        type: "object",
        properties: {
          phrase: { type: "string", description: "The search phrase." },
          limit: { type: "integer", minimum: 1, maximum: 1000, description: "The most rows to bring back. Default: Petal's setting (100)." },
          show: SHOW,
        },
        required: ["phrase"],
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "expand",
      title: "Expand nodes",
      description: "Returns the neighbors of nodes, by their ids (as other tools return them), optionally of one relationship type and direction.",
      inputSchema: {
        type: "object",
        properties: {
          node_ids: { type: "array", items: { type: "string" }, minItems: 1, description: "The ids of the nodes to expand." },
          relationship_type: { type: "string", description: "Only relationships of this type." },
          direction: { type: "string", enum: ["out", "in", "both"], description: "Which way relationships point from the nodes. Default both." },
          limit: { type: "integer", minimum: 1, maximum: 1000, description: "The most neighbors. Default: Petal's setting (100)." },
          show: SHOW,
        },
        required: ["node_ids"],
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "get_scene",
      title: "What the person sees",
      description:
        "The nodes and relationships in the scene Petal shows the person now, and the ones they selected. Use it to answer questions about what they are looking at.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "add_to_notebook",
      title: "Add to the notebook",
      description:
        "Runs a query or a search phrase in a new frame at the top of Petal's notebook, where the person sees it with its graph, table and raw rows and can run or change it again. Returns what it found, as run_query does. The same write check applies.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "The query or search phrase." } },
        required: ["query"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
  ];
}

const compactNode = (n: DbNode) => ({ id: n.id, labels: n.labels, properties: plainProps(n.properties) });
const compactRel = (r: DbRel) => ({ id: r.id, type: r.type, start: r.start, end: r.end, properties: plainProps(r.properties) });

function plainProps(p: DbNode["properties"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) out[k] = plainValue(v);
  return out;
}

/** A result as tools return it: rows (when the source keeps them), nodes and relationships, capped. */
export function describeResult(result: GraphResult): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (result.table && result.table.columns.length) {
    const records = tableRecords(result.table);
    out.columns = result.table.columns;
    out.rows = records.slice(0, ROW_CAP);
    out.rowCount = records.length;
    if (records.length > ROW_CAP) out.rowsTruncated = true;
  } else out.rowCount = result.rows;
  out.nodes = result.nodes.slice(0, NODE_CAP).map(compactNode);
  out.relationships = result.rels.slice(0, REL_CAP).map(compactRel);
  if (result.nodes.length > NODE_CAP || result.rels.length > REL_CAP) {
    out.graphTruncated = { nodes: result.nodes.length, relationships: result.rels.length };
  }
  return out;
}

const ok = (value: unknown): ToolResult => ({ text: JSON.stringify(value) });
const fail = (message: string): ToolResult => ({ text: message, isError: true });

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

function count(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.max(1, Math.min(1000, Math.floor(v))) : fallback;
}

/** Runs a tool; a failure the assistant should read comes back as an error result, not a thrown error. */
export async function callTool(host: ToolHost, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!host.ready() && name !== "get_scene") {
    return fail("Petal isn't connected to a database right now. Ask the person to connect, then try again.");
  }
  const source = host.source();
  const show = args.show === true;
  const withScene = async (result: GraphResult, extra: Record<string, unknown> = {}) => {
    const out: Record<string, unknown> = { ...extra, ...describeResult(result) };
    if (show) out.addedToScene = await host.show(result);
    return ok(out);
  };

  switch (name) {
    case "get_schema": {
      const s = host.schema();
      return ok({
        database: { kind: source.kind, name: source.label, queryLanguage: source.language },
        labels: s.labels,
        relationshipTypes: s.relTypes,
        patterns: s.patterns.map((p) => `(:${p.from})-[:${p.type}]->(:${p.to})`),
      });
    }
    case "run_query": {
      const query = str(args, "query");
      if (!query) return fail("Give the query to run.");
      if (!source.language) return fail("This database runs no query language (it is Petal's demo graph). Use the search tool, or ask the person to connect a database.");
      const write = !host.allowWrites() && looksLikeWrite(query, source.language);
      if (write) return fail(writeRefusal(write));
      return withScene(await source.search({ kind: "raw", statement: query }, host.limit()));
    }
    case "search": {
      const phrase = str(args, "phrase");
      const spec = host.parse(phrase);
      if (!spec) return fail("Give a search phrase.");
      if (spec.kind === "raw") {
        const write = !host.allowWrites() && looksLikeWrite(phrase, source.language);
        if (write) return fail(writeRefusal(write));
      }
      return withScene(await source.search(spec, count(args, "limit", host.limit())));
    }
    case "expand": {
      const ids = Array.isArray(args.node_ids) ? args.node_ids.filter((x): x is string => typeof x === "string" && x !== "") : [];
      if (!ids.length) return fail("Give the ids of the nodes to expand.");
      const direction = (["out", "in", "both"] as const).find((d) => d === args.direction) as Direction | undefined;
      const type = str(args, "relationship_type") || undefined;
      return withScene(await source.expand(ids, { type, direction, limit: count(args, "limit", host.limit()) }));
    }
    case "get_scene": {
      const s = host.scene();
      return ok({
        database: { kind: source.kind, name: source.label },
        nodeCount: s.nodes.length,
        relationshipCount: s.rels.length,
        selected: s.selected,
        nodes: s.nodes.slice(0, 500).map(compactNode),
        relationships: s.rels.slice(0, 1000).map(compactRel),
        truncated: s.nodes.length > 500 || s.rels.length > 1000,
      });
    }
    case "add_to_notebook": {
      const query = str(args, "query");
      if (!query) return fail("Give the query or phrase to run.");
      const spec = host.parse(query);
      if (spec?.kind === "raw") {
        const write = !host.allowWrites() && looksLikeWrite(query, source.language);
        if (write) return fail(writeRefusal(write));
      }
      const frame = await host.notebook(query);
      if (!frame) return fail("Give the query or phrase to run.");
      if (frame.status === "error") return fail(frame.error ?? "The query failed.");
      return ok({ frame: frame.id, ms: frame.ms, ...(frame.result ? describeResult(frame.result) : {}) });
    }
    default:
      return fail(`Unknown tool: ${name}.`);
  }
}

function writeRefusal(what: string): string {
  return `Petal refused this query because it ${what}, and the person hasn't allowed assistants to change the database. Rewrite it to only read, or ask them to turn on "Allow queries that write" in Petal.`;
}

/**
 * Text with string literals, quoted names and comments blanked out, so their words aren't read as keywords.
 * Comments are `//` and `/* *\/` in Cypher and Gremlin; nGQL also has `#` and `--` (which in Cypher is a
 * relationship, `(a)--(b)`, so it stays).
 */
export function code(statement: string, language: string | null): string {
  const s = statement;
  let out = "";
  let i = 0;
  const lineComment = (at: number) =>
    s.startsWith("//", at) || (language === "nGQL" && (s[at] === "#" || s.startsWith("--", at)));
  while (i < s.length) {
    const ch = s[i];
    if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      out += " ";
    } else if (lineComment(i)) {
      const end = s.indexOf("\n", i);
      i = end < 0 ? s.length : end;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      // A literal or a quoted name, to its closing quote: `\` escapes in strings, a doubled backtick in names.
      let j = i + 1;
      while (j < s.length) {
        if (ch !== "`" && s[j] === "\\") j += 2;
        else if (s[j] === ch && ch === "`" && s[j + 1] === "`") j += 2;
        else if (s[j] === ch) break;
        else j++;
      }
      i = j + 1;
      out += " x ";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const CYPHER_WRITES = /(?<![.\w$])(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|FOREACH|LOAD\s+CSV|ALTER|RENAME|GRANT|REVOKE|DENY|IN\s+TRANSACTIONS)(?![\w$])/i;
const NGQL_WRITES = /(?<![.\w$])(INSERT|UPDATE|UPSERT|DELETE|CREATE|DROP|ALTER|CLEAR|REBUILD|SUBMIT|DOWNLOAD|INGEST|GRANT|REVOKE|KILL|BALANCE|ADD|REMOVE|SIGN|MERGE|RESTORE)(?![\w$])/i;
const GREMLIN_WRITES = /(\baddV|\baddE|\bmergeV|\bmergeE|\.drop|\.property|\.io|\.sideEffect)\s*\(/;
/** Procedures Cypher may call that only read. */
const READ_PROCEDURES = /^(db\.(labels|relationshipTypes|propertyKeys|schema\.\w+|indexes|constraints|info)|dbms\.(components|procedures|functions)|apoc\.meta\.\w+|mg\.procedures|schema\.(node_type_properties|rel_type_properties))$/i;

/** What makes a statement look like it writes ("uses DELETE"), or null when it looks like it only reads. */
export function looksLikeWrite(statement: string, language: string | null): string | null {
  const c = code(statement, language);
  if (language === "Gremlin") {
    const m = GREMLIN_WRITES.exec(c);
    return m ? `calls ${m[1].replace(/^\./, "")}()` : null;
  }
  const m = (language === "nGQL" ? NGQL_WRITES : CYPHER_WRITES).exec(c);
  if (m) return `uses ${m[1].toUpperCase().replace(/\s+/g, " ")}`;
  if (language !== "nGQL") {
    for (const call of c.matchAll(/(?<![.\w$])CALL\s+([\w.]+)/gi)) {
      if (!READ_PROCEDURES.test(call[1])) return `calls the procedure ${call[1]}, which may write`;
    }
  }
  return null;
}
