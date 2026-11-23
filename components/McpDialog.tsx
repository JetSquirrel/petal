/**
 * Connect an assistant: turns Petal's MCP server on and off, and shows how to add Petal to Claude Code or
 * another MCP client (the address and the token), whether queries that write are allowed, and the tools
 * assistants called lately.
 */
import { Clipboard, Scroll, signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { useStore } from "../store/app";
import { claudeCodeCommand, clientConfig, DEFAULT_MCP_PORT, mcpAvailable } from "../store/mcp";
import { Button, Field, Icon, IconButton, Separator, Switch, TextField } from "../ui";

export function McpDialog() {
  const store = useStore();
  return (
    <Dialog
      open={store.mcpOpen()}
      onOpenChange={(e) => store.mcpOpen.set(e.open)}
      accessibilityLabel="Connect an assistant"
      animation="fade"
      backdropClass="bg-scrim"
      class="m-auto overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
      style={{ width: 620, maxWidth: "94%", height: 640, maxHeight: "90%" }}
      testID="mcp-dialog"
    >
      <McpSettingsPane />
    </Dialog>
  );
}

function McpSettingsPane() {
  const store = useStore();
  const mcp = store.mcp;
  const portText = signal(String(mcp.settings().port));
  const showToken = signal(false);

  const copy = async (text: string, what: string) => {
    try {
      await Clipboard.writeText(text);
      store.notify(`Copied ${what}.`);
    } catch {
      store.notify("Couldn't copy to the clipboard.", "error");
    }
  };

  const applyPort = () => {
    const p = Number(portText().trim());
    if (Number.isInteger(p) && p >= 0 && p <= 65535) void mcp.setPort(p);
    else portText.set(String(mcp.settings().port));
  };

  const statusText = () => {
    switch (mcp.status()) {
      case "on":
        return `Listening on ${mcp.endpoint()}`;
      case "starting":
        return "Starting…";
      case "error":
        return mcp.error() ?? "The server couldn't start.";
      default:
        return "Off. Assistants can't reach Petal.";
    }
  };

  const token = () => mcp.settings().token;
  const masked = () => (showToken() ? token() : `${token().slice(0, 4)}${"•".repeat(20)}${token().slice(-4)}`);

  return (
    <View class="flex-1">
      <View class="h-14 flex-row items-center gap-3 border-b border-border px-4">
        <Icon name="plug" size={18} tone="foreground" />
        <Text class="flex-1 text-sm font-semibold text-foreground">Connect an assistant</Text>
        <IconButton size="sm" icon="x" label="Close" onPress={() => store.mcpOpen.set(false)} testID="mcp-close" />
      </View>
      <Scroll class="flex-1">
        <View class="gap-5 p-4">
          <Text class="text-sm text-muted-foreground">
            Petal can run an MCP server, so an assistant such as Claude Code can read the database you're connected to, run queries, see your
            scene, and add frames to your notebook. It listens on this computer only, and every request needs the token below.
          </Text>

          <If
            when={mcpAvailable}
            else={
              <Text class="text-sm text-destructive" testID="mcp-unavailable">
                The MCP server needs the desktop version of Petal.
              </Text>
            }
          >
            <View class="gap-2">
              <Switch label="Run the MCP server" checked={mcp.settings().enabled} onChange={(on) => mcp.setEnabled(on)} testID="mcp-enabled" />
              <View class="flex-row items-center gap-2">
                <View
                  class={`h-2 w-2 rounded-full ${mcp.status() === "on" ? "bg-success" : mcp.status() === "error" ? "bg-destructive" : "bg-muted-foreground"}`}
                />
                <Text class={`flex-1 text-xs ${mcp.status() === "error" ? "text-destructive" : "text-muted-foreground"}`} testID="mcp-status">
                  {statusText()}
                </Text>
              </View>
            </View>

            <View class="flex-row gap-3">
              <Field label="Port" description={`On 127.0.0.1. Default ${DEFAULT_MCP_PORT}.`} class="w-40">
                <TextField value={portText()} onChange={(v) => portText.set(v.replace(/[^0-9]/g, ""))} onSubmit={applyPort} verbatim mono testID="mcp-port" />
              </Field>
              <View class="justify-start pt-[22px]">
                <Button
                  size="md"
                  variant="outline"
                  label="Apply"
                  disabled={portText() === String(mcp.settings().port)}
                  onPress={applyPort}
                  testID="mcp-port-apply"
                />
              </View>
            </View>

            <Field label="Token" description="Clients send it as Authorization: Bearer <token>. A new token disconnects the clients set up with the old one.">
              <View class="flex-row items-center gap-1.5">
                <View class="h-9 flex-1 justify-center rounded-(--radius) border border-input bg-muted px-3">
                  <Text class="font-mono text-xs text-foreground line-clamp-1" testID="mcp-token">
                    {masked()}
                  </Text>
                </View>
                <IconButton icon="eye" label={showToken() ? "Hide the token" : "Show the token"} selected={showToken()} onPress={() => showToken.update((s) => !s)} testID="mcp-token-show" />
                <IconButton icon="copy" label="Copy the token" onPress={() => copy(token(), "the token")} testID="mcp-token-copy" />
                <IconButton icon="relayout" label="Make a new token" onPress={() => mcp.regenerateToken()} testID="mcp-token-new" />
              </View>
            </Field>

            <View class="gap-1">
              <Switch
                label="Allow queries that write"
                checked={mcp.settings().allowWrites}
                onChange={(on) => mcp.setAllowWrites(on)}
                testID="mcp-allow-writes"
              />
              <Text class="text-xs text-muted-foreground">
                Off, Petal refuses queries with CREATE, MERGE, SET, DELETE and the like (INSERT and UPDATE in nGQL, addV and drop in Gremlin).
                It reads keywords, so it guards against mistakes, not against a determined client. Use a read-only database user for that.
              </Text>
            </View>

            <Separator />

            <View class="gap-2">
              <Text class="text-sm font-semibold text-foreground">Add Petal to Claude Code</Text>
              <CodeBlock text={claudeCodeCommand(mcp.endpoint(), token())} onCopy={(t) => copy(t, "the command")} testID="mcp-claude-code" />
              <Text class="text-sm font-semibold text-foreground">Or to another client's configuration</Text>
              <Text class="text-xs text-muted-foreground">A project's .mcp.json, Cursor, and other clients that connect to a URL.</Text>
              <CodeBlock text={clientConfig(mcp.endpoint(), token())} onCopy={(t) => copy(t, "the configuration")} testID="mcp-config" />
            </View>

            <Separator />

            <View class="gap-2">
              <Text class="text-sm font-semibold text-foreground">Recent requests</Text>
              <If when={mcp.activity().length === 0}>
                <Text class="text-xs text-muted-foreground">No assistant has called Petal's tools yet.</Text>
              </If>
              <Each of={mcp.activity()} key={(a) => a.id}>
                {(a) => (
                  <View class="flex-row items-center gap-2" testID="mcp-activity">
                    <Icon name={a().ok ? "check" : "alert"} size={12} tone={a().ok ? "success" : "destructive"} />
                    <Text class="w-14 text-xs text-muted-foreground tabular-nums">{new Date(a().at).toTimeString().slice(0, 8)}</Text>
                    <Text class="font-mono text-xs text-foreground">{a().tool}</Text>
                    <Text class="flex-1 font-mono text-xs text-muted-foreground line-clamp-1">{a().detail}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </Scroll>
    </View>
  );
}

function CodeBlock(props: { text: string; onCopy: (text: string) => void; testID: string }) {
  return (
    <View class="flex-row items-start gap-2 rounded-(--radius) border border-border bg-muted p-2.5">
      <Text class="flex-1 font-mono text-xs text-foreground" testID={props.testID}>
        {props.text}
      </Text>
      <IconButton size="sm" icon="copy" label="Copy" onPress={() => props.onCopy(props.text)} testID={`${props.testID}-copy`} />
    </View>
  );
}
