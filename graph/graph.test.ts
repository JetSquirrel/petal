import { expect, test } from "nsh/test";
import { expandStatement, orient, searchStatement } from "./cypher";
import { cypherWrite, DemoSource } from "./demo";
import { nodeCaption, valueText } from "./model";
import { collectTyped, decodeTyped, httpBase, isBoltAddress, withProtocol } from "./neo4j";
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

test("Bolt URIs go over Bolt on the desktops; http and bare addresses over HTTP", () => {
  for (const url of ["bolt://localhost:7687", "neo4j://db:7687", "bolt+s://x", "neo4j+s://abc.databases.neo4j.io", " NEO4J+SSC://x "]) {
    expect(isBoltAddress(url)).toBe(true);
  }
  for (const url of ["http://localhost:7474", "https://abc.databases.neo4j.io", "localhost:7687", "bolty://x"]) expect(isBoltAddress(url)).toBe(false);
});

test("the protocol switch moves an address between HTTP and Bolt, TLS kept", () => {
  expect(withProtocol("http://localhost:7474", "bolt")).toBe("bolt://localhost:7687");
  expect(withProtocol("localhost:7474", "bolt")).toBe("bolt://localhost:7687");
  expect(withProtocol("https://abc.databases.neo4j.io", "bolt")).toBe("neo4j+s://abc.databases.neo4j.io");
  expect(withProtocol("http://db:8080", "bolt")).toBe("bolt://db:8080");
  expect(withProtocol("bolt://db:7687", "http")).toBe("http://db:7474");
  expect(withProtocol("neo4j+s://abc.databases.neo4j.io", "http")).toBe("https://abc.databases.neo4j.io");
  expect(withProtocol("bolt://db:7687", "bolt")).toBe("bolt://db:7687");
  expect(withProtocol("", "bolt")).toBe("bolt://localhost:7687");
  expect(withProtocol("", "http")).toBe("http://localhost:7474");
});

test("Neo4j over Bolt matches nodes by their integer IDs, turned back from text", async () => {
  const { neighborhoodStatement, relationshipsAmongStatement } = await import("./cypher");
  expect(expandStatement(["0", "7"], { limit: 5 }, "neo4j-bolt").statement).toBe(
    "MATCH (n)-[r]-(m) WHERE id(n) IN [x IN $ids | toInteger(x)] RETURN n, r, m LIMIT 5",
  );
  expect(relationshipsAmongStatement(["0"], "neo4j-bolt").statement).toBe(
    "MATCH (a)-[r]->(b) WHERE id(a) IN [x IN $ids | toInteger(x)] AND id(b) IN [x IN $ids | toInteger(x)] RETURN r",
  );
  expect(neighborhoodStatement("3", "neo4j-bolt").statement).toContain("WHERE id(n) = toInteger($id) RETURN");
  // Words are matched as on Neo4j over HTTP.
  expect(searchStatement({ kind: "text", term: "Ada" }, 5, schema, "neo4j-bolt").statement).toBe(
    searchStatement({ kind: "text", term: "Ada" }, 5, schema, "neo4j").statement,
  );
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

test("the demo database runs Cypher with its own nodes and relationships, and only reads", async () => {
  const db = new DemoSource();
  expect(db.language).toBe("Cypher");
  const res = await db.search({ kind: "raw", statement: "MATCH (p:Person)-[r:WORKS_AT]->(c:Company) WHERE p.name = 'Inês Carvalho' RETURN p, r, c" }, 100);
  expect(res.nodes.map((n) => n.id).sort()).toEqual(["company:brightloom", "person:ines-carvalho"]);
  expect(res.rels.length).toBe(1);
  expect(res.rels[0].start).toBe("person:ines-carvalho");
  expect(res.table?.columns).toEqual(["p", "r", "c"]);
  // A relationship alone still comes with its ends' own ids.
  const only = await db.search({ kind: "raw", statement: "MATCH ()-[r:ACQUIRED]->() RETURN r" }, 100);
  expect(only.rels.length).toBe(2);
  expect(only.rels.every((r) => r.start.startsWith("company:"))).toBe(true);

  expect(cypherWrite("MATCH (n) RETURN n.created, 'SET'")).toBe(null);
  expect(cypherWrite("MATCH (n) // DELETE n\nRETURN n")).toBe(null);
  expect(cypherWrite("MATCH (n) DETACH DELETE n")).toBe("DETACH DELETE");
  await expect(db.search({ kind: "raw", statement: "MERGE (n:Person {name: 'X'})" }, 10)).rejects.toThrow(/read-only, so MERGE/);
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
import type { NativeResult } from "./encoded";
import { collectGraph as tigerCollect, interpretText, readSchema, resultTable, splitVertexId, tigerBase, tigerName, tigerPattern, toRel } from "./tigergraph";
import { PUPPY_TEXT_SCAN, puppyAmong, puppyExpand, puppyNeighborhood, puppySearch, schemaPatterns } from "./puppygraph";

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

// ---------------------------------------------------------------------------------------------------------
// Expanding with filters: a neighbor's label and words one of its properties contains

test("expand filters by the neighbor's label and words, in every dialect", () => {
  const st = expandStatement(["a"], { type: "KNOWS", direction: "out", label: "Person", text: "Inês", limit: 5 });
  expect(st.statement).toBe(
    "MATCH (n)-[r:`KNOWS`]->(m:`Person`) WHERE elementId(n) IN $ids AND any(k IN keys(m) WHERE toLower(toStringOrNull(m[k])) CONTAINS $text) RETURN n, r, m LIMIT 5",
  );
  expect(st.parameters).toEqual({ ids: ["a"], text: "inês" });
  expect(expandStatement(["a"], { label: "Company", limit: 3 }, "neptune").statement).toBe(
    "MATCH (n)-[r]-(m:`Company`) WHERE id(n) IN $ids RETURN n, r, m LIMIT 3",
  );
  expect(expandStatement(["a"], { text: "x", limit: 3 }, "memgraph").statement).toContain("any(x IN values(m) WHERE toLower(toStringOrNull(x)) CONTAINS $text)");
  // Without filters the statements stay as they were.
  expect(expandStatement(["a"], { limit: 3 }).parameters).toEqual({ ids: ["a"] });

  expect(ngqlExpand(["p1"], { label: "team", text: 'Wa"rriors', limit: 9 }, "string")).toBe(
    'MATCH (n)-[r]-(m:`team`) WHERE id(n) IN ["p1"] AND any(k IN keys(m) WHERE toLower(toString(properties(m)[k])) CONTAINS "wa\\"rriors") RETURN n, r, m LIMIT 9',
  );

  const literals = new Map([["4", "4L"]]);
  expect(gremlinExpand(["4"], { direction: "out", label: "Company", limit: 9 }, literals)).toBe(
    "g.V(4L).as('n').outE().as('r').inV().hasLabel('Company').as('m').limit(9).select('n', 'r', 'm').by(elementMap())",
  );
  // Words are checked by Petal, so the traversal reads candidates.
  expect(gremlinExpand(["4"], { text: "acme", limit: 9 }, literals)).toContain(".limit(5000)");

  expect(hawExpand(["3"], { label: "Company", limit: 5 }).statement).toBe("MATCH (n)-[r]-(m:Company) WHERE id(n) IN $ids RETURN n, r, m LIMIT 5");
  const haw = hawExpand(["3"], { type: "WORKS_AT", direction: "out", text: "Acme", limit: 5 });
  expect(haw.statement).toBe("MATCH (n0)-[r0:WORKS_AT]->(n1) WHERE id(n0) IN $ids RETURN n0, r0, n1 LIMIT 20000");
  expect(haw.text).toEqual([undefined, "Acme"]);
  expect(() => hawExpand(["3"], { label: "We ird", limit: 5 })).toThrow();
});

test("the demo database expands by the neighbor's label and words", async () => {
  const db = new DemoSource();
  const [sparrow] = (await db.search({ kind: "text", term: "Sparrow DB" }, 1)).nodes;
  const others = (r: { nodes: { id: string; labels: string[]; properties: Record<string, unknown> }[] }) => r.nodes.filter((n) => n.id !== sparrow.id);

  const all = others(await db.expand([sparrow.id], { limit: 100 }));
  const people = others(await db.expand([sparrow.id], { label: "Person", limit: 100 }));
  expect(people.length > 0).toBe(true);
  expect(people.length < all.length).toBe(true);
  expect(people.every((n) => n.labels.includes("Person"))).toBe(true);

  const kaisa = others(await db.expand([sparrow.id], { text: "kaisa", limit: 100 }));
  expect(kaisa.map((n) => nodeCaption(n as never))).toEqual(["Kaisa Tamm"]);
  expect((await db.expand([sparrow.id], { label: "Person", text: "no such words", limit: 100 })).rows).toBe(0);
  expect(others(await db.expand([sparrow.id], { label: "Person", limit: 1 })).length).toBe(1);
});

test("PuppyGraph's statements keep to its openCypher: elementId(), no startNode(), text checked by Petal", () => {
  const st = puppySearch(parsePhrase("Company WORKS_AT Person Inês", schema)!, 50, schema);
  expect(st.statement).toBe(`MATCH (n0:\`Company\`)<-[r0:\`WORKS_AT\`]-(n1:\`Person\`) RETURN n0, r0, n1 LIMIT ${PUPPY_TEXT_SCAN}`);
  expect(st.text).toEqual([undefined, "Inês"]);
  expect(puppySearch({ kind: "pattern", nodes: [{ label: "Person" }], rels: [] }, 7, schema)).toEqual({
    statement: "MATCH (n0:`Person`) RETURN n0 LIMIT 7",
    parameters: {},
    text: undefined,
  });
  expect(puppySearch({ kind: "text", term: "ada" }, 7, schema).text).toEqual(["ada"]);

  expect(puppyExpand(["person[v1]"], { type: "KNOWS", direction: "out", limit: 10 })).toEqual({
    statement: "MATCH (n0)-[r0:`KNOWS`]->(n1) WHERE elementId(n0) IN $ids RETURN n0, r0, n1 LIMIT 10",
    parameters: { ids: ["person[v1]"] },
  });
  const filtered = puppyExpand(["person[v1]"], { label: "Company", text: "acme", limit: 10 });
  expect(filtered.statement).toBe(`MATCH (n0)-[r0]-(n1:\`Company\`) WHERE elementId(n0) IN $ids RETURN n0, r0, n1 LIMIT ${PUPPY_TEXT_SCAN}`);
  expect(filtered.text).toEqual([undefined, "acme"]);

  expect(puppyAmong(["a[1]", "b[2]"]).statement).toBe("MATCH (a)-[r]->(b) WHERE elementId(a) IN $ids AND elementId(b) IN $ids RETURN r");
  const hood = puppyNeighborhood("person[v1]", "in");
  expect(hood.statement).toBe("MATCH (n)<-[r]-() WHERE elementId(n) = $id RETURN type(r) AS type, count(*) AS count");
  expect(hood.statement).not.toMatch(/startNode/);

  // db.schema.visualization(): a node per label, relationships between them.
  const viz: NativeResult = {
    columns: ["nodes", "relationships"],
    rows: [],
    cells: [],
    nodes: [
      { id: "-1", labels: ["person"], properties: {} },
      { id: "-2", labels: [], properties: { name: { type: "String", value: "software" } } },
    ],
    rels: [
      { id: "-3", type: "created", start: "-1", end: "-2", properties: {} },
      { id: "-4", type: "knows", start: "-1", end: "-1", properties: {} },
      { id: "-5", type: "knows", start: "-1", end: "-1", properties: {} },
    ],
  };
  expect(schemaPatterns(viz)).toEqual([
    { from: "person", type: "created", to: "software" },
    { from: "person", type: "knows", to: "person" },
  ]);
  expect(boltUri("puppy.example.com", "PuppyGraph")).toBe("bolt://puppy.example.com:7687");
  expect(() => boltUri("http://puppy:8081", "PuppyGraph")).toThrow(/PuppyGraph over Bolt/);
});

test("TigerGraph: addresses, its schema with reverse edges, vertex IDs per type, and openCypher patterns", () => {
  expect(tigerBase("localhost")).toBe("http://localhost:14240");
  expect(tigerBase("https://abc.i.tgcloud.io/")).toBe("https://abc.i.tgcloud.io");
  expect(tigerBase("abc.i.tgcloud.io")).toBe("https://abc.i.tgcloud.io");
  expect(() => tigerBase("bolt://x")).toThrow(/http/);
  expect(splitVertexId("Person:a:b")).toEqual({ type: "Person", id: "a:b" });

  const read = readSchema({
    VertexTypes: [
      { Name: "Person", Attributes: [{ AttributeName: "name", AttributeType: { Name: "STRING" } }, { AttributeName: "age", AttributeType: { Name: "INT" } }] },
      { Name: "Company", Attributes: [{ AttributeName: "name", AttributeType: { Name: "STRING" } }] },
    ],
    EdgeTypes: [
      { Name: "WORKS_AT", FromVertexTypeName: "Person", ToVertexTypeName: "Company", IsDirected: true, Config: { REVERSE_EDGE: "WORKS_AT_REV" } },
      { Name: "WORKS_AT_REV", FromVertexTypeName: "Company", ToVertexTypeName: "Person", IsDirected: true, Config: {} },
      { Name: "KNOWS", FromVertexTypeName: "Person", ToVertexTypeName: "Person", IsDirected: false, Config: {} },
    ],
  });
  expect(read.schema.relTypes.map((t) => t.name)).toEqual(["WORKS_AT", "KNOWS"]);
  expect(read.schema.patterns).toEqual([
    { from: "Person", type: "WORKS_AT", to: "Company" },
    { from: "Person", type: "KNOWS", to: "Person" },
  ]);
  expect(read.textAttributes.get("Person")).toEqual(["name"]);

  // A reverse edge is the edge it reverses; an undirected edge is the same from either end.
  const rev = toRel({ e_type: "WORKS_AT_REV", from_type: "Company", from_id: "c1", to_type: "Person", to_id: "p1", directed: true }, read.edgeTypes);
  expect([rev.type, rev.start, rev.end]).toEqual(["WORKS_AT", "Person:p1", "Company:c1"]);
  const k1 = toRel({ e_type: "KNOWS", from_type: "Person", from_id: "p2", to_type: "Person", to_id: "p1", directed: false }, read.edgeTypes);
  const k2 = toRel({ e_type: "KNOWS", from_type: "Person", from_id: "p1", to_type: "Person", to_id: "p2", directed: false }, read.edgeTypes);
  expect(k1.id).toBe(k2.id);

  const results = [{ n0: { v_id: "p1", v_type: "Person", attributes: { name: "Ada" } }, r0: { e_type: "WORKS_AT", from_type: "Person", from_id: "p1", to_type: "Company", to_id: "c1", directed: true, attributes: {} }, n1: { v_id: "c1", v_type: "Company", attributes: { name: "Acme" } } }];
  const g = tigerCollect(results, read.edgeTypes);
  expect(g.nodes.map((n) => n.id)).toEqual(["Person:p1", "Company:c1"]);
  expect(g.rels.map((r) => r.id)).toEqual(["WORKS_AT:Person:p1>Company:c1"]);
  expect(resultTable(results).columns).toEqual(["n0", "r0", "n1"]);
  // PRINT's shape: one object holding the rows.
  expect(resultTable([{ result: [{ name: "Ada", n: 1 }, { name: "Bob", n: 2 }] }]).rows.length).toBe(2);

  const spec = parsePhrase("Person Ada WORKS_AT Company", read.schema)!;
  expect(spec.kind).toBe("pattern");
  expect(tigerPattern(spec as Extract<typeof spec, { kind: "pattern" }>, 25, read)).toBe(
    'MATCH (n0:Person)-[r0:WORKS_AT]->(n1:Company) WHERE (toLower(n0.name) CONTAINS "ada") RETURN n0, r0, n1 LIMIT 25',
  );
  expect(tigerPattern({ kind: "pattern", nodes: [{ label: "Person" }, { label: "Person" }], rels: [{ type: "KNOWS" }] }, 5, read)).toBe(
    "MATCH (n0:Person)-[r0:KNOWS]-(n1:Person) RETURN n0, r0, n1 LIMIT 5",
  );
  expect(() => tigerPattern({ kind: "pattern", nodes: [{ text: "ada" }, { label: "Company" }], rels: [{}] }, 5, read)).toThrow(/need a category/);
  expect(() => tigerName("a b")).toThrow();
  expect(interpretText("MATCH (n) RETURN n LIMIT 3;", "social")).toBe("INTERPRET OPENCYPHER QUERY () FOR GRAPH social {\nMATCH (n) RETURN n LIMIT 3\n}");
  expect(interpretText("INTERPRET QUERY () { PRINT 1; }", "social")).toBe("INTERPRET QUERY () { PRINT 1; }");
});
