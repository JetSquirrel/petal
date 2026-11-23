/**
 * The connection manager, the way a database client has one: saved connections on the left, and on the right
 * either a driver to start a new one with or the chosen connection's settings, with Test, Save and Connect.
 * Drivers: Neo4j over its HTTP API, Memgraph over Bolt, Amazon Neptune over openCypher (signed with SigV4 when it
 * uses IAM), NebulaGraph through its HTTP gateway, a Gremlin server (JanusGraph, HugeGraph, Neptune, TinkerPop),
 * and HawDB embedded in Petal. Passwords (and AWS secrets) are kept only while the app runs.
 */
import { signal, Scroll, Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { joinSecret, splitSecret } from "../graph/neptune";
import { useStore } from "../store/app";
import { addressOf, defaultSettings, toForm, type ConnectionSettings, type DriverKind, type SavedConnection } from "../store/connections";
import { Button, Field, Icon, IconButton, Row, SectionTitle, Separator, Switch, TextField } from "../ui";

interface FieldSpec {
  key: string;
  label: string;
  description?: string;
  testID: string;
  autoComplete?: "username" | "url";
  mono?: boolean;
}

interface Driver {
  kind: DriverKind;
  name: string;
  /** Two letters for its mark. */
  mark: string;
  blurb: string;
  group: "server" | "embedded";
  /** Its fields, a row at a time. */
  rows: FieldSpec[][];
  password: boolean;
  /** AWS credentials in place of a password: a secret access key and a session token (Neptune). */
  awsSecret?: boolean;
}

const DRIVERS: Driver[] = [
  {
    kind: "neo4j",
    name: "Neo4j",
    mark: "N4",
    blurb: "Neo4j 5 or later, including Aura, over its HTTP API.",
    group: "server",
    password: true,
    rows: [
      [{ key: "url", label: "Address", description: "http://host:7474, https://…databases.neo4j.io, or a neo4j+s:// URI", testID: "connect-url", autoComplete: "url" }],
      [
        { key: "user", label: "User", testID: "connect-user", autoComplete: "username" },
        { key: "database", label: "Database", testID: "connect-database" },
      ],
    ],
  },
  {
    kind: "memgraph",
    name: "Memgraph",
    mark: "MG",
    blurb: "Memgraph over Bolt, its binary protocol.",
    group: "server",
    password: true,
    rows: [
      [{ key: "url", label: "Address", description: "bolt://host:7687, or bolt+s:// for TLS (Memgraph Cloud)", testID: "connect-bolt-url", autoComplete: "url" }],
      [
        { key: "user", label: "User", description: "Empty when authentication is off", testID: "connect-bolt-user", autoComplete: "username" },
        { key: "database", label: "Database", description: "Empty for the default", testID: "connect-bolt-database" },
      ],
    ],
  },
  {
    kind: "neptune",
    name: "Amazon Neptune",
    mark: "AN",
    blurb: "Neptune Database over openCypher, with IAM authentication or without.",
    group: "server",
    password: true,
    awsSecret: true,
    rows: [
      [
        {
          key: "url",
          label: "Endpoint",
          description: "https://…neptune.amazonaws.com:8182, the cluster's or an instance's. Reached only inside its VPC.",
          testID: "connect-neptune-url",
          autoComplete: "url",
        },
      ],
      [
        { key: "accessKeyId", label: "Access key ID", description: "Empty when IAM authentication is off", testID: "connect-neptune-key" },
        { key: "region", label: "Region", description: "Empty to read it from the endpoint", testID: "connect-neptune-region" },
      ],
    ],
  },
  {
    kind: "nebula",
    name: "NebulaGraph",
    mark: "NG",
    blurb: "NebulaGraph 3.5 or later, through nebula-http-gateway.",
    group: "server",
    password: true,
    rows: [
      [{ key: "gateway", label: "Gateway", description: "Where nebula-http-gateway listens: http://host:8080", testID: "connect-gateway", autoComplete: "url" }],
      [
        { key: "graphd", label: "graphd", description: "As the gateway reaches it", testID: "connect-graphd" },
        { key: "space", label: "Space", testID: "connect-space" },
      ],
      [{ key: "user", label: "User", testID: "connect-nebula-user", autoComplete: "username" }],
    ],
  },
  {
    kind: "gremlin",
    name: "Gremlin",
    mark: "GR",
    blurb: "Any Gremlin server: TinkerPop, JanusGraph, HugeGraph, Amazon Neptune.",
    group: "server",
    password: true,
    rows: [
      [
        {
          key: "url",
          label: "Address",
          description: "ws://host:8182/gremlin or wss://; https://…:8182/gremlin for HTTP (Neptune)",
          testID: "connect-gremlin-url",
          autoComplete: "url",
        },
      ],
      [
        { key: "user", label: "User", description: "Empty when authentication is off", testID: "connect-gremlin-user", autoComplete: "username" },
        { key: "traversal", label: "Traversal source", description: "g, or the server's name for it", testID: "connect-traversal" },
      ],
    ],
  },
  {
    kind: "hawdb",
    name: "HawDB",
    mark: "HW",
    blurb: "An embedded database in a folder on this computer, opened by Petal itself.",
    group: "embedded",
    password: false,
    rows: [
      [
        {
          key: "path",
          label: "Folder",
          description: "Created when it is missing; empty for a database in memory. Only one app can have it open at a time.",
          testID: "connect-path",
          mono: true,
        },
      ],
    ],
  },
];

const driverOf = (kind: DriverKind) => DRIVERS.find((d) => d.kind === kind)!;

function defaultHawDbPath(): string {
  const dir = typeof process !== "undefined" ? process.dataDir : null;
  return dir ? `${dir.replace(/[\\/]+$/, "")}/petal.hawdb` : "";
}

/** What a saved connection is called: its name, or its address. */
function titleOf(c: SavedConnection): string {
  return c.name || addressOf(c.settings);
}

export function ConnectDialog() {
  const store = useStore();
  return (
    <Dialog
      open={store.connectOpen()}
      onOpenChange={(e) => store.connectOpen.set(e.open)}
      accessibilityLabel="Connections"
      animation="fade"
      backdropClass="bg-scrim"
      class="m-auto flex-row overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
      style={{ width: 820, maxWidth: "94%", height: 560, maxHeight: "90%" }}
      testID="connect-dialog"
    >
      <ConnectionManager />
    </Dialog>
  );
}

type Pane = { mode: "pick" } | { mode: "edit"; id: string | null; kind: DriverKind; nonce: number };

function ConnectionManager() {
  const store = useStore();
  let nonce = 0;
  const editing = (c: SavedConnection): Pane => ({ mode: "edit", id: c.id, kind: c.settings.kind, nonce: ++nonce });
  const first = store.connections().find((c) => c.id === store.activeConnection()) ?? store.connections()[0];
  const pane = signal<Pane>(first ? editing(first) : { mode: "pick" });
  const selectedId = () => {
    const p = pane();
    return p.mode === "edit" ? p.id : null;
  };

  return (
    <>
      <View class="w-64 border-r border-border bg-sidebar">
        <View class="h-14 flex-row items-center justify-between px-3">
          <Text class="text-sm font-semibold text-foreground">Connections</Text>
          <IconButton
            size="sm"
            icon="plus"
            label="New connection"
            selected={pane().mode === "pick" || selectedId() === null}
            onPress={() => pane.set({ mode: "pick" })}
            testID="new-connection"
          />
        </View>
        <Scroll class="flex-1">
          <View class="gap-0.5 px-2 pb-2">
            <If when={store.connections().length === 0}>
              <Text class="px-2 py-1 text-xs text-muted-foreground">No saved connections yet. Pick a database on the right to add one.</Text>
            </If>
            <Each of={store.connections()} key={(c) => c.id}>
              {(c) => (
                <Row selected={selectedId() === c().id} onPress={() => pane.set(editing(c()))} testID={`saved-${c().id}`} accessibilityLabel={titleOf(c())}>
                  <DriverMark kind={c().settings.kind} />
                  <View class="flex-1 gap-0.5 py-1.5">
                    <Text class="text-sm text-foreground line-clamp-1">{titleOf(c())}</Text>
                    <Text class="text-xs text-muted-foreground line-clamp-1">
                      {c().name ? `${driverOf(c().settings.kind).name}, ${addressOf(c().settings)}` : driverOf(c().settings.kind).name}
                    </Text>
                  </View>
                  <If when={store.activeConnection() === c().id && store.connection() === "ready"}>
                    <View class="h-2 w-2 rounded-full bg-success" accessibilityLabel="In use" />
                  </If>
                </Row>
              )}
            </Each>
          </View>
        </Scroll>
        <Separator />
        <View class="p-2">
          <Row
            selected={store.source().kind === "demo"}
            onPress={() => {
              store.connectOpen.set(false);
              if (store.source().kind !== "demo") store.useDemo();
            }}
            testID="use-demo"
            accessibilityLabel="Use the demo graph"
          >
            <View class="h-7 w-7 items-center justify-center rounded-md bg-accent">
              <Icon name="sliders" size={14} tone="accent-foreground" />
            </View>
            <View class="flex-1 gap-0.5 py-1.5">
              <Text class="text-sm text-foreground">Demo graph</Text>
              <Text class="text-xs text-muted-foreground">Built in, no database needed</Text>
            </View>
          </Row>
        </View>
      </View>

      <View class="flex-1">
        <If
          when={pane().mode === "edit"}
          else={<DriverPicker onPick={(kind) => pane.set({ mode: "edit", id: null, kind, nonce: ++nonce })} />}
        >
          {/* Keyed on the pane, so each connection gets a fresh editor. */}
          <Each of={[pane()]} key={(p) => (p.mode === "edit" ? `${p.id}:${p.nonce}` : "pick")}>
            {(p) => {
              const edit = p() as Extract<Pane, { mode: "edit" }>;
              return (
                <ConnectionEditor
                  saved={store.connections().find((c) => c.id === edit.id)}
                  kind={edit.kind}
                  onSaved={(c) => pane.set(editing(c))}
                  onDeleted={() => {
                    const next = store.connections()[0];
                    pane.set(next ? editing(next) : { mode: "pick" });
                  }}
                />
              );
            }}
          </Each>
        </If>
      </View>
    </>
  );
}

function DriverMark(props: { kind: DriverKind; large?: boolean }) {
  return (
    <View class={`${props.large ? "h-10 w-10 rounded-lg" : "h-7 w-7 rounded-md"} items-center justify-center border border-border bg-background`}>
      <Text class={`${props.large ? "text-sm" : "text-xs"} font-semibold tracking-tight text-muted-foreground`}>{driverOf(props.kind).mark}</Text>
    </View>
  );
}

function PaneHeader(props: { title: string; detail: string; kind?: DriverKind }) {
  const store = useStore();
  return (
    <View class="flex-row items-start gap-3 px-5 pb-4 pt-4">
      <If when={props.kind}>{(k) => <DriverMark kind={k()} large />}</If>
      <View class="flex-1 gap-0.5">
        <Text class="text-base font-semibold text-popover-foreground line-clamp-1">{props.title}</Text>
        <Text class="text-sm text-muted-foreground">{props.detail}</Text>
      </View>
      <IconButton size="sm" icon="x" label="Close" onPress={() => store.connectOpen.set(false)} />
    </View>
  );
}

function DriverPicker(props: { onPick: (kind: DriverKind) => void }) {
  const groups = [
    { title: "Servers", drivers: DRIVERS.filter((d) => d.group === "server") },
    { title: "On this computer", drivers: DRIVERS.filter((d) => d.group === "embedded") },
  ];
  return (
    <>
      <PaneHeader title="New connection" detail="Choose the database to connect to." />
      <Scroll class="flex-1">
        <View class="gap-5 px-5 pb-5">
          <Each of={groups}>
            {(g) => (
              <View class="gap-2">
                <SectionTitle title={g().title} />
                <View class="flex-row flex-wrap gap-2">
                  <Each of={g().drivers} key={(d) => d.kind}>
                    {(d) => (
                      <Row class="items-start border border-border p-3" onPress={() => props.onPick(d().kind)} testID={`driver-${d().kind}`} accessibilityLabel={d().name}>
                        <View class="flex-row items-start gap-3" style={{ width: 222 }}>
                          <DriverMark kind={d().kind} large />
                          <View class="flex-1 gap-0.5">
                            <Text class="text-sm font-medium text-foreground">{d().name}</Text>
                            <Text class="text-xs text-muted-foreground">{d().blurb}</Text>
                          </View>
                        </View>
                      </Row>
                    )}
                  </Each>
                </View>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
    </>
  );
}

function ConnectionEditor(props: { saved?: SavedConnection; kind: DriverKind; onSaved: (c: SavedConnection) => void; onDeleted: () => void }) {
  const store = useStore();
  const driver = driverOf(props.kind);
  /** The connection as it was when the editor opened: Delete takes it out of the list before the pane moves on. */
  const savedAtOpen = props.saved;
  const isNew = !savedAtOpen;
  const draft = signal<ConnectionSettings>(savedAtOpen?.settings ?? defaultSettings(props.kind, defaultHawDbPath()));
  const name = signal(savedAtOpen?.name ?? "");
  const password = signal(savedAtOpen ? store.passwordOf(savedAtOpen.id) : "");
  const loadDemo = signal(false);
  const working = signal<"test" | "connect" | null>(null);
  const status = signal<{ ok: boolean; message: string } | null>(null);

  const value = (key: string) => (draft() as unknown as Record<string, string>)[key] ?? "";
  const setValue = (key: string, v: string) => {
    draft.set({ ...draft(), [key]: v } as ConnectionSettings);
    status.set(null);
  };
  const form = () => toForm(draft(), password(), loadDemo());
  const inUse = () => !!savedAtOpen && store.activeConnection() === savedAtOpen.id && store.connection() === "ready";

  const test = async () => {
    if (working()) return;
    working.set("test");
    status.set(null);
    status.set(await store.testConnection(form()));
    working.set(null);
  };
  const save = () => {
    const saved = store.saveConnection({ id: savedAtOpen?.id, name: name(), settings: draft() }, driver.password ? password() : undefined);
    store.notify(`Saved ${titleOf(saved)}.`);
    props.onSaved(saved);
  };
  const connect = async () => {
    if (working()) return;
    working.set("connect");
    status.set(null);
    const message = await store.connect(form(), { id: savedAtOpen?.id, name: name() });
    working.set(null);
    if (message) status.set({ ok: false, message });
    else store.connectOpen.set(false);
  };

  return (
    <>
      <PaneHeader
        kind={props.kind}
        title={isNew ? `New ${driver.name} connection` : titleOf(savedAtOpen!)}
        detail={inUse() ? `In use now. ${driver.blurb}` : driver.blurb}
      />
      <Scroll class="flex-1">
        <View class="gap-3 px-5 pb-4">
          <Field label="Name" description="How it shows in the list. Empty to use its address.">
            <TextField
              value={name()}
              onChange={name.set}
              onSubmit={connect}
              placeholder={addressOf(draft())}
              testID="connect-name"
              accessibilityLabel="Name"
            />
          </Field>
          <Separator class="my-1" />
          <Each of={driver.rows}>
            {(row) => (
              <View class="flex-row gap-3">
                <Each of={row()} key={(f) => f.key}>
                  {(f) => (
                    <Field label={f().label} description={f().description} class="flex-1">
                      <TextField
                        value={value(f().key)}
                        onChange={(v) => setValue(f().key, v)}
                        onSubmit={connect}
                        verbatim
                        mono={f().mono}
                        autoComplete={f().autoComplete}
                        testID={f().testID}
                        accessibilityLabel={f().label}
                      />
                    </Field>
                  )}
                </Each>
              </View>
            )}
          </Each>
          <If when={driver.awsSecret}>
            <View class="flex-row gap-3">
              <Field label="Secret access key" description="Kept only while Petal runs, never saved." class="flex-1">
                <TextField
                  value={splitSecret(password()).secret}
                  onChange={(v) => {
                    password.set(joinSecret(v, splitSecret(password()).sessionToken));
                    status.set(null);
                  }}
                  onSubmit={connect}
                  masked
                  verbatim
                  testID="connect-password"
                  accessibilityLabel="Secret access key"
                />
              </Field>
              <Field label="Session token" description="For temporary credentials only." class="flex-1">
                <TextField
                  value={splitSecret(password()).sessionToken}
                  onChange={(v) => {
                    password.set(joinSecret(splitSecret(password()).secret, v));
                    status.set(null);
                  }}
                  onSubmit={connect}
                  masked
                  verbatim
                  testID="connect-session-token"
                  accessibilityLabel="Session token"
                />
              </Field>
            </View>
          </If>
          <If when={driver.password && !driver.awsSecret}>
            <Field label="Password" description="Kept only while Petal runs, never saved.">
              <TextField
                value={password()}
                onChange={(v) => {
                  password.set(v);
                  status.set(null);
                }}
                onSubmit={connect}
                masked
                autoComplete="current-password"
                testID="connect-password"
                accessibilityLabel="Password"
              />
            </Field>
          </If>
          <If when={props.kind === "hawdb"}>
            <Switch label="Load the demo graph into a new, empty database" checked={loadDemo()} onChange={loadDemo.set} testID="connect-load-demo" />
          </If>
          <If when={status()}>
            {(s) => (
              <View
                class={`flex-row items-start gap-2 rounded-md p-2.5 ${s().ok ? "bg-success/10" : "bg-destructive/10"}`}
                testID={s().ok ? "connect-ok" : "connect-error"}
              >
                <Icon name={s().ok ? "check" : "alert"} size={14} tone={s().ok ? "success" : "destructive"} />
                <Text class={`flex-1 text-xs ${s().ok ? "text-success" : "text-destructive"}`}>{s().message}</Text>
              </View>
            )}
          </If>
        </View>
      </Scroll>
      <View class="flex-row items-center justify-between gap-2 border-t border-border px-5 py-3">
        <If when={savedAtOpen} else={<View />}>
          {(saved) => (
            <Button
              variant="ghost"
              icon="trash"
              label="Delete"
              onPress={() => {
                store.deleteConnection(saved().id);
                store.notify(`Deleted ${titleOf(saved())}.`);
                props.onDeleted();
              }}
              testID="connect-delete"
            />
          )}
        </If>
        <View class="flex-row gap-2">
          <Button variant="outline" label={working() === "test" ? "Testing…" : "Test"} disabled={!!working()} onPress={test} testID="connect-test" />
          <Button variant="outline" label="Save" disabled={!!working()} onPress={save} testID="connect-save" />
          <Button
            variant="primary"
            label={working() === "connect" ? "Connecting…" : props.kind === "hawdb" ? "Open" : "Connect"}
            disabled={!!working()}
            onPress={connect}
            testID="connect-submit"
          />
        </View>
      </View>
    </>
  );
}
