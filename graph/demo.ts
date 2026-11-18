/**
 * The demo database: Petal's built-in graph, answered in memory with the same semantics as the Cypher
 * Petal sends to Neo4j, so everything but raw Cypher works without a server.
 */
import { demoGraph, type DemoNode } from "./demoData";
import { fromPlain, valueText, type DbNode, type DbRel, type GraphResult, type Value } from "./model";
import {
  SourceError,
  type Direction,
  type ExpandOptions,
  type GraphSource,
  type NeighborhoodEntry,
  type NodeStep,
  type Schema,
  type SearchSpec,
} from "./source";
import { orient } from "./cypher";

function demoValue(v: unknown): Value {
  if (v && typeof v === "object" && "$date" in (v as object)) return { type: "Text", kind: "Date", value: String((v as { $date: string }).$date) };
  return fromPlain(v);
}

function toNode(n: DemoNode): DbNode {
  const properties: Record<string, Value> = {};
  for (const [k, v] of Object.entries(n.props)) properties[k] = demoValue(v);
  return { id: n.id, labels: n.labels, properties };
}

export class DemoSource implements GraphSource {
  readonly kind = "demo" as const;
  readonly label = "Demo graph";
  readonly key = "demo";
  readonly language = null;
  private nodes = new Map<string, DbNode>();
  private rels: DbRel[] = [];
  private out = new Map<string, DbRel[]>();
  private in = new Map<string, DbRel[]>();
  private cachedSchema: Schema | undefined;

  constructor(private readonly latencyMs = 0) {
    const g = demoGraph();
    for (const n of g.nodes) this.nodes.set(n.id, toNode(n));
    g.rels.forEach((r, i) => {
      const properties: Record<string, Value> = {};
      for (const [k, v] of Object.entries(r.props ?? {})) properties[k] = demoValue(v);
      const rel: DbRel = { id: `r${i}`, type: r.type, start: r.from, end: r.to, properties };
      this.rels.push(rel);
      push(this.out, r.from, rel);
      push(this.in, r.to, rel);
    });
  }

  private async later<T>(value: T): Promise<T> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    return value;
  }

  async schema(): Promise<Schema> {
    if (!this.cachedSchema) {
      const labels = new Map<string, number>();
      const types = new Map<string, number>();
      const patterns = new Map<string, { from: string; type: string; to: string }>();
      for (const n of this.nodes.values()) for (const l of n.labels) labels.set(l, (labels.get(l) ?? 0) + 1);
      for (const r of this.rels) {
        types.set(r.type, (types.get(r.type) ?? 0) + 1);
        const from = this.nodes.get(r.start)!.labels[0];
        const to = this.nodes.get(r.end)!.labels[0];
        patterns.set(`${from}|${r.type}|${to}`, { from, type: r.type, to });
      }
      const sorted = (m: Map<string, number>) =>
        [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      this.cachedSchema = { labels: sorted(labels), relTypes: sorted(types), patterns: [...patterns.values()] };
    }
    return this.later(this.cachedSchema);
  }

  private matches(n: DbNode, step: NodeStep): boolean {
    if (step.label && !n.labels.includes(step.label)) return false;
    if (step.text && !containsText(n, step.text)) return false;
    return true;
  }

  async search(spec: SearchSpec, limit: number): Promise<GraphResult> {
    if (spec.kind === "raw") throw new SourceError("Queries need a database. Connect to Neo4j, NebulaGraph or HawDB to run one.", "NO_QUERY");
    if (spec.kind === "text") {
      const nodes = [...this.nodes.values()].filter((n) => containsText(n, spec.term)).slice(0, limit);
      return this.later({ nodes, rels: [], rows: nodes.length });
    }
    const schema = await this.schema();
    // Walk the pattern breadth-first, keeping whole paths, as `MATCH p = …` does.
    let paths: { nodes: DbNode[]; rels: DbRel[] }[] = [...this.nodes.values()]
      .filter((n) => this.matches(n, spec.nodes[0]))
      .map((n) => ({ nodes: [n], rels: [] }));
    for (let i = 1; i < spec.nodes.length; i++) {
      const type = spec.rels[i - 1]?.type;
      const direction = orient(schema, spec.nodes[i - 1].label, type, spec.nodes[i].label);
      const next: typeof paths = [];
      for (const p of paths) {
        const last = p.nodes[p.nodes.length - 1];
        for (const { rel, other } of this.around(last.id, direction, type)) {
          if (p.rels.includes(rel)) continue;
          const n = this.nodes.get(other)!;
          if (!this.matches(n, spec.nodes[i])) continue;
          next.push({ nodes: [...p.nodes, n], rels: [...p.rels, rel] });
          if (next.length >= limit * 4) break;
        }
      }
      paths = next;
    }
    paths = paths.slice(0, limit);
    const nodes = new Map<string, DbNode>();
    const rels = new Map<string, DbRel>();
    for (const p of paths) {
      for (const n of p.nodes) nodes.set(n.id, n);
      for (const r of p.rels) rels.set(r.id, r);
    }
    return this.later({ nodes: [...nodes.values()], rels: [...rels.values()], rows: paths.length });
  }

  private around(id: string, direction: Direction, type?: string): { rel: DbRel; other: string }[] {
    const out: { rel: DbRel; other: string }[] = [];
    if (direction !== "in") for (const r of this.out.get(id) ?? []) if (!type || r.type === type) out.push({ rel: r, other: r.end });
    if (direction !== "out") for (const r of this.in.get(id) ?? []) if ((!type || r.type === type) && r.start !== r.end) out.push({ rel: r, other: r.start });
    return out;
  }

  async expand(ids: string[], options: ExpandOptions): Promise<GraphResult> {
    const nodes = new Map<string, DbNode>();
    const rels = new Map<string, DbRel>();
    let rows = 0;
    outer: for (const id of ids) {
      const self = this.nodes.get(id);
      if (!self) continue;
      for (const { rel, other } of this.around(id, options.direction ?? "both", options.type)) {
        if (rows >= options.limit) break outer;
        rows++;
        nodes.set(id, self);
        nodes.set(other, this.nodes.get(other)!);
        rels.set(rel.id, rel);
      }
    }
    return this.later({ nodes: [...nodes.values()], rels: [...rels.values()], rows });
  }

  async relationshipsAmong(ids: string[]) {
    const set = new Set(ids);
    return this.later(this.rels.filter((r) => set.has(r.start) && set.has(r.end)));
  }

  async neighborhood(id: string): Promise<NeighborhoodEntry[]> {
    const counts = new Map<string, NeighborhoodEntry>();
    const add = (type: string, direction: "out" | "in") => {
      const key = `${type}|${direction}`;
      const e = counts.get(key) ?? { type, direction, count: 0 };
      e.count++;
      counts.set(key, e);
    };
    for (const r of this.out.get(id) ?? []) add(r.type, "out");
    for (const r of this.in.get(id) ?? []) if (r.start !== r.end) add(r.type, "in");
    return this.later([...counts.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)));
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function containsText(n: DbNode, term: string): boolean {
  const t = term.toLowerCase();
  return Object.values(n.properties).some((v) => v.type !== "Null" && valueText(v).toLowerCase().includes(t));
}
