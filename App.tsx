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
import { McpDialog } from "./components/McpDialog";
import { Notebook } from "./components/Notebook";
import { PerspectivePanel } from "./components/PerspectivePanel";
import { Scene } from "./components/Scene";
import { focusSearch } from "./components/SearchBar";
import { AppContext, createAppStore, type AppStore } from "./store/app";

// The scene's force layout and drawing run in Rust (nsh-graph's Rust module, `nsh-graph/native`): a big
// scene settles in seconds instead of minutes. Set before any graph view mounts.
setNativeBackend(graphNative as unknown as NativeBackend);

function App() {
  const store = createAppStore();
  store.start();
  if (desktop) installMenu(store);

  const width = () => windowSize().width;
  const selection = () => store.selectedNode() !== null || store.selectedRel() !== null;
  const notebook = () => store.settings().mode === "notebook";

  return (
    <AppContext.Provider value={store}>
      <View class="flex-1 bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <Header />
        <View class="relative flex-1 flex-row">
          <If when={store.panelOpen()}>
            <PerspectivePanel floating={!store.perspectiveDocked()} />
          </If>
          {/* The scene stays mounted under the notebook, so its layout is where it was when you come back. */}
          <View class={`relative flex-1 flex-row ${notebook() ? "hidden" : ""}`}>
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
          <If when={notebook()}>
            <Notebook />
          </If>
        </View>
      </View>
      <ConnectDialog />
      <McpDialog />
    </AppContext.Provider>
  );
}

/** The menu bar: what the toolbar does, with shortcuts. It follows the state it shows. */
function installMenu(store: AppStore) {
  effect(() => {
    const canUndo = store.scene.canUndo();
    const hasNodes = store.scene.nodes().size > 0;
    const hasFrames = store.notebook.frames().length > 0;
    const settings = store.settings();
    Menu.setApplicationMenu([
      {
        label: "File",
        submenu: [
          { label: "Connect to a database…", shortcut: "mod+o", onSelect: () => store.connectOpen.set(true) },
          { label: "Use the demo graph", onSelect: () => store.useDemo() },
          { type: "separator" },
          { label: "Open notebook…", shortcut: "mod+shift+o", onSelect: () => store.openNotebook() },
          { label: "Save notebook", shortcut: "mod+s", disabled: !hasFrames, onSelect: () => store.saveNotebook() },
          { type: "separator" },
          { label: "Connect an assistant (MCP)…", onSelect: () => store.mcpOpen.set(true) },
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
          { label: "Explore", shortcut: "mod+1", checked: settings.mode === "explore", onSelect: () => store.setMode("explore") },
          { label: "Notebook", shortcut: "mod+2", checked: settings.mode === "notebook", onSelect: () => store.setMode("notebook") },
          { type: "separator" },
          {
            label: "Search",
            shortcut: "mod+k",
            onSelect: () => {
              store.setMode("explore");
              // The search field mounts with the explore mode: focus it once it has.
              setTimeout(focusSearch, 0);
            },
          },
          { label: "Perspective", shortcut: "mod+b", checked: store.panelOpen(), onSelect: store.togglePerspective },
          { label: "Relationship types", checked: settings.edgeLabels, onSelect: () => store.updateSettings({ edgeLabels: !settings.edgeLabels }) },
          { label: "Table", shortcut: "mod+j", checked: settings.table, onSelect: () => store.updateSettings({ table: !settings.table }) },
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
