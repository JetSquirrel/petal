/**
 * Files on this computer: exports written to the Downloads folder, scene files opened with the system's picker,
 * and saved scenes kept as files in Petal's data folder. The web build has no file system: there exports go to
 * the clipboard and saved scenes to Storage (`filesAvailable()` is false).
 */
import { Picker } from "nsh";
import fs from "fs/promises";
import os from "os";
import proc from "process";

/** Whether Petal can write files here (the desktop apps, not the web build). */
export function filesAvailable(): boolean {
  try {
    return !!proc.dataDir && proc.platform !== "web";
  } catch {
    return false;
  }
}

const sep = () => (proc.platform === "windows" ? "\\" : "/");
export const join = (...parts: string[]) => parts.join(sep());

/** A file name made safe on every system: no separators, reserved characters or trailing dots. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned.slice(0, 120) || "untitled";
}

/** `2026-11-23 15-04`: a stamp that sorts and is allowed in file names. */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
}

/** The folder exports go to: Downloads in the home folder. */
export function exportFolder(): string {
  return join(os.homedir(), "Downloads");
}

/**
 * Writes `text` to `name` in the Downloads folder, adding " (2)", " (3)", … rather than replacing a file.
 * Resolves with the path written.
 */
export async function exportFile(name: string, text: string): Promise<string> {
  const folder = exportFolder();
  if (!(await fs.exists(folder))) await fs.mkdir(folder, { recursive: true });
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let path = join(folder, name);
  for (let i = 2; (await fs.exists(path)) && i < 1000; i++) path = join(folder, `${base} (${i})${ext}`);
  await fs.writeFile(path, text);
  return path;
}

/** Lets the person pick a JSON file (`kind` names it in the picker) and resolves with its text, or null when they cancel. */
export async function pickJsonFile(kind = "Petal scene"): Promise<{ name: string; text: string } | null> {
  const [picked] = await Picker.pickFiles({
    multiple: false,
    filters: [{ name: kind, extensions: ["json"] }],
    maxSize: 64 * 1024 * 1024,
  });
  if (!picked) return null;
  if (picked.status !== "read" || !picked.file) throw new Error(`${picked.name} is too large to open.`);
  return { name: picked.name, text: await picked.file.text() };
}

/** The folder a database's saved scenes are kept in, inside Petal's data folder. */
export function scenesFolder(sourceKey: string): string {
  return join(proc.dataDir!, "scenes", safeFileName(encodeURIComponent(sourceKey)));
}

/** Reads every `.json` file of `folder` (none when it is missing), skipping ones that don't read. */
export async function readJsonFiles(folder: string): Promise<{ file: string; text: string }[]> {
  if (!(await fs.exists(folder))) return [];
  const out: { file: string; text: string }[] = [];
  for (const name of await fs.readdir(folder)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push({ file: name, text: await fs.readFile(join(folder, name), "utf8") });
    } catch {
      // an unreadable file is left out
    }
  }
  return out;
}

export async function writeFileIn(folder: string, name: string, text: string) {
  if (!(await fs.exists(folder))) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(join(folder, name), text);
}

export async function removeFileIn(folder: string, name: string) {
  const path = join(folder, name);
  if (await fs.exists(path)) await fs.unlink(path);
}
