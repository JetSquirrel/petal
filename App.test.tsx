import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1320, height: 840, platform: "windows" as const };

const stats = (texts: string[]) => texts.find((t) => /\d+ nodes? · \d+ relationships?/.test(t)) ?? "";

test("starts on the demo graph with its categories and starting points", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("id:empty");
  await app.waitFor("text:Explore your graph, one connection at a time");
  const texts = app.texts();
  for (const label of ["Person", "Project", "Company", "Language", "City"]) expect(texts).toContain(label);
  expect(texts).toContain("WORKS_AT");
  expect(app.shows("id:example-Person")).toBe(true);
  expect(stats(texts)).toBe("0 nodes · 0 relationships");
});

test("a starting point fills the scene, and undo takes it back", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("id:example-Person");
  await app.press("id:example-Person");
  await app.waitUntil(() => stats(app.texts()).startsWith("30 nodes"), { timeout: 8000 });
  expect(stats(app.texts())).toMatch(/^30 nodes · \d+ relationships$/);
  expect(app.shows("id:empty")).toBe(false);

  await app.press("id:undo");
  await app.waitFor("id:empty");
  expect(stats(app.texts())).toBe("0 nodes · 0 relationships");
});

test("typing a phrase suggests patterns and runs the one chosen", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("id:example-Person");
  await app.type("id:search", "Comp");
  await app.waitFor("id:suggestions");
  await app.press("id:suggestion-0");
  await app.waitFor("text:Added 9 nodes and 2 relationships.");
  expect(app.value("id:search")).toBe("Company");

  await app.clear("id:search");
  await app.type("id:search", "Company WORKS_AT Person Inês");
  await app.submit("id:search");
  await app.waitFor("text:Added 1 node and 1 relationship.");
  expect(stats(app.texts())).toBe("10 nodes · 3 relationships");
});

test("hiding a category takes its nodes off the canvas but keeps them in the scene", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("id:example-Person");
  await app.type("id:search", "Person LIVES_IN City");
  await app.submit("id:search");
  await app.waitUntil(() => stats(app.texts()).startsWith("38 nodes"), { timeout: 8000 });
  const before = stats(app.texts());
  await app.press("id:category-eye-City");
  expect(stats(app.texts())).toMatch(/^30 nodes · /);
  await app.press("id:category-eye-City");
  expect(stats(app.texts())).toBe(before);
});

test("selecting a node shows its properties and expands it by relationship type", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("id:example-Person");
  await app.type("id:search", "Lattice");
  await app.submit("id:search");
  await app.waitFor("text:Added 1 node.");
  await app.wait(400);
  await app.drag("id:scene", {}); // lands on the middle, where the one node is: a tap
  await app.waitFor("id:inspector");
  expect(app.texts()).toContain("Lattice");
  expect(app.texts()).toContain("Apache-2.0");
  await app.waitFor("id:expand-WRITTEN_IN-out");
  await app.press("id:expand-WRITTEN_IN-out");
  await app.waitFor("text:Added 1 node and 1 relationship.");
  expect(stats(app.texts())).toBe("2 nodes · 1 relationship");
  await app.press("id:dismiss");
  await app.waitFor("text:Dismissed 1 node.");
  expect(stats(app.texts())).toBe("1 node · 0 relationships");
});

test("queries need a database", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("id:example-Person");
  await app.type("id:search", "MATCH (n) RETURN n");
  await app.submit("id:search");
  await app.waitFor("text:Queries need a database. Connect to Neo4j, NebulaGraph or HawDB to run one.");
});

// --- A Neo4j server played by the test ----------------------------------------------------------------

const str = (v: string) => ({ $type: "String", _value: v });
const int = (v: number) => ({ $type: "Integer", _value: String(v) });
const node = (id: string, label: string, name: string) => ({
  $type: "Node",
  _value: { _element_id: id, _labels: [label], _properties: { name: str(name) } },
});
const rel = (id: string, type: string, from: string, to: string) => ({
  $type: "Relationship",
  _value: { _element_id: id, _start_node_element_id: from, _end_node_element_id: to, _type: type, _properties: {} },
});
const rows = (fields: string[], values: unknown[][]) => ({ status: 202, body: { data: { fields, values } } });

function neo4j(seen: string[]) {
  return {
    "GET http://localhost:7474/": { body: { query: "http://localhost:7474/db/{databaseName}/query/v2", neo4j_version: "5.26.0" } },
    "POST http://localhost:7474/db/movies/query/v2": (req: { headers: Record<string, string>; body?: string | null }) => {
      const auth = req.headers.authorization ?? req.headers.Authorization;
      if (auth !== "Basic " + Buffer.from("neo4j:secret").toString("base64")) {
        return { status: 401, body: { errors: [{ code: "Neo.ClientError.Security.Unauthorized", message: "Invalid credentials" }] } };
      }
      const st: string = JSON.parse(req.body ?? "{}").statement;
      seen.push(st);
      if (st === "RETURN 1 AS ok") return rows(["ok"], [[int(1)]]);
      if (st.startsWith("CALL db.labels()")) return rows(["label"], [[str("Movie")], [str("Person")]]);
      if (st.startsWith("CALL db.relationshipTypes()")) return rows(["relationshipType"], [[str("ACTED_IN")]]);
      if (st.includes("UNION ALL") && st.includes("(:`Movie`)")) return rows(["name", "count"], [[str("Movie"), int(38)], [str("Person"), int(133)]]);
      if (st.includes("UNION ALL")) return rows(["name", "count"], [[str("ACTED_IN"), int(172)]]);
      if (st === "CALL db.schema.visualization()") {
        return rows(
          ["nodes", "relationships"],
          [[{ $type: "List", _value: [node("-1", "Person", "Person"), node("-2", "Movie", "Movie")] }, { $type: "List", _value: [rel("-3", "ACTED_IN", "-1", "-2")] }]],
        );
      }
      if (st.startsWith("MATCH p = (n0:`Person`)-[r0:`ACTED_IN`]->(n1:`Movie`)")) {
        return rows(["p"], [[{ $type: "Path", _value: [node("4:a:1", "Person", "Ada Quill"), rel("5:a:1", "ACTED_IN", "4:a:1", "4:a:2"), node("4:a:2", "Movie", "The Long Field")] }]]);
      }
      if (st.startsWith("MATCH (a)-[r]->(b)")) return rows(["r"], [[rel("5:a:1", "ACTED_IN", "4:a:1", "4:a:2")]]);
      return { status: 400, body: { errors: [{ code: "Neo.ClientError.Statement.SyntaxError", message: `Unexpected statement: ${st}` }] } };
    },
  };
}

async function connect(app: Awaited<ReturnType<typeof open>>, password: string) {
  await app.press("id:connection");
  await app.waitFor("id:connect-dialog");
  await app.clear("id:connect-url");
  await app.type("id:connect-url", "localhost:7474");
  await app.clear("id:connect-database");
  await app.type("id:connect-database", "movies");
  await app.type("id:connect-password", password);
  await app.press("id:connect-submit");
}

test("connects to Neo4j over the Query API and searches it", async () => {
  const seen: string[] = [];
  const app = await open("./App.tsx", { ...DESKTOP, network: neo4j(seen) });
  await app.waitFor("id:example-Person");
  await connect(app, "secret");
  await app.waitFor("text:Connected to movies · localhost:7474.");
  expect(app.shows("id:connect-dialog")).toBe(false);
  expect(app.texts()).toContain("Movie");
  expect(app.texts()).toContain("ACTED_IN");
  expect(app.texts()).toContain("133");

  await app.type("id:search", "Person ACTED_IN Movie");
  await app.submit("id:search");
  await app.waitFor("text:Added 2 nodes and 1 relationship.");
  expect(seen).toContain("MATCH p = (n0:`Person`)-[r0:`ACTED_IN`]->(n1:`Movie`) RETURN p LIMIT 100");
  expect(JSON.parse(app.storage().connection).neo4j).toEqual({ url: "localhost:7474", user: "neo4j", database: "movies" });
});

test("a wrong password is reported in the dialog", async () => {
  const app = await open("./App.tsx", { ...DESKTOP, network: neo4j([]) });
  await app.waitFor("id:example-Person");
  await connect(app, "nope");
  await app.waitFor("id:connect-error");
  expect(app.texts()).toContain("The user name or password is wrong.");
  expect(app.shows("id:connect-dialog")).toBe(true);
});

test("in a narrow window the inspector floats over the scene at full height", async () => {
  const app = await open("./App.tsx", { width: 960, height: 700, platform: "windows" });
  await app.waitFor("id:example-Person");
  await app.type("id:search", "Lattice");
  await app.submit("id:search");
  await app.waitFor("text:Added 1 node.");
  await app.wait(400);
  await app.drag("id:scene", {});
  await app.waitFor("id:inspector");
  expect(app.shows("id:expand")).toBe(true);
  expect(app.shows("text:Apache-2.0")).toBe(true);
});

// --- A NebulaGraph gateway played by the test -----------------------------------------------------------

function gateway(seen: string[]) {
  const ok = (data: unknown) => ({ body: { code: 0, data, message: "" } });
  const table = (headers: string[], tables: Record<string, unknown>[]) => ok({ headers, tables, timeCost: 1 });
  return {
    "POST http://localhost:8080/api/db/connect": (req: { body?: string | null }) => {
      const body = JSON.parse(req.body ?? "{}");
      if (body.password !== "nebula") return { body: { code: -1, data: null, message: "Bad username/password" } };
      return { headers: { "Set-Cookie": "common-nsid=abc123; Path=/; HttpOnly" }, body: { code: 0, data: "nsid", message: "Login successfully" } };
    },
    "POST http://localhost:8080/api/db/exec": (req: { headers: Record<string, string>; body?: string | null }) => {
      if (!(req.headers.cookie ?? req.headers.Cookie ?? "").includes("common-nsid=abc123")) return { body: { code: -1, message: "session expired" } };
      const gql: string = JSON.parse(req.body ?? "{}").gql;
      seen.push(gql);
      const st = gql.replace(/^USE `basketball`; /, "");
      if (st === "SHOW SPACES") return table(["Name"], [{ Name: "basketball" }]);
      if (st === "DESCRIBE SPACE `basketball`") return table(["Name", "Vid Type"], [{ Name: "basketball", "Vid Type": "FIXED_STRING(32)" }]);
      if (st === "SHOW TAGS") return table(["Name"], [{ Name: "player" }, { Name: "team" }]);
      if (st === "SHOW EDGES") return table(["Name"], [{ Name: "serve" }]);
      if (st === "SHOW STATS") return table(["Type", "Name", "Count"], [{ Type: "Tag", Name: "player", Count: 51 }, { Type: "Tag", Name: "team", Count: 30 }, { Type: "Edge", Name: "serve", Count: 152 }]);
      if (st.startsWith("MATCH (a)-[e:`serve`]->(b) RETURN tags(a)[0]")) return table(["f", "t"], [{ f: "player", t: "team" }]);
      const tim = { vid: "player100", tags: ["player"], properties: { player: { name: "Tim Duncan", age: 42 } } };
      const spurs = { vid: "team204", tags: ["team"], properties: { team: { name: "Spurs" } } };
      const serve = { srcID: "player100", dstID: "team204", edgeName: "serve", rank: 0, properties: { start_year: 1997 } };
      if (st.startsWith("MATCH (n0:`player`)-[r0:`serve`]->(n1:`team`)")) {
        return table(["n0", "r0", "n1"], [{ n0: "(...)", r0: "[...]", n1: "(...)", _verticesParsedList: [tim, spurs], _edgesParsedList: [serve] }]);
      }
      if (st.startsWith("MATCH (a)-[r]->(b) WHERE id(a) IN")) return table(["r"], [{ r: "[...]", _edgesParsedList: [serve] }]);
      return { body: { code: -1, message: `SyntaxError: unexpected ${st}` } };
    },
  };
}

test("connects to NebulaGraph through its gateway and searches a space", async () => {
  const seen: string[] = [];
  const app = await open("./App.tsx", { ...DESKTOP, network: gateway(seen) });
  await app.waitFor("id:example-Person");
  await app.press("id:connection");
  await app.waitFor("id:connect-dialog");
  await app.press("id:connect-kind-nebula");
  await app.clear("id:connect-graphd");
  await app.type("id:connect-graphd", "graphd:9669");
  await app.type("id:connect-space", "basketball");
  await app.type("id:connect-password", "nebula");
  await app.press("id:connect-submit");
  await app.waitFor("text:Connected to basketball · graphd:9669.");
  expect(app.texts()).toContain("player");
  expect(app.texts()).toContain("51");

  await app.type("id:search", "player serve team");
  await app.submit("id:search");
  await app.waitFor("text:Added 2 nodes and 1 relationship.");
  expect(seen).toContain("USE `basketball`; MATCH (n0:`player`)-[r0:`serve`]->(n1:`team`) RETURN n0, r0, n1 LIMIT 100");
  expect(JSON.parse(app.storage().connection).nebula).toEqual({ gateway: "http://localhost:8080", graphd: "graphd:9669", user: "root", space: "basketball" });
});

test("NebulaGraph's sign-in errors show in the dialog", async () => {
  const app = await open("./App.tsx", { ...DESKTOP, network: gateway([]) });
  await app.waitFor("id:example-Person");
  await app.press("id:connection");
  await app.press("id:connect-kind-nebula");
  await app.type("id:connect-space", "basketball");
  await app.type("id:connect-password", "wrong");
  await app.press("id:connect-submit");
  await app.waitFor("id:connect-error");
  expect(app.texts()).toContain("The user name or password is wrong.");
});

// --- HawDB, embedded: a real engine, in memory -----------------------------------------------------------

async function openHawDb(app: Awaited<ReturnType<typeof open>>) {
  await app.press("id:connection");
  await app.waitFor("id:connect-dialog");
  await app.press("id:connect-kind-hawdb");
  await app.clear("id:connect-path"); // an empty folder: in memory
  await app.press("id:connect-load-demo");
  await app.press("id:connect-submit");
  await app.waitFor("text:Connected to HawDB · in memory.", { timeout: 15000 });
}

test("opens an embedded HawDB database, loads the demo graph and explores it", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("id:example-Person");
  await openHawDb(app);
  const texts = app.texts();
  for (const label of ["Person", "Project", "Company", "WORKS_AT", "DEPENDS_ON"]) expect(texts).toContain(label);
  expect(texts).toContain("30");

  await app.type("id:search", "Company WORKS_AT Person Inês");
  await app.submit("id:search");
  await app.waitFor("text:Added 2 nodes and 1 relationship.");
  expect(stats(app.texts())).toBe("2 nodes · 1 relationship");

  await app.clear("id:search");
  await app.type("id:search", "sparrow");
  await app.submit("id:search");
  await app.waitUntil(() => stats(app.texts()).startsWith("3 nodes"));
  await app.clear("id:search");
  await app.type("id:search", "MATCH (n:Language) RETURN n LIMIT 3");
  await app.submit("id:search");
  await app.waitUntil(() => stats(app.texts()).startsWith("6 nodes"));
});

test("expands HawDB nodes by relationship type", async () => {
  const app = await open("./App.tsx", DESKTOP);
  await app.waitFor("id:example-Person");
  await openHawDb(app);
  await app.type("id:search", "Lattice");
  await app.submit("id:search");
  await app.waitFor("text:Added 1 node.");
  await app.wait(400);
  await app.drag("id:scene", {});
  await app.waitFor("id:expand-DEPENDS_ON-in");
  await app.press("id:expand-DEPENDS_ON-in");
  await app.waitFor("text:Added 4 nodes and 4 relationships.");
});
