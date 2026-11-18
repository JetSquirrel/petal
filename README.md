# Petal

**Explore your graph, one connection at a time.**

Petal is a visual graph explorer in the spirit of Neo4j Bloom, for **Neo4j**, **NebulaGraph** and **HawDB**. It is a
[Native Shell (NSH)](https://nsh.dev) app written in TSX, with a small Rust crate that embeds HawDB, and it draws the
graph with [nsh-graph](../nsh-graph). It runs as a native app on Windows, macOS and Linux, and on the web (without
HawDB).

You search with phrases instead of queries, bring in neighbors one double-click at a time, and set how each category
looks. It starts on a built-in demo graph, so it works before you connect a database.

## Run it

```sh
nsh run                 # this desktop
nsh run --target web    # in a browser
nsh test                # headless tests
nsh check               # type check (builds the Rust crate first)
cargo test --lib -- --ignored --nocapture   # print which Cypher forms HawDB accepts
```

nsh-graph is resolved from `../nsh-graph` (`nsh.json` → `resolve.alias`). The Rust crate (`Cargo.toml`, `src/`) is
declared in `nsh.json` (`"rust": "."`), so the first run builds HawDB, which takes a few minutes.

## What it does

- **Search phrases.** As you type, Petal suggests readings of the phrase, built from the database's schema:
  | Phrase | Finds |
  |---|---|
  | `Person` | every Person |
  | `Person Inês` | People with any property containing "Inês" |
  | `Person WORKS_AT Company` | people and the companies they work at, following the direction the schema has |
  | `Project DEPENDS_ON` | projects and what they depend on |
  | `"Sparrow DB"` | any node with a property containing the words |
  | `MATCH (n:Person) RETURN n LIMIT 25` | the database's own query language, run as written: Cypher on Neo4j and HawDB, nGQL (`MATCH`, `GO`, `LOOKUP`, `FETCH`, …) on NebulaGraph |

  Labels (NebulaGraph's tags) and types match in any case, and quotes keep words together. Up and Down move through
  the suggestions, Enter runs one, and Escape closes the list. Recent searches come back when the field is empty.
- **Scene.** Results are added to the scene along with the relationships between them and the nodes already there.
  Double-click a node, or use the inspector, to expand it: all its neighbors at once, or one relationship type and
  direction at a time, with counts. Dismiss a node, focus on it (dismiss everything else), pin it, or clear the scene.
  Select several nodes with Shift-, Ctrl- or ⌘-click or a Shift-drag box (Scene → Select all nodes takes them all); the inspector
  and the context menu then expand, focus, pin or dismiss them together, and dragging one moves them all. Every change
  can be undone. Right-click opens a context menu on the desktop.
- **Perspective.** Every label is a category with a color from a palette that was checked for color-blind viewers
  (light and dark variants), a caption property and a size. Hiding a category or a relationship type takes it off
  the canvas but keeps it in the scene. Petal remembers the perspective for each database.
- **Inspector.** Labels, typed properties (Integer, Float, Date, List and so on), the node's ID, and copying the
  properties as JSON.
- **Layouts.** Force, tree (hierarchical), circle and grid. Use pan, zoom and fit on the canvas, and toggle the
  relationship-type labels.
- **Keyboard.** Ctrl/⌘ + K to search, + B to toggle the perspective panel, + Z to undo, + 0 to fit, + O to connect.

## Connecting

Use the database button at the top right and pick the kind. Petal remembers the last connection of each kind, but
never a password.

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

## How it is built

```
App.tsx               the shell: header, perspective panel, scene, inspector; the menu bar
nsh.json, theme.json  the app's settings and design tokens (light and dark)
Cargo.toml, src/      the Rust crate: HawDB, exported to TSX as the class `HawDb` of `petal/native`
ui/                   Petal's own styled components (Button, IconButton, TextField, Segmented, Popover, Icon, …)
components/           the screens' parts: SearchBar, PerspectivePanel, Scene, Inspector, ConnectDialog, Header
store/                state and actions: app.ts (connections, search, expand), scene.ts (contents and undo),
                      perspective.ts (category styles), sceneGraph.ts (what the canvas draws)
graph/                data access, with no UI: model.ts, source.ts (the GraphSource interface), phrase.ts (search
                      phrases and suggestions), and one module per database: neo4j.ts and cypher.ts, nebula.ts
                      (gateway client and nGQL), hawdb.ts (HawDB's Cypher subset), demo.ts and demoData.ts
```

The UI never writes queries. Every question goes through `GraphSource` (`search`, `expand`, `relationshipsAmong`,
`neighborhood`, `schema`), and each database answers it in its own dialect. Label and type names are always
quoted, or checked where the dialect can't quote them. Typed words are passed as parameters on Neo4j, escaped into
literals on NebulaGraph, and matched by Petal on HawDB.

## Tests

`graph/graph.test.ts` covers phrase parsing and suggestions; the Cypher, nGQL and HawDB statements; address mapping;
decoding of Neo4j's typed JSON, the gateway's rows and HawDB's rows; and the demo database. `App.test.tsx` drives the
app itself. It covers searching, the suggestion list, undo, hiding categories, selecting and expanding a node, and a
narrow window. It connects to a Neo4j server and a NebulaGraph gateway that the test plays, including wrong
passwords. It also opens a real embedded HawDB, loads the demo graph into it, and explores it.

## Limits

- Selecting several nodes takes Shift-, Ctrl- or ⌘-click, or a Shift-drag box, so it needs a keyboard. There is no
  lasso yet, and on a touch screen one node is selected at a time.
- A scene holds at most 1,500 nodes. The force layout slows down past a few hundred, so use the tree, circle or grid
  layout for bigger scenes.
- Text search scans every node's properties and doesn't use full-text indexes, so it will be slow on large databases.
- Petal needs Neo4j 5 or later.
- Context menus and the menu bar are desktop features. On the web and on touch screens, the inspector and toolbar
  do the same things.
