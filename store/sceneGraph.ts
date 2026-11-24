/**
 * What the canvas draws: the scene's nodes and relationships through the perspective (category colors,
 * captions, sizes, hidden categories and types). nsh-graph diffs it by id, so positions survive.
 */
import type { GraphData, GraphEdge, GraphNode } from "nsh-graph";
import { nodeCaption, type DbNode, type DbRel } from "../graph/model";
import { paletteColor, SIZE_RADIUS, type PerspectiveStore } from "./perspective";

export function sceneGraphData(
  nodes: Map<string, DbNode>,
  rels: Map<string, DbRel>,
  perspective: PerspectiveStore,
  scheme: "light" | "dark",
  /** Where nodes start: an opened saved scene's layout. */
  places?: Record<string, [number, number] | [number, number, 1]> | null,
): GraphData<DbNode, DbRel> {
  const hiddenTypes = new Set(perspective.state().hiddenTypes);
  const shown = new Set<string>();
  const outNodes: GraphNode<DbNode>[] = [];
  for (const n of nodes.values()) {
    const category = perspective.categoryOf(n);
    const style = perspective.style(category);
    if (style.hidden) continue;
    shown.add(n.id);
    const place = places?.[n.id];
    outNodes.push({
      ...(place ? { x: place[0], y: place[1] } : {}),
      id: n.id,
      caption: nodeCaption(n, style.caption),
      category,
      color: paletteColor(style.color, scheme),
      size: style.size === "auto" ? undefined : SIZE_RADIUS[style.size],
      data: n,
    });
  }
  const outEdges: GraphEdge<DbRel>[] = [];
  for (const r of rels.values()) {
    if (hiddenTypes.has(r.type) || !shown.has(r.start) || !shown.has(r.end)) continue;
    outEdges.push({ id: r.id, from: r.start, to: r.end, caption: r.type, data: r });
  }
  return { nodes: outNodes, edges: outEdges };
}

/** How many nodes of each category, and relationships of each type, the scene holds (shown or hidden). */
export function sceneCounts(nodes: Map<string, DbNode>, rels: Map<string, DbRel>, perspective: PerspectiveStore) {
  const categories = new Map<string, number>();
  const types = new Map<string, number>();
  for (const n of nodes.values()) {
    const c = perspective.categoryOf(n);
    categories.set(c, (categories.get(c) ?? 0) + 1);
  }
  for (const r of rels.values()) types.set(r.type, (types.get(r.type) ?? 0) + 1);
  return { categories, types };
}
