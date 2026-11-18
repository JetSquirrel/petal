import { expect, test } from "nsh/test";
import { expandStatement, orient, searchStatement } from "./cypher";
import { DemoSource } from "./demo";
import { nodeCaption, valueText } from "./model";
import { collectTyped, decodeTyped, httpBase } from "./neo4j";
import { parsePhrase, phraseOf, suggest, tokenize } from "./phrase";
import type { Schema } from "./source";

const schema: Schema = {
  labels: [{ name: "Person" }, { name: "Company" }, { name: "Project" }, { name: "City" }],
  relTypes: [{ name: "WORKS_AT" }, { name: "MAINTAINS" }, { name: "LIVES_IN" }, { name: "KNOWS" }],
  patterns: [
    { from: "Person", type: "WORKS_AT", to: "Company" },
    { from: "Person", type: "MAINTAINS", to: "Project" },
    { from: "Person", type: "LIVES_IN", to: "City" },
    { from: "Person", type: "KNOWS", to: "Person" },
  ],
};

test("tokenizes quoted words as one", () => {
  expect(tokenize(`Person "Sparrow DB"  WORKS_AT`)).toEqual(["Person", "Sparrow DB", "WORKS_AT"]);
});

test("reads labels, types and words, in any case", () => {
  expect(parsePhrase("person works_at company", schema)).toEqual({
    kind: "pattern",
    nodes: [{ label: "Person" }, { label: "Company" }],
    rels: [{ type: "WORKS_AT" }],
  });
  expect(parsePhrase("Person Inês", schema)).toEqual({ kind: "pattern", nodes: [{ label: "Person", text: "Inês" }], rels: [] });
  expect(parsePhrase("MAINTAINS", schema)).toEqual({ kind: "pattern", nodes: [{}, {}], rels: [{ type: "MAINTAINS" }] });
  expect(parsePhrase("Person City", schema)).toEqual({ kind: "pattern", nodes: [{ label: "Person" }, { label: "City" }], rels: [{}] });
  expect(parsePhrase("lattice", schema)).toEqual({ kind: "text", term: "lattice" });
  expect(parsePhrase("match (n) return n", schema)).toEqual({ kind: "raw", statement: "match (n) return n" });
  expect(parsePhrase("   ", schema)).toBe(null);
});

test("a phrase reads back as itself", () => {
  for (const p of ["Person WORKS_AT Company", `Person "Inês Carvalho"`, "Project"]) {
    expect(phraseOf(parsePhrase(p, schema)!)).toBe(p);
  }
});

test("suggests completions and the patterns that continue a phrase", () => {
  const s = suggest("Pe", schema, [], "Cypher").map((x) => x.phrase);
  expect(s[0]).toBe("Person");
  const more = suggest("Person", schema, [], "Cypher").map((x) => x.phrase);
  expect(more).toContain("Person WORKS_AT Company");
  expect(more).toContain("Person LIVES_IN City");
  const empty = suggest("", schema, ["Project"], "Cypher").map((x) => x.phrase);
  expect(empty[0]).toBe("Project");
  expect(suggest("MATCH (n) RETURN n", schema, [], null)).toEqual([]);
});

test("builds Cypher that follows the schema's direction and keeps words in parameters", () => {
  const st = searchStatement(parsePhrase("Company WORKS_AT Person Inês", schema)!, 50, schema);
  expect(st.statement).toBe(
    "MATCH p = (n0:`Company`)<-[r0:`WORKS_AT`]-(n1:`Person`) WHERE any(k IN keys(n1) WHERE toLower(toStringOrNull(n1[k])) CONTAINS $t1) RETURN p LIMIT 50",
  );
  expect(st.parameters).toEqual({ t1: "inês" });
  expect(orient(schema, "Person", "KNOWS", "Person")).toBe("both");
  expect(searchStatement({ kind: "pattern", nodes: [{ label: "We`ird" }], rels: [] }, 10, schema).statement).toBe(
    "MATCH (n0:`We``ird`) RETURN n0 LIMIT 10",
  );
  expect(expandStatement(["a"], { type: "KNOWS", direction: "out", limit: 5 }).statement).toBe(
    "MATCH (n)-[r:`KNOWS`]->(m) WHERE elementId(n) IN $ids RETURN n, r, m LIMIT 5",
  );
});

test("maps database addresses to HTTP", () => {
  expect(httpBase("localhost:7474")).toBe("http://localhost:7474");
  expect(httpBase("neo4j+s://abc.databases.neo4j.io")).toBe("https://abc.databases.neo4j.io");
  expect(httpBase("bolt://db.internal:7687")).toBe("http://db.internal:7474");
  expect(httpBase("https://graph.example.com/browser/")).toBe("https://graph.example.com");
  expect(() => httpBase("ftp://x")).toThrow();
});

test("decodes typed JSON, nodes inside paths and lists included", () => {
  expect(decodeTyped({ $type: "Integer", _value: "9007199254740993" })).toEqual({ type: "Integer", value: "9007199254740993" });
  expect(valueText(decodeTyped({ $type: "Date", _value: "2015-03-26" }))).toBe("2015-03-26");
  const node = (id: string, name: string) => ({
    $type: "Node",
    _value: { _element_id: id, _labels: ["Person"], _properties: { name: { $type: "String", _value: name } } },
  });
  const path = {
    $type: "Path",
    _value: [
      node("4:x:0", "Alice"),
      { $type: "Relationship", _value: { _element_id: "5:x:0", _start_node_element_id: "4:x:0", _end_node_element_id: "4:x:1", _type: "KNOWS", _properties: {} } },
      node("4:x:1", "Bob"),
    ],
  };
  const nodes = new Map();
  const rels = new Map();
  collectTyped({ $type: "List", _value: [path] }, nodes, rels);
  expect([...nodes.keys()]).toEqual(["4:x:0", "4:x:1"]);
  expect(rels.get("5:x:0").start).toBe("4:x:0");
  expect(nodeCaption(nodes.get("4:x:1"))).toBe("Bob");
});

test("the demo database answers patterns, text and expansions", async () => {
  const db = new DemoSource();
  const s = await db.schema();
  expect(s.labels.map((l) => l.name)).toContain("Person");
  expect(s.patterns.some((p) => p.from === "Person" && p.type === "WORKS_AT" && p.to === "Company")).toBe(true);

  const works = await db.search(parsePhrase("Company WORKS_AT Person Inês", s)!, 100);
  expect(works.nodes.map((n) => valueText(n.properties.name)).sort()).toEqual(["Brightloom", "Inês Carvalho"]);
  expect(works.rels.map((r) => r.type)).toEqual(["WORKS_AT"]);

  const text = await db.search({ kind: "text", term: "sparrow" }, 100);
  expect(text.nodes.map((n) => valueText(n.properties.name))).toEqual(["Sparrow DB"]);

  const lattice = text.nodes[0].id;
  const out = await db.expand([lattice], { direction: "out", type: "DEPENDS_ON", limit: 10 });
  expect(out.nodes.map((n) => valueText(n.properties.name)).sort()).toEqual(["Lattice", "Sparrow DB"]);
  const hood = await db.neighborhood(lattice);
  expect(hood.find((e) => e.type === "WRITTEN_IN")?.direction).toBe("out");
  await expect(db.search({ kind: "raw", statement: "RETURN 1" }, 1)).rejects.toThrow();
});

// --- NebulaGraph ----------------------------------------------------------------------------------------

import {
  gatewayGraph,
  gatewayNode,
  ngqlAmong,
  ngqlExpand,
  ngqlNeighborhood,
  ngqlSearch,
  ngqlString,
  sessionCookie,
  splitHostPort,
  vidLiteral,
} from "./nebula";

const nebulaSchema: Schema = {
  labels: [{ name: "player" }, { name: "team" }],
  relTypes: [{ name: "serve" }, { name: "follow" }],
  patterns: [
    { from: "player", type: "serve", to: "team" },
    { from: "player", type: "follow", to: "player" },
  ],
};

test("builds nGQL that returns vertices and edges as columns", () => {
  expect(ngqlSearch(parsePhrase("team serve player Tim", nebulaSchema)!, 20, nebulaSchema)).toBe(
    'MATCH (n0:`team`)<-[r0:`serve`]-(n1:`player`) WHERE any(k IN keys(n1) WHERE toLower(toString(properties(n1)[k])) CONTAINS "tim") RETURN n0, r0, n1 LIMIT 20',
  );
  expect(ngqlSearch({ kind: "pattern", nodes: [{ label: "player" }], rels: [] }, 5, nebulaSchema)).toBe("MATCH (n0:`player`) RETURN n0 LIMIT 5");
  expect(ngqlExpand(["player100", 'x"y'], { type: "follow", direction: "out", limit: 9 }, "string")).toBe(
    'MATCH (n)-[r:`follow`]->(m) WHERE id(n) IN ["player100", "x\\"y"] RETURN n, r, m LIMIT 9',
  );
  expect(ngqlAmong(["1", "2"], "int")).toBe("MATCH (a)-[r]->(b) WHERE id(a) IN [1, 2] AND id(b) IN [1, 2] RETURN r");
  expect(ngqlNeighborhood("7", "int")).toContain("WHERE id(n) == 7 RETURN type(r) AS type, src(r) == id(n) AS outgoing");
  expect(() => vidLiteral("1 OR 1", "int")).toThrow();
  // a, a backslash, b, a quote, a line break → each escaped C-style inside double quotes
  expect(ngqlString('a\\b"\n')).toBe('"a\\\\b\\"\\n"');
  expect(parsePhrase("GO FROM 'player100' OVER follow", nebulaSchema, "nGQL")?.kind).toBe("raw");
});

test("reads the gateway's vertices and edges", () => {
  const v = gatewayNode({ vid: "player100", tags: ["player", "coach"], properties: { player: { name: "Tim", age: 42 }, coach: { name: "T. D.", since: "NULL" } } });
  expect(v.labels).toEqual(["player", "coach"]);
  expect(valueText(v.properties["player.name"])).toBe("Tim");
  expect(valueText(v.properties["coach.name"])).toBe("T. D.");
  expect(v.properties.since).toEqual({ type: "Null" });
  expect(v.properties.age).toEqual({ type: "Integer", value: "42" });
  const g = gatewayGraph({
    headers: ["n", "r", "m"],
    tables: [
      {
        n: "(...)",
        _verticesParsedList: [{ vid: 1, tags: ["player"], properties: { player: { name: "A" } } }, { vid: 2, tags: ["team"], properties: { team: { name: "B" } } }],
        _edgesParsedList: [{ srcID: 1, dstID: 2, edgeName: "serve", rank: 0, properties: { start_year: 1997 } }],
      },
    ],
  });
  expect(g.nodes.map((n) => n.id)).toEqual(["1", "2"]);
  expect(g.rels[0]).toEqual({ id: "1|serve|0|2", type: "serve", start: "1", end: "2", properties: { start_year: { type: "Integer", value: "1997" } } });
});

test("reads the gateway's session cookie and graphd's address", () => {
  expect(sessionCookie("common-nsid=bec2e665; Path=/; HttpOnly, Secure=true; Path=/")).toBe("common-nsid=bec2e665");
  expect(sessionCookie(null)).toBe(null);
  expect(splitHostPort("graphd:9669")).toEqual(["graphd", 9669]);
  expect(splitHostPort("10.0.0.5")).toEqual(["10.0.0.5", 9669]);
});

// --- HawDB ----------------------------------------------------------------------------------------------

import { decodeHawDb, filterRows, hawCreateRels, hawExpand, hawName, hawSearch } from "./hawdb";

test("builds HawDB's Cypher subset: columns for paths, plain names, text filtered by Petal", () => {
  const st = hawSearch(parsePhrase("Company WORKS_AT Person Inês", schema)!, 50, schema);
  expect(st.statement).toBe("MATCH (n0:Company)<-[r0:WORKS_AT]-(n1:Person) RETURN n0, r0, n1 LIMIT 20000");
  expect(st.text).toEqual([undefined, "Inês"]);
  expect(hawSearch({ kind: "pattern", nodes: [{ label: "Person" }], rels: [] }, 7, schema).statement).toBe("MATCH (n0:Person) RETURN n0 LIMIT 7");
  expect(hawExpand(["3", "x", "4"], { type: "KNOWS", direction: "in", limit: 5 })).toEqual({
    statement: "MATCH (n)<-[r:KNOWS]-(m) WHERE id(n) IN $ids RETURN n, r, m LIMIT 5",
    parameters: { ids: [3, 4] },
  });
  expect(() => hawName("We ird")).toThrow();
  expect(hawCreateRels("SPONSORS", "Company", "Project", ["since"])).toBe(
    "UNWIND $rows AS row MATCH (a:Company) WHERE a.key = row.from MATCH (b:Project) WHERE b.key = row.to CREATE (a)-[r:SPONSORS {since: row.p_since}]->(b)",
  );
});

test("reads HawDB rows and filters them by text", () => {
  const node = (id: string, name: string) => ({ type: "Node", id, labels: ["Person"], properties: { name: { type: "String", value: name } } });
  const res = decodeHawDb(
    JSON.stringify({
      columns: ["n0", "r0", "n1"],
      rows: [
        [node("1", "Acme"), { type: "Relationship", id: "9", start: "2", end: "1", relType: "WORKS_AT", properties: {} }, node("2", "Inês")],
        [node("1", "Acme"), { type: "Relationship", id: "8", start: "3", end: "1", relType: "WORKS_AT", properties: {} }, node("3", "Bo")],
      ],
    }),
  );
  expect(res.nodes.map((n) => n.id)).toEqual(["1", "2", "3"]);
  expect(res.rows[0][0]).toEqual({ type: "Text", kind: "Node", value: "(:Person)" });
  const kept = filterRows(res.cells, res.columns, [undefined, "inê"], 10);
  expect(kept.length).toBe(1);
});
