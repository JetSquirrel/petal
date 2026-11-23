import { expect, test } from "nsh/test";
import { DemoSource } from "../graph/demo";
import { valueText, type GraphResult } from "../graph/model";
import { parsePhrase } from "../graph/phrase";
import type { Schema } from "../graph/source";
import { frameSummary, frameTable, tableRecords, type Frame } from "../store/notebook";
import { claudeCodeCommand, clientConfig, newToken } from "../store/mcp";
import { fromAWebPage, handleHttp, PROTOCOL_VERSIONS, type HttpRequest, type McpServerOptions } from "./protocol";
import { callTool, code, describeResult, looksLikeWrite, toolDefinitions, type ToolHost } from "./tools";

// --- The protocol -----------------------------------------------------------------------------------------

const TOKEN = "t0k3n-0123456789abcdef";

const options = (calls: string[] = []): McpServerOptions => ({
  token: TOKEN,
  name: "petal",
  version: "9.9.9",
  instructions: "Be kind.",
  tools: () => [{ name: "echo", title: "Echo", description: "Echoes.", inputSchema: { type: "object", properties: { say: { type: "string" } } } }],
  call: async (name, args) => {
    calls.push(name);
    if (args.say === "boom") throw new Error("It broke.");
    return { text: `you said ${String(args.say)}` };
  },
});

const post = (body: unknown, headers: Record<string, string> = {}): HttpRequest => ({
  method: "POST",
  path: "/mcp",
  headers: { host: "127.0.0.1:7470", authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

test("initializes, negotiating the protocol version", async () => {
  const res = await handleHttp(post(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } })), options());
  expect(res.status).toBe(200);
  expect(res.headers["Content-Type"]).toBe("application/json");
  const body = JSON.parse(res.body);
  expect(body.id).toBe(1);
  expect(body.result.protocolVersion).toBe("2025-03-26");
  expect(body.result.capabilities).toEqual({ tools: { listChanged: false } });
  expect(body.result.serverInfo).toEqual({ name: "petal", title: "Petal", version: "9.9.9" });
  expect(body.result.instructions).toBe("Be kind.");

  const future = JSON.parse((await handleHttp(post(rpc("initialize", { protocolVersion: "2099-01-01" })), options())).body);
  expect(future.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
});

test("lists and calls tools; a tool's failure is a result the client reads", async () => {
  const calls: string[] = [];
  const list = JSON.parse((await handleHttp(post(rpc("tools/list", {}, "a")), options(calls))).body);
  expect(list.id).toBe("a");
  expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);

  const ok = JSON.parse((await handleHttp(post(rpc("tools/call", { name: "echo", arguments: { say: "hi" } })), options(calls))).body);
  expect(ok.result).toEqual({ content: [{ type: "text", text: "you said hi" }], isError: false });

  const broke = JSON.parse((await handleHttp(post(rpc("tools/call", { name: "echo", arguments: { say: "boom" } })), options(calls))).body);
  expect(broke.result).toEqual({ content: [{ type: "text", text: "It broke." }], isError: true });

  const unknown = JSON.parse((await handleHttp(post(rpc("tools/call", { name: "nope" })), options(calls))).body);
  expect(unknown.error.code).toBe(-32602);
  expect(calls).toEqual(["echo", "echo"]);
});

test("notifications get 202, unknown methods and bad JSON get errors, batches get one answer each", async () => {
  const note = await handleHttp(post({ jsonrpc: "2.0", method: "notifications/initialized" }), options());
  expect(note.status).toBe(202);
  expect(note.body).toBe("");

  const unknown = JSON.parse((await handleHttp(post(rpc("sampling/createMessage")), options())).body);
  expect(unknown.error.code).toBe(-32601);

  const bad = await handleHttp(post("{nope"), options());
  expect(bad.status).toBe(400);
  expect(JSON.parse(bad.body).error.code).toBe(-32700);

  const batch = await handleHttp(post([rpc("ping", {}, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("ping", {}, 2)]), options());
  expect(JSON.parse(batch.body)).toEqual([
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: 2, result: {} },
  ]);
});

test("refuses requests without the token, from web pages, and to other paths or methods", async () => {
  const ping = rpc("ping");
  expect((await handleHttp(post(ping, { authorization: "" }), options())).status).toBe(401);
  expect((await handleHttp(post(ping, { authorization: "Bearer wrong-token-of-same-size!" }), options())).status).toBe(401);
  const unauth = await handleHttp(post(ping, { authorization: "Basic abc" }), options());
  expect(unauth.headers["WWW-Authenticate"]).toBe('Bearer realm="petal"');

  expect((await handleHttp(post(ping, { origin: "https://evil.example" }), options())).status).toBe(403);
  expect((await handleHttp(post(ping, { origin: "null" }), options())).status).toBe(403);
  expect((await handleHttp(post(ping, { host: "evil.example:7470" }), options())).status).toBe(403);
  expect((await handleHttp(post(ping, { origin: "http://localhost:3000" }), options())).status).toBe(200);
  expect((await handleHttp(post(ping, { host: "[::1]:7470" }), options())).status).toBe(200);

  expect((await handleHttp({ ...post(ping), path: "/other" }, options())).status).toBe(404);
  const get = await handleHttp({ ...post(ping), method: "GET", body: "" }, options());
  expect(get.status).toBe(405);
  expect(get.headers.Allow).toBe("POST");
  expect((await handleHttp(post(ping, { "mcp-protocol-version": "1999-01-01" }), options())).status).toBe(400);
  expect((await handleHttp(post(ping, { "mcp-protocol-version": "2025-06-18" }), options())).status).toBe(200);
  // No token configured: nothing gets in.
  expect((await handleHttp(post(ping), { ...options(), token: "" })).status).toBe(401);
});

test("tells web pages from local clients", () => {
  expect(fromAWebPage({ host: "localhost:7470" })).toBeNull();
  expect(fromAWebPage({})).toBeNull();
  expect(fromAWebPage({ host: "127.0.0.1" })).toBeNull();
  expect(fromAWebPage({ host: "127.0.0.1.nip.io:7470" })).toMatch(/aren't allowed/);
  expect(fromAWebPage({ origin: "http://localhost.evil.example" })).toMatch(/aren't allowed/);
});

// --- The write check --------------------------------------------------------------------------------------

test("queries that write are told from queries that read", () => {
  const reads = [
    "MATCH (n:Person) RETURN n LIMIT 25",
    "MATCH (a)--(b) RETURN a, b",
    "MATCH (n) WHERE n.name = 'CREATE me' RETURN n.offset, n.settings",
    "MATCH (n) RETURN n // DELETE is in a comment",
    "MATCH (n:`DELETE`) RETURN n /* SET x = 1 */",
    "CALL db.labels() YIELD label RETURN label",
    "CALL db.schema.visualization()",
    "MATCH (n) CALL { WITH n MATCH (n)--(m) RETURN count(m) AS c } RETURN n, c",
  ];
  for (const q of reads) expect([q, looksLikeWrite(q, "Cypher")]).toEqual([q, null]);

  expect(looksLikeWrite("MATCH (n) DETACH DELETE n", "Cypher")).toBe("uses DETACH");
  expect(looksLikeWrite("match (n) set n.x = 1", "Cypher")).toBe("uses SET");
  expect(looksLikeWrite("CREATE (:Person {name: 'x'})", "Cypher")).toBe("uses CREATE");
  expect(looksLikeWrite("LOAD CSV FROM 'file:///x' AS row RETURN row", "Cypher")).toBe("uses LOAD CSV");
  expect(looksLikeWrite("CALL apoc.create.node(['X'], {})", "Cypher")).toMatch(/procedure apoc\.create\.node/);
  // A quote in a comment doesn't hide what comes after it, and `--` is a relationship in Cypher, not a comment.
  expect(looksLikeWrite("// it's fine\nMATCH (n) DELETE n", "Cypher")).toBe("uses DELETE");
  expect(looksLikeWrite("MATCH (a)--(b) DELETE a", "Cypher")).toBe("uses DELETE");

  expect(looksLikeWrite("GO FROM 'a' OVER follow YIELD dst(edge)", "nGQL")).toBeNull();
  expect(looksLikeWrite("MATCH (v) RETURN v -- INSERT in a comment", "nGQL")).toBeNull();
  expect(looksLikeWrite("INSERT VERTEX player(name) VALUES 'p':('x')", "nGQL")).toBe("uses INSERT");
  expect(looksLikeWrite("g.V().hasLabel('person').valueMap()", "Gremlin")).toBeNull();
  expect(looksLikeWrite("g.V().hasLabel('person').properties('name')", "Gremlin")).toBeNull();
  expect(looksLikeWrite("g.addV('person').property('name', 'x')", "Gremlin")).toBe("calls addV()");
  expect(looksLikeWrite("g.V('1').drop()", "Gremlin")).toBe("calls drop()");
});

test("blanks literals, names and comments, by language", () => {
  expect(code("RETURN 'it''s' + \"q\\\"\" // c\n, `a``b`", "Cypher").replace(/\s+/g, " ").trim()).toBe("RETURN x x + x , x");
  expect(code("RETURN 1 # c", "nGQL").trim()).toBe("RETURN 1");
  expect(code("RETURN 1 # c", "Cypher").trim()).toBe("RETURN 1 # c");
});

// --- The tools, on the demo graph -------------------------------------------------------------------------

async function demoHost(over: Partial<ToolHost> = {}) {
  const source = new DemoSource();
  const schema: Schema = await source.schema();
  const shown: GraphResult[] = [];
  const host: ToolHost = {
    source: () => source,
    schema: () => schema,
    ready: () => true,
    parse: (text) => parsePhrase(text, schema, source.language),
    limit: () => 100,
    scene: () => ({ nodes: [], rels: [], selected: [] }),
    show: async (r) => {
      shown.push(r);
      return { addedNodes: r.nodes.length, addedRels: r.rels.length };
    },
    notebook: async () => undefined,
    allowWrites: () => false,
    ...over,
  };
  return { host, shown };
}

test("the tools are described with schemas and hints", () => {
  const tools = toolDefinitions();
  expect(tools.map((t) => t.name)).toEqual(["get_schema", "run_query", "search", "expand", "get_scene", "add_to_notebook"]);
  for (const t of tools) {
    expect(t.inputSchema.type).toBe("object");
    expect(t.description.length).toBeGreaterThan(20);
  }
  expect(tools.find((t) => t.name === "search")!.inputSchema.required).toEqual(["phrase"]);
});

test("get_schema and search answer from the database, and show brings results into the scene", async () => {
  const { host, shown } = await demoHost();
  const schema = JSON.parse((await callTool(host, "get_schema", {})).text);
  expect(schema.database).toEqual({ kind: "demo", name: "Demo graph", queryLanguage: null });
  expect(schema.labels.map((l: { name: string }) => l.name)).toContain("Person");
  expect(schema.patterns).toContain("(:Person)-[:WORKS_AT]->(:Company)");

  const found = await callTool(host, "search", { phrase: "Company WORKS_AT Person Inês", show: true });
  expect(found.isError).toBeUndefined();
  const body = JSON.parse(found.text);
  expect(body.nodes.map((n: { properties: { name: string } }) => n.properties.name).sort()).toEqual(["Brightloom", "Inês Carvalho"]);
  expect(body.relationships[0].type).toBe("WORKS_AT");
  expect(body.addedToScene).toEqual({ addedNodes: 2, addedRels: 1 });
  expect(shown).toHaveLength(1);
});

test("expand, get_scene, and the errors an assistant reads", async () => {
  const { host } = await demoHost({
    scene: () => ({ nodes: [{ id: "n1", labels: ["Person"], properties: { name: { type: "String", value: "Ada" } } }], rels: [], selected: ["n1"] }),
  });
  const sparrow = JSON.parse((await callTool(host, "search", { phrase: '"Sparrow DB"' })).text).nodes[0].id;
  const out = JSON.parse((await callTool(host, "expand", { node_ids: [sparrow], relationship_type: "DEPENDS_ON", direction: "out" })).text);
  expect(out.nodes.map((n: { properties: { name: string } }) => n.properties.name).sort()).toEqual(["Lattice", "Sparrow DB"]);

  const scene = JSON.parse((await callTool(host, "get_scene", {})).text);
  expect(scene.selected).toEqual(["n1"]);
  expect(scene.nodes).toEqual([{ id: "n1", labels: ["Person"], properties: { name: "Ada" } }]);

  expect((await callTool(host, "run_query", { query: "MATCH (n) RETURN n" })).text).toMatch(/demo graph/);
  expect((await callTool(host, "expand", { node_ids: [] })).isError).toBe(true);
  expect((await callTool(host, "search", { phrase: "" })).isError).toBe(true);

  const offline = await demoHost({ ready: () => false });
  expect((await callTool(offline.host, "get_schema", {})).text).toMatch(/isn't connected/);
});

test("run_query refuses writes unless they are allowed, and returns rows as records", async () => {
  const ran: string[] = [];
  const source = Object.assign(new DemoSource(), {
    language: "Cypher" as const,
    search: async (spec: { kind: string; statement?: string }) => {
      ran.push(spec.statement ?? "");
      return {
        nodes: [{ id: "1", labels: ["Person"], properties: { name: { type: "String" as const, value: "Ada" } } }],
        rels: [],
        rows: 1,
        table: { columns: ["n", "count"], rows: [[{ type: "Text" as const, kind: "Node", value: "(:Person)" }, { type: "Integer" as const, value: "42" }]] },
      };
    },
  });
  const { host } = await demoHost({ source: () => source as unknown as DemoSource });
  const refused = await callTool(host, "run_query", { query: "MATCH (n) DETACH DELETE n" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toMatch(/uses DETACH/);
  expect(ran).toEqual([]);

  const rows = JSON.parse((await callTool(host, "run_query", { query: "MATCH (n) RETURN n, count(*) AS count" })).text);
  expect(rows.columns).toEqual(["n", "count"]);
  expect(rows.rows).toEqual([{ n: "(:Person)", count: 42 }]);
  expect(rows.rowCount).toBe(1);
  expect(rows.nodes).toEqual([{ id: "1", labels: ["Person"], properties: { name: "Ada" } }]);

  const writer = await demoHost({ source: () => source as unknown as DemoSource, allowWrites: () => true });
  expect((await callTool(writer.host, "run_query", { query: "MATCH (n) DETACH DELETE n" })).isError).toBeUndefined();
  expect(ran).toEqual(["MATCH (n) RETURN n, count(*) AS count", "MATCH (n) DETACH DELETE n"]);
});

test("add_to_notebook runs in the notebook and reports the frame", async () => {
  const frames: string[] = [];
  const { host } = await demoHost({
    notebook: async (text) => {
      frames.push(text);
      const result = await new DemoSource().search(parsePhrase(text, await new DemoSource().schema(), null)!, 100);
      return { id: 7, text, status: "done", result, ms: 3, view: "graph", collapsed: false, by: "assistant" } satisfies Frame;
    },
  });
  const body = JSON.parse((await callTool(host, "add_to_notebook", { query: "Language" })).text);
  expect(frames).toEqual(["Language"]);
  expect(body.frame).toBe(7);
  expect(body.nodes.length).toBeGreaterThan(0);
  // The demo graph keeps no rows: the nodes say it all, with no made-up table beside them.
  expect(body.columns).toBeUndefined();
  expect(body.rowCount).toBe(body.nodes.length);
});

// --- Results as tables ------------------------------------------------------------------------------------

test("a result without rows of its own becomes a table of its nodes and relationships", async () => {
  const db = new DemoSource();
  const result = await db.search(parsePhrase("Company WORKS_AT Person Inês", await db.schema())!, 100);
  const table = frameTable(result);
  expect(table.columns).toEqual(["kind", "id", "labels / type", "properties"]);
  expect(table.rows.map((r) => valueText(r[0]))).toEqual(["node", "node", "relationship"]);
  const records = tableRecords(table);
  expect(records[2]["labels / type"]).toBe("WORKS_AT");

  const huge = describeResult({ nodes: [], rels: [], rows: 300, table: { columns: ["i"], rows: Array.from({ length: 300 }, (_, i) => [{ type: "Integer" as const, value: String(i) }]) } });
  expect((huge.rows as unknown[]).length).toBe(200);
  expect(huge.rowCount).toBe(300);
  expect(huge.rowsTruncated).toBe(true);

  const big = tableRecords({ columns: ["big"], rows: [[{ type: "Integer", value: "9007199254740993" }]] });
  expect(big[0].big).toBe("9007199254740993");

  const frame = { id: 1, text: "x", status: "done", result, ms: 12, view: "graph", collapsed: false, by: "you" } satisfies Frame;
  expect(frameSummary(frame)).toBe("2 nodes, 1 relationship in 12 ms");
  expect(frameSummary({ ...frame, result: { ...result, table: { columns: ["a"], rows: [] }, nodes: [], rels: [], rows: 0 } })).toBe("0 rows in 12 ms");
});

// --- Setting up a client ----------------------------------------------------------------------------------

test("tokens are long and random, and the setup text carries them", () => {
  const a = newToken();
  expect(a).toMatch(/^[0-9a-f]{48}$/);
  expect(newToken()).not.toBe(a);
  expect(claudeCodeCommand("http://127.0.0.1:7470/mcp", "abc")).toBe(
    'claude mcp add --transport http petal http://127.0.0.1:7470/mcp --header "Authorization: Bearer abc"',
  );
  expect(JSON.parse(clientConfig("http://127.0.0.1:7470/mcp", "abc"))).toEqual({
    mcpServers: { petal: { type: "http", url: "http://127.0.0.1:7470/mcp", headers: { Authorization: "Bearer abc" } } },
  });
});
