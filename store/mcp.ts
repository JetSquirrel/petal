/**
 * Petal's MCP server: lets an assistant (Claude Code, Claude Desktop, any MCP client) read and query the
 * database Petal is connected to, see the scene, and add to it and to the notebook. The Rust crate listens on
 * 127.0.0.1 (`McpServer` of `petal/native`) and hands each request here; `mcp/protocol.ts` answers it and
 * `mcp/tools.ts` does the work.
 *
 * It is off until the person turns it on, and remembers that. Every request needs the token Petal makes the
 * first time; queries that write are refused unless the person allows them.
 */
import { appInfo, computed, platform, signal, Storage } from "nsh";
import { McpServer } from "petal/native";
import { handleHttp, type HttpRequest, type McpServerOptions } from "../mcp/protocol";
import { callTool, toolDefinitions, type ToolHost } from "../mcp/tools";

export interface McpSettings {
  enabled: boolean;
  port: number;
  token: string;
  allowWrites: boolean;
}

export type McpStatus = "off" | "starting" | "on" | "error";

/** A tool call, for the list in the dialog. */
export interface McpActivity {
  id: number;
  at: number;
  tool: string;
  /** The query or phrase, when the tool took one. */
  detail: string;
  ok: boolean;
}

export const DEFAULT_MCP_PORT = 7470;
const KEY = "mcp";
const ACTIVITY = 30;

/** The MCP server needs sockets, which the web version doesn't have. */
export const mcpAvailable = platform.os !== "web";

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const INSTRUCTIONS =
  "Petal is a graph database explorer the person has open. These tools work on the database it is connected to now. " +
  "Call get_schema first to learn the labels, relationship types and query language. get_scene shows what the person is looking at. " +
  "Pass show: true, or use add_to_notebook, when the person should see a result in Petal.";

export function createMcp(host: ToolHost) {
  const settings = signal<McpSettings>({ enabled: false, port: DEFAULT_MCP_PORT, token: "", allowWrites: false });
  const status = signal<McpStatus>("off");
  /** The port it listens on, while it does. */
  const port = signal<number | null>(null);
  const error = signal<string | null>(null);
  const activity = signal<McpActivity[]>([]);
  let server: McpServer | null = null;
  /** Bumped each time the server starts or stops, so an old loop ends. */
  let generation = 0;
  let activityId = 0;

  const save = () => Storage.setItem(KEY, JSON.stringify(settings())).catch(() => {});
  const change = (patch: Partial<McpSettings>) => {
    settings.update((s) => ({ ...s, ...patch }));
    save();
  };

  const record = (tool: string, args: Record<string, unknown>, ok: boolean) => {
    const detail = ["query", "phrase"].map((k) => args[k]).find((v): v is string => typeof v === "string") ?? (Array.isArray(args.node_ids) ? args.node_ids.join(", ") : "");
    activity.update((list) => [{ id: ++activityId, at: Date.now(), tool, detail, ok }, ...list].slice(0, ACTIVITY));
  };

  const options: McpServerOptions = {
    get token() {
      return settings().token;
    },
    name: "petal",
    version: appInfo().version ?? "0.1.0",
    instructions: INSTRUCTIONS,
    tools: toolDefinitions,
    call: async (name, args) => {
      try {
        const result = await callTool(host, name, args);
        record(name, args, !result.isError);
        return result;
      } catch (e) {
        record(name, args, false);
        throw e;
      }
    },
  };

  async function answer(s: McpServer, raw: string) {
    let req: HttpRequest & { id: number };
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    let res;
    try {
      res = await handleHttp(req, options);
    } catch (e) {
      res = { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: e instanceof Error ? e.message : String(e) };
    }
    try {
      s.respond(req.id, res.status, JSON.stringify(res.headers), res.body);
    } catch {
      // the server stopped meanwhile
    }
  }

  async function serve(s: McpServer, gen: number) {
    while (gen === generation) {
      let raw: string;
      try {
        raw = await s.next();
      } catch {
        break;
      }
      if (!raw) break;
      // Answer each request on its own: a slow query doesn't hold up the next request.
      void answer(s, raw);
    }
  }

  async function start() {
    if (!mcpAvailable) {
      status.set("error");
      error.set("The MCP server needs the desktop version of Petal.");
      return;
    }
    stopServer();
    const gen = ++generation;
    status.set("starting");
    error.set(null);
    const s = new McpServer();
    try {
      const listening = await s.start(settings().port);
      if (gen !== generation) {
        s.stop();
        s.dispose();
        return;
      }
      server = s;
      port.set(listening);
      status.set("on");
      void serve(s, gen);
    } catch (e) {
      s.dispose();
      if (gen !== generation) return;
      status.set("error");
      error.set(e instanceof Error ? e.message : String(e));
    }
  }

  function stopServer() {
    generation++;
    if (server) {
      try {
        server.stop();
        server.dispose();
      } catch {
        // already gone
      }
    }
    server = null;
    port.set(null);
  }

  function stop() {
    stopServer();
    status.set("off");
    error.set(null);
  }

  /** Reads what Petal remembered, makes a token the first time, and starts the server if it was on. */
  async function restore() {
    try {
      const raw = await Storage.getItem(KEY);
      if (raw) {
        const kept = JSON.parse(raw) as Partial<McpSettings>;
        settings.update((s) => ({
          enabled: kept.enabled === true,
          port: typeof kept.port === "number" && kept.port >= 0 && kept.port <= 65535 ? kept.port : s.port,
          token: typeof kept.token === "string" && kept.token.length >= 16 ? kept.token : s.token,
          allowWrites: kept.allowWrites === true,
        }));
      }
    } catch {
      // a damaged entry keeps the defaults
    }
    if (!settings().token) change({ token: newToken() });
    if (settings().enabled && mcpAvailable) await start();
  }

  async function setEnabled(on: boolean) {
    change({ enabled: on });
    if (on) await start();
    else stop();
  }

  /** Listens on another port: at once while it is on. */
  async function setPort(p: number) {
    if (!Number.isInteger(p) || p < 0 || p > 65535) return;
    change({ port: p });
    if (settings().enabled) await start();
  }

  /** A new token: clients set up with the old one stop working. */
  function regenerateToken() {
    change({ token: newToken() });
  }

  const setAllowWrites = (allow: boolean) => change({ allowWrites: allow });

  const endpoint = computed(() => `http://127.0.0.1:${port() ?? settings().port}/mcp`);

  return { settings, status, port, error, activity, endpoint, restore, setEnabled, setPort, regenerateToken, setAllowWrites, stop };
}

export type Mcp = ReturnType<typeof createMcp>;

/** The command that adds Petal to Claude Code. */
export function claudeCodeCommand(endpoint: string, token: string): string {
  return `claude mcp add --transport http petal ${endpoint} --header "Authorization: Bearer ${token}"`;
}

/** Petal in an MCP client's JSON configuration (`mcpServers`), as a project's `.mcp.json`, Cursor and other clients that take a URL read it. */
export function clientConfig(endpoint: string, token: string): string {
  return JSON.stringify({ mcpServers: { petal: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}
