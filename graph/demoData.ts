/**
 * The demo graph: a fictional open-source ecosystem of people, companies, projects, languages and cities.
 * Every name in it is invented.
 */

export interface DemoNode {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
}

export interface DemoRel {
  type: string;
  from: string;
  to: string;
  props?: Record<string, unknown>;
}

const cities: [string, string, number][] = [
  ["Lisbon", "Portugal", 545_000],
  ["Montréal", "Canada", 1_762_000],
  ["Osaka", "Japan", 2_752_000],
  ["Nairobi", "Kenya", 4_397_000],
  ["Kraków", "Poland", 804_000],
  ["Austin", "United States", 974_000],
  ["Tallinn", "Estonia", 454_000],
  ["Bengaluru", "India", 8_443_000],
];

const languages: [string, string, number][] = [
  ["Rust", "systems", 2015],
  ["TypeScript", "multi-paradigm", 2012],
  ["Go", "concurrent", 2012],
  ["Python", "multi-paradigm", 1991],
  ["Zig", "systems", 2016],
  ["Elixir", "functional", 2012],
  ["Kotlin", "multi-paradigm", 2016],
];

// name, founded, employees, industry, city
const companies: [string, number, number, string, string][] = [
  ["Brightloom", 2014, 420, "Developer tools", "Lisbon"],
  ["Northwind Labs", 2009, 1800, "Cloud infrastructure", "Austin"],
  ["Kestrel Systems", 2017, 260, "Databases", "Tallinn"],
  ["Ferrocene Works", 2019, 95, "Embedded", "Kraków"],
  ["Halcyon Data", 2012, 640, "Analytics", "Montréal"],
  ["Tidepool", 2020, 48, "Developer tools", "Osaka"],
  ["Savanna Cloud", 2016, 310, "Cloud infrastructure", "Nairobi"],
  ["Indigo Mesh", 2018, 150, "Networking", "Bengaluru"],
  ["Quarry & Co", 2005, 2400, "Consulting", "Austin"],
];

// name, stars, license, first release, languages
const projects: [string, number, string, string, string[]][] = [
  ["Lattice", 48_200, "Apache-2.0", "2016-03-14", ["Rust"]],
  ["Driftwood", 12_900, "MIT", "2018-07-02", ["TypeScript"]],
  ["Ember Queue", 8_400, "Apache-2.0", "2015-11-20", ["Go"]],
  ["Pollen", 21_700, "BSD-3-Clause", "2013-05-09", ["Python"]],
  ["Sparrow DB", 31_500, "Apache-2.0", "2017-09-30", ["Rust", "Go"]],
  ["Vellum", 5_600, "MIT", "2020-01-17", ["TypeScript"]],
  ["Tarn", 3_100, "MPL-2.0", "2021-04-22", ["Zig"]],
  ["Murmur", 9_800, "Apache-2.0", "2016-10-05", ["Elixir"]],
  ["Ridgeline", 14_300, "MIT", "2019-06-11", ["Kotlin"]],
  ["Copperleaf", 2_200, "MIT", "2022-02-28", ["Rust"]],
  ["Anvil CI", 17_600, "Apache-2.0", "2014-08-19", ["Go", "TypeScript"]],
  ["Heron", 6_900, "BSD-2-Clause", "2018-12-03", ["Python"]],
  ["Glasswing", 25_100, "MIT", "2017-03-27", ["TypeScript"]],
  ["Orchard", 4_700, "Apache-2.0", "2020-09-14", ["Go"]],
  ["Saltmarsh", 1_300, "GPL-3.0", "2023-05-01", ["Zig", "Rust"]],
  ["Quill", 11_200, "MIT", "2015-02-12", ["Python", "Rust"]],
];

const dependsOn: [string, string][] = [
  ["Sparrow DB", "Lattice"],
  ["Copperleaf", "Lattice"],
  ["Saltmarsh", "Lattice"],
  ["Saltmarsh", "Tarn"],
  ["Vellum", "Driftwood"],
  ["Glasswing", "Driftwood"],
  ["Anvil CI", "Ember Queue"],
  ["Anvil CI", "Glasswing"],
  ["Orchard", "Ember Queue"],
  ["Orchard", "Sparrow DB"],
  ["Heron", "Pollen"],
  ["Quill", "Pollen"],
  ["Quill", "Lattice"],
  ["Murmur", "Ember Queue"],
  ["Ridgeline", "Sparrow DB"],
];

// name, role, city, company, since, handle
const people: [string, string, string, string, number, string][] = [
  ["Inês Carvalho", "Staff engineer", "Lisbon", "Brightloom", 2016, "inesc"],
  ["Tomás Rocha", "Engineering manager", "Lisbon", "Brightloom", 2015, "trocha"],
  ["Amara Okafor", "Principal engineer", "Nairobi", "Savanna Cloud", 2017, "amarao"],
  ["Wanjiru Kamau", "SRE", "Nairobi", "Savanna Cloud", 2019, "wkamau"],
  ["Hiroshi Tanabe", "Founder", "Osaka", "Tidepool", 2020, "htanabe"],
  ["Yui Morimoto", "Developer advocate", "Osaka", "Tidepool", 2021, "yuim"],
  ["Élodie Gagnon", "Data scientist", "Montréal", "Halcyon Data", 2013, "egagnon"],
  ["Marc-André Roy", "CTO", "Montréal", "Halcyon Data", 2012, "maroy"],
  ["Zofia Wiśniewska", "Firmware engineer", "Kraków", "Ferrocene Works", 2019, "zofiaw"],
  ["Piotr Zieliński", "Founder", "Kraków", "Ferrocene Works", 2019, "pziel"],
  ["Kaisa Tamm", "Database engineer", "Tallinn", "Kestrel Systems", 2017, "ktamm"],
  ["Rasmus Kask", "Staff engineer", "Tallinn", "Kestrel Systems", 2018, "rkask"],
  ["Priya Raman", "Network engineer", "Bengaluru", "Indigo Mesh", 2018, "praman"],
  ["Arjun Mehta", "Founder", "Bengaluru", "Indigo Mesh", 2018, "amehta"],
  ["Dana Whitfield", "VP Engineering", "Austin", "Northwind Labs", 2011, "dwhit"],
  ["Luis Ortega", "Platform engineer", "Austin", "Northwind Labs", 2014, "lortega"],
  ["Grace Holloway", "Consultant", "Austin", "Quarry & Co", 2008, "ghollo"],
  ["Ben Achterberg", "Consultant", "Austin", "Quarry & Co", 2016, "bachter"],
  ["Sofia Lindqvist", "Compiler engineer", "Tallinn", "Kestrel Systems", 2020, "slind"],
  ["Mateus Pires", "Frontend engineer", "Lisbon", "Brightloom", 2019, "mpires"],
  ["Nkechi Eze", "Product engineer", "Nairobi", "Savanna Cloud", 2020, "nkeze"],
  ["Kenji Arai", "Systems engineer", "Osaka", "Northwind Labs", 2016, "karai"],
  ["Chloé Lefebvre", "ML engineer", "Montréal", "Halcyon Data", 2018, "clefeb"],
  ["Jakub Nowak", "Embedded engineer", "Kraków", "Ferrocene Works", 2021, "jnowak"],
  ["Ananya Iyer", "Backend engineer", "Bengaluru", "Northwind Labs", 2017, "aiyer"],
  ["Oskar Lepp", "Security engineer", "Tallinn", "Indigo Mesh", 2022, "olepp"],
  ["Rosa Delgado", "Engineering manager", "Austin", "Northwind Labs", 2013, "rdelgado"],
  ["Felipe Moura", "Independent maintainer", "Lisbon", "", 0, "fmoura"],
  ["Ayesha Siddiqui", "Independent maintainer", "Bengaluru", "", 0, "ayeshas"],
  ["Mika Halonen", "Independent maintainer", "Tallinn", "", 0, "mhalonen"],
];

const maintains: [string, string][] = [
  ["Inês Carvalho", "Driftwood"],
  ["Mateus Pires", "Vellum"],
  ["Amara Okafor", "Ember Queue"],
  ["Hiroshi Tanabe", "Tarn"],
  ["Élodie Gagnon", "Pollen"],
  ["Chloé Lefebvre", "Heron"],
  ["Zofia Wiśniewska", "Copperleaf"],
  ["Kaisa Tamm", "Sparrow DB"],
  ["Rasmus Kask", "Lattice"],
  ["Priya Raman", "Orchard"],
  ["Luis Ortega", "Anvil CI"],
  ["Kenji Arai", "Glasswing"],
  ["Nkechi Eze", "Murmur"],
  ["Ananya Iyer", "Ridgeline"],
  ["Felipe Moura", "Lattice"],
  ["Ayesha Siddiqui", "Quill"],
  ["Mika Halonen", "Saltmarsh"],
  ["Sofia Lindqvist", "Tarn"],
];

const sponsors: [string, string, number][] = [
  ["Brightloom", "Driftwood", 2017],
  ["Brightloom", "Lattice", 2019],
  ["Northwind Labs", "Anvil CI", 2015],
  ["Northwind Labs", "Glasswing", 2018],
  ["Northwind Labs", "Lattice", 2020],
  ["Kestrel Systems", "Sparrow DB", 2017],
  ["Ferrocene Works", "Copperleaf", 2022],
  ["Halcyon Data", "Pollen", 2014],
  ["Halcyon Data", "Heron", 2019],
  ["Tidepool", "Tarn", 2021],
  ["Savanna Cloud", "Ember Queue", 2017],
  ["Savanna Cloud", "Murmur", 2018],
  ["Indigo Mesh", "Orchard", 2020],
  ["Quarry & Co", "Ridgeline", 2019],
];

const acquired: [string, string, number][] = [
  ["Northwind Labs", "Tidepool", 2024],
  ["Quarry & Co", "Indigo Mesh", 2025],
];

/** A small deterministic generator, so the demo graph is the same on every launch. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const slug = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

export function demoGraph(): { nodes: DemoNode[]; rels: DemoRel[] } {
  const nodes: DemoNode[] = [];
  const rels: DemoRel[] = [];
  const id = (label: string, name: string) => `${label.toLowerCase()}:${slug(name)}`;

  for (const [name, country, population] of cities) nodes.push({ id: id("City", name), labels: ["City"], props: { name, country, population } });
  for (const [name, paradigm, year] of languages) nodes.push({ id: id("Language", name), labels: ["Language"], props: { name, paradigm, firstAppeared: year } });
  for (const [name, founded, employees, industry, city] of companies) {
    nodes.push({ id: id("Company", name), labels: ["Company"], props: { name, founded, employees, industry } });
    rels.push({ type: "HEADQUARTERED_IN", from: id("Company", name), to: id("City", city) });
  }
  for (const [name, stars, license, firstRelease, langs] of projects) {
    nodes.push({
      id: id("Project", name),
      labels: ["Project"],
      props: { name, stars, license, firstRelease: { $date: firstRelease }, topics: topicsFor(name) },
    });
    for (const l of langs) rels.push({ type: "WRITTEN_IN", from: id("Project", name), to: id("Language", l) });
  }
  for (const [a, b] of dependsOn) rels.push({ type: "DEPENDS_ON", from: id("Project", a), to: id("Project", b) });
  for (const [name, role, city, company, since, handle] of people) {
    const labels = company ? ["Person"] : ["Person", "Maintainer"];
    nodes.push({ id: id("Person", name), labels, props: { name, role, handle, ...(company ? {} : { independent: true }) } });
    rels.push({ type: "LIVES_IN", from: id("Person", name), to: id("City", city) });
    if (company) rels.push({ type: "WORKS_AT", from: id("Person", name), to: id("Company", company), props: { since, title: role } });
  }
  for (const [p, proj] of maintains) rels.push({ type: "MAINTAINS", from: id("Person", p), to: id("Project", proj) });
  for (const [c, proj, since] of sponsors) rels.push({ type: "SPONSORS", from: id("Company", c), to: id("Project", proj), props: { since } });
  for (const [a, b, year] of acquired) rels.push({ type: "ACQUIRED", from: id("Company", a), to: id("Company", b), props: { year } });

  // Contributions and acquaintances: generated, but fixed by the seed.
  const random = rng(7);
  const maintained = new Set(maintains.map(([p, proj]) => `${p}|${proj}`));
  for (const [name] of people) {
    const count = 1 + Math.floor(random() * 3);
    const picked = new Set<string>();
    for (let i = 0; i < count; i++) {
      const proj = projects[Math.floor(random() * projects.length)][0];
      if (picked.has(proj) || maintained.has(`${name}|${proj}`)) continue;
      picked.add(proj);
      rels.push({ type: "CONTRIBUTES_TO", from: id("Person", name), to: id("Project", proj), props: { commits: 5 + Math.floor(random() * 900) } });
    }
  }
  const knows = new Set<string>();
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const sameCompany = people[i][3] && people[i][3] === people[j][3];
      const sameCity = people[i][2] === people[j][2];
      const p = sameCompany ? 0.55 : sameCity ? 0.3 : 0.035;
      if (random() < p) {
        const key = `${i}|${j}`;
        if (knows.has(key)) continue;
        knows.add(key);
        rels.push({ type: "KNOWS", from: id("Person", people[i][0]), to: id("Person", people[j][0]) });
      }
    }
  }
  return { nodes, rels };
}

function topicsFor(name: string): string[] {
  const t: Record<string, string[]> = {
    Lattice: ["async", "runtime"],
    Driftwood: ["ui", "components"],
    "Ember Queue": ["messaging", "streams"],
    Pollen: ["data", "notebooks"],
    "Sparrow DB": ["database", "storage"],
    Vellum: ["editor", "ui"],
    Tarn: ["build", "compiler"],
    Murmur: ["realtime", "pubsub"],
    Ridgeline: ["mobile", "sync"],
    Copperleaf: ["embedded", "drivers"],
    "Anvil CI": ["ci", "automation"],
    Heron: ["ml", "pipelines"],
    Glasswing: ["web", "framework"],
    Orchard: ["scheduling", "workflows"],
    Saltmarsh: ["allocator", "systems"],
    Quill: ["parsing", "text"],
  };
  return t[name] ?? [];
}
