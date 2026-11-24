import { expect, test } from "nsh/test";
import type { DbNode, DbRel } from "../graph/model";
import { createScene } from "./scene";
import { createSavedScenes, layoutOf, parseSceneFile, sceneFile, sceneFileName, SCENE_FORMAT } from "./savedScenes";
import { fileStamp, filesAvailable, safeFileName } from "./files";
import {
  csvField,
  filterNodeRows,
  filterRelRows,
  nodeRows,
  nodesCsv,
  nodesJson,
  relRows,
  relsCsv,
  sortRows,
  type TableLens,
} from "./sceneTable";

const node = (id: string, labels: string[], props: Record<string, string | number>): DbNode => ({
  id,
  labels,
  properties: Object.fromEntries(
    Object.entries(props).map(([k, v]) => [k, typeof v === "number" ? { type: "Integer" as const, value: String(v) } : { type: "String" as const, value: v }]),
  ),
});

const nodes = new Map<string, DbNode>([
  ["a", node("a", ["Person"], { name: "Ada", born: 1815 })],
  ["b", node("b", ["Person"], { name: "Bea, the second", city: 'Quote "town"' })],
  ["c", node("c", ["Company"], { name: "Acme" })],
]);
const rels = new Map<string, DbRel>([
  ["r1", { id: "r1", type: "WORKS_AT", start: "a", end: "c", properties: { since: { type: "Integer", value: "2020" } } }],
  ["r2", { id: "r2", type: "KNOWS", start: "a", end: "b", properties: {} }],
]);

const lens = (hidden: string[] = [], hiddenTypes: string[] = []): TableLens => ({
  categoryOf: (n) => n.labels[0],
  captionKey: () => undefined,
  categoryHidden: (c) => hidden.includes(c),
  typeHidden: (t) => hiddenTypes.includes(t),
});

test("the table has a row per node with its relationships in the scene, and per relationship", () => {
  const rows = nodeRows(nodes, rels, lens(["Company"]));
  expect(rows.map((r) => [r.caption, r.labels, r.degree, r.hidden])).toEqual([
    ["Ada", "Person", 2, false],
    ["Bea, the second", "Person", 1, false],
    ["Acme", "Company", 1, true],
  ]);
  const rr = relRows(nodes, rels, lens([], ["KNOWS"]));
  expect(rr.map((r) => [r.type, r.from, r.to, r.hidden])).toEqual([
    ["WORKS_AT", "Ada", "Acme", false],
    ["KNOWS", "Ada", "Bea, the second", true],
  ]);
  // A relationship to a node of a hidden category is hidden too.
  expect(relRows(nodes, rels, lens(["Company"]))[0].hidden).toBe(true);
});

test("the table filters by every word, in columns and properties, and sorts numbers as numbers", () => {
  const rows = nodeRows(nodes, rels, lens());
  expect(filterNodeRows(rows, nodes, "town").map((r) => r.id)).toEqual(["b"]);
  expect(filterNodeRows(rows, nodes, "person 1815").map((r) => r.id)).toEqual(["a"]);
  expect(filterNodeRows(rows, nodes, "  ").length).toBe(3);
  expect(filterRelRows(relRows(nodes, rels, lens()), rels, "2020").map((r) => r.id)).toEqual(["r1"]);

  expect(sortRows(rows, { key: "degree", direction: "descending" }).map((r) => r.id)).toEqual(["a", "b", "c"]);
  expect(sortRows(rows, { key: "caption", direction: "ascending" }).map((r) => r.caption)).toEqual(["Acme", "Ada", "Bea, the second"]);
  expect(sortRows([{ n: "item 10" }, { n: "item 9" }], { key: "n", direction: "ascending" }).map((r) => r.n)).toEqual(["item 9", "item 10"]);
  expect(sortRows(rows, null)).toBe(rows);
});

test("the table writes CSV with a column per property, quoted where it must be, and JSON", () => {
  expect(csvField("plain")).toBe("plain");
  expect(csvField("a,b")).toBe('"a,b"');
  expect(csvField('say "hi"')).toBe('"say ""hi"""');
  expect(csvField("two\nlines")).toBe('"two\nlines"');

  expect(nodesCsv([...nodes.values()])).toBe(
    'id,labels,born,city,name\r\na,Person,1815,,Ada\r\nb,Person,,"Quote ""town""","Bea, the second"\r\nc,Company,,,Acme\r\n',
  );
  expect(relsCsv([...rels.values()])).toBe("id,type,start,end,since\r\nr1,WORKS_AT,a,c,2020\r\nr2,KNOWS,a,b,\r\n");
  expect(JSON.parse(nodesJson([nodes.get("a")!]))).toEqual([{ id: "a", labels: ["Person"], properties: { name: "Ada", born: 1815 } }]);
  // An integer past 2^53 keeps its digits.
  const big = node("z", ["X"], {});
  big.properties.n = { type: "Integer", value: "9007199254740993" };
  expect(JSON.parse(nodesJson([big]))[0].properties.n).toBe("9007199254740993");
});

test("a scene goes to JSON and back with its layout, and other text is refused", () => {
  const layout = layoutOf(
    ["a", "b", "gone"],
    (id) => (id === "gone" ? undefined : { x: id === "a" ? 1.234 : -5, y: 10 }),
    (id) => id === "b",
  );
  expect(layout).toEqual({ a: [1.2, 10], b: [-5, 10, 1] });

  const text = sceneFile({ name: "Team", savedAt: 5, nodes: [...nodes.values()], rels: [...rels.values()], layout }, "neo4j");
  const back = parseSceneFile(text);
  if ("error" in back) throw new Error(back.error);
  expect(back.scene.format).toBe(SCENE_FORMAT);
  expect(back.scene.source).toBe("neo4j");
  expect(back.scene.nodes.length).toBe(3);
  expect(back.scene.rels.length).toBe(2);
  expect(back.scene.layout).toEqual(layout);

  expect("error" in parseSceneFile("MATCH (n) RETURN n")).toBe(true);
  expect("error" in parseSceneFile(JSON.stringify({ format: "other" }))).toBe(true);
  const damaged = parseSceneFile(JSON.stringify({ format: SCENE_FORMAT, nodes: [{ id: 1 }], rels: [] }));
  expect("error" in damaged && damaged.error).toMatch(/damaged/);
});

test("replacing the scene is one step to undo, and drops relationships whose ends are missing", () => {
  const scene = createScene();
  scene.add({ nodes: [nodes.get("a")!], rels: [] });
  scene.replace({ nodes: [nodes.get("b")!, nodes.get("c")!], rels: [...rels.values()] });
  expect([...scene.nodes().keys()]).toEqual(["b", "c"]);
  expect(scene.rels().size).toBe(0);
  expect(scene.undo()).toBe(true);
  expect([...scene.nodes().keys()]).toEqual(["a"]);
});

test("file names are made safe, and saved scenes' files differ when their names clean alike", () => {
  expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  expect(safeFileName("  trailing dots... ")).toBe("trailing dots");
  expect(safeFileName("///")).toBe("-");
  expect(safeFileName("")).toBe("untitled");
  expect(fileStamp(new Date(2026, 10, 3, 9, 5))).toBe("2026-11-03 09-05");
  expect(sceneFileName("a/b")).toMatch(/^a-b-[0-9a-z]+\.json$/);
  expect(sceneFileName("a/b") === sceneFileName("a:b")).toBe(false);
});

for (const files of [false, true]) {
  (files && !filesAvailable() ? test.skip : test)(`saved scenes are kept per database and replaced by name (${files ? "files" : "Storage"})`, async () => {
    const scenes = createSavedScenes({ files });
    const key = `test-${files}-${Date.now()}`;
    await scenes.load(key);
    expect(scenes.list()).toEqual([]);
    const one = { name: "One", savedAt: 1, nodes: [nodes.get("a")!], rels: [], layout: { a: [0, 0] as [number, number] } };
    expect(await scenes.save(one, "demo")).toBe(null);
    expect(await scenes.save({ ...one, name: "Two", savedAt: 2 }, "demo")).toBe(null);
    expect(await scenes.save({ ...one, savedAt: 3, nodes: [...nodes.values()] }, "demo")).toBe(null);
    expect(scenes.list().map((s) => [s.name, s.nodes.length])).toEqual([["One", 3], ["Two", 1]]);

    const again = createSavedScenes({ files });
    await again.load(key);
    expect(again.list().map((s) => s.name)).toEqual(["One", "Two"]);
    await again.load("another database");
    expect(again.list()).toEqual([]);

    await scenes.remove("One");
    await scenes.remove("Two");
    await again.load(key);
    expect(again.list()).toEqual([]);
  });
}
