/**
 * Where a scene's data comes from: a Neo4j database over HTTP, or Petal's built-in demo graph. Both answer
 * the same questions, so the rest of the app never writes Cypher of its own.
 */
import type { DbRel, GraphResult } from "./model";

export interface LabelInfo {
  name: string;
  /** Nodes with the label, when the database tells cheaply. */
  count?: number;
}

export interface RelTypeInfo {
  name: string;
  count?: number;
}

/** A relationship type between two labels, as the database's schema has it: what search suggests. */
export interface SchemaPattern {
  from: string;
  type: string;
  to: string;
}

export interface Schema {
  labels: LabelInfo[];
  relTypes: RelTypeInfo[];
  patterns: SchemaPattern[];
}

export const EMPTY_SCHEMA: Schema = { labels: [], relTypes: [], patterns: [] };

/** One node of a search pattern: a label, words a property of it contains, both or neither. */
export interface NodeStep {
  label?: string;
  text?: string;
}

/** A search: nodes and relationships alternate; `rels[i]` links `nodes[i]` to `nodes[i + 1]`. */
export type SearchSpec =
  | { kind: "pattern"; nodes: NodeStep[]; rels: { type?: string }[] }
  | { kind: "text"; term: string }
  | { kind: "raw"; statement: string };

export type Direction = "out" | "in" | "both";

export interface ExpandOptions {
  type?: string;
  direction?: Direction;
  /** Only neighbors with this label (NebulaGraph's tag). */
  label?: string;
  /** Only neighbors with a property containing these words, ignoring case. */
  text?: string;
  limit: number;
}

/** How many relationships of each type and direction a node has: the inspector's expand menu. */
export interface NeighborhoodEntry {
  type: string;
  direction: "out" | "in";
  count: number;
}

export type SourceKind = "neo4j" | "memgraph" | "puppygraph" | "tigergraph" | "neptune" | "nebula" | "gremlin" | "hawdb" | "demo";

/** The query language a source runs as written (`{ kind: "raw" }`); null when it runs none. */
export type QueryLanguage = "Cypher" | "nGQL" | "Gremlin" | null;

export interface GraphSource {
  readonly kind: SourceKind;
  /** Where it is, for the connection button: `localhost:7474/neo4j`. */
  readonly label: string;
  /** A key for what Petal remembers per database (its perspective). */
  readonly key: string;
  readonly language: QueryLanguage;
  schema(): Promise<Schema>;
  search(spec: SearchSpec, limit: number): Promise<GraphResult>;
  expand(ids: string[], options: ExpandOptions): Promise<GraphResult>;
  /** The relationships whose two ends are both among `ids`. */
  relationshipsAmong(ids: string[]): Promise<DbRel[]>;
  neighborhood(id: string): Promise<NeighborhoodEntry[]>;
  /** Lets go of what the source holds (an embedded database's folder) once Petal moves to another. */
  close?(): void;
}

/** Thrown with a message meant for the person, not a stack. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof SourceError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
