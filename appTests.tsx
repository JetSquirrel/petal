import { expect, open, test } from "nsh/test";

/** The UI tests, run once per desktop platform (`App.test.tsx` on Windows, `AppMac.test.tsx` on macOS). */
export function appTests(platform: "windows" | "macos") {
  const DESKTOP = { width: 1320, height: 840, platform };

  const stats = (texts: string[]) => texts.find((t) => /\d+ nodes?, \d+ relationships?/.test(t)) ?? "";

  test("starts on the demo graph with its categories and starting points", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:empty");
    await app.waitFor("text:Explore your graph, one connection at a time");
    const texts = app.texts();
    for (const label of ["Person", "Project", "Company", "Language", "City"]) expect(texts).toContain(label);
    expect(texts).toContain("WORKS_AT");
    expect(app.shows("id:example-Person")).toBe(true);
    expect(stats(texts)).toBe("0 nodes, 0 relationships");
  });

  test("a starting point fills the scene, and undo takes it back", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.press("id:example-Person");
    await app.waitUntil(() => stats(app.texts()).startsWith("30 nodes"), { timeout: 8000 });
    expect(stats(app.texts())).toMatch(/^30 nodes, \d+ relationships$/);
    expect(app.shows("id:empty")).toBe(false);

    await app.press("id:undo");
    await app.waitFor("id:empty");
    expect(stats(app.texts())).toBe("0 nodes, 0 relationships");
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
    expect(stats(app.texts())).toBe("10 nodes, 3 relationships");
  });

  test("hiding a category takes its nodes off the canvas but keeps them in the scene", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.type("id:search", "Person LIVES_IN City");
    await app.submit("id:search");
    await app.waitUntil(() => stats(app.texts()).startsWith("38 nodes"), { timeout: 8000 });
    const before = stats(app.texts());
    await app.press("id:category-eye-City");
    expect(stats(app.texts())).toMatch(/^30 nodes, /);
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
    expect(stats(app.texts())).toBe("2 nodes, 1 relationship");
    await app.press("id:dismiss");
    await app.waitFor("text:Dismissed 1 node.");
    expect(stats(app.texts())).toBe("1 node, 0 relationships");
  });

  test("expand with filters brings in neighbors of one label, with words, up to a limit", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.type("id:search", "Lattice");
    await app.submit("id:search");
    await app.waitFor("text:Added 1 node.");
    await app.wait(400);
    await app.drag("id:scene", {});
    await app.waitFor("id:inspector");
    expect(app.shows("id:expand-filters")).toBe(false);
    await app.press("id:expand-filters-toggle");
    await app.waitFor("id:expand-filters");

    // Lattice's maintainers are people: only the one whose properties hold "rasmus".
    await app.press("id:filter-label-Person");
    await app.type("id:filter-text", "rasmus");
    await app.press("id:filter-expand");
    await app.waitFor("text:Added 1 node and 1 relationship.");
    expect(stats(app.texts())).toBe("2 nodes, 1 relationship");

    await app.type("id:filter-text", " nobody");
    await app.press("id:filter-expand");
    await app.waitFor("text:No neighbors match the filters.");

    // One project that depends on it, of the four.
    await app.clear("id:filter-text");
    await app.press("id:filter-label-Project");
    await app.clear("id:filter-limit");
    await app.type("id:filter-limit", "1");
    await app.press("id:filter-expand");
    await app.waitUntil(() => stats(app.texts()).startsWith("3 nodes"), { timeout: 8000 });

    await app.clear("id:filter-limit");
    await app.type("id:filter-limit", "0");
    await app.waitFor("text:Enter a whole number above 0.");
    expect(app.enabled("id:filter-expand")).toBe(false);
  }, 60_000);

  test("the table lists the scene's nodes and relationships, filters them, and closes", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.press("id:example-Person");
    await app.waitUntil(() => stats(app.texts()).startsWith("30 nodes"), { timeout: 8000 });
    expect(app.shows("id:scene-table")).toBe(false);
    await app.press("id:table-toggle");
    await app.waitFor("id:scene-table");
    expect(app.texts()).toContain("Nodes 30");
    await app.type("id:table-filter", "Inês");
    await app.waitUntil(() => app.texts().includes("1 of 30"));
    await app.clear("id:table-filter");
    await app.press("id:table-kind-rels");
    await app.waitFor("id:table-rels");
    await app.press("id:table-close");
    expect(app.shows("id:scene-table")).toBe(false);
  });

  test("a scene saved under a name opens again, undo goes back, and it can be deleted", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.press("id:example-Person");
    await app.waitUntil(() => stats(app.texts()).startsWith("30 nodes"), { timeout: 8000 });
    const full = stats(app.texts());

    await app.press("id:scenes-open");
    await app.waitFor("id:scene-name");
    await app.type("id:scene-name", "People");
    await app.press("id:scene-save");
    await app.waitFor("text:Saved the scene as “People”.");

    await app.press("id:clear");
    await app.waitFor("id:empty");
    await app.press("id:scenes-open");
    await app.waitFor("id:scene-People");
    await app.press("id:scene-People");
    await app.waitFor("text:Opened “People”.");
    expect(stats(app.texts())).toBe(full);

    await app.press("id:undo");
    await app.waitFor("id:empty");

    await app.press("id:scenes-open");
    await app.waitFor("id:scene-delete-People");
    await app.press("id:scene-delete-People");
    await app.waitFor("text:Deleted the saved scene “People”.");
    expect(app.shows("id:scene-People")).toBe(false);
  });

  test("the demo graph runs Cypher, and refuses writes", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.type("id:search", "MATCH (c:Company)<-[r:WORKS_AT]-(p:Person) WHERE p.name = 'Inês Carvalho' RETURN c, r, p");
    await app.submit("id:search");
    await app.waitFor("text:Added 2 nodes and 1 relationship.", { timeout: 15000 });
    await app.clear("id:search");
    await app.type("id:search", "MATCH (n:Person) SET n.x = 1 RETURN n");
    await app.submit("id:search");
    await app.waitFor("text:The demo graph is read-only, so SET can't run. Open a HawDB database to change a graph.");
  });

  // --- Notebook mode --------------------------------------------------------------------------------------

  test("the notebook runs a phrase into a frame with graph, table and raw views, and adds it to the scene", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.press("id:mode-notebook");
    await app.waitFor("id:notebook-empty");
    expect(app.shows("id:search")).toBe(false);
    expect(app.enabled("id:notebook-run")).toBe(false);

    await app.type("id:notebook-input", "Company WORKS_AT Person Inês");
    await app.press("id:notebook-run");
    await app.waitFor("id:frame-0-summary");
    expect(app.texts().find((t) => / in \d+ ms$/.test(t))).toMatch(/^2 nodes, 1 relationship in \d+ ms$/);
    expect(app.texts()).toContain("Company WORKS_AT Person Inês");
    expect(app.shows("id:frame-0-graph")).toBe(true);
    expect(app.value("id:notebook-input")).toBe("");

    await app.press("id:frame-0-view-table");
    await app.waitFor("id:frame-0-table");
    await app.press("id:frame-0-view-raw");
    await app.waitFor("id:frame-0-raw");
    expect(app.value("id:frame-0-raw")).toContain('"labels / type": "WORKS_AT"');

    await app.press("id:frame-0-to-scene");
    await app.waitFor("text:Added 2 nodes and 1 relationship.");
    await app.press("id:mode-explore");
    await app.waitFor("id:search");
    expect(stats(app.texts())).toBe("2 nodes, 1 relationship");
    expect(JSON.parse(app.storage()["notebook:demo"])).toEqual([{ text: "Company WORKS_AT Person Inês", by: "you" }]);
  });

  test("frames stack newest first, run again, fold and close; the notebook comes back next time", async () => {
    const app = await open("./App.tsx", {
      ...DESKTOP,
      storage: { settings: JSON.stringify({ mode: "notebook" }), "notebook:demo": JSON.stringify([{ text: "Language" }]) },
    });
    await app.waitFor("id:frame-0");
    expect(app.texts()).toContain("Language");
    await app.press("id:frame-0-fold");
    await app.waitFor("text:Not run since Petal started.");
    await app.press("id:frame-0-run");
    await app.waitFor("id:frame-0-summary");

    await app.type("id:notebook-input", "City");
    await app.press("id:notebook-run");
    await app.waitUntil(() => app.texts().filter((t) => / in \d+ ms$/.test(t)).length === 2);
    expect(JSON.parse(app.storage()["notebook:demo"])).toEqual([
      { text: "City", by: "you" },
      { text: "Language", by: "you" },
    ]);

    await app.press("id:frame-1-fold");
    expect(app.shows("id:frame-1-summary")).toBe(false);
    // A folded frame keeps its query and its edit button.
    expect(app.shows("id:frame-1-query")).toBe(true);
    expect(app.shows("id:frame-1-edit-start")).toBe(true);
    await app.press("id:frame-0-close");
    await app.waitUntil(() => !app.shows("id:frame-1"));
    expect(app.shows("id:frame-0-query")).toBe(true);
    expect(app.shows("id:frame-0-edit-start")).toBe(true);
    expect(JSON.parse(app.storage()["notebook:demo"])).toEqual([{ text: "Language", by: "you" }]);
  });

  test("a frame that fails says why", async () => {
    const app = await open("./App.tsx", { ...DESKTOP, storage: { settings: JSON.stringify({ mode: "notebook" }) } });
    await app.waitFor("id:notebook-empty");
    await app.type("id:notebook-input", "MATCH (n) DELETE n");
    await app.press("id:notebook-run");
    await app.waitFor("id:frame-0-error");
    expect(app.texts()).toContain("The demo graph is read-only, so DELETE can't run. Open a HawDB database to change a graph.");
  });

  test("a notebook file opens in place of the notebook, its queries not run until asked", async () => {
    const app = await open("./App.tsx", {
      ...DESKTOP,
      storage: { settings: JSON.stringify({ mode: "notebook" }), "notebook:demo": JSON.stringify([{ text: "Language" }]) },
    });
    await app.waitFor("id:frame-0");
    expect(app.enabled("id:notebook-save")).toBe(true);
    const file = JSON.stringify({
      format: "petal-notebook/1",
      source: "demo",
      language: "Cypher",
      cells: [
        { text: "City", by: "you", view: "table" },
        { text: "Company WORKS_AT Person", by: "assistant", view: "graph" },
      ],
    });
    app.onPick(() => [{ name: "team.json", type: "application/json", data: new TextEncoder().encode(file) }]);
    await app.press("id:notebook-open");
    await app.waitUntil(() => app.texts().includes("City"));
    expect(app.picks()[0].filters[0].name).toBe("Petal notebook");
    expect(app.texts()).toContain("Opened 2 queries from team.json. Run them to see their results.");
    expect(app.shows("id:frame-2")).toBe(false);
    expect(JSON.parse(app.storage()["notebook:demo"])).toEqual([
      { text: "City", by: "you" },
      { text: "Company WORKS_AT Person", by: "assistant" },
    ]);
    await app.press("id:frame-0-fold");
    await app.waitFor("text:Not run since Petal started.");
    await app.press("id:frame-0-run");
    await app.waitFor("id:frame-0-summary");
  });

  test("a file that isn't a notebook is refused and the notebook stays", async () => {
    const app = await open("./App.tsx", {
      ...DESKTOP,
      storage: { settings: JSON.stringify({ mode: "notebook" }), "notebook:demo": JSON.stringify([{ text: "Language" }]) },
    });
    await app.waitFor("id:frame-0");
    app.onPick(() => [{ name: "scene.json", data: new TextEncoder().encode(JSON.stringify({ format: "petal-scene/1", nodes: [], rels: [] })) }]);
    await app.press("id:notebook-open");
    await app.waitUntil(() => app.texts().includes("The file isn't a Petal notebook."));
    expect(app.shows("id:frame-0")).toBe(true);
    expect(JSON.parse(app.storage()["notebook:demo"])).toEqual([{ text: "Language" }]);
  });

  // --- MCP -------------------------------------------------------------------------------------------------

  test("the MCP dialog runs the server on this computer and shows how to connect to it", async () => {
    const token = "0123456789abcdef0123456789abcdef";
    const app = await open("./App.tsx", {
      ...DESKTOP,
      storage: { mcp: JSON.stringify({ enabled: false, port: 0, token, allowWrites: false }) },
    });
    await app.waitFor("id:example-Person");
    await app.press("id:mcp");
    await app.waitFor("id:mcp-dialog");
    expect(app.texts()).toContain("Off. Assistants can't reach Petal.");
    expect(app.texts().some((t) => t.includes(token))).toBe(true); // in the setup command
    expect(app.texts()).not.toContain(token); // but the token field hides it

    await app.press("id:mcp-enabled");
    await app.waitUntil(() => app.texts().some((t) => /^Listening on http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(t)), { timeout: 8000 });
    const endpoint = app.texts().find((t) => t.startsWith("Listening on "))!.slice("Listening on ".length);
    expect(app.texts().some((t) => t.startsWith(`claude mcp add --transport http petal ${endpoint} --header`))).toBe(true);
    expect(JSON.parse(app.storage().mcp)).toEqual({ enabled: true, port: 0, token, allowWrites: false });

    await app.press("id:mcp-allow-writes");
    expect(JSON.parse(app.storage().mcp).allowWrites).toBe(true);
    await app.press("id:mcp-token-new");
    expect(JSON.parse(app.storage().mcp).token).not.toBe(token);

    await app.press("id:mcp-enabled");
    await app.waitFor("text:Off. Assistants can't reach Petal.");
    expect(JSON.parse(app.storage().mcp).enabled).toBe(false);
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
        if (st === "MATCH (m:Movie) RETURN m.title AS title, m.released AS released") {
          return rows(["title", "released"], [[str("The Long Field"), int(1999)], [str("Quiet Harbor"), int(2004)]]);
        }
        return { status: 400, body: { errors: [{ code: "Neo.ClientError.Statement.SyntaxError", message: `Unexpected statement: ${st}` }] } };
      },
    };
  }

  async function connect(app: Awaited<ReturnType<typeof open>>, password: string) {
    await app.press("id:connection");
    await app.waitFor("id:connect-dialog");
    await app.press("id:driver-neo4j");
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
    await app.waitFor("text:Connected to localhost:7474/movies.");
    expect(app.shows("id:connect-dialog")).toBe(false);
    expect(app.texts()).toContain("Movie");
    expect(app.texts()).toContain("ACTED_IN");
    expect(app.texts()).toContain("133");

    await app.type("id:search", "Person ACTED_IN Movie");
    await app.submit("id:search");
    await app.waitFor("text:Added 2 nodes and 1 relationship.");
    expect(seen).toContain("MATCH p = (n0:`Person`)-[r0:`ACTED_IN`]->(n1:`Movie`) RETURN p LIMIT 100");
    const [saved] = JSON.parse(app.storage().connections);
    expect(saved.settings).toEqual({ kind: "neo4j", url: "localhost:7474", user: "neo4j", database: "movies" });
    expect(JSON.stringify(saved)).not.toContain("secret");
  });

  test("the notebook runs Cypher on Neo4j and shows its rows", async () => {
    const seen: string[] = [];
    const app = await open("./App.tsx", { ...DESKTOP, network: neo4j(seen) });
    await app.waitFor("id:example-Person");
    await connect(app, "secret");
    await app.waitFor("text:Connected to localhost:7474/movies.");
    await app.press("id:mode-notebook");
    await app.waitFor("id:notebook-empty");
    await app.type("id:notebook-input", "MATCH (m:Movie) RETURN m.title AS title, m.released AS released");
    await app.press("id:notebook-run");
    await app.waitFor("id:frame-0-summary");
    expect(seen).toContain("MATCH (m:Movie) RETURN m.title AS title, m.released AS released");
    expect(app.texts().find((t) => / in \d+ ms$/.test(t))).toMatch(/^2 rows in \d+ ms$/);
    // No nodes to draw: the frame opens on its table.
    await app.waitFor("id:frame-0-table");
    await app.press("id:frame-0-view-raw");
    await app.waitFor("id:frame-0-raw");
    expect(JSON.parse(app.value("id:frame-0-raw")!)).toEqual([
      { title: "The Long Field", released: 1999 },
      { title: "Quiet Harbor", released: 2004 },
    ]);
  });

  test("a wrong password is reported in the dialog", async () => {
    const app = await open("./App.tsx", { ...DESKTOP, network: neo4j([]) });
    await app.waitFor("id:example-Person");
    await connect(app, "nope");
    await app.waitFor("id:connect-error");
    expect(app.texts()).toContain("The user name or password is wrong.");
    expect(app.shows("id:connect-dialog")).toBe(true);
  });

  test("a saved connection reconnects with this session's password, tests, and can be deleted", async () => {
    const app = await open("./App.tsx", { ...DESKTOP, network: neo4j([]) });
    await app.waitFor("id:example-Person");
    await connect(app, "secret");
    await app.waitFor("text:Connected to localhost:7474/movies.");
    const [saved] = JSON.parse(app.storage().connections);

    await app.press("id:connection");
    await app.waitFor(`id:saved-${saved.id}`);
    await app.press("id:connect-test");
    await app.waitFor("id:connect-ok");
    expect(app.texts().some((t) => t.startsWith("Connected: 2 labels"))).toBe(true);

    await app.type("id:connect-name", "Movies");
    await app.press("id:connect-save");
    await app.waitUntil(() => JSON.parse(app.storage().connections)[0].name === "Movies");
    expect(JSON.parse(app.storage().connections)).toHaveLength(1);

    await app.press("id:use-demo");
    await app.waitFor("text:Switched to the demo graph.");
    await app.press("id:connection");
    await app.waitFor(`id:saved-${saved.id}`);
    await app.press("id:connect-submit");
    await app.waitFor("text:Connected to localhost:7474/movies.");
    expect(app.texts()).toContain("Movies");

    await app.press("id:connection");
    await app.waitFor("id:connect-delete");
    await app.press("id:connect-delete");
    await app.waitFor("id:driver-neo4j");
    expect(JSON.parse(app.storage().connections)).toEqual([]);
  });

  test("Neo4j's protocol switch turns the address between HTTP and Bolt", async () => {
    const app = await open("./App.tsx", { width: 1320, height: 840, platform });
    await app.waitFor("id:example-Person");
    await app.press("id:connection");
    await app.waitFor("id:connect-dialog");
    await app.press("id:driver-neo4j");
    expect(app.value("id:connect-url")).toBe("http://localhost:7474");
    expect(app.shows("text:http://host:7474, or https://…databases.neo4j.io for Aura")).toBe(true);
    await app.press("id:connect-protocol-bolt");
    expect(app.value("id:connect-url")).toBe("bolt://localhost:7687");
    expect(app.shows("text:bolt://host:7687, or neo4j+s://… for TLS and Aura")).toBe(true);
    await app.clear("id:connect-url");
    await app.type("id:connect-url", "https://abc.databases.neo4j.io");
    await app.press("id:connect-protocol-bolt");
    expect(app.value("id:connect-url")).toBe("neo4j+s://abc.databases.neo4j.io");
    await app.press("id:connect-protocol-http");
    expect(app.value("id:connect-url")).toBe("https://abc.databases.neo4j.io");
  });

  test("Petal 0.2's one connection per driver becomes saved connections", async () => {
    const old = { last: "nebula", neo4j: { url: "http://db:7474", user: "neo4j", database: "movies" }, nebula: { gateway: "http://gw:8080", graphd: "graphd:9669", user: "root", space: "nba" } };
    const app = await open("./App.tsx", { ...DESKTOP, storage: { connection: JSON.stringify(old) } });
    await app.waitFor("id:example-Person");
    await app.waitUntil(() => !!app.storage().connections);
    const saved = JSON.parse(app.storage().connections);
    expect(saved.map((c: { settings: { kind: string } }) => c.settings.kind)).toEqual(["nebula", "neo4j"]);
    expect(app.storage().connection).toBeUndefined();
    await app.press("id:connection");
    await app.waitFor("text:graphd:9669/nba");
  });

  test("a narrow window can open and close the perspective without shrinking the scene", async () => {
    const app = await open("./App.tsx", { width: 740, height: 620, platform });
    await app.setViewport(740, 620);
    await app.waitFor("id:example-Person");
    const sceneWidth = app.layout("id:scene")?.width;
    expect(sceneWidth ?? 0).toBeGreaterThan(0);
    expect(app.shows("id:perspective")).toBe(false);

    await app.press("id:toggle-panel");
    await app.waitFor("id:category-add-Person");
    expect(app.layout("id:scene")?.width).toBe(sceneWidth);
    await app.press("id:category-add-Person");
    await app.waitUntil(() => stats(app.texts()).startsWith("30 nodes"));
    await app.press("id:toggle-panel");
    expect(app.shows("id:perspective")).toBe(false);
    expect(stats(app.texts())).toMatch(/^30 nodes, /);
  });

  test("in a narrow window the inspector floats over the scene at full height", async () => {
    const app = await open("./App.tsx", { width: 960, height: 700, platform });
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
    await app.press("id:driver-nebula");
    await app.clear("id:connect-graphd");
    await app.type("id:connect-graphd", "graphd:9669");
    await app.type("id:connect-space", "basketball");
    await app.type("id:connect-password", "nebula");
    await app.press("id:connect-submit");
    await app.waitFor("text:Connected to graphd:9669/basketball.");
    expect(app.texts()).toContain("player");
    expect(app.texts()).toContain("51");

    await app.type("id:search", "player serve team");
    await app.submit("id:search");
    await app.waitFor("text:Added 2 nodes and 1 relationship.");
    expect(seen).toContain("USE `basketball`; MATCH (n0:`player`)-[r0:`serve`]->(n1:`team`) RETURN n0, r0, n1 LIMIT 100");
    expect(JSON.parse(app.storage().connections)[0].settings).toEqual({
      kind: "nebula",
      gateway: "http://localhost:8080",
      graphd: "graphd:9669",
      user: "root",
      space: "basketball",
    });
  });

  test("NebulaGraph's sign-in errors show in the dialog", async () => {
    const app = await open("./App.tsx", { ...DESKTOP, network: gateway([]) });
    await app.waitFor("id:example-Person");
    await app.press("id:connection");
    await app.press("id:driver-nebula");
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
    await app.press("id:driver-hawdb");
    await app.clear("id:connect-path"); // an empty folder: in memory
    await app.press("id:connect-load-demo");
    await app.press("id:connect-submit");
    await app.waitFor("text:Connected to HawDB in memory.", { timeout: 15000 });
  }

  test("without HawDB on this computer, its pane says how to get it and the demo graph's Cypher says why it can't run", async () => {
    // A desktop where the helper was never downloaded (and no development build of it).
    class NoHelper {
      kind() {
        return "download";
      }
      check() {
        return "";
      }
      devPath() {
        return "";
      }
      async install() {
        throw new Error("no download in tests");
      }
      dispose() {}
    }
    const app = await open("./App.tsx", { ...DESKTOP, modules: { "petal/native": { HawDbHelper: NoHelper } } });
    await app.waitFor("id:example-Person");
    await app.type("id:search", "MATCH (n:Person) RETURN n LIMIT 5");
    await app.submit("id:search");
    await app.waitUntil(() => app.texts().some((t) => t.startsWith("Cypher on the demo graph runs on HawDB.")));

    await app.press("id:connection");
    await app.waitFor("id:connect-dialog");
    await app.press("id:driver-hawdb");
    await app.waitFor("id:hawdb-download");
    await app.clear("id:connect-path");
    await app.press("id:connect-submit");
    await app.waitFor("id:connect-error");
    expect(app.texts().some((t) => t.includes("HawDB"))).toBe(true);
    expect(app.texts()).not.toContain("Connected to HawDB in memory.");
  });

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
    expect(stats(app.texts())).toBe("2 nodes, 1 relationship");

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

  // --- A Gremlin Server played by the test, over HTTP ---------------------------------------------------

  function gremlinServer(seen: string[]) {
    const T = (v: string) => ({ "@type": "g:T", "@value": v });
    const D = (v: string) => ({ "@type": "g:Direction", "@value": v });
    const long = (n: number) => ({ "@type": "g:Int64", "@value": n });
    const gmap = (...kv: unknown[]) => ({ "@type": "g:Map", "@value": kv });
    const list = (...items: unknown[]) => ({ "@type": "g:List", "@value": items });
    const ok = (data: unknown) => ({ body: { requestId: "r", status: { code: 200, message: "", attributes: {} }, result: { data, meta: {} } } });
    const marko = gmap(T("id"), long(1), T("label"), "person", "name", list("marko"), "age", list({ "@type": "g:Int32", "@value": 29 }));
    const lop = gmap(T("id"), long(3), T("label"), "software", "name", list("lop"), "lang", list("java"));
    const created = gmap(T("id"), long(9), T("label"), "created", D("OUT"), gmap(T("id"), long(1), T("label"), "person"), D("IN"), gmap(T("id"), long(3), T("label"), "software"), "weight", { "@type": "g:Double", "@value": 0.4 });
    return {
      "POST http://localhost:8182/gremlin": (req: { headers: Record<string, string>; body?: string | null }) => {
        const auth = req.headers.authorization ?? req.headers.Authorization ?? "";
        if (auth !== "Basic " + Buffer.from("stephen:password").toString("base64")) {
          return { status: 401, body: { requestId: "r", status: { code: 401, message: "Username and/or password are incorrect" }, result: { data: null } } };
        }
        const script: string = JSON.parse(req.body ?? "{}").gremlin;
        seen.push(script);
        if (script === "g.inject(1)") return ok(list({ "@type": "g:Int32", "@value": 1 }));
        if (script.startsWith("g.V().limit(200000).groupCount()")) return ok(list(gmap("person", long(4), "software", long(2))));
        if (script.startsWith("g.E().limit(200000).groupCount()")) return ok(list(gmap("created", long(4), "knows", long(2))));
        if (script.startsWith("g.E().limit(2000).project(")) return ok(list(gmap("f", "person", "t", "created", "e", "software"), gmap("f", "person", "t", "knows", "e", "person")));
        if (script.startsWith("g.V().hasLabel('person').as('n0').outE('created')")) return ok(list(gmap("n0", marko, "r0", created, "n1", lop)));
        if (script.startsWith("g.V(1L, 3L).outE().where(")) return ok(list(created));
        if (script.startsWith("g.V(3L, 1L).outE().where(")) return ok(list(created));
        return { status: 500, body: { requestId: "r", status: { code: 597, message: `No such property: ${script}` }, result: { data: null } } };
      },
    };
  }

  async function connectGremlin(app: Awaited<ReturnType<typeof open>>, password: string) {
    await app.press("id:connection");
    await app.waitFor("id:connect-dialog");
    await app.press("id:driver-gremlin");
    await app.clear("id:connect-gremlin-url");
    await app.type("id:connect-gremlin-url", "http://localhost:8182");
    await app.type("id:connect-gremlin-user", "stephen");
    await app.type("id:connect-password", password);
    await app.press("id:connect-submit");
  }

  test("connects to a Gremlin server over HTTP and searches it", async () => {
    const seen: string[] = [];
    const app = await open("./App.tsx", { ...DESKTOP, network: gremlinServer(seen) });
    await app.waitFor("id:example-Person");
    await connectGremlin(app, "password");
    await app.waitFor("text:Connected to localhost:8182.");
    for (const t of ["person", "software", "created", "knows"]) expect(app.texts()).toContain(t);

    await app.type("id:search", "person created software");
    await app.submit("id:search");
    await app.waitFor("text:Added 2 nodes and 1 relationship.");
    expect(seen).toContain(
      "g.V().hasLabel('person').as('n0').outE('created').as('r0').inV().hasLabel('software').as('n1').limit(100).select('n0', 'r0', 'n1').by(elementMap())",
    );
    expect(JSON.parse(app.storage().connections)[0].settings).toEqual({ kind: "gremlin", url: "http://localhost:8182", user: "stephen", traversal: "g" });
  });

  test("a Gremlin server's refusal shows in the dialog", async () => {
    const app = await open("./App.tsx", { ...DESKTOP, network: gremlinServer([]) });
    await app.waitFor("id:example-Person");
    await connectGremlin(app, "nope");
    await app.waitFor("id:connect-error");
    expect(app.texts()).toContain("The user name or password is wrong.");
  });

  // --- Amazon Neptune played by the test: openCypher over HTTPS, signed with SigV4 --------------------------

  const NEPTUNE = "https://db.cluster-abc.us-east-1.neptune.amazonaws.com:8182";

  function neptuneServer(seen: string[]) {
    const ada = { "~id": "p1", "~entityType": "node", "~labels": ["Person"], "~properties": { name: "Ada" } };
    const acme = { "~id": "c1", "~entityType": "node", "~labels": ["Company"], "~properties": { name: "Acme" } };
    const works = { "~id": "e1", "~entityType": "relationship", "~start": "p1", "~end": "c1", "~type": "WORKS_AT", "~properties": {} };
    const ok = (results: unknown[]) => ({ body: { results } });
    return {
      [`POST ${NEPTUNE}/openCypher`]: (req: { headers: Record<string, string>; body?: string | null }) => {
        const auth = req.headers.authorization ?? req.headers.Authorization ?? "";
        if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/") || !auth.includes("/us-east-1/neptune-db/aws4_request")) {
          return { status: 403, body: { requestId: "r", code: "AccessDeniedException", detailedMessage: "Missing Authentication Token" } };
        }
        const form = new Map((req.body ?? "").split("&").map((kv) => kv.split("=").map((s) => decodeURIComponent(s)) as [string, string]));
        const query = form.get("query") ?? "";
        seen.push(query);
        if (query === "RETURN 1 AS ok") return ok([{ ok: 1 }]);
        if (query.includes("UNWIND labels(n) AS name")) return ok([{ name: "Person", count: 1 }, { name: "Company", count: 1 }]);
        if (query.includes("RETURN type(r) AS name")) return ok([{ name: "WORKS_AT", count: 1 }]);
        if (query.includes("RETURN DISTINCT labels(a) AS f")) return ok([{ f: ["Person"], t: "WORKS_AT", e: ["Company"] }]);
        if (query.startsWith("MATCH p = (n0:`Person`)-[r0:`WORKS_AT`]->(n1:`Company`)")) return ok([{ p: [ada, works, acme] }]);
        if (query.startsWith("MATCH (a)-[r]->(b) WHERE id(a) IN $ids")) return ok([{ r: works }]);
        return { status: 400, body: { requestId: "r", code: "MalformedQueryException", detailedMessage: `Unexpected query: ${query}` } };
      },
    };
  }

  async function connectNeptune(app: Awaited<ReturnType<typeof open>>, keyId: string) {
    await app.press("id:connection");
    await app.waitFor("id:connect-dialog");
    await app.press("id:driver-neptune");
    await app.type("id:connect-neptune-url", NEPTUNE);
    if (keyId) {
      await app.type("id:connect-neptune-key", keyId);
      await app.type("id:connect-password", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
      await app.type("id:connect-session-token", "session-token");
    }
    await app.press("id:connect-submit");
  }

  test("connects to Amazon Neptune with IAM credentials and searches it", async () => {
    const seen: string[] = [];
    const app = await open("./App.tsx", { ...DESKTOP, network: neptuneServer(seen) });
    await app.waitFor("id:example-Person");
    await connectNeptune(app, "AKIDEXAMPLE");
    await app.waitFor("text:Connected to db.cluster-abc.us-east-1.neptune.amazonaws.com.");
    for (const t of ["Person", "Company", "WORKS_AT"]) expect(app.texts()).toContain(t);

    await app.clear("id:search");
    await app.type("id:search", "Person WORKS_AT Company");
    await app.submit("id:search");
    await app.waitFor("text:Added 2 nodes and 1 relationship.");
    expect(seen).toContain("MATCH p = (n0:`Person`)-[r0:`WORKS_AT`]->(n1:`Company`) RETURN p LIMIT 100");
    const stored = app.storage().connections;
    expect(JSON.parse(stored)[0].settings).toEqual({ kind: "neptune", url: NEPTUNE, region: "", accessKeyId: "AKIDEXAMPLE" });
    expect(stored.includes("EXAMPLEKEY") || stored.includes("session-token")).toBe(false);
  });

  test("a Neptune cluster that wants IAM says so when Petal sends no key", async () => {
    const app = await open("./App.tsx", { ...DESKTOP, network: neptuneServer([]) });
    await app.waitFor("id:example-Person");
    await connectNeptune(app, "");
    await app.waitFor("id:connect-error");
    expect(app.texts()).toContain("The cluster wants signed requests: it has IAM authentication on. Enter an access key and its secret.");
  });

  // --- TigerGraph played by the test: the GSQL server's schema, REST++ and interpreted openCypher -----------

  const TIGER = "http://tg.test:14240";

  function tigerServer(seen: string[]) {
    const ada = { v_id: "p1", v_type: "Person", attributes: { name: "Ada" } };
    const bob = { v_id: "p2", v_type: "Person", attributes: { name: "Bob" } };
    const acme = { v_id: "c1", v_type: "Company", attributes: { name: "Acme" } };
    const works = { e_type: "WORKS_AT", directed: true, from_type: "Person", from_id: "p1", to_type: "Company", to_id: "c1", attributes: {} };
    const knows = (a: string, b: string) => ({ e_type: "KNOWS", directed: false, from_type: "Person", from_id: a, to_type: "Person", to_id: b, attributes: {} });
    const ok = (results: unknown): any => ({ body: { error: false, message: "", results } });
    const authed = (req: { headers: Record<string, string> }) =>
      (req.headers.authorization ?? req.headers.Authorization) === "Basic dGlnZXJncmFwaDpzZWNyZXQ=";
    const guard = (fn: (req: { url: string; body?: string | null; headers: Record<string, string> }) => any) => (req: { url: string; body?: string | null; headers: Record<string, string> }) =>
      authed(req) ? fn(req) : { status: 401, body: { error: true, message: "Wrong username or password!" } };
    return {
      [`GET ${TIGER}/gsql/v1/schema/graphs/social`]: guard(() =>
        ok({
          GraphName: "social",
          VertexTypes: [
            { Name: "Person", Attributes: [{ AttributeName: "name", AttributeType: { Name: "STRING" } }] },
            { Name: "Company", Attributes: [{ AttributeName: "name", AttributeType: { Name: "STRING" } }] },
          ],
          EdgeTypes: [
            { Name: "WORKS_AT", FromVertexTypeName: "Person", ToVertexTypeName: "Company", IsDirected: true, Config: { REVERSE_EDGE: "WORKS_AT_REV" } },
            { Name: "WORKS_AT_REV", FromVertexTypeName: "Company", ToVertexTypeName: "Person", IsDirected: true, Config: {} },
            { Name: "KNOWS", FromVertexTypeName: "Person", ToVertexTypeName: "Person", IsDirected: false, Config: {} },
          ],
        }),
      ),
      [`POST ${TIGER}/restpp/builtins/social`]: guard((req) =>
        JSON.parse(req.body ?? "{}").function === "stat_vertex_number"
          ? ok([{ v_type: "Person", count: 2 }, { v_type: "Company", count: 1 }])
          : ok([{ e_type: "WORKS_AT", count: 1 }, { e_type: "WORKS_AT_REV", count: 1 }, { e_type: "KNOWS", count: 1 }]),
      ),
      [`GET ${TIGER}/restpp/graph/social/vertices/Person?limit=*`]: guard(() => ok([ada, bob])),
      [`GET ${TIGER}/restpp/graph/social/vertices/Company/c1`]: guard(() => ok([acme])),
      [`GET ${TIGER}/restpp/graph/social/edges/Person/p1?limit=*`]: guard(() => ok([works, knows("p1", "p2")])),
      [`GET ${TIGER}/restpp/graph/social/edges/Person/p2?limit=*`]: guard(() => ok([knows("p2", "p1")])),
      [`GET ${TIGER}/restpp/graph/social/edges/Company/c1?limit=*`]: guard(() => ok([{ ...works, e_type: "WORKS_AT_REV", from_type: "Company", from_id: "c1", to_type: "Person", to_id: "p1" }])),
      [`POST ${TIGER}/gsql/v1/queries/interpret?graph=social`]: guard((req) => {
        seen.push(req.body ?? "");
        if ((req.body ?? "").includes("MATCH (n0:Person)-[r0:WORKS_AT]->(n1:Company)")) return ok([{ n0: ada, r0: works, n1: acme }]);
        return { body: { error: true, message: "Unexpected query" } };
      }),
    };
  }

  async function connectTiger(app: Awaited<ReturnType<typeof open>>, password: string) {
    await app.press("id:connection");
    await app.waitFor("id:connect-dialog");
    await app.press("id:driver-tigergraph");
    await app.clear("id:connect-tiger-url");
    await app.type("id:connect-tiger-url", "tg.test");
    await app.type("id:connect-tiger-graph", "social");
    await app.type("id:connect-password", password);
    await app.press("id:connect-submit");
  }

  test("connects to TigerGraph, reads its schema without reverse edges, and explores it", async () => {
    const seen: string[] = [];
    const app = await open("./App.tsx", { ...DESKTOP, network: tigerServer(seen) });
    await app.waitFor("id:example-Person");
    await connectTiger(app, "secret");
    await app.waitFor("text:Connected to tg.test/social.");
    for (const t of ["Person", "Company", "WORKS_AT", "KNOWS"]) expect(app.texts()).toContain(t);
    expect(app.texts()).not.toContain("WORKS_AT_REV");

    await app.clear("id:search");
    await app.type("id:search", "Person");
    await app.submit("id:search");
    await app.waitFor("text:Added 2 nodes and 1 relationship.");

    await app.clear("id:search");
    await app.type("id:search", "Person WORKS_AT Company");
    await app.submit("id:search");
    await app.waitFor("text:Added 1 node and 1 relationship.");
    expect(seen[0]).toBe("INTERPRET OPENCYPHER QUERY () FOR GRAPH social {\nMATCH (n0:Person)-[r0:WORKS_AT]->(n1:Company) RETURN n0, r0, n1 LIMIT 100\n}");
    expect(stats(app.texts())).toBe("3 nodes, 2 relationships");
    expect(JSON.parse(app.storage().connections)[0].settings).toEqual({ kind: "tigergraph", url: "tg.test", graph: "social", user: "tigergraph" });
  });

  test("a wrong TigerGraph password is reported in the dialog", async () => {
    const app = await open("./App.tsx", { ...DESKTOP, network: tigerServer([]) });
    await app.waitFor("id:example-Person");
    await connectTiger(app, "nope");
    await app.waitFor("id:connect-error");
    expect(app.texts()).toContain("The user name or password is wrong.");
  });

  // --- Memgraph: Bolt goes through the Rust crate; a closed port is reported --------------------------------

  test("a Memgraph that isn't there is reported in the dialog", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.press("id:connection");
    await app.waitFor("id:connect-dialog");
    await app.press("id:driver-memgraph");
    await app.clear("id:connect-bolt-url");
    await app.type("id:connect-bolt-url", "bolt://127.0.0.1:1");
    await app.press("id:connect-submit");
    await app.waitFor("id:connect-error", { timeout: 30000 });
    expect(app.texts().some((t) => t.startsWith("Couldn't reach 127.0.0.1:1."))).toBe(true);
  });

  test("a PuppyGraph that isn't there is reported in the dialog", async () => {
    const app = await open("./App.tsx", DESKTOP);
    await app.waitFor("id:example-Person");
    await app.press("id:connection");
    await app.waitFor("id:connect-dialog");
    await app.press("id:driver-puppygraph");
    await app.clear("id:connect-puppy-url");
    await app.type("id:connect-puppy-url", "bolt://127.0.0.1:1");
    await app.press("id:connect-submit");
    await app.waitFor("id:connect-error", { timeout: 30000 });
    expect(app.texts().some((t) => t.startsWith("Couldn't reach 127.0.0.1:1. Check the address and that PuppyGraph is running."))).toBe(true);
  });
}
