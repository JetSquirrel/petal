/**
 * Saved scenes, from the scene's toolbar: save the scene under a name, open or delete a saved one, and copy
 * the scene to the clipboard or open one from it (Graph Explorer's Save Graph and Load Graph).
 */
import { signal, Text, View } from "nsh";
import { useStore } from "../store/app";
import { Button, IconButton, Popover, Row, SectionTitle, Separator, TextField } from "../ui";

export function ScenesMenu() {
  const store = useStore();
  const open = signal(false);
  const name = signal("");
  const error = signal<string | null>(null);
  const empty = () => store.scene.nodes().size === 0;

  const save = async () => {
    const e = await store.saveScene(name());
    error.set(e);
    if (!e) name.set("");
  };
  const when = (ms: number) => {
    const d = new Date(ms);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  };

  return (
    <Popover
      open={open()}
      onOpenChange={(o) => {
        open.set(o);
        if (o) error.set(null);
      }}
      placement="top"
      align="center"
      width={300}
      testID="scenes"
      trigger={<IconButton icon="bookmark" label="Saved scenes" selected={open()} testID="scenes-open" />}
    >
      <View class="gap-2">
        <SectionTitle title="Save this scene" />
        <View class="flex-row gap-1.5">
          <TextField
            size="sm"
            value={name()}
            onChange={(v) => {
              name.set(v);
              error.set(null);
            }}
            onSubmit={save}
            placeholder="Name"
            accessibilityLabel="Scene name"
            class="flex-1"
            testID="scene-name"
          />
          <Button size="sm" variant="primary" label="Save" disabled={empty() || !name().trim()} onPress={save} testID="scene-save" />
        </View>
        <If when={error()}>{(e) => <Text class="text-xs text-destructive" testID="scene-error">{e()}</Text>}</If>
        <If when={!error() && store.scenes.list().some((s) => s.name === name().trim())}>
          <Text class="text-xs text-muted-foreground">Saving replaces the scene of that name.</Text>
        </If>
      </View>

      <Separator />

      <View class="gap-1">
        <SectionTitle title="Saved" detail={store.scenes.list().length ? String(store.scenes.list().length) : undefined} />
        <If when={store.scenes.list().length === 0}>
          <Text class="text-xs text-muted-foreground">No saved scenes for this database yet.</Text>
        </If>
        <Each of={store.scenes.list()} key={(s) => s.name}>
          {(s) => (
            <View class="flex-row items-center gap-1">
              <Row
                class="flex-1"
                onPress={() => {
                  open.set(false);
                  store.openScene(s());
                }}
                accessibilityLabel={`Open ${s().name}`}
                testID={`scene-${s().name}`}
              >
                <View class="flex-1 py-1">
                  <Text class="text-sm text-popover-foreground line-clamp-1">{s().name}</Text>
                  <Text class="text-xs text-muted-foreground tabular-nums">
                    {`${s().nodes.length} ${s().nodes.length === 1 ? "node" : "nodes"} · ${when(s().savedAt)}`}
                  </Text>
                </View>
              </Row>
              <IconButton size="sm" icon="trash" label={`Delete ${s().name}`} onPress={() => store.deleteScene(s().name)} testID={`scene-delete-${s().name}`} />
            </View>
          )}
        </Each>
      </View>

      <Separator />

      <If when={store.filesAvailable()}>
        <View class="flex-row gap-1.5">
          <Button size="sm" variant="outline" icon="download" label="Export file" disabled={empty()} onPress={() => store.exportScene()} class="flex-1" testID="scene-export" />
          <Button
            size="sm"
            variant="outline"
            icon="folder"
            label="Open file…"
            onPress={() => {
              open.set(false);
              store.importScene();
            }}
            class="flex-1"
            testID="scene-import"
          />
        </View>
      </If>
      <View class="flex-row gap-1.5">
        <Button size="sm" variant="outline" icon="copy" label="Copy scene" disabled={empty()} onPress={() => store.copyScene()} class="flex-1" testID="scene-copy" />
        <Button
          size="sm"
          variant="outline"
          icon="plus"
          label="Paste scene"
          onPress={() => {
            open.set(false);
            store.pasteScene();
          }}
          class="flex-1"
          testID="scene-paste"
        />
      </View>
      <Text class="text-xs text-muted-foreground">
        {store.filesAvailable()
          ? "An exported scene goes to Downloads, and opens for anyone connected to the same database."
          : "A copied scene opens for anyone connected to the same database."}
      </Text>
    </Popover>
  );
}
