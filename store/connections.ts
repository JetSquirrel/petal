/**
 * Saved connections, the way a database client keeps them: any number, each with a name and a driver's
 * settings. Passwords are never stored; Petal keeps them only while it runs.
 */
import type { GremlinConnection } from "../graph/gremlin";
import type { MemgraphConnection } from "../graph/memgraph";
import type { NebulaConnection } from "../graph/nebula";
import type { Neo4jConnection } from "../graph/neo4j";

/** A database to open, by driver, with what it needs to sign in. */
export type ConnectionForm =
  | ({ kind: "neo4j" } & Neo4jConnection)
  | ({ kind: "memgraph" } & MemgraphConnection)
  | ({ kind: "nebula" } & NebulaConnection)
  | ({ kind: "gremlin" } & GremlinConnection)
  | { kind: "hawdb"; path: string; loadDemo: boolean };

export type DriverKind = ConnectionForm["kind"];

type Kept<T> = T extends unknown ? Omit<T, "password" | "loadDemo"> : never;
/** A connection's settings as Petal stores them: no password, no one-off options. */
export type ConnectionSettings = Kept<ConnectionForm>;

export interface SavedConnection {
  id: string;
  /** What the person calls it; empty to use the database's own label. */
  name: string;
  settings: ConnectionSettings;
  /** When Petal last opened it, in ms since the epoch. */
  lastUsed?: number;
}

export function defaultSettings(kind: DriverKind, hawDbPath = ""): ConnectionSettings {
  switch (kind) {
    case "neo4j":
      return { kind, url: "http://localhost:7474", user: "neo4j", database: "neo4j" };
    case "memgraph":
      return { kind, url: "bolt://localhost:7687", user: "", database: "" };
    case "nebula":
      return { kind, gateway: "http://localhost:8080", graphd: "graphd:9669", user: "root", space: "" };
    case "gremlin":
      return { kind, url: "ws://localhost:8182/gremlin", user: "", traversal: "g" };
    case "hawdb":
      return { kind, path: hawDbPath };
  }
}

/** The settings with spaces trimmed and empty fields given their defaults. */
export function tidy(s: ConnectionSettings): ConnectionSettings {
  switch (s.kind) {
    case "neo4j":
      return { kind: s.kind, url: s.url.trim(), user: s.user, database: s.database.trim() || "neo4j" };
    case "memgraph":
      return { kind: s.kind, url: s.url.trim(), user: s.user, database: s.database.trim() };
    case "nebula":
      return { kind: s.kind, gateway: s.gateway.trim(), graphd: s.graphd.trim(), user: s.user, space: s.space.trim() };
    case "gremlin":
      return { kind: s.kind, url: s.url.trim(), user: s.user, traversal: s.traversal.trim() || "g" };
    case "hawdb":
      return { kind: s.kind, path: s.path.trim() };
  }
}

export function toForm(s: ConnectionSettings, password: string, loadDemo = false): ConnectionForm {
  return s.kind === "hawdb" ? { ...s, loadDemo } : { ...s, password };
}

/** Where the connection points, for a list: `localhost:7474/movies`, a folder's name. */
export function addressOf(s: ConnectionSettings): string {
  const host = (url: string) => url.replace(/^[a-z+]+:\/\//i, "").replace(/\/.*$/, "");
  switch (s.kind) {
    case "neo4j":
    case "memgraph":
      return s.database ? `${host(s.url)}/${s.database}` : host(s.url);
    case "gremlin":
      return host(s.url);
    case "nebula":
      return s.space ? `${s.graphd}/${s.space}` : s.graphd;
    case "hawdb":
      return s.path ? (s.path.split(/[\\/]/).filter(Boolean).pop() ?? s.path) : "In memory";
  }
}

export function newConnectionId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Petal 0.2 kept one connection per driver (and 0.1 a single Neo4j one): each becomes a saved connection. */
export function migrateRemembered(kept: unknown): SavedConnection[] {
  if (!kept || typeof kept !== "object") return [];
  const old = "url" in kept ? { neo4j: kept } : (kept as Record<string, unknown>);
  const out: SavedConnection[] = [];
  for (const kind of ["neo4j", "memgraph", "nebula", "gremlin", "hawdb"] as const) {
    const entry = old[kind];
    if (!entry || typeof entry !== "object") continue;
    const settings = tidy({ ...defaultSettings(kind), ...entry, kind } as ConnectionSettings);
    out.push({ id: newConnectionId() + kind, name: "", settings, lastUsed: old.last === kind ? 1 : 0 });
  }
  return out;
}
