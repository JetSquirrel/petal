import { expect, test } from "nsh/test";
import { completionsAt, lineStarts, positionOf, tokenizeQuery } from "./queryLang";
import type { Schema } from "./source";

const schema: Schema = {
  labels: [{ name: "Person", count: 3 }, { name: "Company" }, { name: "Open Source" }],
  relTypes: [{ name: "WORKS_AT" }, { name: "KNOWS" }],
  patterns: [],
};

const words = (text: string, language: Parameters<typeof tokenizeQuery>[1]) =>
  tokenizeQuery(text, language, schema).map((t) => [text.slice(t.start, t.end), t.kind]);

test("colors Cypher keywords in any case, labels, properties, functions, strings and numbers", () => {
  expect(words(`match (p:Person {name: 'Ana'})-[:WORKS_AT]->(c) WHERE p.age > 30 RETURN count(*) // done`, "Cypher")).toEqual([
    ["match", "keyword"],
    ["Person", "label"],
    ["name", "property"],
    ["'Ana'", "string"],
    ["WORKS_AT", "label"],
    ["WHERE", "keyword"],
    ["age", "property"],
    ["30", "number"],
    ["RETURN", "keyword"],
    ["count", "function"],
    ["// done", "comment"],
  ]);
});

test("a misspelled keyword stays plain; parameters and ranges", () => {
  expect(words("MATHC (n) RETURN n LIMIT $limit", "Cypher")).toEqual([
    ["RETURN", "keyword"],
    ["LIMIT", "keyword"],
    ["$limit", "parameter"],
  ]);
  expect(words("MATCH (a)-[*1..3]-(b)", "Cypher")).toEqual([
    ["MATCH", "keyword"],
    ["1", "number"],
    ["3", "number"],
  ]);
});

test("colors Gremlin steps and globals, and search phrases by the schema", () => {
  expect(words(`g.V().hasLabel("Person").out('KNOWS').limit(5)`, "Gremlin")).toEqual([
    ["g", "keyword"],
    ["V", "function"],
    ["hasLabel", "function"],
    [`"Person"`, "string"],
    ["out", "function"],
    ["'KNOWS'", "string"],
    ["limit", "function"],
    ["5", "number"],
  ]);
  expect(words(`person works_at Company "Ana B"`, null)).toEqual([
    ["person", "label"],
    ["works_at", "label"],
    ["Company", "label"],
    [`"Ana B"`, "string"],
  ]);
});

const ctx = { language: "Cypher" as const, schema, propertyKeys: ["age", "name"] };
const labelsOf = (text: string, c: Parameters<typeof completionsAt>[3] = ctx) => {
  const offset = text.length;
  let start = offset;
  while (start > 0 && /\w/.test(text[start - 1])) start--;
  return completionsAt(text, offset, start, c).map((i) => i.insertText ?? i.label);
};

test("completes labels in a node, types in a relationship, properties after a dot", () => {
  expect(labelsOf("MATCH (p:")).toEqual(["Person", "Company", "`Open Source`"]);
  expect(labelsOf("MATCH (p)-[:")).toEqual(["WORKS_AT", "KNOWS"]);
  expect(labelsOf("MATCH (p) RETURN p.")).toEqual(["age", "name"]);
  expect(labelsOf("MATCH (p) WHERE p.name = 'ab")).toEqual([]);
});

test("completes keywords and functions in Cypher, steps in Gremlin, names in phrases", () => {
  const items = labelsOf("MAT");
  expect(items.includes("MATCH")).toBe(true);
  expect(items.includes("count(")).toBe(true);
  expect(labelsOf("g.V().", { ...ctx, language: "Gremlin" }).includes("hasLabel(")).toBe(true);
  expect(labelsOf("Per", { ...ctx, language: null })).toEqual(["Person", "Company", "Open Source", "WORKS_AT", "KNOWS"]);
});

test("maps offsets to lines and columns", () => {
  const starts = lineStarts("ab\ncd\n\nef");
  expect(positionOf(starts, 0)).toEqual({ line: 0, column: 0 });
  expect(positionOf(starts, 4)).toEqual({ line: 1, column: 1 });
  expect(positionOf(starts, 6)).toEqual({ line: 2, column: 0 });
  expect(positionOf(starts, 8)).toEqual({ line: 3, column: 1 });
});
