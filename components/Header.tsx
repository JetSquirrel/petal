/**
 * The top bar: the perspective toggle, Petal's mark, the mode (Explore or Notebook), the search field while
 * exploring, the assistant (MCP) button and the database button.
 */
import { Text, View, windowSize } from "nsh";
import { useStore, type Mode } from "../store/app";
import { Button, IconButton, PetalMark, Segmented, type SegmentOption } from "../ui";
import { SearchBar } from "./SearchBar";
import { shortcutText } from "./Scene";

const MODES: SegmentOption<Mode>[] = [
  { value: "explore", label: "Explore", icon: "graph" },
  { value: "notebook", label: "Notebook", icon: "notebook" },
];

export function Header() {
  const store = useStore();
  /** The saved connection's name when it has one, or the database's own label. */
  const name = () => store.connections().find((c) => c.id === store.activeConnection())?.name || store.source().label;
  const status = () => (store.connection() === "error" ? "Not connected" : store.connection() === "connecting" ? "Connecting…" : name());
  const mcpOn = () => store.mcp.status() === "on";
  const wide = () => windowSize().width >= 960;
  return (
    <View class="h-14 flex-row items-center gap-3 border-b border-border bg-background px-3">
      <IconButton
        icon="panel"
        label={store.panelOpen() ? "Hide the perspective" : "Show the perspective"}
        shortcut={shortcutText("B")}
        selected={store.panelOpen()}
        onPress={() => store.panelOpen.update((o) => !o)}
        testID="toggle-panel"
      />
      <View class="flex-row items-center gap-2 pr-1">
        <PetalMark size={22} />
        <If when={wide()}>
          <Text class="text-base font-semibold tracking-tight text-foreground">Petal</Text>
        </If>
      </View>
      <Segmented label="Mode" value={store.settings().mode} options={MODES} onChange={(m) => store.setMode(m)} testID="mode" class="w-[196px]" />
      <View class="flex-1 flex-row justify-center">
        <If when={store.settings().mode === "explore"}>
          <SearchBar class="max-w-[680px] flex-1" />
        </If>
      </View>
      <View class="relative">
        <IconButton
          icon="plug"
          label={mcpOn() ? `Assistants can connect (MCP, ${store.mcp.endpoint()})` : "Connect an assistant (MCP)"}
          selected={mcpOn()}
          onPress={() => store.mcpOpen.set(true)}
          testID="mcp"
        />
        <If when={mcpOn()}>
          <View class="absolute right-1 top-1 h-2 w-2 rounded-full bg-success" style={{ pointerEvents: "none" }} />
        </If>
      </View>
      <Button
        variant="outline"
        icon="database"
        trailingIcon="chevronDown"
        label={status()}
        onPress={() => store.connectOpen.set(true)}
        accessibilityLabel={`Database: ${status()}. Manage connections`}
        testID="connection"
        class="max-w-[260px]"
      />
    </View>
  );
}
