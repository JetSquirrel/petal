/**
 * Petal: explore a graph database (Neo4j, NebulaGraph, HawDB), one connection at a time.
 *
 * The shell composes the header, the perspective panel, the scene and the inspector; the state and the
 * work live in `store/`, the database access in `graph/`, the styled controls in `ui/`.
 */
import { effect, mount, View, windowSize } from "nsh";
import { isAvailable as desktop, Menu } from "nsh/desktop";
import { setNativeBackend, type NativeBackend } from "nsh-graph";
import * as graphNative from "nsh-graph/native";
import { ConnectDialog } from "./components/ConnectDialog";
import { Header } from "./components/Header";
import { canSelectAll, fitSelection, selectAll } from "./store/graphSelection";
import { Inspector } from "./components/Inspector";
import { PerspectivePanel } from "./components/PerspectivePanel";
import { Scene } from "./components/Scene";
import { focusSearch } from "./components/SearchBar";
import { AppContext, createAppStore, type AppStore } from "./store/app";

// The scene's force layout and drawing run in Rust (nsh-graph's native crate, listed in nsh.json): a big
// scene settles in seconds instead of minutes. Set before any graph view mounts.
setNativeBackend(graphNative as unknown as NativeBackend);

function App() {
  const store = createAppStore();
  store.start();
  if (desktop) installMenu(store);

  const width = () => windowSize().width;
  const selection = () => store.selectedNode() !== null || store.selectedRel() !== null;

  return (
    <AppContext.Provider value={store}>
      <View class="flex-1 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <Header />
        <View class="relative flex-1 flex-row">
          <If when={store.panelOpen() && width() >= 760}>
            <PerspectivePanel />
          </If>
          <Scene />
          <If when={selection()}>
            <If
              when={width() >= 1060}
              else={
                <View class="absolute bottom-0 right-0 top-0 flex-row shadow-xl">
                  <Inspector />
                </View>
              }
            >
              <Inspector />
            </If>
          </If>
        </View>
      </View>
      <ConnectDialog />
    </AppContext.Provider>
  );
}

/** The menu bar: what the toolbar does, with shortcuts. It follows the state it shows. */
function installMenu(store: AppStore) {
  effect(() => {
    const canUndo = store.scene.canUndo();
    const hasNodes = store.scene.nodes().size > 0;
    const settings = store.settings();
    Menu.setApplicationMenu([
      {
        label: "File",
        submenu: [
          { label: "Connect to a database…", shortcut: "mod+o", onSelect: () => store.connectOpen.set(true) },
          { label: "Use the demo graph", onSelect: () => store.useDemo() },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { label: "Undo scene change", shortcut: "mod+z", when: "auto", disabled: !canUndo, onSelect: () => store.undo() },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { label: "Search", shortcut: "mod+k", onSelect: focusSearch },
          { label: "Perspective", shortcut: "mod+b", checked: store.panelOpen(), onSelect: () => store.panelOpen.update((o) => !o) },
          { label: "Relationship types", checked: settings.edgeLabels, onSelect: () => store.updateSettings({ edgeLabels: !settings.edgeLabels }) },
          { type: "separator" },
          { label: "Fit to the scene", shortcut: "mod+0", onSelect: () => store.graph.fit() },
          { label: "Zoom in", shortcut: "mod+plus", onSelect: () => store.graph.zoomIn() },
          { label: "Zoom out", shortcut: "mod+minus", onSelect: () => store.graph.zoomOut() },
        ],
      },
      {
        label: "Scene",
        submenu: [
          { label: "Lay out again", onSelect: () => store.graph.relayout() },
          { label: "Unpin all", onSelect: () => store.graph.unpinAll() },
          { label: "Select all nodes", disabled: !hasNodes || !canSelectAll(store.graph), onSelect: () => selectAll(store.graph) },
          { label: "Fit to the selection", onSelect: () => fitSelection(store.graph) },
          { type: "separator" },
          { label: "Clear the scene", shortcut: "mod+shift+backspace", disabled: !hasNodes, onSelect: () => store.clearScene() },
        ],
      },
    ]);
  });
}

mount(App);
