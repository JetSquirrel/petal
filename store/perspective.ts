/**
 * The perspective: how each category (a label) and relationship type looks, kept per database.
 *
 * A category's color is a slot of nsh-graph's categorical palette, not a hex value, so it follows the
 * light and dark palettes; slots are handed out in the order categories first appear and never cycled.
 * Past the eighth, categories share the neutral color until the person picks one.
 */
import { colorScheme, signal, Storage } from "nsh";
import { OTHER, PALETTE_DARK, PALETTE_LIGHT } from "nsh-graph";
import type { DbNode } from "../graph/model";

export type SizeChoice = "auto" | "small" | "medium" | "large";

export interface CategoryStyle {
  /** A palette slot, or -1 for the neutral color. */
  color: number;
  /** The property captions show; unset: the first of name, title, … the node has. */
  caption?: string;
  size: SizeChoice;
  hidden: boolean;
}

export interface Perspective {
  /** Categories in the order they first appeared: the order that picks a node's category among its labels. */
  order: string[];
  categories: Record<string, CategoryStyle>;
  hiddenTypes: string[];
}

export const PALETTE_SIZE = PALETTE_LIGHT.length;

export const SIZE_RADIUS: Record<Exclude<SizeChoice, "auto">, number> = { small: 11, medium: 18, large: 28 };

const empty = (): Perspective => ({ order: [], categories: {}, hiddenTypes: [] });

export function paletteColor(slot: number, scheme: "light" | "dark" = colorScheme()): string {
  const p = scheme === "dark" ? PALETTE_DARK : PALETTE_LIGHT;
  return slot >= 0 && slot < p.length ? p[slot] : OTHER;
}

export function createPerspective() {
  const state = signal<Perspective>(empty());
  let storageKey: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    if (!storageKey) return;
    clearTimeout(saveTimer);
    const key = storageKey;
    saveTimer = setTimeout(() => {
      Storage.setItem(key, JSON.stringify(state())).catch(() => {});
    }, 300);
  };

  const change = (fn: (p: Perspective) => Perspective) => {
    state.update(fn);
    save();
  };

  /** Loads the perspective Petal kept for a database (`source.key`). */
  async function load(sourceKey: string) {
    storageKey = `perspective:${sourceKey}`;
    let loaded = empty();
    try {
      const raw = await Storage.getItem(storageKey);
      if (raw) loaded = { ...empty(), ...(JSON.parse(raw) as Perspective) };
    } catch {
      // a damaged entry starts over
    }
    state.set(loaded);
  }

  /** Gives categories seen for the first time their slots, biggest first (as the schema orders them). */
  function register(labels: Iterable<string>) {
    const fresh = [...labels].filter((l) => !state().categories[l]);
    if (fresh.length === 0) return;
    change((p) => {
      const used = new Set(Object.values(p.categories).map((c) => c.color));
      const categories = { ...p.categories };
      const order = [...p.order];
      for (const l of fresh) {
        if (categories[l]) continue;
        let slot = -1;
        for (let i = 0; i < PALETTE_SIZE; i++) {
          if (!used.has(i)) {
            slot = i;
            break;
          }
        }
        if (slot >= 0) used.add(slot);
        categories[l] = { color: slot, size: "auto", hidden: false };
        order.push(l);
      }
      return { ...p, order, categories };
    });
  }

  /** The label a node is drawn as: the one of its labels that came first. */
  function categoryOf(node: DbNode): string {
    if (node.labels.length <= 1) return node.labels[0] ?? "(no label)";
    const order = state().order;
    let best = node.labels[0];
    let bestAt = Infinity;
    for (const l of node.labels) {
      const at = order.indexOf(l);
      if (at >= 0 && at < bestAt) {
        best = l;
        bestAt = at;
      }
    }
    return best;
  }

  function style(label: string): CategoryStyle {
    return state().categories[label] ?? { color: -1, size: "auto", hidden: false };
  }

  function setStyle(label: string, patch: Partial<CategoryStyle>) {
    change((p) => ({ ...p, categories: { ...p.categories, [label]: { ...style(label), ...patch } } }));
  }

  function toggleType(type: string) {
    change((p) => ({
      ...p,
      hiddenTypes: p.hiddenTypes.includes(type) ? p.hiddenTypes.filter((t) => t !== type) : [...p.hiddenTypes, type],
    }));
  }

  function resetStyles() {
    const order = state().order;
    change(() => ({
      order,
      hiddenTypes: [],
      categories: Object.fromEntries(order.map((l, i) => [l, { color: i < PALETTE_SIZE ? i : -1, size: "auto" as const, hidden: false }])),
    }));
  }

  return { state, load, register, categoryOf, style, setStyle, toggleType, resetStyles };
}

export type PerspectiveStore = ReturnType<typeof createPerspective>;
