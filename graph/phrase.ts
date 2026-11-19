/**
 * Search phrases: what the person types in the search field, read against the database's schema.
 *
 *   Person                          every Person
 *   Person Inês                     People with a property containing "Inês"
 *   Person WORKS_AT Company         People and the companies they work at
 *   Project DEPENDS_ON              projects and what they depend on
 *   "Sparrow DB"                    anything with a property containing the words
 *   MATCH (n) RETURN n LIMIT 5      Cypher, run as it is
 *
 * Words matching a label or relationship type (in any case) are pattern steps; other words are text that
 * the node before them must contain. Quotes keep words together.
 */
import { looksLikeCypher, orient } from "./cypher";
import { looksLikeGremlin } from "./gremlin";
import { looksLikeNgql } from "./nebula";
import type { NodeStep, QueryLanguage, Schema, SearchSpec } from "./source";

/** Whether text reads as a statement of the language (Cypher when the source runs none, to say it can't). */
export function looksLikeQuery(text: string, language: QueryLanguage): boolean {
  if (language === "nGQL") return looksLikeNgql(text);
  if (language === "Gremlin") return looksLikeGremlin(text);
  return looksLikeCypher(text);
}

export interface Suggestion {
  /** Stable within one list: the row's key and test id. */
  id: string;
  kind: "pattern" | "label" | "text" | "raw" | "recent";
  /** The phrase the field shows once it is chosen. */
  phrase: string;
  spec: SearchSpec;
  /** The parts of the line, labels and types told apart from the words. */
  parts: SuggestionPart[];
}

export interface SuggestionPart {
  text: string;
  role: "label" | "type" | "text" | "arrow" | "hint";
}

/** Splits on spaces, keeping "quoted words" as one token. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"?|'([^']*)'?|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const t = m[1] ?? m[2] ?? m[3];
    if (t !== undefined && t !== "") out.push(t);
  }
  return out;
}

function finder(names: string[]) {
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  return (token: string) => byLower.get(token.toLowerCase());
}

/** The phrase read as a search, or null when there is nothing to search for. */
export function parsePhrase(input: string, schema: Schema, language: QueryLanguage = "Cypher"): SearchSpec | null {
  const text = input.trim();
  if (!text) return null;
  if (looksLikeQuery(text, language)) return { kind: "raw", statement: text };
  const label = finder(schema.labels.map((l) => l.name));
  const type = finder(schema.relTypes.map((t) => t.name));
  const nodes: NodeStep[] = [];
  const rels: { type?: string }[] = [];
  let last: "node" | "rel" | null = null;
  let loose: string[] = [];
  for (const token of tokenize(text)) {
    const l = label(token);
    const t = l ? undefined : type(token);
    if (l) {
      if (last === "node") rels.push({});
      nodes.push({ label: l });
      last = "node";
    } else if (t) {
      if (last !== "node") nodes.push({});
      rels.push({ type: t });
      last = "rel";
    } else if (last === "node") {
      const n = nodes[nodes.length - 1];
      n.text = n.text ? `${n.text} ${token}` : token;
    } else if (last === "rel") {
      nodes.push({ text: token });
      last = "node";
    } else {
      loose.push(token);
    }
  }
  if (nodes.length === 0) return loose.length ? { kind: "text", term: loose.join(" ") } : null;
  if (loose.length) nodes[0].text = [loose.join(" "), nodes[0].text].filter(Boolean).join(" ");
  if (last === "rel") nodes.push({});
  return { kind: "pattern", nodes, rels };
}

/** The phrase that reads back as `spec`. */
export function phraseOf(spec: SearchSpec): string {
  if (spec.kind === "raw") return spec.statement;
  if (spec.kind === "text") return quote(spec.term);
  const words: string[] = [];
  spec.nodes.forEach((n, i) => {
    if (n.label) words.push(n.label);
    if (n.text) words.push(quote(n.text));
    if (i < spec.rels.length && spec.rels[i].type) words.push(spec.rels[i].type!);
  });
  return words.join(" ");
}

const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

/** The parts that describe `spec` in a suggestion row. */
export function describe(spec: SearchSpec, schema: Schema, language: QueryLanguage = "Cypher"): SuggestionPart[] {
  if (spec.kind === "raw") return [{ text: `Run ${language ?? "Cypher"}`, role: "hint" }, { text: spec.statement.length > 60 ? spec.statement.slice(0, 59) + "…" : spec.statement, role: "type" }];
  if (spec.kind === "text") return [{ text: "Any node containing", role: "hint" }, { text: `“${spec.term}”`, role: "text" }];
  const parts: SuggestionPart[] = [];
  spec.nodes.forEach((n, i) => {
    if (n.label) parts.push({ text: n.label, role: "label" });
    else if (!n.text) parts.push({ text: "any node", role: "hint" });
    if (n.text) parts.push({ text: n.label ? `“${n.text}”` : `any node with “${n.text}”`, role: "text" });
    if (i < spec.nodes.length - 1) {
      const t = spec.rels[i]?.type;
      const d = orient(schema, n.label, t, spec.nodes[i + 1].label);
      parts.push({ text: d === "in" ? "←" : d === "out" ? "→" : "—", role: "arrow" });
      parts.push({ text: t ?? "any relationship", role: t ? "type" : "hint" });
      parts.push({ text: d === "in" ? "—" : d === "out" ? "→" : "—", role: "arrow" });
    }
  });
  return parts;
}

const MAX = 8;

/**
 * What the dropdown offers for `input`: the phrase as typed, completions of its last word, the schema's
 * patterns that continue it, and a plain text search; with an empty field, recent searches and the
 * biggest labels.
 */
export function suggest(input: string, schema: Schema, recent: string[], language: QueryLanguage): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (kind: Suggestion["kind"], phrase: string, spec: SearchSpec | null) => {
    if (!spec || out.length >= MAX) return;
    const key = phraseOf(spec).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: `${kind}-${out.length}`, kind, phrase, spec, parts: describe(spec, schema, language) });
  };

  const text = input.trim();
  if (!text) {
    for (const r of recent.slice(0, 4)) add("recent", r, parsePhrase(r, schema, language));
    for (const l of schema.labels.slice(0, 4)) add("label", l.name, parsePhrase(l.name, schema, language));
    for (const p of schema.patterns.slice(0, 2)) {
      const phrase = `${p.from} ${p.type} ${p.to}`;
      add("pattern", phrase, parsePhrase(phrase, schema, language));
    }
    return out;
  }

  if (looksLikeQuery(text, language)) {
    if (language) add("raw", text, { kind: "raw", statement: text });
    return out;
  }

  const tokens = tokenize(text);
  const endsWithSpace = /\s$/.test(input);
  const head = endsWithSpace ? tokens : tokens.slice(0, -1);
  const lastWord = endsWithSpace ? "" : tokens[tokens.length - 1] ?? "";
  const prefix = head.map(quote).join(" ");
  const join = (w: string) => (prefix ? `${prefix} ${w}` : w);
  const exact = parsePhrase(text, schema, language);

  // The phrase as typed, when its last word is a whole label or type (or plain text).
  const exactIsComplete =
    !lastWord ||
    schema.labels.some((l) => l.name.toLowerCase() === lastWord.toLowerCase()) ||
    schema.relTypes.some((t) => t.name.toLowerCase() === lastWord.toLowerCase());
  if (exactIsComplete && exact?.kind === "pattern") add("pattern", text, exact);

  // Completions of the last word.
  if (lastWord) {
    const lw = lastWord.toLowerCase();
    const starts = (n: string) => n.toLowerCase().startsWith(lw);
    const within = (n: string) => !starts(n) && n.toLowerCase().includes(lw) && lw.length >= 2;
    const labels = schema.labels.map((l) => l.name);
    const types = schema.relTypes.map((t) => t.name);
    for (const name of [...labels.filter(starts), ...types.filter(starts), ...labels.filter(within), ...types.filter(within)]) {
      const phrase = join(name);
      add("label", phrase, parsePhrase(phrase, schema, language));
    }
  }

  // Patterns from the schema that continue the phrase.
  if (exact?.kind === "pattern") {
    const lastNode = exact.nodes[exact.nodes.length - 1];
    const lastRel = exact.rels[exact.rels.length - 1];
    const tailIsBareNode = !lastNode.label && !lastNode.text && lastRel?.type;
    for (const p of schema.patterns) {
      if (out.length >= MAX) break;
      if (tailIsBareNode) {
        const prev = exact.nodes[exact.nodes.length - 2];
        if (p.type === lastRel!.type && (!prev.label || p.from === prev.label || p.to === prev.label)) {
          const other = !prev.label || p.from === prev.label ? p.to : p.from;
          add("pattern", `${text} ${other}`, parsePhrase(`${text} ${other}`, schema, language));
        }
      } else if (lastNode.label && exactIsComplete) {
        if (p.from === lastNode.label) add("pattern", `${text} ${p.type} ${p.to}`, parsePhrase(`${text} ${p.type} ${p.to}`, schema, language));
        else if (p.to === lastNode.label) add("pattern", `${text} ${p.type} ${p.from}`, parsePhrase(`${text} ${p.type} ${p.from}`, schema, language));
      }
    }
  }

  // The phrase as typed (a label with words after it, say), then a search of every property.
  if (exact) add(exact.kind === "text" ? "text" : "pattern", text, exact);
  const isName = (t: string) =>
    schema.labels.some((l) => l.name.toLowerCase() === t.toLowerCase()) ||
    schema.relTypes.some((r) => r.name.toLowerCase() === t.toLowerCase());
  if (exact?.kind !== "text" && tokens.some((t) => !isName(t))) add("text", text, { kind: "text", term: tokens.join(" ") });
  return out;
}
