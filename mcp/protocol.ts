/**
 * MCP over Streamable HTTP, the server's side: what Petal answers to a request the Rust endpoint
 * (`src/mcp.rs`) hands over. JSON-RPC 2.0 messages in a POST to `/mcp`, answered with JSON (no event
 * streams: every tool answers once). No UI and no database here, so the tests drive it directly.
 *
 * Every request must carry the token (`Authorization: Bearer …`), and a request that a web page could
 * have sent (another `Origin`, or a `Host` that isn't this computer: DNS rebinding) is refused.
 */

export interface HttpRequest {
  method: string;
  path: string;
  /** Names in lower case. */
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface McpServerOptions {
  token: string;
  name: string;
  version: string;
  instructions: string;
  tools: () => ToolDefinition[];
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** The protocol versions Petal speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

type Id = string | number;

interface JsonRpcError {
  code: number;
  message: string;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (status: number, value: unknown, extra: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "Content-Type": "application/json", ...extra },
  body: JSON.stringify(value),
});

const text = (status: number, body: string, extra: Record<string, string> = {}): HttpResponse => ({
  status,
  headers: { "Content-Type": "text/plain; charset=utf-8", ...extra },
  body,
});

const rpcError = (id: Id | null, error: JsonRpcError) => ({ jsonrpc: "2.0", id, error });

/** The host part of a `Host` header or an origin's authority: `localhost` of `localhost:7470`. */
export function hostName(authority: string): string {
  const a = authority.trim().toLowerCase();
  if (a.startsWith("[")) return a.slice(0, a.indexOf("]") + 1);
  return a.replace(/:\d+$/, "");
}

/** Whether a request could have come from a web page rather than an MCP client on this computer. */
export function fromAWebPage(headers: Record<string, string>): string | null {
  const origin = headers["origin"];
  if (origin !== undefined && origin !== "null") {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(origin.trim());
    if (!m || !LOCAL_HOSTS.has(hostName(m[1]))) return `Requests from ${origin} aren't allowed.`;
  } else if (origin === "null") return "Requests from web pages aren't allowed.";
  const host = headers["host"];
  if (host !== undefined && !LOCAL_HOSTS.has(hostName(host))) return `Requests for ${host} aren't allowed.`;
  return null;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Answers one HTTP request to the MCP endpoint. */
export async function handleHttp(req: HttpRequest, options: McpServerOptions): Promise<HttpResponse> {
  const path = req.path.split("?")[0];
  if (path !== "/mcp") return text(404, "Petal's MCP endpoint is /mcp.");

  const refused = fromAWebPage(req.headers);
  if (refused) return text(403, refused);

  const auth = req.headers["authorization"] ?? "";
  const given = /^Bearer\s+(.+)$/i.exec(auth.trim())?.[1] ?? "";
  if (!options.token || !sameText(given, options.token)) {
    return text(401, "Petal's MCP server needs its token: Authorization: Bearer <token>. Petal shows it under Connect an assistant.", {
      "WWW-Authenticate": 'Bearer realm="petal"',
    });
  }

  if (req.method !== "POST") return text(405, "Petal's MCP server takes POST requests, and has no event stream.", { Allow: "POST" });

  const version = req.headers["mcp-protocol-version"];
  if (version !== undefined && !PROTOCOL_VERSIONS.includes(version)) {
    return json(400, rpcError(null, { code: -32600, message: `Unsupported MCP protocol version ${version}.` }));
  }

  let message: unknown;
  try {
    message = JSON.parse(req.body);
  } catch {
    return json(400, rpcError(null, { code: -32700, message: "The body isn't JSON." }));
  }

  if (Array.isArray(message)) {
    if (!message.length) return json(400, rpcError(null, { code: -32600, message: "An empty batch." }));
    const answers = (await Promise.all(message.map((m) => handleMessage(m, options)))).filter((a) => a !== null);
    return answers.length ? json(200, answers) : { status: 202, headers: {}, body: "" };
  }
  const answer = await handleMessage(message, options);
  return answer === null ? { status: 202, headers: {}, body: "" } : json(200, answer);
}

/** Answers one JSON-RPC message; null for a notification or a response, which get no answer. */
async function handleMessage(message: unknown, options: McpServerOptions): Promise<object | null> {
  if (!message || typeof message !== "object") return rpcError(null, { code: -32600, message: "Not a JSON-RPC message." });
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = typeof m.id === "string" || typeof m.id === "number";
  if (typeof m.method !== "string") return hasId ? rpcError(m.id as Id, { code: -32600, message: "No method." }) : null;
  if (!hasId) return null; // a notification: notifications/initialized, notifications/cancelled, …
  const id = m.id as Id;
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
  try {
    return { jsonrpc: "2.0", id, result: await dispatch(m.method, params, options) };
  } catch (e) {
    if (e instanceof RpcError) return rpcError(id, { code: e.code, message: e.message });
    return rpcError(id, { code: -32603, message: e instanceof Error ? e.message : String(e) });
  }
}

async function dispatch(method: string, params: Record<string, unknown>, options: McpServerOptions): Promise<unknown> {
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: options.name, title: "Petal", version: options.version },
        instructions: options.instructions,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: options.tools() };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !options.tools().some((t) => t.name === name)) {
        throw new RpcError(-32602, `Unknown tool: ${String(name)}.`);
      }
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      let result: ToolResult;
      try {
        result = await options.call(name, args);
      } catch (e) {
        result = { text: e instanceof Error ? e.message : String(e), isError: true };
      }
      return { content: [{ type: "text", text: result.text }], isError: result.isError === true };
    }
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new RpcError(-32601, `Petal doesn't handle ${method}.`);
  }
}
