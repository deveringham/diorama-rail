// Graphics quality: the few renderer settings that decide the frame rate on weak
// hardware, as three presets or set one by one. Kept in localStorage; ?quality=low|
// medium|high overrides them for the visit. Pure data and parsing, no DOM or three.js.

export type ShadowMode = "off" | "static" | "full";
export type Level = "low" | "medium" | "high";
export type Preset = Level | "custom";

export type Quality = {
  /** Fraction of the default pixel ratio (the screen's, capped at 1.5) to render at. */
  resolution: 0.5 | 0.75 | 1;
  /** Multisampled edges. Changing it swaps the WebGL context. */
  antialias: boolean;
  /** off; static: buildings, trees and bridges only, redrawn as the sun moves; full: everything, every frame. */
  shadows: ShadowMode;
  /** Shadow map size (px per side). */
  shadowSize: 1024 | 2048 | 4096;
  /** How far out small things (props, windows, sleepers, people) are drawn: high draws everything. */
  detail: Level;
  /** Frames per second at most; 0 = as often as the screen refreshes. */
  fpsCap: 0 | 30;
};

export const PRESETS: Record<Level, Quality> = {
  low: { resolution: 0.75, antialias: false, shadows: "off", shadowSize: 1024, detail: "low", fpsCap: 0 },
  medium: { resolution: 1, antialias: true, shadows: "static", shadowSize: 2048, detail: "medium", fpsCap: 0 },
  high: { resolution: 1, antialias: true, shadows: "full", shadowSize: 2048, detail: "high", fpsCap: 0 },
};

/** Smallest size on screen (px) a small thing is drawn at, per detail level. */
export const DETAIL_PIXELS: Record<Level, number> = { low: 3, medium: 1.5, high: 0 };

export const OPTIONS = {
  resolution: [0.5, 0.75, 1],
  shadows: ["off", "static", "full"],
  shadowSize: [1024, 2048, 4096],
  detail: ["low", "medium", "high"],
  fpsCap: [0, 30],
} as const;

const LEVELS: Level[] = ["low", "medium", "high"];
const KEYS = Object.keys(PRESETS.high) as Array<keyof Quality>;

/** The preset these settings match, or "custom". */
export function presetOf(q: Quality): Preset {
  return LEVELS.find((l) => KEYS.every((k) => PRESETS[l][k] === q[k])) ?? "custom";
}

/** The next preset down from `p` (custom counts as high), or null at the bottom. */
export function lower(p: Preset): Level | null {
  const i = LEVELS.indexOf(p === "custom" ? "high" : p);
  return i > 0 ? LEVELS[i - 1] : null;
}

/**
 * Settings from untrusted JSON (a stored copy, possibly from an older version):
 * every valid field is kept, anything missing or invalid comes from `base`.
 */
export function sanitize(raw: unknown, base: Quality = PRESETS.high): Quality {
  const q: Quality = { ...base };
  if (!raw || typeof raw !== "object") return q;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof typeof OPTIONS>(k: K) => {
    if ((OPTIONS[k] as readonly unknown[]).includes(r[k])) (q as Record<string, unknown>)[k] = r[k];
  };
  pick("resolution");
  pick("shadows");
  pick("shadowSize");
  pick("detail");
  pick("fpsCap");
  if (typeof r.antialias === "boolean") q.antialias = r.antialias;
  return q;
}

/** What the page starts with: the URL's preset, else the stored settings, else `auto` (adapts to the frame rate). */
export type Stored = { auto: boolean; quality: Quality };

export const STORAGE_KEY = "dr-quality";

export function initialQuality(param: string | null, stored: string | null): Stored {
  if (param && (LEVELS as string[]).includes(param)) return { auto: false, quality: { ...PRESETS[param as Level] } };
  if (stored) {
    try {
      const s = JSON.parse(stored) as { auto?: unknown; quality?: unknown };
      return { auto: s.auto === true, quality: sanitize(s.quality) };
    } catch {
      // Unreadable: start afresh.
    }
  }
  return { auto: true, quality: { ...PRESETS.high } };
}

export const serialize = (s: Stored): string => JSON.stringify(s);
