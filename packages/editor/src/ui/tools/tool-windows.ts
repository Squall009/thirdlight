/**
 * The Window menu's floating tool windows (Lighting, Environment): which are
 * open, in which order they stack, and where each stands, remembered per
 * browser like the dock sizes (presentation only, never project data).
 *
 * They are scene settings that preview in the Scene view, so they float over
 * it instead of covering the editor (Unity's Lighting window is a floating
 * or docked window, not a full one).
 */
import { useCallback, useMemo, useState } from 'react';

export type ToolWindowId = 'lighting' | 'environment';

/** The tool windows in the order the Window menu lists them. */
export const TOOL_WINDOWS: ReadonlyArray<{ id: ToolWindowId; label: string }> = [
  { id: 'lighting', label: 'Lighting' },
  { id: 'environment', label: 'Environment' },
];

/** A window's box in the work area (px from its top-left corner). */
export interface ToolWindowPlace {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest a tool window is resized to (its scene bar and a few controls stay usable). */
export const TOOL_WINDOW_MIN = { width: 280, height: 160 } as const;
/** How much of a window's title bar stays inside the work area when it is dragged towards an edge. */
const TITLE_KEPT = 48;
const TITLE_HEIGHT = 30;

const KEY = 'thirdlight.toolWindows.v1';

interface Stored {
  /** Open windows, bottom to top. */
  open: ToolWindowId[];
  places: Partial<Record<ToolWindowId, ToolWindowPlace>>;
}

const isId = (x: unknown): x is ToolWindowId => TOOL_WINDOWS.some((t) => t.id === x);

function placeOf(v: unknown): ToolWindowPlace | null {
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Record<string, unknown>;
  const n = (k: string): number | null => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : null);
  const [x, y, width, height] = [n('x'), n('y'), n('width'), n('height')];
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

function load(): Stored {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as { open?: unknown; places?: unknown } | null;
    if (v === null) return { open: [], places: {} };
    const open = Array.isArray(v.open) ? [...new Set(v.open.filter(isId))] : [];
    const places: Stored['places'] = {};
    if (typeof v.places === 'object' && v.places !== null) {
      for (const [k, p] of Object.entries(v.places as Record<string, unknown>)) {
        const place = placeOf(p);
        if (isId(k) && place !== null) places[k] = place;
      }
    }
    return { open, places };
  } catch {
    return { open: [], places: {} };
  }
}

function save(s: Stored): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // no storage: the windows stay where they are for this page only
  }
}

/** Forget the tool windows' places and open state (Window → Reset layout). */
export function resetToolWindows(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

/**
 * A box kept usable inside an area of `w` × `h`: at least the minimum size,
 * no larger than the area, and its title bar reachable.
 */
export function clampPlace(p: ToolWindowPlace, w: number, h: number): ToolWindowPlace {
  const width = Math.max(TOOL_WINDOW_MIN.width, Math.min(p.width, Math.max(TOOL_WINDOW_MIN.width, w)));
  const height = Math.max(TOOL_WINDOW_MIN.height, Math.min(p.height, Math.max(TOOL_WINDOW_MIN.height, h)));
  const x = Math.min(Math.max(p.x, TITLE_KEPT - width), Math.max(0, w - TITLE_KEPT));
  const y = Math.min(Math.max(p.y, 0), Math.max(0, h - TITLE_HEIGHT));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function useToolWindows() {
  const [state, setState] = useState<Stored>(load);
  const update = useCallback((f: (s: Stored) => Stored) => {
    setState((s) => {
      const next = f(s);
      save(next);
      return next;
    });
  }, []);
  /** Open a window (or bring it to the top), placed at `initial` the first time it opens. */
  const show = useCallback(
    (id: ToolWindowId, initial: ToolWindowPlace) =>
      update((s) => ({ open: [...s.open.filter((x) => x !== id), id], places: s.places[id] !== undefined ? s.places : { ...s.places, [id]: initial } })),
    [update],
  );
  const close = useCallback((id: ToolWindowId) => update((s) => ({ ...s, open: s.open.filter((x) => x !== id) })), [update]);
  const front = useCallback((id: ToolWindowId) => update((s) => (s.open.at(-1) === id || !s.open.includes(id) ? s : { ...s, open: [...s.open.filter((x) => x !== id), id] })), [update]);
  const place = useCallback((id: ToolWindowId, p: ToolWindowPlace) => update((s) => ({ ...s, places: { ...s.places, [id]: p } })), [update]);
  return useMemo(() => ({ open: state.open as readonly ToolWindowId[], places: state.places, show, close, front, place, isOpen: (id: ToolWindowId) => state.open.includes(id) }), [state, show, close, front, place]);
}

export type ToolWindows = ReturnType<typeof useToolWindows>;
