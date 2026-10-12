/**
 * What the terrain editor remembers while a page is open, per terrain: the
 * tool picked in each mode, the painted layer, the noise tool's bumps, the
 * scatter brush's rule, the stamp and erode tools' settings, the stamp and
 * tile picked, the open rule cards and the rules preview's switches. Modes
 * come and go as the rail switches (each its own column), so this is kept
 * apart from them; it is never stored in the project (the brush settings
 * themselves are remembered per tool in `brush.ts`).
 *
 * Pure but for its in-memory store.
 */
import { DEFAULT_ERODE_TOOL, DEFAULT_STAMP_TOOL, DEFAULT_TERRAIN_BRUSH, TERRAIN_MODES, type ErodeToolState, type StampToolState, type TerrainBrushState, type TerrainModeId } from './terrain-brush';

export interface TerrainToolState {
  /** The tool tile picked in each mode (its id in the mode's grid). */
  readonly tiles: Readonly<Record<TerrainModeId, string>>;
  readonly brush: TerrainBrushState;
  readonly stamp: StampToolState;
  readonly erode: ErodeToolState;
  /** The stamp picked in Stack (its layer and place in it). */
  readonly pickedStamp: { readonly layer: string; readonly index: number } | null;
  /** The tile picked in Tiles. */
  readonly pickedTile: readonly [number, number] | null;
  /** The open material rule card and scatter rule card. */
  readonly rule: number | null;
  readonly scatterRule: number | null;
  /** Material rules: the draft drawn on the terrain as it would bake; only the open card's rule shown. */
  readonly livePreview: boolean;
  readonly solo: boolean;
}

const DEFAULT_TILES = Object.fromEntries(TERRAIN_MODES.map((m) => [m.id, m.tiles[0]?.id ?? ''])) as Record<TerrainModeId, string>;

export const DEFAULT_TERRAIN_TOOL_STATE: TerrainToolState = Object.freeze({ tiles: DEFAULT_TILES, brush: DEFAULT_TERRAIN_BRUSH, stamp: DEFAULT_STAMP_TOOL, erode: DEFAULT_ERODE_TOOL, pickedStamp: null, pickedTile: null, rule: null, scatterRule: null, livePreview: true, solo: false });

/** One terrain's state: read, changed and listened to. */
export interface TerrainToolStore {
  get(): TerrainToolState;
  set(patch: Partial<TerrainToolState>): void;
  subscribe(listener: () => void): () => void;
}

const stores = new Map<string, TerrainToolStore>();

/** The state of a terrain's editor (made on first use; kept while the page is open). */
export function terrainToolStore(entityId: string): TerrainToolStore {
  let s = stores.get(entityId);
  if (s !== undefined) return s;
  let state = DEFAULT_TERRAIN_TOOL_STATE;
  const listeners = new Set<() => void>();
  s = {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  stores.set(entityId, s);
  return s;
}
