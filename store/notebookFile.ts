/**
 * Notebook files (`petal-notebook/1`): a notebook's cells (each query or phrase, who wrote it, and the view
 * it showed) as JSON, in the order the notebook shows them, newest first. Results are not kept, so the file
 * stays small and readable in a diff: opened, the cells are not run until you run them, against whichever
 * database is connected.
 */
import type { FrameAuthor, FrameView } from "./notebook";

export const NOTEBOOK_FORMAT = "petal-notebook/1";

export interface NotebookCell {
  text: string;
  by: FrameAuthor;
  view: FrameView;
}

export interface NotebookFile {
  format: typeof NOTEBOOK_FORMAT;
  /** The kind of database the cells were written for (`neo4j`, `hawdb`, …). */
  source: string;
  /** The query language of that database (`Cypher`, `Gremlin`, …), or "" for search phrases only. */
  language: string;
  savedAt: number;
  cells: NotebookCell[];
}

const VIEWS: FrameView[] = ["graph", "table", "raw"];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The notebook as a file, one cell per line-block so that changes to it diff well. */
export function notebookFile(cells: NotebookCell[], source: string, language: string, savedAt = Date.now()): string {
  const file: NotebookFile = {
    format: NOTEBOOK_FORMAT,
    source,
    language,
    savedAt,
    cells: cells.map((c) => ({ text: c.text, by: c.by, view: c.view })),
  };
  return JSON.stringify(file, null, 2) + "\n";
}

/** Reads a notebook file back, checking its shape: the notebook, or a message saying what is wrong. */
export function parseNotebookFile(text: string): { notebook: NotebookFile } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "The file isn't a Petal notebook." };
  }
  if (!isObject(data) || data.format !== NOTEBOOK_FORMAT) return { error: "The file isn't a Petal notebook." };
  if (!Array.isArray(data.cells)) return { error: "The notebook is damaged: it has no cells." };
  const cells: NotebookCell[] = [];
  for (const c of data.cells) {
    if (!isObject(c) || typeof c.text !== "string" || !c.text.trim()) continue;
    cells.push({
      text: c.text.trim(),
      by: c.by === "assistant" ? "assistant" : "you",
      view: VIEWS.includes(c.view as FrameView) ? (c.view as FrameView) : "graph",
    });
  }
  return {
    notebook: {
      format: NOTEBOOK_FORMAT,
      source: typeof data.source === "string" ? data.source : "",
      language: typeof data.language === "string" ? data.language : "",
      savedAt: typeof data.savedAt === "number" ? data.savedAt : Date.now(),
      cells,
    },
  };
}
