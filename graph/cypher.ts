/**
 * The Cypher Petal sends for each question. Plain functions of their inputs, so tests check the text.
 * Names are backticked; words the person typed go in parameters, never in the statement.
 */
import { cypherName } from "./model";
import type { Direction, ExpandOptions, Schema, SearchSpec } from "./source";

export interface Statement {
  statement: string;
  parameters: Record<string, unknown>;
}

const int = (n: number) => String(Math.max(1, Math.floor(n)));

/** The Cypher of a database, where it differs from Neo4j's. */
/**
 * The Cypher of a database, where it differs from Neo4j's. `neo4j-bolt` is Neo4j through Petal's Bolt client,
 * which speaks Bolt 4.4: nodes come with their integer IDs, not element IDs, so they are matched with `id()`.
 */
export type CypherDialect = "neo4j" | "neo4j-bolt" | "memgraph" | "neptune";

/**
 * `any property of v contains $p`, case-insensitively. Neo4j reads a property by a key it holds in a variable
 * (`v[k]`); Memgraph lists the values themselves (`values(v)`); Neptune's openCypher has no `toStringOrNull`.
 */
function textFilter(v: string, p: string, dialect: CypherDialect): string {
  if (dialect === "memgraph") return `any(x IN values(${v}) WHERE toLower(toStringOrNull(x)) CONTAINS $${p})`;
  if (dialect === "neptune") return `any(k IN keys(${v}) WHERE toLower(toString(${v}[k])) CONTAINS $${p})`;
  return `any(k IN keys(${v}) WHERE toLower(toStringOrNull(${v}[k])) CONTAINS $${p})`;
}

/** A node's ID as text: `elementId()` in Neo4j 5 and Memgraph; Neptune's IDs are strings, read with `id()`. */
const idOf = (v: string, dialect: CypherDialect) => (dialect === "neptune" ? `id(${v})` : `elementId(${v})`);

/**
 * `v`'s ID is one of the list `$p`. Over Bolt 4.4, Neo4j's IDs are integers that Petal keeps as text: the
 * list is turned back into integers, so Neo4j still finds the nodes by ID rather than scanning them.
 */
const idIn = (v: string, p: string, dialect: CypherDialect) =>
  dialect === "neo4j-bolt" ? `id(${v}) IN [x IN $${p} | toInteger(x)]` : `${idOf(v, dialect)} IN $${p}`;

const idIs = (v: string, p: string, dialect: CypherDialect) =>
  dialect === "neo4j-bolt" ? `id(${v}) = toInteger($${p})` : `${idOf(v, dialect)} = $${p}`;

/** The arrow of `(a)-[:type]-(b)` that the schema has, so a pattern follows the data's direction. */
export function orient(schema: Schema, from: string | undefined, type: string | undefined, to: string | undefined): Direction {
  const fits = (p: { from: string; type: string; to: string }, a?: string, b?: string) =>
    (!type || p.type === type) && (!a || p.from === a) && (!b || p.to === b);
  const forward = schema.patterns.some((p) => fits(p, from, to));
  const backward = schema.patterns.some((p) => fits(p, to, from));
  if (forward && !backward) return "out";
  if (backward && !forward) return "in";
  return "both";
}

function relPattern(v: string, type: string | undefined, direction: Direction): string {
  const inner = `[${v}${type ? ":" + cypherName(type) : ""}]`;
  if (direction === "out") return `-${inner}->`;
  if (direction === "in") return `<-${inner}-`;
  return `-${inner}-`;
}

export function searchStatement(spec: SearchSpec, limit: number, schema: Schema, dialect: CypherDialect = "neo4j"): Statement {
  if (spec.kind === "raw") return { statement: spec.statement, parameters: {} };
  if (spec.kind === "text") {
    return {
      statement: `MATCH (n) WHERE ${textFilter("n", "term", dialect)} RETURN n LIMIT ${int(limit)}`,
      parameters: { term: spec.term.toLowerCase() },
    };
  }
  const parameters: Record<string, unknown> = {};
  const where: string[] = [];
  let pattern = "";
  spec.nodes.forEach((step, i) => {
    pattern += `(n${i}${step.label ? ":" + cypherName(step.label) : ""})`;
    if (step.text) {
      parameters[`t${i}`] = step.text.toLowerCase();
      where.push(textFilter(`n${i}`, `t${i}`, dialect));
    }
    if (i < spec.nodes.length - 1) {
      const type = spec.rels[i]?.type;
      pattern += relPattern(`r${i}`, type, orient(schema, step.label, type, spec.nodes[i + 1].label));
    }
  });
  const single = spec.nodes.length === 1;
  return {
    statement: `MATCH ${single ? "" : "p = "}${pattern}${where.length ? " WHERE " + where.join(" AND ") : ""} RETURN ${single ? "n0" : "p"} LIMIT ${int(limit)}`,
    parameters,
  };
}

export function expandStatement(ids: string[], options: ExpandOptions, dialect: CypherDialect = "neo4j"): Statement {
  const parameters: Record<string, unknown> = { ids };
  let where = idIn("n", "ids", dialect);
  if (options.text) {
    parameters.text = options.text.toLowerCase();
    where += ` AND ${textFilter("m", "text", dialect)}`;
  }
  const m = `(m${options.label ? ":" + cypherName(options.label) : ""})`;
  return {
    statement: `MATCH (n)${relPattern("r", options.type, options.direction ?? "both")}${m} WHERE ${where} RETURN n, r, m LIMIT ${int(options.limit)}`,
    parameters,
  };
}

export function relationshipsAmongStatement(ids: string[], dialect: CypherDialect = "neo4j"): Statement {
  return {
    statement: `MATCH (a)-[r]->(b) WHERE ${idIn("a", "ids", dialect)} AND ${idIn("b", "ids", dialect)} RETURN r`,
    parameters: { ids },
  };
}

export function neighborhoodStatement(id: string, dialect: CypherDialect = "neo4j"): Statement {
  return {
    statement: `MATCH (n)-[r]-() WHERE ${idIs("n", "id", dialect)} RETURN type(r) AS type, startNode(r) = n AS outgoing, count(*) AS count ORDER BY count DESC`,
    parameters: { id },
  };
}

/** One statement counting every label's nodes from the count store, which answers at once. */
export function labelCountsStatement(labels: string[]): Statement {
  return {
    statement: labels.map((l) => `MATCH (:${cypherName(l)}) RETURN ${JSON.stringify(l)} AS name, count(*) AS count`).join(" UNION ALL "),
    parameters: {},
  };
}

export function relCountsStatement(types: string[]): Statement {
  return {
    statement: types.map((t) => `MATCH ()-[:${cypherName(t)}]->() RETURN ${JSON.stringify(t)} AS name, count(*) AS count`).join(" UNION ALL "),
    parameters: {},
  };
}

/** Whether text in the search field reads as Cypher rather than a search phrase. */
export function looksLikeCypher(text: string): boolean {
  return /^\s*(MATCH|OPTIONAL\s+MATCH|CALL|WITH|UNWIND|RETURN|SHOW|CYPHER)\b/i.test(text);
}
