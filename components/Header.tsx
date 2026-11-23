/** The top bar: the perspective toggle, Petal's mark, the search field and the database button. */
import { Text, View } from "nsh";
import { useStore } from "../store/app";
import { Button, IconButton, PetalMark } from "../ui";
import { SearchBar } from "./SearchBar";
import { shortcutText } from "./Scene";

export function Header() {
  const store = useStore();
  /** The saved connection's name when it has one, or the database's own label. */
  const name = () => store.connections().find((c) => c.id === store.activeConnection())?.name || store.source().label;
  const status = () => (store.connection() === "error" ? "Not connected" : store.connection() === "connecting" ? "Connecting…" : name());
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
      <View class="flex-row items-center gap-2 pr-2">
        <PetalMark size={22} />
        <Text class="text-base font-semibold tracking-tight text-foreground">Petal</Text>
      </View>
      <View class="flex-1 flex-row justify-center">
        <SearchBar class="max-w-[680px] flex-1" />
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
