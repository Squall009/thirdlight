/**
 * Where an editor's docked panels sit over the Scene view, and how that is
 * remembered.
 *
 * Eight docks: the view's four corners and four edges. Each side of the view
 * is one column (top corner, edge, bottom corner) and the top and bottom
 * edges sit between the two columns, so no dock covers another; panels in
 * one dock stack in order, so no panel covers another. A panel's place is its
 * dock, whether it is open, and its order in the dock.
 *
 * Only what the user changed is stored (a panel moved or collapsed); every
 * other panel takes its mode's default, so a panel the editor gains later
 * lands where its mode puts it, and an entry that no longer reads as a place
 * falls back to the default. The layout is editor preference state, kept per
 * editor in the browser's storage, never in the project.
 *
 * Pure.
 */

export type DockId = 'tl' | 't' | 'tr' | 'l' | 'r' | 'bl' | 'b' | 'br';

/** Every dock, in reading order (top row, the sides, bottom row). */
export const DOCKS: readonly DockId[] = ['tl', 't', 'tr', 'l', 'r', 'bl', 'b', 'br'];

/** A dock in words (drop targets, the status line). */
export const DOCK_NAMES: Readonly<Record<DockId, string>> = { tl: 'Top left', t: 'Top edge', tr: 'Top right', l: 'Left edge', r: 'Right edge', bl: 'Bottom left', b: 'Bottom edge', br: 'Bottom right' };

/** The view's ninths a drop lands in: the middle one is no dock (the panel goes back). */
const NINTHS: readonly (readonly (DockId | null)[])[] = [
  ['tl', 't', 'tr'],
  ['l', null, 'r'],
  ['bl', 'b', 'br'],
];

/** A press on a title bar that moves less than this (px) is a click: it collapses or opens the panel. */
export const PANEL_DRAG_THRESHOLD = 5;

/** A short open panel keeps up to this much height (px) when its column runs out of room; taller ones give way and scroll. */
export const PANEL_KEEP_HEIGHT = 340;

export interface PanelPlace {
  readonly dock: DockId;
  readonly open: boolean;
  readonly order: number;
}

/** What a mode says of a panel's place before the user moves it. */
export interface PanelDefault {
  readonly id: string;
  readonly dock: DockId;
  readonly open: boolean;
  /** Its place in its dock's stack (a mode's declaration order). */
  readonly order: number;
}

/** The places the user gave panels, by panel id. */
export type DockLayout = Readonly<Record<string, PanelPlace>>;

/** What an editor's layout stores: the panels' places and whether the panels show at all. */
export interface StoredDocks {
  readonly places: DockLayout;
  /** The view's Panels switch is off: every panel is hidden. */
  readonly hidden: boolean;
}

export const EMPTY_DOCKS: StoredDocks = { places: {}, hidden: false };

export function isDock(v: unknown): v is DockId {
  return typeof v === 'string' && (DOCKS as readonly string[]).includes(v);
}

/** A stored entry as a place, or null when it does not read as one (it falls back to the default). */
function placeOf(v: unknown): PanelPlace | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isDock(o['dock']) || typeof o['open'] !== 'boolean' || typeof o['order'] !== 'number' || !Number.isFinite(o['order'])) return null;
  return { dock: o['dock'], open: o['open'], order: o['order'] };
}

/** A stored layout read back: entries that are not places are dropped, anything else unreadable is the empty layout. */
export function sanitizeDocks(raw: unknown): StoredDocks {
  if (typeof raw !== 'object' || raw === null) return EMPTY_DOCKS;
  const o = raw as Record<string, unknown>;
  const places: Record<string, PanelPlace> = {};
  if (typeof o['places'] === 'object' && o['places'] !== null) {
    for (const [id, v] of Object.entries(o['places'] as Record<string, unknown>)) {
      const p = placeOf(v);
      if (p !== null) places[id] = p;
    }
  }
  return { places, hidden: o['hidden'] === true };
}

/** A panel's place now: the user's, else its mode's default. */
export function placeFor(layout: DockLayout, d: PanelDefault): PanelPlace {
  return layout[d.id] ?? { dock: d.dock, open: d.open, order: d.order };
}

/** The panels each dock stacks, top to bottom (ties in order keep the panels' given order). */
export function stacks(layout: DockLayout, panels: readonly PanelDefault[]): Readonly<Record<DockId, readonly string[]>> {
  const out = Object.fromEntries(DOCKS.map((d) => [d, [] as string[]])) as Record<DockId, string[]>;
  const placed = panels.map((p, i) => ({ id: p.id, place: placeFor(layout, p), i }));
  placed.sort((a, b) => a.place.order - b.place.order || a.i - b.i);
  for (const p of placed) out[p.place.dock].push(p.id);
  return out;
}

/** A panel collapsed or opened. */
export function togglePanel(layout: DockLayout, panels: readonly PanelDefault[], id: string): DockLayout {
  const d = panels.find((p) => p.id === id);
  if (d === undefined) return layout;
  const now = placeFor(layout, d);
  return { ...layout, [id]: { ...now, open: !now.open } };
}

/** A panel moved to the end of a dock's stack (it keeps whether it is open). */
export function movePanel(layout: DockLayout, panels: readonly PanelDefault[], id: string, dock: DockId): DockLayout {
  const d = panels.find((p) => p.id === id);
  if (d === undefined) return layout;
  const now = placeFor(layout, d);
  const last = Math.max(-1, ...panels.filter((p) => p.id !== id).map((p) => placeFor(layout, p)).filter((p) => p.dock === dock).map((p) => p.order));
  return { ...layout, [id]: { ...now, dock, order: last + 1 } };
}

/** The dock a drop at client (x, y) lands in: the view's ninth it is in; the middle ninth (or outside the view) is none. */
export function dockAt(x: number, y: number, view: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }): DockId | null {
  if (view.width <= 0 || view.height <= 0 || x < view.left || y < view.top || x > view.left + view.width || y > view.top + view.height) return null;
  const col = Math.min(2, Math.floor(((x - view.left) / view.width) * 3));
  const row = Math.min(2, Math.floor(((y - view.top) / view.height) * 3));
  return NINTHS[row]![col]!;
}

/** The least height (px) an open panel keeps when its column is short of room: all of it when short, else it scrolls. */
export function panelKeepHeight(headPx: number, bodyPx: number): number {
  return Math.min(headPx + bodyPx, PANEL_KEEP_HEIGHT);
}

// ---- the store ------------------------------------------------------------------------------

/** Where an editor's panel layout is remembered (one per editor kind). */
export function dockStorageKey(editor: string): string {
  return `thirdlight.docks.${editor}`;
}

type DockStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** An editor's stored layout (the empty one when there is none or it does not read). */
export function loadDocks(editor: string, storage: DockStorage | null): StoredDocks {
  try {
    const text = storage?.getItem(dockStorageKey(editor)) ?? null;
    return text === null ? EMPTY_DOCKS : sanitizeDocks(JSON.parse(text) as unknown);
  } catch {
    return EMPTY_DOCKS;
  }
}

/** Remember an editor's layout; the empty one is forgotten (the defaults need no entry). */
export function saveDocks(editor: string, docks: StoredDocks, storage: DockStorage | null): void {
  try {
    if (Object.keys(docks.places).length === 0 && !docks.hidden) storage?.removeItem(dockStorageKey(editor));
    else storage?.setItem(dockStorageKey(editor), JSON.stringify(docks));
  } catch {
    // Storage full or refused: the layout still holds for the page.
  }
}
