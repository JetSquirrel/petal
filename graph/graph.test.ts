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

// --- Memgraph ---------------------------------------------------------------------------------------------

import { boltUri } from "./memgraph";

test("maps Memgraph addresses to Bolt URIs and uses its dialect", () => {
  expect(boltUri("localhost")).toBe("bolt://localhost:7687");
  expect(boltUri("db.example.com:7688")).toBe("bolt://db.example.com:7688");
  expect(boltUri("neo4j+s://abc.memgraph.cloud")).toBe("bolt+s://abc.memgraph.cloud:7687");
  expect(() => boltUri("http://x")).toThrow();
  expect(searchStatement({ kind: "text", term: "Ada" }, 5, schema, "memgraph").statement).toBe(
    "MATCH (n) WHERE any(x IN values(n) WHERE toLower(toStringOrNull(x)) CONTAINS $term) RETURN n LIMIT 5",
  );
});

// --- Gremlin ----------------------------------------------------------------------------------------------

import {
  collectGraph,
  decodeGraphSON,
  gremlinAmong,
  gremlinEndpoint,
  gremlinExpand,
  gremlinSearch,
  gremlinString,
  idLiteral,
  looksLikeGremlin,
  newCollected,
} from "./gremlin";

const T = (v: string) => ({ "@type": "g:T", "@value": v });
const D = (v: string) => ({ "@type": "g:Direction", "@value": v });
const long = (n: number) => ({ "@type": "g:Int64", "@value": n });
const gmap = (...kv: unknown[]) => ({ "@type": "g:Map", "@value": kv });

test("builds Gremlin traversals that end in elementMap and keep ID types", () => {
  expect(gremlinSearch(parsePhrase("Person WORKS_AT Company", schema)!, 20, schema).script).toBe(
    "g.V().hasLabel('Person').as('n0').outE('WORKS_AT').as('r0').inV().hasLabel('Company').as('n1').limit(20).select('n0', 'r0', 'n1').by(elementMap())",
  );
  const text = gremlinSearch(parsePhrase("Person Inês", schema)!, 20, schema);
  expect(text.script).toBe("g.V().hasLabel('Person').limit(5000).elementMap()");
  expect(text.text).toEqual(["Inês"]);
  const literals = new Map([["4", "4L"], ["a'b", "'a\\'b'"]]);
  expect(gremlinExpand(["4"], { type: "KNOWS", direction: "in", limit: 9 }, literals)).toBe(
    "g.V(4L).as('n').inE('KNOWS').as('r').outV().as('m').limit(9).select('n', 'r', 'm').by(elementMap())",
  );
  expect(gremlinAmong(["4", "a'b"], literals)).toBe("g.V(4L, 'a\\'b').outE().where(inV().hasId(within(4L, 'a\\'b'))).elementMap()");
  // A quote and a backslash are both escaped: it's \ ok → 'it\'s \\ ok'.
  expect(gremlinString("it's \\ ok")).toBe("'it\\'s \\\\ ok'");
  expect(idLiteral(decodeGraphSON({ "@type": "g:UUID", "@value": "6f1e" }))).toBe("UUID.fromString('6f1e')");
  expect(looksLikeGremlin("g.V().limit(3)")).toBe(true);
  expect(looksLikeGremlin("Person KNOWS")).toBe(false);
  expect(parsePhrase("g.V().has('name', 'x')", schema, "Gremlin")?.kind).toBe("raw");
  expect(gremlinEndpoint("localhost")).toBe("ws://localhost:8182/gremlin");
  expect(gremlinEndpoint("https://db.cluster.neptune.amazonaws.com:8182")).toBe("https://db.cluster.neptune.amazonaws.com:8182/gremlin");
  expect(() => gremlinEndpoint("bolt://x")).toThrow();
});

test("reads GraphSON 3: elementMap vertices and edges, references, typed values", () => {
  const vertex = gmap(T("id"), long(1), T("label"), "Person", "name", "Ada", "age", { "@type": "g:Int32", "@value": 36 });
  const edge = gmap(T("id"), long(9), T("label"), "KNOWS", D("OUT"), gmap(T("id"), long(1), T("label"), "Person"), D("IN"), gmap(T("id"), long(2), T("label"), "Person"), "since", long(2019));
  const out = newCollected();
  collectGraph(decodeGraphSON({ "@type": "g:List", "@value": [gmap("n", vertex, "r", edge)] }), out);
  expect(out.nodes.get("1")).toEqual({ id: "1", labels: ["Person"], properties: { name: { type: "String", value: "Ada" }, age: { type: "Integer", value: "36" } } });
  expect(out.rels.get("9")).toEqual({ id: "9", type: "KNOWS", start: "1", end: "2", properties: { since: { type: "Integer", value: "2019" } } });
  expect([...out.vertexRefs.keys()]).toEqual(["2"]);
  expect(out.literals.get("2")).toBe("2L");

  const refs = newCollected();
  collectGraph(decodeGraphSON({ "@type": "g:Edge", "@value": { id: "e1", label: "KNOWS", outV: "a", inV: "b", outVLabel: "Person", inVLabel: "Person" } }), refs);
  expect(refs.rels.get("e1")?.start).toBe("a");
  expect([...refs.vertexRefs.keys()].sort()).toEqual(["a", "b"]);
});

// --- Amazon Neptune ---------------------------------------------------------------------------------------

import { fromNeptune, joinSecret, neptuneBase, regionOf, signV4, splitSecret } from "./neptune";
import { neighborhoodStatement, relationshipsAmongStatement } from "./cypher";

test("signs requests as AWS's Signature Version 4 test suite has them", () => {
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
  const sign = (method: string) => signV4({ method, url: "https://example.amazonaws.com/", headers: {}, body: "" }, creds, "us-east-1", "service", now);
  // get-vanilla and post-vanilla
  expect(sign("GET").Authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
  expect(sign("POST").Authorization).toBe(
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
  );
  const temp = signV4({ method: "POST", url: "https://db.cluster-x.eu-west-1.neptune.amazonaws.com:8182/openCypher", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "query=RETURN%201" }, { ...creds, sessionToken: "tok" }, "eu-west-1", "neptune-db", now);
  expect(temp["X-Amz-Security-Token"]).toBe("tok");
  expect(temp["X-Amz-Date"]).toBe("20150830T123600Z");
  expect(temp.Authorization).toContain("/eu-west-1/neptune-db/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=");
});

test("maps Neptune endpoints, Regions and credentials", () => {
  expect(neptuneBase("my-db.cluster-abc.us-east-1.neptune.amazonaws.com")).toBe("https://my-db.cluster-abc.us-east-1.neptune.amazonaws.com:8182");
  expect(neptuneBase("https://host:8183/openCypher")).toBe("https://host:8183");
  expect(() => neptuneBase("bolt://host")).toThrow();
  expect(regionOf("https://my-db.cluster-abc.ap-southeast-2.neptune.amazonaws.com:8182")).toBe("ap-southeast-2");
  expect(regionOf("https://my-db.cluster-abc.cn-north-1.neptune.amazonaws.com.cn:8182")).toBe("cn-north-1");
  expect(regionOf("https://localhost:8182")).toBe(null);
  expect(splitSecret(joinSecret("secret", "token"))).toEqual({ secret: "secret", sessionToken: "token" });
  expect(splitSecret(joinSecret("secret", ""))).toEqual({ secret: "secret", sessionToken: "" });
});

test("writes Neptune's openCypher: id() for IDs, toString() in text filters", () => {
  expect(searchStatement({ kind: "text", term: "Ada" }, 5, schema, "neptune").statement).toBe(
    "MATCH (n) WHERE any(k IN keys(n) WHERE toLower(toString(n[k])) CONTAINS $term) RETURN n LIMIT 5",
  );
  expect(expandStatement(["a"], { type: "KNOWS", direction: "out", limit: 3 }, "neptune").statement).toBe(
    "MATCH (n)-[r:`KNOWS`]->(m) WHERE id(n) IN $ids RETURN n, r, m LIMIT 3",
  );
  expect(relationshipsAmongStatement(["a"], "neptune").statement).toBe("MATCH (a)-[r]->(b) WHERE id(a) IN $ids AND id(b) IN $ids RETURN r");
  expect(neighborhoodStatement("a", "neptune").statement).toContain("WHERE id(n) = $id");
  expect(expandStatement(["a"], { limit: 3 }).statement).toContain("elementId(n)");
});

test("reads Neptune's openCypher results: nodes, relationships and paths anywhere in a row", () => {
  const ada = { "~id": "1", "~entityType": "node", "~labels": ["Person"], "~properties": { name: "Ada", born: 1815 } };
  const acme = { "~id": "2", "~entityType": "node", "~labels": ["Company"], "~properties": {} };
  const works = { "~id": "e1", "~entityType": "relationship", "~start": "1", "~end": "2", "~type": "WORKS_AT", "~properties": { since: 1.5 } };
  const res = fromNeptune({ results: [{ p: [ada, works, acme], names: ["a", "b"], n: null }] });
  expect(res.fields).toEqual(["p", "names", "n"]);
  expect(res.rows[0][0]).toEqual({ type: "Text", kind: "Path", value: "path of 1" });
  expect(res.rows[0][1]).toEqual({ type: "List", value: [{ type: "String", value: "a" }, { type: "String", value: "b" }] });
  expect(res.nodes.map((n) => n.id)).toEqual(["1", "2"]);
  expect(res.nodes[0].properties.born).toEqual({ type: "Integer", value: "1815" });
  expect(res.rels).toEqual([{ id: "e1", type: "WORKS_AT", start: "1", end: "2", properties: { since: { type: "Float", value: 1.5 } } }]);
  expect(fromNeptune({ results: [{ n: ada }] }).rows[0][0]).toEqual({ type: "Text", kind: "Node", value: "(:Person)" });
  expect(fromNeptune({ results: [] })).toEqual({ fields: [], rows: [], nodes: [], rels: [] });
});
