import { expect, test } from "nsh/test";
import { NOTEBOOK_FORMAT, notebookFile, parseNotebookFile } from "./notebookFile";

test("a notebook goes to a file and back, its cells in order, without results", () => {
  const cells = [
    { text: "MATCH (p:Person) RETURN p.name AS name", by: "you" as const, view: "table" as const },
    { text: "Company WORKS_AT Person", by: "assistant" as const, view: "graph" as const },
  ];
  const text = notebookFile(cells, "neo4j", "Cypher", 5);
  // One key per line, so a changed query is a one-line diff.
  expect(text.split("\n").filter((l) => l.includes('"text"')).length).toBe(2);
  const back = parseNotebookFile(text);
  expect(back).toEqual({ notebook: { format: NOTEBOOK_FORMAT, source: "neo4j", language: "Cypher", savedAt: 5, cells } });
});

test("other files are refused, and damaged cells are left out or mended", () => {
  expect(parseNotebookFile("MATCH (n) RETURN n")).toEqual({ error: "The file isn't a Petal notebook." });
  expect(parseNotebookFile(JSON.stringify({ format: "petal-scene/1", nodes: [], rels: [] }))).toEqual({ error: "The file isn't a Petal notebook." });
  expect(parseNotebookFile(JSON.stringify({ format: NOTEBOOK_FORMAT }))).toEqual({ error: "The notebook is damaged: it has no cells." });
  const parsed = parseNotebookFile(
    JSON.stringify({ format: NOTEBOOK_FORMAT, cells: [{ text: "  City  ", view: "chart", by: "robot" }, { text: "" }, { view: "table" }, 7] }),
  );
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.notebook.cells).toEqual([{ text: "City", by: "you", view: "graph" }]);
  expect(parsed.notebook.source).toBe("");
});
