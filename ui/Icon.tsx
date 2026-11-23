/**
 * Petal's icons: stroked paths on a 24-point grid, drawn on a canvas in a theme color, so they follow the
 * appearance and stay crisp at any size.
 */
import { Canvas, Path2D, token } from "nsh";

const PATHS = {
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M16.5 16.5 L21 21",
  pencil: "M4 20 H8 L19 9 L15 5 L4 16 Z M13 7 L17 11",
  x: "M6 6 L18 18 M18 6 L6 18",
  plus: "M12 5 V19 M5 12 H19",
  minus: "M5 12 H19",
  fit: "M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15",
  undo: "M9 14 L4 9 L9 4 M4 9 H15 A5 5 0 0 1 15 19 H11",
  trash: "M4 7 H20 M10 11 V17 M14 11 V17 M6 7 L7 20 H17 L18 7 M9 7 V4 H15 V7",
  eye: "M2.5 12 A10.5 10.5 0 0 1 21.5 12 A10.5 10.5 0 0 1 2.5 12 Z M12 9 A3 3 0 1 0 12 15 A3 3 0 1 0 12 9",
  eyeOff:
    "M10.7 5.1 A10.5 10.5 0 0 1 21.5 12 A10.6 10.6 0 0 1 20.2 14.6 M14.1 14.1 A3 3 0 0 1 9.9 9.9 M17.5 17.5 A10.5 10.5 0 0 1 2.5 12 A10.6 10.6 0 0 1 6.5 6.4 M3 3 L21 21",
  pin: "M12 16 V22 M8 3 H16 M9.5 3 V9 L6 14 H18 L14.5 9 V3",
  expand: "M12 9.5 A2.5 2.5 0 1 0 12 14.5 A2.5 2.5 0 1 0 12 9.5 M12 9.5 V3 M14.2 13.2 L20 17 M9.8 13.2 L4 17",
  database: "M4 6 A8 3 0 1 0 20 6 A8 3 0 1 0 4 6 M4 6 V18 A8 3 0 0 0 20 18 V6 M4 12 A8 3 0 0 0 20 12",
  panel: "M4 4 H20 V20 H4 Z M9.5 4 V20",
  relayout: "M20 11 A8 8 0 1 0 17.7 17.7 M20 4 V11 H13",
  loader: "M12 3 A9 9 0 1 1 3 12",
  chevronDown: "M6 9 L12 15 L18 9",
  chevronRight: "M9 6 L15 12 L9 18",
  arrowOut: "M5 12 H19 M13 6 L19 12 L13 18",
  arrowIn: "M19 12 H5 M11 6 L5 12 L11 18",
  focus: "M12 9 A3 3 0 1 0 12 15 A3 3 0 1 0 12 9 M12 2 V6 M12 18 V22 M2 12 H6 M18 12 H22",
  copy: "M8 8 H20 V20 H8 Z M16 8 V4 H4 V16 H8",
  zoomIn: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M16.5 16.5 L21 21 M8 11 H14 M11 8 V14",
  zoomOut: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14 M16.5 16.5 L21 21 M8 11 H14",
  clock: "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 M12 7 V12 L15 14",
  code: "M8 6 L2 12 L8 18 M16 6 L22 12 L16 18",
  tag: "M3 3 H11 L21 13 L13 21 L3 11 Z M7.5 7.5 L7.6 7.6",
  link: "M10 14 L14 10 M8.5 11.5 L6 14 A3.5 3.5 0 0 0 11 19 L13.5 16.5 M15.5 12.5 L18 10 A3.5 3.5 0 0 0 13 5 L10.5 7.5",
  check: "M5 12.5 L10 17.5 L19 7",
  alert: "M12 3 L22 20 H2 Z M12 10 V14 M12 17 V17.1",
  image: "M4 5 H20 V19 H4 Z M4 16 L9 11 L13 15 L15.5 12.5 L20 17 M15 8.5 A1 1 0 1 0 15 9.5",
  sliders: "M4 7 H14 M18 7 H20 M14 5 V9 M4 17 H8 M12 17 H20 M8 15 V19",
  play: "M7 5 L19 12 L7 19 Z",
  chevronUp: "M6 15 L12 9 L18 15",
  notebook: "M6 3 H18 A1 1 0 0 1 19 4 V20 A1 1 0 0 1 18 21 H6 Z M6 3 V21 M3.5 7 H8.5 M3.5 12 H8.5 M3.5 17 H8.5 M11 8 H16 M11 12 H16",
  table: "M4 5 H20 V19 H4 Z M4 10 H20 M4 14.5 H20 M10 5 V19",
  graph: "M6 7 A2 2 0 1 0 6 3 A2 2 0 1 0 6 7 M18 13 A2 2 0 1 0 18 9 A2 2 0 1 0 18 13 M8 21 A2 2 0 1 0 8 17 A2 2 0 1 0 8 21 M7.8 5.9 L16.2 10.1 M16.4 12.2 L9.6 17.8 M6.4 7 L7.6 17",
  plug: "M9 3 V8 M15 3 V8 M6 8 H18 V11 A6 6 0 0 1 6 11 Z M12 17 V21",
  key: "M8 11 A4 4 0 1 0 8 19 A4 4 0 1 0 8 11 M10.8 12.2 L19 4 M16 7 L18.5 9.5 M14 9 L16 11",
} as const;

export type IconName = keyof typeof PATHS;

export type IconTone =
  | "foreground"
  | "muted-foreground"
  | "primary"
  | "primary-foreground"
  | "secondary-foreground"
  | "accent-foreground"
  | "destructive"
  | "destructive-foreground"
  | "success"
  | "warning";

const cache = new Map<string, Path2D>();
function path(name: IconName): Path2D {
  let p = cache.get(name);
  if (!p) {
    p = new Path2D(PATHS[name]);
    cache.set(name, p);
  }
  return p;
}

export function Icon(props: { name: IconName; size?: number; tone?: IconTone; class?: string; strokeWidth?: number }) {
  const size = () => props.size ?? 16;
  return (
    <Canvas
      class={props.class}
      style={{ width: size(), height: size() }}
      accessibilityElementsHidden
      draw={(cx, { width }) => {
        const s = width / 24;
        cx.scale(s, s);
        cx.strokeStyle = token(props.tone ?? "foreground");
        cx.lineWidth = props.strokeWidth ?? 2;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        cx.stroke(path(props.name));
      }}
    />
  );
}

/**
 * Petal's mark: five round petals around a center, in the primary color. Each petal is edged in the
 * background color so they read as overlapping blossoms (and as nodes around a hub).
 */
export function PetalMark(props: { size?: number }) {
  const size = () => props.size ?? 22;
  return (
    <Canvas
      style={{ width: size(), height: size() }}
      accessibilityElementsHidden
      draw={(cx, { width }) => {
        const s = width / 24;
        cx.scale(s, s);
        cx.fillStyle = token("primary");
        cx.strokeStyle = token("background");
        cx.lineWidth = 1.2;
        for (let i = 0; i < 5; i++) {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
          cx.beginPath();
          cx.arc(12 + 6.3 * Math.cos(a), 12.6 + 6.3 * Math.sin(a), 4.4, 0, Math.PI * 2);
          cx.fill();
          cx.stroke();
        }
        cx.fillStyle = token("background");
        cx.beginPath();
        cx.arc(12, 12.6, 2.4, 0, Math.PI * 2);
        cx.fill();
      }}
    />
  );
}
