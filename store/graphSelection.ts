/**
 * Multi-selection on top of nsh-graph. Newer nsh-graph controllers select several nodes (`selectedIds`,
 * `selectAll`, `fitSelection`, `selection().nodes`); the published one selects one node at a time. These helpers
 * use the multi-select API when the controller has it and fall back to the single selection otherwise.
 */
import type { GraphController, GraphNode, Selection } from "nsh-graph";

type MultiSelect = {
  selectedIds?: () => string[];
  selectAll?: () => void;
  fitSelection?: () => void;
};

const multi = (graph: GraphController) => graph as GraphController & MultiSelect;

/** The selected nodes of a selection: all of them when nsh-graph selects several, else the one. */
export function selectionNodes(sel: Selection): GraphNode[] {
  if (!sel || sel.kind !== "node") return [];
  return (sel as { nodes?: GraphNode[] }).nodes ?? [sel.node];
}

/** The ids of the selected nodes. */
export function selectedIds(graph: GraphController): string[] {
  const m = multi(graph);
  return m.selectedIds ? m.selectedIds() : selectionNodes(graph.selection()).map((n) => n.id);
}

/** Whether this nsh-graph can select every node at once. */
export function canSelectAll(graph: GraphController): boolean {
  return typeof multi(graph).selectAll === "function";
}

export function selectAll(graph: GraphController) {
  multi(graph).selectAll?.();
}

/** Fits the view to the selection: the selected nodes, or the selected node centered, or the whole scene. */
export function fitSelection(graph: GraphController) {
  const m = multi(graph);
  if (m.fitSelection) return m.fitSelection();
  const [node] = selectionNodes(graph.selection());
  if (node) graph.centerOn(node.id);
  else graph.fit();
}
