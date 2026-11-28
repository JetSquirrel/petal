/**
 * Where HawDB comes from. Petal's desktop builds don't link HawDB (it would be most of their size): they
 * run `petal-hawdb` (`hawdb-helper/`), which Petal downloads from its GitHub releases the first time
 * HawDB is used, checks against the SHA-256 pinned below, and keeps in its data folder. The phones link
 * HawDB in, and the web has none.
 *
 * Releasing a new helper: bump `hawdb-helper/Cargo.toml`'s version, push the tag
 * `hawdb-helper-v<version>` (the `hawdb-helper` workflow builds and attaches the programs and
 * `SHA256SUMS`), then pin the version and the checksums here with `hawdb-helper/pin.sh <version>`.
 */
import { HawDbHelper } from "petal/native";
import proc from "process";

export const HELPER_VERSION = "0.1.0";
const RELEASE = `https://github.com/JetSquirrel/petal/releases/download/hawdb-helper-v${HELPER_VERSION}/`;

/** The builds of `HELPER_VERSION`, by `process.platform` and `process.arch`: the gzipped program and its SHA-256. */
export const BUILDS: Record<string, { target: string; sha256: string }> = {
  "windows-x86_64": { target: "x86_64-pc-windows-msvc", sha256: "1f136abd1fa64eb29f7cf49611e6886762d1d6982be1eba36836eb91b82a007f" },
  "windows-aarch64": { target: "aarch64-pc-windows-msvc", sha256: "41e287326a8ab4ee71d43a5e034c74b5484873f47d9ef373eacd925a0ea6cd19" },
  "macos-aarch64": { target: "aarch64-apple-darwin", sha256: "1d7cda9110429fb0aabf63eb314bbef4ce82cb4c9c8f36fa6df99ed59aa30d86" },
  "macos-x86_64": { target: "x86_64-apple-darwin", sha256: "8f902d0f4da25ef2fdd690c24de2c422319d9710f3c8a98b461daee3d1097dd4" },
  "linux-x86_64": { target: "x86_64-unknown-linux-gnu", sha256: "8e55f73b4b643f8d8c0e7fe787cade1e611074bb250526dcc3cdda9ec807a8a2" },
  "linux-aarch64": { target: "aarch64-unknown-linux-gnu", sha256: "341f66bffd0abde17691f5ccf51e1a380c2a52747f0cef629f63a1809c2e2813" },
};

/** About how much the download is, for the button that starts it. */
export const DOWNLOAD_MB = 10;

/**
 * - `ready`: HawDB runs (linked in, or the helper is installed);
 * - `missing`: the helper can be downloaded;
 * - `unpinned`: this Petal has no checksum for this computer's build, so it won't download one;
 * - `none`: no HawDB here (the web).
 */
export type HawDbState = "ready" | "missing" | "unpinned" | "none";

let native: HawDbHelper | null = null;
const helper = () => (native ??= new HawDbHelper());

const isWindows = () => proc.platform === "windows";
const sep = () => (isWindows() ? "\\" : "/");

export function buildKey(): string {
  return `${proc.platform}-${proc.arch}`;
}

/** Where the downloaded helper is kept: `<data folder>/hawdb/<version>/petal-hawdb[.exe]`. */
export function installedPath(): string {
  const dir = proc.dataDir;
  if (!dir) return "";
  return [dir.replace(/[\\/]+$/, ""), "hawdb", HELPER_VERSION, `petal-hawdb${isWindows() ? ".exe" : ""}`].join(sep());
}

/** The helper found the last time: checked once, since checking runs the program. */
let resolved: string | null = null;

/**
 * The helper `HawDb` runs, `""` when there is none (or HawDB is linked in, where none is needed): one built
 * from Petal's checkout in development builds, else the downloaded one when it runs and speaks this
 * Petal's protocol.
 */
export function helperPath(): string {
  if (resolved !== null) return resolved;
  let path = "";
  try {
    const h = helper();
    if (h.kind() === "download") {
      const dev = h.devPath();
      const installed = installedPath();
      if (dev && h.check(dev)) path = dev;
      else if (installed && h.check(installed)) path = installed;
    }
  } catch {
    path = "";
  }
  resolved = path;
  return path;
}

export function hawDbState(): HawDbState {
  let kind: string;
  try {
    kind = helper().kind();
  } catch {
    return "none";
  }
  if (kind === "linked") return "ready";
  if (kind !== "download") return "none";
  if (helperPath()) return "ready";
  return BUILDS[buildKey()]?.sha256 ? "missing" : "unpinned";
}

/** What to say when HawDB is needed and isn't there. */
export function missingMessage(state: HawDbState = hawDbState()): string {
  if (state === "unpinned") return `This version of Petal has no HawDB download for ${buildKey()}.`;
  if (state === "none") return "HawDB opens a database on this computer, which the web version of Petal can't do.";
  return `HawDB isn't on this computer yet. Petal downloads it once (about ${DOWNLOAD_MB} MB): open a HawDB connection and choose Download HawDB.`;
}

/** Downloads the helper for this computer, checks it and installs it. Resolves with its version. */
export async function installHelper(): Promise<string> {
  const build = BUILDS[buildKey()];
  if (!build?.sha256) throw new Error(missingMessage("unpinned"));
  const dest = installedPath();
  if (!dest) throw new Error("Petal has no data folder to keep HawDB in.");
  const url = `${RELEASE}petal-hawdb-${build.target}.gz`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Couldn't download HawDB: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`Couldn't download HawDB: the server answered ${res.status}.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const version = await helper().install(bytes, build.sha256, dest);
  resolved = null;
  return version;
}

/** Forgets the helper found, so the next `helperPath` looks again (tests). */
export function resetHelper() {
  resolved = null;
}
