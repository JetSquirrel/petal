/**
 * Connecting to a database: Neo4j over its HTTP API, NebulaGraph through its HTTP gateway, or a HawDB
 * database embedded in Petal. Passwords are kept only while the app runs; the rest is remembered, per kind.
 */
import { signal, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { useStore, type ConnectionForm } from "../store/app";
import { Button, Field, Icon, IconButton, Segmented, Switch, TextField } from "../ui";

type Kind = ConnectionForm["kind"];

const KINDS: { value: Kind; label: string }[] = [
  { value: "neo4j", label: "Neo4j" },
  { value: "nebula", label: "NebulaGraph" },
  { value: "hawdb", label: "HawDB" },
];

const ABOUT: Record<Kind, string> = {
  neo4j: "Neo4j 5 or later, including Aura, over its HTTP API.",
  nebula: "NebulaGraph 3.5 or later, through its HTTP gateway (nebula-http-gateway).",
  hawdb: "An embedded HawDB database: a folder on this computer that Petal opens itself.",
};

export function ConnectDialog() {
  const store = useStore();
  return (
    <Dialog
      open={store.connectOpen()}
      onOpenChange={(e) => store.connectOpen.set(e.open)}
      accessibilityLabel="Connect to a database"
      animation="fade"
      backdropClass="bg-scrim"
      class="m-auto gap-5 rounded-xl border border-border bg-popover p-5 shadow-xl"
      style={{ width: 480, maxWidth: "94%" }}
      testID="connect-dialog"
    >
      <ConnectForm />
    </Dialog>
  );
}

function defaultHawDbPath(): string {
  const dir = typeof process !== "undefined" ? process.dataDir : null;
  return dir ? `${dir.replace(/[\\/]+$/, "")}/petal.hawdb` : "";
}

function ConnectForm() {
  const store = useStore();
  const kept = store.connections();
  const current = store.source().kind;
  const kind = signal<Kind>(current !== "demo" ? current : (kept.last ?? "neo4j"));

  const neo4j = {
    url: signal(kept.neo4j?.url ?? "http://localhost:7474"),
    user: signal(kept.neo4j?.user ?? "neo4j"),
    database: signal(kept.neo4j?.database ?? "neo4j"),
  };
  const nebula = {
    gateway: signal(kept.nebula?.gateway ?? "http://localhost:8080"),
    graphd: signal(kept.nebula?.graphd ?? "graphd:9669"),
    user: signal(kept.nebula?.user ?? "root"),
    space: signal(kept.nebula?.space ?? ""),
  };
  const hawdb = { path: signal(kept.hawdb?.path ?? defaultHawDbPath()), loadDemo: signal(false) };
  const password = signal("");
  const connecting = signal(false);
  const error = signal<string | null>(null);

  const form = (): ConnectionForm => {
    switch (kind()) {
      case "neo4j":
        return { kind: "neo4j", url: neo4j.url(), user: neo4j.user(), password: password(), database: neo4j.database() };
      case "nebula":
        return { kind: "nebula", gateway: nebula.gateway(), graphd: nebula.graphd(), user: nebula.user(), password: password(), space: nebula.space() };
      case "hawdb":
        return { kind: "hawdb", path: hawdb.path(), loadDemo: hawdb.loadDemo() };
    }
  };

  const connect = async () => {
    if (connecting()) return;
    connecting.set(true);
    error.set(null);
    const message = await store.connect(form());
    connecting.set(false);
    if (message) error.set(message);
    else store.connectOpen.set(false);
  };

  return (
    <>
      <View class="flex-row items-start gap-3">
        <View class="h-9 w-9 items-center justify-center rounded-lg bg-accent">
          <Icon name="database" size={18} tone="accent-foreground" />
        </View>
        <View class="flex-1 gap-0.5">
          <Text class="text-base font-semibold text-popover-foreground">Connect to a database</Text>
          <Text class="text-sm text-muted-foreground">{ABOUT[kind()]}</Text>
        </View>
        <IconButton size="sm" icon="x" label="Close" onPress={() => store.connectOpen.set(false)} />
      </View>

      <Segmented
        label="Database"
        value={kind()}
        options={KINDS}
        onChange={(k) => {
          kind.set(k);
          error.set(null);
          password.set("");
        }}
        testID="connect-kind"
      />

      <View class="gap-3">
        <If when={kind() === "neo4j"}>
          <Field label="Address" description="http://host:7474, https://…databases.neo4j.io, or a neo4j+s:// URI">
            <TextField value={neo4j.url()} onChange={neo4j.url.set} onSubmit={connect} verbatim autoComplete="url" testID="connect-url" accessibilityLabel="Address" />
          </Field>
          <View class="flex-row gap-3">
            <Field label="User" class="flex-1">
              <TextField value={neo4j.user()} onChange={neo4j.user.set} onSubmit={connect} verbatim autoComplete="username" testID="connect-user" accessibilityLabel="User" />
            </Field>
            <Field label="Database" class="flex-1">
              <TextField value={neo4j.database()} onChange={neo4j.database.set} onSubmit={connect} verbatim testID="connect-database" accessibilityLabel="Database" />
            </Field>
          </View>
        </If>

        <If when={kind() === "nebula"}>
          <Field label="Gateway" description="Where nebula-http-gateway listens: http://host:8080">
            <TextField
              value={nebula.gateway()}
              onChange={nebula.gateway.set}
              onSubmit={connect}
              verbatim
              autoComplete="url"
              testID="connect-gateway"
              accessibilityLabel="Gateway"
            />
          </Field>
          <View class="flex-row gap-3">
            <Field label="graphd" description="As the gateway reaches it" class="flex-1">
              <TextField value={nebula.graphd()} onChange={nebula.graphd.set} onSubmit={connect} verbatim testID="connect-graphd" accessibilityLabel="graphd address" />
            </Field>
            <Field label="Space" class="flex-1">
              <TextField value={nebula.space()} onChange={nebula.space.set} onSubmit={connect} verbatim testID="connect-space" accessibilityLabel="Space" />
            </Field>
          </View>
          <Field label="User">
            <TextField value={nebula.user()} onChange={nebula.user.set} onSubmit={connect} verbatim autoComplete="username" testID="connect-nebula-user" accessibilityLabel="User" />
          </Field>
        </If>

        <If when={kind() !== "hawdb"}>
          <Field label="Password">
            <TextField
              value={password()}
              onChange={password.set}
              onSubmit={connect}
              masked
              autoComplete="current-password"
              testID="connect-password"
              accessibilityLabel="Password"
            />
          </Field>
        </If>

        <If when={kind() === "hawdb"}>
          <Field label="Folder" description="HawDB keeps a database in a folder and creates it when it is missing. Only one app can have it open at a time.">
            <TextField value={hawdb.path()} onChange={hawdb.path.set} onSubmit={connect} verbatim mono testID="connect-path" accessibilityLabel="Folder" />
          </Field>
          <Switch label="Load the demo graph into a new, empty database" checked={hawdb.loadDemo()} onChange={hawdb.loadDemo.set} testID="connect-load-demo" />
        </If>

        <If when={error()}>
          {(e) => (
            <View class="flex-row items-start gap-2 rounded-md bg-destructive/10 p-2.5" testID="connect-error">
              <Icon name="alert" size={14} tone="destructive" />
              <Text class="flex-1 text-xs text-destructive">{e()}</Text>
            </View>
          )}
        </If>
      </View>

      <View class="flex-row items-center justify-between gap-2">
        <If when={store.source().kind !== "demo"} else={<View />}>
          <Button
            variant="ghost"
            label="Use the demo graph"
            onPress={() => {
              store.connectOpen.set(false);
              store.useDemo();
            }}
            testID="use-demo"
          />
        </If>
        <View class="flex-row gap-2">
          <Button variant="outline" label="Cancel" onPress={() => store.connectOpen.set(false)} />
          <Button
            variant="primary"
            label={connecting() ? "Connecting…" : kind() === "hawdb" ? "Open" : "Connect"}
            disabled={connecting()}
            onPress={connect}
            testID="connect-submit"
          />
        </View>
      </View>
    </>
  );
}
