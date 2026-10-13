/**
 * What every part of the vertex paint editor reads (its columns and what
 * lies over the Scene view): the object's material and what its paint means
 * there (`vertex-paint-channels.ts`), the shared brush's settings, and the
 * editor's state remembered per object while the page is open — the tile
 * picked and the channel the view shows.
 *
 * Browser-only (React).
 */
import { useMemo, useSyncExternalStore } from 'react';

import { brushStore, type BrushSettings, type BrushStore } from '../../session/brush';
import type { ProjectedEntity } from '../../session/projection';
import { VERTEX_PAINT_BRUSH_BOUNDS, VERTEX_PAINT_DEFAULT_BRUSH } from '../../session/vertex-paint-brush';
import { paintChannels, paintMaterialSlots, type PaintChannels, type PaintTarget } from '../../session/vertex-paint-channels';
import { useBrush } from '../brush/useBrush';
import type { EditModeHost } from '../editmode/modes';
import { usePalette, type Palette } from '../palette/MaterialLayers';

/** What the editor remembers per object (never project data). */
export interface VertexPaintState {
  /** The palette tile picked (its place; null: the first a stroke would usually want — layer 2, else the first). */
  readonly tile: number | null;
  /** The channel the view shows as grey (null: the material as drawn). */
  readonly view: number | null;
}

const DEFAULT_STATE: VertexPaintState = Object.freeze({ tile: null, view: null });

interface StateStore {
  get(): VertexPaintState;
  set(patch: Partial<VertexPaintState>): void;
  subscribe(l: () => void): () => void;
}

const stores = new Map<string, StateStore>();

function stateStore(entityId: string): StateStore {
  let s = stores.get(entityId);
  if (s !== undefined) return s;
  let state = DEFAULT_STATE;
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

/** The vertex paint brush's shared settings (one for every object; remembered in this browser). */
export const vertexPaintBrushStore = (): BrushStore => brushStore('vertex-paint', 'paint', VERTEX_PAINT_DEFAULT_BRUSH, VERTEX_PAINT_BRUSH_BOUNDS);

export interface VertexPaintSetup {
  readonly entity: ProjectedEntity;
  readonly host: EditModeHost;
  /** The material the paint is read by, as an all-materials mapping, and the named slots that name it. */
  readonly mapping: Readonly<Record<string, string>> | undefined;
  readonly slots: readonly string[];
  /** The material's layer palette (names, pictures, "no height" badges). */
  readonly palette: Palette;
  readonly channels: PaintChannels;
  /** The material reads the paint (and the object can be edited). */
  readonly paintable: boolean;
  readonly locked: boolean;
  readonly state: VertexPaintState;
  readonly setState: (patch: Partial<VertexPaintState>) => void;
  /** The tile picked (within the palette) and what it paints. */
  readonly tile: number;
  readonly target: PaintTarget;
  readonly store: BrushStore;
  readonly settings: BrushSettings;
}

/** Everything a part of the editor reads about the object and its paint. */
export function useVertexPaint(entity: ProjectedEntity, host: EditModeHost): VertexPaintSetup {
  const own = entity.components['materials'] as Readonly<Record<string, string>> | undefined;
  const drawn = useMemo(() => paintMaterialSlots(own), [own]);
  const mapping = useMemo(() => (drawn === null ? undefined : { '*': drawn.materialId }), [drawn]);
  const palette = usePalette(mapping, host.palette.materials, NO_STAND_INS, host.palette.heightInAlpha);
  const channels = useMemo(() => paintChannels(mapping, host.palette.materials, palette.source.kind === 'none' ? undefined : palette.layers), [mapping, host.palette.materials, palette]);
  const st = stateStore(entity.id);
  const state = useSyncExternalStore(st.subscribe, st.get);
  const store = vertexPaintBrushStore();
  const settings = useBrush(store);
  const locked = host.flags(entity.id)?.locked === true;
  const tile = Math.min(state.tile ?? (channels.meaning === 'layers' || channels.meaning === 'none' ? 1 : 0), channels.tiles.length - 1);
  return { entity, host, mapping, slots: drawn?.slots ?? NO_SLOTS, palette, channels, paintable: channels.meaning !== 'none' && !locked, locked, state, setState: st.set, tile, target: channels.targets[tile]!, store, settings };
}

const NO_STAND_INS: readonly string[] = [];
const NO_SLOTS: readonly string[] = [];
