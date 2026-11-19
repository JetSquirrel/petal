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
export type CypherDialect = "neo4j" | "memgraph";

/**
 * `any property of v contains $p`, case-insensitively. Neo4j reads a property by a key it holds in a variable
 * (`v[k]`); Memgraph lists the values themselves (`values(v)`).
 */
function textFilter(v: string, p: string, dialect: CypherDialect): string {
  return dialect === "memgraph"
    ? `any(x IN values(${v}) WHERE toLower(toStringOrNull(x)) CONTAINS $${p})`
    : `any(k IN keys(${v}) WHERE toLower(toStringOrNull(${v}[k])) CONTAINS $${p})`;
}

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

export function expandStatement(ids: string[], options: ExpandOptions): Statement {
  return {
    statement: `MATCH (n)${relPattern("r", options.type, options.direction ?? "both")}(m) WHERE elementId(n) IN $ids RETURN n, r, m LIMIT ${int(options.limit)}`,
    parameters: { ids },
  };
}

export function relationshipsAmongStatement(ids: string[]): Statement {
  return {
    statement: "MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids AND elementId(b) IN $ids RETURN r",
    parameters: { ids },
  };
}

export function neighborhoodStatement(id: string): Statement {
  return {
    statement:
      "MATCH (n)-[r]-() WHERE elementId(n) = $id RETURN type(r) AS type, startNode(r) = n AS outgoing, count(*) AS count ORDER BY count DESC",
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
