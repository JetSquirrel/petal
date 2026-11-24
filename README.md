# Petal

**Explore your graph, one connection at a time.**

Petal is a visual graph explorer in the spirit of Neo4j Bloom, for **Neo4j**, **Memgraph**, **PuppyGraph**, **Amazon Neptune**,
**NebulaGraph**, Gremlin servers and **HawDB**. It is a [Native Shell (NSH)](https://nsh.dev) app written in TSX, with
a small Rust crate that embeds HawDB, and it draws the graph with [nsh-graph](../nsh-graph). It runs as a native app
on Windows, macOS and Linux, and on the web (without HawDB).

You search with phrases instead of queries, bring in neighbors one double-click at a time, and set how each category
looks. When you do want queries, the notebook keeps each one with its result as a graph, a table and raw rows. An
assistant such as Claude Code can work with you over MCP. It starts on a built-in demo graph, so it works before you
connect a database.

## Run it

```sh
nsh run                 # this desktop
nsh run --target web    # in a browser
nsh test                # headless tests
nsh check               # type check (builds the Rust crate first)
cargo test --lib -- --ignored --nocapture   # print which Cypher forms HawDB accepts
```

nsh-graph is an nshm from crates.io (`nsh.json` → `"dependencies"`, pinned in `nsh.lock`; `nsh upgrade nsh-graph`
updates it). The Rust crate (`Cargo.toml`, `src/`) is declared in `nsh.json` (`"rust": "."`), so the first run builds
HawDB, which takes a few minutes. Package dependencies need nsh's nightly channel (`nsh update nightly`); 0.6.1, the
latest release, ignores them.

`nsh.json` grants what Petal uses: the network to any host (it connects to the databases you give it), the
clipboard, the menu bar and status bar, the file picker, and files in its data folder (saved scenes) and in
Downloads (exports).

## What it does

- **Search phrases.** As you type, Petal suggests readings of the phrase, built from the database's schema:
  | Phrase | Finds |
  |---|---|
  | `Person` | every Person |
  | `Person Inês` | People with any property containing "Inês" |
  | `Person WORKS_AT Company` | people and the companies they work at, following the direction the schema has |
  | `Project DEPENDS_ON` | projects and what they depend on |
  | `"Sparrow DB"` | any node with a property containing the words |
  | `MATCH (n:Person) RETURN n LIMIT 25` | the database's own query language, run as written: Cypher on Neo4j, HawDB and the demo graph (read-only, run by HawDB in memory; not on the web), nGQL (`MATCH`, `GO`, `LOOKUP`, `FETCH`, …) on NebulaGraph |

  Labels (NebulaGraph's tags) and types match in any case, and quotes keep words together. Up and Down move through
  the suggestions, Enter runs one, and Escape closes the list. Recent searches come back when the field is empty.
- **Scene.** Results are added to the scene along with the relationships between them and the nodes already there.
  Double-click a node, or use the inspector, to expand it: all its neighbors at once, or one relationship type and
  direction at a time, with counts. Dismiss a node, focus on it (dismiss everything else), pin it, or clear the scene.
  Select several nodes with Shift-, Ctrl- or ⌘-click or a Shift-drag box, or all of them from Scene → Select all
  nodes; the inspector and the context menu then expand, focus, pin or dismiss them together, and dragging one moves
  them all. Every change can be undone. Right-click opens a context menu on the desktop.
- **Expand with filters.** Under a node's relationships in the inspector (and under a selection of several),
  **Expand with filters** brings in only some neighbors: across one relationship type and direction, with one label
  (the choices are the labels the schema says can be there), with a property containing some words, and how many at
  most. Databases that can't filter by words in a query (Gremlin servers and HawDB) read up to 5,000 or 20,000
  candidates and Petal filters them.
- **Table.** The table button in the toolbar (Ctrl/⌘ + J) shows the scene as a table under the canvas: its nodes
  (caption, labels, how many relationships each has in the scene, whether it's shown, ID) or its relationships (type,
  from, to). Filter it by any words, which match its columns and the properties, and sort it by a column. Clicking a
  row selects that node or relationship on the canvas. **CSV** and **JSON** write the rows the table shows, with
  every property, to a file in your Downloads folder (on the web, to the clipboard). The CSV has a column per
  property key.
- **Saved scenes.** The bookmark button in the toolbar saves the scene under a name, with its layout and pins, and
  lists the scenes saved for this database, to open (undo goes back) or delete. Each is a file in Petal's data
  folder (`scenes/<database>/`), up to 8 MB; the web build keeps them in its storage, up to 1.5 MB each. **Export
  file** writes the scene to Downloads as JSON (`petal-scene/1`), and **Open file…** opens one, so you can pass a
  scene to someone connected to the same database; **Copy scene** and **Paste scene** do the same through the
  clipboard. A saved scene keeps its nodes' properties as they were when it was saved.
- **Perspective.** Every label is a category with a color from a palette that was checked for color-blind viewers
  (light and dark variants), a caption property and a size. Hiding a category or a relationship type takes it off
  the canvas but keeps it in the scene. Petal remembers the perspective for each database.
- **Inspector.** Labels, typed properties (Integer, Float, Date, List and so on), the node's ID, and copying the
  properties as JSON.
- **Layouts.** Force, tree (hierarchical), circle and grid. Use pan, zoom and fit on the canvas, and toggle the
  relationship-type labels.
- **Notebook.** The Explore / Notebook switch in the header (Ctrl/⌘ + 1 and + 2) turns the scene into a notebook, as
  a database's own browser has one. Type a query in the database's language, or any search phrase, and press Run or
  Ctrl/⌘ + Enter. Each run becomes a frame at the top, with its result as a **Graph**, a **Table** or the **Raw** rows
  as JSON, and how long it took. Click a frame's query to edit and run it again. A frame can also run again as it is,
  add its result to the scene, fold, or close. Petal remembers the frames for each database (their queries, not their
  results), and they come back folded the next time you connect. On the demo graph, frames run search phrases and read-only Cypher.
- **Assistants (MCP).** Petal can run an MCP server, so Claude Code or another MCP client can read the schema, run
  queries, look at your scene, and add to it and to your notebook. See [Assistants (MCP)](#assistants-mcp).
- **Keyboard.** Ctrl/⌘ + K to search, + B to toggle the perspective panel, + Z to undo, + 0 to fit, + O to connect,
  + 1 and + 2 to explore or use the notebook, + J to toggle the table, + Enter to run in the notebook.

## Connecting

The database button at the top right (Ctrl/⌘ + O) opens the connection manager. It works the way a database
client does: saved connections are listed on the left, and you can keep as many as you like, of any database.

- **New connection** (+) shows the databases Petal can open: servers (Neo4j, Memgraph, PuppyGraph, Amazon Neptune, NebulaGraph, any Gremlin
  server) and HawDB, which runs on this computer. Pick one to fill in its settings.
- **Test** opens the database, reads its schema, reports what it found and closes it again, without leaving the
  graph you're exploring.
- **Save** keeps the connection, under a name if you give it one. **Connect** saves it too, and switches to it.
- **Delete** removes a saved connection. **Demo graph** at the bottom goes back to the built-in graph.

Passwords are never saved. Petal keeps one only while it runs, so reconnecting in the same session doesn't ask for
it again. Connections from Petal 0.2, which kept one per database kind, become saved connections the first time
the new version starts.

### Neo4j

Petal talks to Neo4j over HTTP, with no driver or proxy:

- The **Query API** (`/db/{name}/query/v2`, Neo4j 5.19 and later, and Aura), with typed JSON results.
- The **transactional endpoint** (`/db/{name}/tx/commit`) on earlier 5.x servers, which Petal finds through the
  server's discovery document.

The address can be `http://host:7474`, `https://xxxx.databases.neo4j.io`, or a Bolt URI: `neo4j+s://host` is turned
into `https://host`, and `bolt://host:7687` into `http://host:7474`. Petal needs Neo4j 5 or later, because it uses
`elementId()`.

### NebulaGraph

graphd speaks Thrift over TCP, a binary protocol, so Petal goes through
[nebula-http-gateway](https://github.com/vesoft-inc/nebula-http-gateway), the HTTP gateway that NebulaGraph Studio
uses. Run it next to graphd, then give Petal:

- **Gateway**: where the gateway listens, such as `http://localhost:8080`.
- **graphd**: graphd's address *as the gateway reaches it*, such as `graphd:9669`.
- **Space**: the graph space to explore. If it's left empty or wrong, the error lists the spaces that exist.

Petal signs in with `/api/db/connect`, keeps the gateway's `common-nsid` session cookie, and sends each statement as
`USE <space>; …` to `/api/db/exec`. Tags are categories, and edge types are relationship types. A vertex is its VID
(INT64 or string, as `DESCRIBE SPACE` says), and an edge is its source, type, rank and destination.

Some details of how Petal works with NebulaGraph:

- **Returned columns.** The gateway reports vertices and edges only when they are top-level columns, not inside
  paths or lists. So every statement Petal sends returns them as columns (`RETURN n0, r0, n1`), and a raw nGQL query
  should do the same to put its results in the scene.
- **Category counts.** Counts come from `SHOW STATS`, which reports the space's last `SUBMIT JOB STATS`. Run that job
  to see counts.
- **Schema patterns.** NebulaGraph doesn't record which tags an edge type joins, so Petal samples 25 edges of each
  type.
- **Version.** Pattern and text searches scan with `MATCH`, which needs NebulaGraph 3.5 or later.
- **Words you type.** nGQL over the gateway has no parameters, so typed words are escaped into string literals, and
  VIDs are checked against the space's VID type.

### Amazon Neptune

Petal talks to Neptune Database over its openCypher HTTPS endpoint (`POST /openCypher`, engine 1.1.1 and later), so
search, expansion, the notebook and the MCP tools all run openCypher. Give Petal:

- **Endpoint**: the cluster's (or an instance's) endpoint, such as
  `https://my-db.cluster-xxxx.us-east-1.neptune.amazonaws.com:8182`. Petal adds `https://` and `:8182` if they're
  missing.
- **Access key ID**, **Secret access key** and, for temporary credentials, a **Session token**, when the cluster has
  IAM database authentication on. Petal signs each request with Signature Version 4 (service `neptune-db`). Leave the
  key empty when IAM authentication is off. The secret and token are kept only while Petal runs, like passwords.
- **Region**: empty to read it from the endpoint's name.

Neptune answers only inside its VPC, so connect from a machine there, over a VPN, or through an SSH tunnel. With IAM
on, the signed `Host` has to be the cluster's name, so tunnel to it under that name (a hosts-file entry) rather than
`localhost`. Neptune keeps no count store and has no `db.labels()`, so the schema is read from up to 200,000 nodes
and relationships; past that, counts are left out. Integers past 2^53 lose precision, because Neptune returns plain
JSON numbers. To use Gremlin on Neptune instead, the Gremlin driver reaches it over `https://…:8182/gremlin`, without
IAM signing.

### PuppyGraph

[PuppyGraph](https://www.puppygraph.com) queries relational tables and data lakes as a graph, with no copy into a
graph database. Petal speaks openCypher to it over Bolt, the same protocol it uses for Memgraph. Give Petal:

- **Address**: `bolt://host:7687`. Petal adds `bolt://` and `:7687` if they're missing.
- **User** and **Password**: the ones PuppyGraph was started with (`puppygraph` in PuppyGraph's examples).

PuppyGraph's openCypher is a subset, and Petal's statements stay inside what its documentation lists:

- **IDs.** IDs are text such as `person[v1]` (the label and the ID column), read with `elementId()`.
- **Schema.** The schema is declared rather than inferred. Labels and types come from `db.labels()` and
  `db.relationshipTypes()`, and which labels a type joins comes from `db.schema.visualization()`. Counts are one
  `count(*)` per label and type; if counting fails, the schema shows without counts.
- **Relationship counts.** `startNode()` doesn't work on matched relationships, so the inspector counts outgoing and
  incoming relationships separately.
- **Text search.** Text search reads up to 5,000 candidates and Petal checks their properties itself, because
  PuppyGraph doesn't document `toLower()` or `any()`. Words past those candidates aren't found, so a label in the
  phrase (`Person Ada`) helps.

For about a minute after PuppyGraph starts, its Cypher engine isn't ready, and Petal says so. Petal hasn't been run
against a live PuppyGraph yet. The statements follow PuppyGraph's documentation, and parameters (`$ids`) are
assumed to work over Bolt as they do with Neo4j drivers.

### HawDB

[HawDB](https://hawdb.ai) is an embedded database with no server. Petal links it as a library through its Rust crate
(`src/lib.rs`, imported in TSX as `petal/native`) and opens a database folder on this computer. Enter a folder:
HawDB creates the database there if it's missing, and an empty folder field opens an in-memory database. Turn on
**Load the demo graph** to fill a new, empty database with Petal's demo graph. Only one process can open a folder at
a time, so Petal closes it when you switch to another database.

HawDB runs a subset of openCypher, and Petal's statements stay inside it. Each form below was checked against the
engine (`src/tests.rs`):

- Paths can't be returned, so patterns return their nodes and relationships as columns.
- There are no schema procedures, so labels, types and patterns are counted with `labels()` and `type()`. This
  scans the database each time you open it.
- Names can't be backticked, so Petal can only query labels and types made of letters, digits and `_`. It says so
  when one isn't.
- There is no `keys()` or `any()`, so for text search Petal reads up to 20,000 candidates and filters them itself.
- A node gets one label per `CREATE`, so the demo graph in HawDB keeps each node's first label.

HawDB isn't available in the web build: the crate compiles HawDB only for native targets, and on the web opening a
database explains why it can't.

## Assistants (MCP)

The plug button in the header (or File → Connect an assistant) opens Petal's MCP settings. Turn on **Run the MCP
server**, and Petal listens at `http://127.0.0.1:7470/mcp` (the port can be changed). It speaks MCP's Streamable HTTP
transport and answers each request with JSON. Add it to Claude Code with the command the dialog shows:

```sh
claude mcp add --transport http petal http://127.0.0.1:7470/mcp --header "Authorization: Bearer <token>"
```

The dialog also shows the same setup as JSON, for a project's `.mcp.json`, Cursor, and other clients that connect to
a URL. The tools work on whatever database Petal is connected to at the moment:

| Tool | Does |
|---|---|
| `get_schema` | the database's kind and query language, its labels and relationship types with counts, and which labels each type joins |
| `run_query` | runs a query in the database's own language and returns its columns and rows (at most 200), plus the nodes and relationships in them |
| `search` | finds nodes with a search phrase, the same phrases the search field takes |
| `expand` | the neighbors of nodes, optionally of one relationship type and direction, with one label, or with a property containing some words |
| `get_scene` | the nodes and relationships in your scene, and the ones you selected |
| `add_to_notebook` | runs a query or phrase in a new notebook frame, marked *Assistant*, and returns what it found |

`run_query`, `search` and `expand` take `show: true` to bring what they found into your scene. The dialog lists the
calls assistants made lately.

How Petal keeps the server safe:

- **It listens on 127.0.0.1 only**, and is off until you turn it on. Petal remembers whether it was on.
- **Every request needs the token.** Petal makes a random one the first time, shows it in the dialog, and can make a
  new one, which disconnects clients set up with the old one.
- **Web pages can't call it.** A request whose `Origin` isn't this computer, or whose `Host` isn't `localhost` or
  `127.0.0.1` (DNS rebinding), is refused.
- **Queries that write are refused** unless you turn on **Allow queries that write**: Cypher's `CREATE`, `MERGE`,
  `SET`, `DELETE`, `REMOVE`, `DROP`, `LOAD CSV` and procedures that aren't known to only read; nGQL's `INSERT`,
  `UPDATE`, `DELETE` and the rest; Gremlin's `addV`, `addE`, `property` and `drop`. Petal finds them by reading
  keywords (outside strings, quoted names and comments), so this stops mistakes, not a client set on writing. For
  that, connect as a database user that can only read.

The server needs sockets, so it is in the desktop apps, not the web build.

## How it is built

```
App.tsx               the shell: header, perspective panel, scene or notebook, inspector; the menu bar
nsh.json, theme.json  the app's settings and design tokens (light and dark)
Cargo.toml, src/      the Rust crate, `petal/native` in TSX: `HawDb` (lib.rs), `BoltClient` (bolt.rs) and
                      `McpServer` (mcp.rs, the MCP server's HTTP endpoint on 127.0.0.1)
ui/                   Petal's own styled components (Button, IconButton, TextField, Segmented, Popover, Icon, …)
components/           the screens' parts: SearchBar, PerspectivePanel, Scene, SceneTable, ScenesMenu, Inspector,
                      Notebook, ConnectDialog, McpDialog, Header
store/                state and actions: app.ts (connections, search, expand, saved scenes), scene.ts (contents
                      and undo), perspective.ts (category styles), sceneGraph.ts (what the canvas draws),
                      sceneTable.ts (the table's rows, filter, sort, CSV and JSON), files.ts (exports, the file
                      picker, the data folder), savedScenes.ts (saved scenes
                      and their JSON), notebook.ts (frames), mcp.ts (the MCP server's settings and its request loop)
mcp/                  MCP with no UI: protocol.ts (JSON-RPC over Streamable HTTP, the token and origin checks) and
                      tools.ts (the tools, and the check for queries that write)
graph/                data access, with no UI: model.ts, source.ts (the GraphSource interface), phrase.ts (search
                      phrases and suggestions), and one module per database: neo4j.ts and cypher.ts, neptune.ts (openCypher
                      over HTTPS and SigV4), memgraph.ts and puppygraph.ts (Bolt), nebula.ts
                      (gateway client and nGQL), hawdb.ts (HawDB's Cypher subset), demo.ts and demoData.ts
```

The UI never writes queries. Every question goes through `GraphSource` (`search`, `expand`, `relationshipsAmong`,
`neighborhood`, `schema`), and each database answers it in its own dialect. Label and type names are always
quoted, or checked where the dialect can't quote them. Typed words are passed as parameters on Neo4j, escaped into
literals on NebulaGraph, and matched by Petal on HawDB. The notebook and the MCP tools go through `GraphSource`
too. A query runs as `search({ kind: "raw" })`, whose result carries the rows (`GraphResult.table`) as well as the
graph.

The MCP server is split between Rust and TSX, because TSX can't listen on a socket. `McpServer` accepts connections,
reads each HTTP request and hands it to TSX (`next()`). TSX answers (`respond()`) with what `mcp/protocol.ts`
decides. A request TSX doesn't answer within two minutes gets a 504.

## Tests

`graph/graph.test.ts` covers phrase parsing and suggestions; the Cypher, nGQL, HawDB and PuppyGraph statements; address mapping;
decoding of Neo4j's typed JSON, the gateway's rows and HawDB's rows; and the demo database. `App.test.tsx` drives the
app itself. It covers searching, the suggestion list, undo, hiding categories, selecting and expanding a node, and a
narrow window. It connects to a Neo4j server and a NebulaGraph gateway that the test plays, including wrong
passwords. It also opens a real embedded HawDB, loads the demo graph into it, and explores it. In notebook mode it runs
phrases and Cypher into frames, switches views, reruns, folds, closes and remembers frames, and adds a result to the
scene. It turns the MCP server on and off.

`mcp/mcp.test.ts` covers the MCP protocol (initialize, tools, notifications, batches, errors), the token, origin and
host checks, the write check across Cypher, nGQL and Gremlin, and each tool on the demo graph. `src/mcp_tests.rs`
sends real HTTP to the endpoint: bodies in pieces, malformed and oversized requests, stopping, and a port in use.

## Limits

- Selecting several nodes takes Shift-, Ctrl- or ⌘-click, or a Shift-drag box, so it needs a keyboard. There is no
  lasso yet, and on a touch screen one node is selected at a time.
- A scene holds at most 5,000 nodes. The force layout runs in Rust and settles that many in about five seconds; past
  a couple of thousand, the tree, circle or grid layout is quicker still.
- Text search scans every node's properties and doesn't use full-text indexes, so it will be slow on large databases.
- Petal needs Neo4j 5 or later.
- The MCP server answers each request with JSON and has no event stream, so it doesn't send progress or
  notifications. It speaks HTTP/1.1, one request per connection.
- The notebook keeps queries, not results, between sessions, and a frame's table shows nodes inside rows as their
  labels. The graph view and the tool results carry their properties.
- Context menus and the menu bar are desktop features. On the web and on touch screens, the inspector and toolbar
  do the same things.
