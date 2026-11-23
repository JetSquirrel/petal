/**
 * The notebook editor's knowledge of the query languages: a tokenizer that colors Cypher, nGQL, Gremlin and
 * search phrases (the editor has no built-in grammar for them), and the completions offered at the caret —
 * keywords and functions, the schema's labels and relationship types after `:`, property keys after `.`,
 * and Gremlin's steps.
 */
import type { QueryLanguage, Schema } from "./source";

export type TokenKind = "keyword" | "function" | "label" | "property" | "string" | "number" | "comment" | "parameter";

export interface Token {
  start: number;
  end: number;
  kind: TokenKind;
}

const CYPHER_KEYWORDS = [
  "MATCH", "OPTIONAL", "WHERE", "RETURN", "WITH", "UNWIND", "AS", "ORDER", "BY", "ASC", "ASCENDING", "DESC", "DESCENDING",
  "SKIP", "LIMIT", "CREATE", "MERGE", "SET", "DELETE", "DETACH", "REMOVE", "ON", "CALL", "YIELD", "UNION", "ALL",
  "DISTINCT", "AND", "OR", "XOR", "NOT", "IN", "IS", "NULL", "TRUE", "FALSE", "CASE", "WHEN", "THEN", "ELSE", "END",
  "STARTS", "ENDS", "CONTAINS", "EXISTS", "FOREACH", "LOAD", "CSV", "FROM", "HEADERS", "INDEX", "CONSTRAINT", "DROP",
  "SHOW", "USE", "PROFILE", "EXPLAIN", "COUNT",
];

const NGQL_KEYWORDS = [
  ...CYPHER_KEYWORDS,
  "GO", "STEPS", "OVER", "REVERSELY", "BIDIRECT", "FETCH", "PROP", "LOOKUP", "VERTEX", "VERTICES", "EDGE", "EDGES",
  "TAG", "TAGS", "SPACE", "SPACES", "INSERT", "UPSERT", "UPDATE", "VALUES", "VALUE", "INTO", "GET", "SUBGRAPH", "FIND",
  "PATH", "SHORTEST", "NOLOOP", "UPTO", "GROUP", "LIMIT", "SAMPLE", "DESCRIBE", "HOSTS", "PARTS", "JOBS",
];

const CYPHER_FUNCTIONS = [
  "count", "collect", "sum", "avg", "min", "max", "labels", "type", "id", "elementId", "keys", "properties", "nodes",
  "relationships", "length", "size", "head", "last", "tail", "range", "coalesce", "toString", "toInteger", "toFloat",
  "toBoolean", "toLower", "toUpper", "trim", "split", "substring", "replace", "startNode", "endNode", "exists",
  "shortestPath", "allShortestPaths", "timestamp", "date", "datetime", "duration", "abs", "round", "rand", "reverse",
  "percentileCont", "stDev", "point", "distance", "any", "none", "single", "reduce",
];

const NGQL_FUNCTIONS = [...CYPHER_FUNCTIONS, "id", "tags", "src", "dst", "rank", "properties", "hash", "now"];

const GREMLIN_STEPS = [
  "V", "E", "addV", "addE", "has", "hasLabel", "hasId", "hasKey", "hasNot", "out", "in", "both", "outE", "inE", "bothE",
  "outV", "inV", "bothV", "otherV", "values", "valueMap", "elementMap", "properties", "id", "label", "count", "limit",
  "range", "skip", "tail", "dedup", "order", "by", "as", "select", "project", "path", "simplePath", "repeat", "times",
  "until", "emit", "where", "and", "or", "not", "is", "group", "groupCount", "fold", "unfold", "toList", "next", "iterate",
  "property", "drop", "union", "coalesce", "choose", "optional", "constant", "math", "sum", "mean", "min", "max", "sample",
  "store", "aggregate", "cap", "match", "identity", "local", "sideEffect", "from", "to", "with", "option",
];

const GREMLIN_GLOBALS = ["g", "__", "P", "T", "TextP", "Order", "Column", "Scope", "Pop", "within", "without", "eq", "neq", "lt", "lte", "gt", "gte", "between", "inside", "outside", "containing", "startingWith", "endingWith", "asc", "desc", "decr", "incr", "keys"];

const upperSet = (xs: string[]) => new Set(xs.map((x) => x.toUpperCase()));
const lowerSet = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));

const KEYWORDS: Record<string, Set<string>> = { Cypher: upperSet(CYPHER_KEYWORDS), nGQL: upperSet(NGQL_KEYWORDS) };
const FUNCTIONS: Record<string, Set<string>> = { Cypher: lowerSet(CYPHER_FUNCTIONS), nGQL: lowerSet(NGQL_FUNCTIONS) };
const GREMLIN_STEP_SET = new Set(GREMLIN_STEPS);
const GREMLIN_GLOBAL_SET = new Set(GREMLIN_GLOBALS);

const isIdentStart = (c: string) => /[A-Za-z_À-￿]/.test(c);
const isIdent = (c: string) => /[A-Za-z0-9_À-￿]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/** The previous non-space character before `i`, or "". */
function prevChar(text: string, i: number): string {
  for (let j = i - 1; j >= 0; j--) if (!/\s/.test(text[j])) return text[j];
  return "";
}

/** The next non-space character from `i`, or "". */
function nextChar(text: string, i: number): string {
  for (let j = i; j < text.length; j++) if (!/\s/.test(text[j])) return text[j];
  return "";
}

/** The tokens of `text` in `language` (a search phrase without one), in order, without gaps colored. */
export function tokenizeQuery(text: string, language: QueryLanguage, schema?: Schema): Token[] {
  if (language === null) return tokenizePhrase(text, schema);
  const out: Token[] = [];
  const gremlin = language === "Gremlin";
  const keywords = KEYWORDS[language] ?? new Set<string>();
  const functions = FUNCTIONS[language] ?? new Set<string>();
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    // Comments: `//` to the end of the line, `/* … */`, and `#` in nGQL.
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      const end = e < 0 ? n : e;
      out.push({ start: i, end, kind: "comment" });
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      out.push({ start: i, end, kind: "comment" });
      i = end;
      continue;
    }
    if (c === "#" && language === "nGQL") {
      const e = text.indexOf("\n", i);
      const end = e < 0 ? n : e;
      out.push({ start: i, end, kind: "comment" });
      i = end;
      continue;
    }
    // Strings, with backslash escapes; an unclosed one runs to the end.
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      out.push({ start: i, end, kind: "string" });
      i = end;
      continue;
    }
    // Backticked names: a label, type or property after `:` or `.`, else a variable (left plain).
    if (c === "`") {
      let j = i + 1;
      while (j < n && !(text[j] === "`" && text[j + 1] !== "`")) j += text[j] === "`" ? 2 : 1;
      const end = Math.min(n, j + 1);
      const before = prevChar(text, i);
      if (before === ":") out.push({ start: i, end, kind: "label" });
      else if (before === ".") out.push({ start: i, end, kind: "property" });
      i = end;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(text[i + 1] ?? "") && !isIdent(text[i - 1] ?? "") && text[i - 1] !== ".")) {
      let j = i + 1;
      while (j < n && /[0-9A-Fa-fxX._eE]/.test(text[j])) {
        // `1..3` in a variable-length pattern is two numbers.
        if (text[j] === "." && text[j + 1] === ".") break;
        j++;
      }
      out.push({ start: i, end: j, kind: "number" });
      i = j;
      continue;
    }
    if ((c === "$" || (c === "@" && language === "nGQL")) && isIdentStart(text[i + 1] ?? "")) {
      let j = i + 1;
      while (j < n && isIdent(text[j])) j++;
      out.push({ start: i, end: j, kind: "parameter" });
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(text[j])) j++;
      const word = text.slice(i, j);
      const before = prevChar(text, i);
      const after = nextChar(text, j);
      let kind: TokenKind | null = null;
      if (gremlin) {
        if (before === "." && GREMLIN_STEP_SET.has(word)) kind = "function";
        else if (GREMLIN_GLOBAL_SET.has(word)) kind = "keyword";
        else if (after === "(" && GREMLIN_STEP_SET.has(word)) kind = "function";
      } else if (before === ":" && !insideBraces(text, i)) kind = "label";
      else if (text[i - 1] === "." && text[i - 2] !== ".") kind = "property";
      else if (after === "(" && functions.has(word.toLowerCase())) kind = "function";
      else if (keywords.has(word.toUpperCase()) && before !== ".") kind = "keyword";
      else if (after === ":" && insideBraces(text, i)) kind = "property";
      if (kind) out.push({ start: i, end: j, kind });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** Whether `i` is inside an unclosed `{`: a map, whose `key:` names are properties, not labels. */
function insideBraces(text: string, i: number): boolean {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const c = text[j];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) return true;
      depth--;
    } else if (c === "(" || c === "[") {
      if (depth === 0) return false;
    }
  }
  return false;
}

/** The innermost unclosed bracket before `i` (`(`, `[`, `{`), or "". */
function enclosingBracket(text: string, i: number): string {
  const closes: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  let quote = "";
  for (let j = 0; j < i; j++) {
    const c = text[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (closes[c] && stack[stack.length - 1] === closes[c]) stack.pop();
  }
  return stack[stack.length - 1] ?? "";
}

/** A search phrase's words that name a label or a relationship type of the schema. */
function tokenizePhrase(text: string, schema?: Schema): Token[] {
  if (!schema) return [];
  const names = new Set([...schema.labels.map((l) => l.name.toLowerCase()), ...schema.relTypes.map((r) => r.name.toLowerCase())]);
  const out: Token[] = [];
  const re = /"[^"]*"?|[^\s"]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const word = m[0];
    if (word.startsWith('"')) out.push({ start: m.index, end: m.index + word.length, kind: "string" });
    else if (names.has(word.toLowerCase())) out.push({ start: m.index, end: m.index + word.length, kind: "label" });
  }
  return out;
}

/** Whether `offset` is inside a string or a comment, where nothing is completed. */
function insideLiteral(text: string, offset: number, language: QueryLanguage): boolean {
  for (const t of tokenizeQuery(text, language)) {
    if (t.start >= offset) break;
    if ((t.kind === "string" || t.kind === "comment") && offset > t.start && (offset < t.end || unclosed(text, t))) return true;
  }
  return false;
}

/** A string or block comment that runs to the end of the text without closing. */
function unclosed(text: string, t: Token): boolean {
  if (t.end !== text.length) return false;
  const s = text.slice(t.start, t.end);
  if (s.startsWith("//") || s.startsWith("#")) return !s.includes("\n");
  if (s.startsWith("/*")) return !s.endsWith("*/") || s.length < 4;
  return s.length < 2 || s[s.length - 1] !== s[0] || s[s.length - 2] === "\\";
}

export type CompletionKind = "keyword" | "function" | "class" | "interface" | "property" | "method" | "variable";

export interface Completion {
  label: string;
  kind: CompletionKind;
  detail?: string;
  insertText?: string;
  sortText?: string;
}

export interface CompletionContext {
  language: QueryLanguage;
  schema: Schema;
  /** Property keys seen in results, for completion after `.`. */
  propertyKeys: string[];
}

/** A name as a query may write it bare, or backticked. */
function quoteName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "`" + name.replace(/`/g, "``") + "`";
}

/** The completions for the word ending at `offset` of `text` (`queryStart` where the word begins). */
export function completionsAt(text: string, offset: number, queryStart: number, ctx: CompletionContext): Completion[] {
  const { language, schema } = ctx;
  if (insideLiteral(text, offset, language)) return [];
  const before = text[queryStart - 1] ?? "";
  const counted = (n?: number) => (n === undefined ? undefined : `${n.toLocaleString()}`);
  const labels = (): Completion[] =>
    schema.labels.map((l) => ({ label: l.name, kind: "class", detail: counted(l.count) ? `label · ${counted(l.count)}` : "label", insertText: language ? quoteName(l.name) : l.name, sortText: `1${l.name}` }));
  const types = (): Completion[] =>
    schema.relTypes.map((r) => ({ label: r.name, kind: "interface", detail: counted(r.count) ? `relationship · ${counted(r.count)}` : "relationship", insertText: language ? quoteName(r.name) : r.name, sortText: `1${r.name}` }));
  const properties = (): Completion[] => ctx.propertyKeys.map((k) => ({ label: k, kind: "property", detail: "property", insertText: language ? quoteName(k) : k, sortText: `1${k}` }));

  if (language === null) return [...labels(), ...types()];

  if (language === "Gremlin") {
    if (before === ".") return GREMLIN_STEPS.map((s) => ({ label: s, kind: "method", detail: "step", insertText: `${s}(`, sortText: `1${s}` }));
    // A string argument of `hasLabel(` / `out(` … gets no completion here (it is a literal).
    return GREMLIN_GLOBALS.map((s) => ({ label: s, kind: "keyword", sortText: `2${s}` }));
  }

  // Cypher and nGQL.
  if (before === ":") {
    const bracket = enclosingBracket(text, queryStart);
    if (bracket === "[") return types();
    if (bracket === "(") return labels();
    if (bracket === "{") return [];
    return [...labels(), ...types()];
  }
  if (before === ".") return properties();
  if (before === "$") return [];
  const keywordList = language === "nGQL" ? NGQL_KEYWORDS : CYPHER_KEYWORDS;
  const functionList = language === "nGQL" ? NGQL_FUNCTIONS : CYPHER_FUNCTIONS;
  const keywordItems: Completion[] = [...new Set(keywordList)].map((k) => ({ label: k, kind: "keyword", sortText: `1${k}` }));
  const functionItems: Completion[] = [...new Set(functionList)].map((f) => ({ label: f, kind: "function", detail: "function", insertText: `${f}(`, sortText: `2${f}` }));
  return [...keywordItems, ...functionItems];
}

/** The start of each line of `text`: offsets to positions. */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
}

/** The line and column of `offset`, given `lineStarts(text)`. */
export function positionOf(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: offset - starts[lo] };
}
