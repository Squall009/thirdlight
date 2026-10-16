/**
 * The terrain tools' brush maths, kept apart from the Scene view so it is
 * checked without a browser: the tools, the shared brush settings each uses
 * (`brush.ts`) and the terrain's own beside them, where a drag drops its
 * dabs, how many dabs one stroke may hold (the command's per-request
 * bounds), the `editTerrain` args a stroke stores and the dab its GPU
 * preview draws (the same numbers, so the preview is the stroke).
 *
 * Ctrl (or the panel's invert) turns raise into lower and back, paint into
 * erasing hand paint, and holes into filling them.
 *
 * Pure.
 */
import { HYDRAULIC_DEFAULTS, TERRAIN_BRUSH_LIMITS, THERMAL_DEFAULTS, terrainDabSamples, type BrushFalloff, type ErosionSettings, type TerrainLayer, type TerrainStamp } from '@thirdlight/runtime';
import type { TerrainBrushKind, TerrainPreviewDab } from '@thirdlight/three-adapter';
import { brushRadius, brushStrokeExtras, type BrushBounds, type BrushSettings, type BrushUse } from './brush';

/**
 * The sculpt and paint tools (previewed on the GPU), the scatter brush (its
 * copies come with the stored edit), the placed tools (a click puts a stamp
 * in a stamps layer, or erodes the square under the brush into an erosion
 * layer: no preview, the combined ground comes back from the backend) and
 * the picking tools (stamps: select a stamp and move, turn or resize it with
 * its handles; tiles: add a tile beside the terrain or pick one).
 */
export type TerrainToolId = TerrainBrushKind | 'scatter' | 'stamp' | 'erode' | 'stamps' | 'tiles';

/** The tools a click places rather than strokes. */
export const PLACED_TERRAIN_TOOLS: readonly TerrainToolId[] = ['stamp', 'erode'];

/** The tools that pick things in the view (no brush). */
export const PICKING_TERRAIN_TOOLS: readonly TerrainToolId[] = ['stamps', 'tiles'];

/** Whether a tool's dabs are previewed on the GPU. */
export const previewedTool = (t: TerrainToolId): t is TerrainBrushKind => t !== 'scatter' && !PLACED_TERRAIN_TOOLS.includes(t) && !PICKING_TERRAIN_TOOLS.includes(t);

/** The terrain editor's modes (its tool rail): what each shows, its tools and its one-line hint. */
export type TerrainModeId = 'sculpt' | 'paint' | 'holes' | 'rules' | 'scatter' | 'stack' | 'tiles' | 'settings';

/**
 * One tile of a mode's tool grid: the tool it arms, with the brush inverted
 * or not (paint and erase are one tool, so they share one brush), its glyph,
 * its key and what to do with it in one sentence (the status line).
 */
export interface TerrainToolTile {
  readonly id: string;
  readonly tool: TerrainToolId;
  /** Picking the tile sets the brush's invert (absent: leaves it). */
  readonly invert?: boolean;
  readonly label: string;
  readonly glyph: string;
  /** The key that picks it (a letter; X is the brush's paint/erase key). */
  readonly key: string;
  readonly hint: string;
}

export interface TerrainMode {
  readonly id: TerrainModeId;
  readonly label: string;
  /** The rail's glyph (ui/editmode/glyphs.tsx). */
  readonly glyph: string;
  /** The tool grid (empty: the mode edits through its column only). */
  readonly tiles: readonly TerrainToolTile[];
  /** The tools it arms in the view (the grid's, or a picking tool of its own). */
  readonly tools: readonly TerrainToolId[];
  /** What to do, in one sentence (the status line, before a tool is chosen). */
  readonly hint: string;
}

const tile = (id: string, tool: TerrainToolId, label: string, glyph: string, key: string, hint: string, invert?: boolean): TerrainToolTile => ({ id, tool, label, glyph, key, hint, ...(invert !== undefined ? { invert } : {}) });

export const TERRAIN_MODES: readonly TerrainMode[] = Object.freeze([
  {
    id: 'sculpt',
    label: 'Sculpt',
    glyph: 'sculpt',
    tiles: [
      tile('raise', 'raise', 'Raise', 'raise', 'Q', 'Drag on the ground to raise it.'),
      tile('lower', 'lower', 'Lower', 'lower', 'W', 'Drag on the ground to lower it.'),
      tile('smooth', 'smooth', 'Smooth', 'smooth', 'E', 'Drag to even the ground out toward its neighbours.'),
      tile('flatten', 'flatten', 'Flatten', 'flatten', 'R', 'Drag to level the ground to the height where the stroke began.'),
      tile('noise', 'noise', 'Noise', 'noise', 'T', 'Drag to add bumps of the noise size.'),
      tile('ramp', 'ramp', 'Ramp', 'ramp', 'Y', 'Drag from one end to the other: the ground between takes the straight slope.'),
    ],
    tools: ['raise', 'lower', 'smooth', 'flatten', 'noise', 'ramp'],
    hint: 'Drag on the ground to shape it.',
  },
  {
    id: 'paint',
    label: 'Paint',
    glyph: 'paint',
    tiles: [tile('paint', 'paint', 'Paint', 'brush', 'B', 'Drag to paint the chosen layer.', false), tile('erase', 'paint', 'Erase', 'erase', 'X', 'Drag to take hand paint off: the rules\' layers show again.', true)],
    tools: ['paint'],
    hint: 'Drag on the ground to paint the chosen layer.',
  },
  {
    id: 'holes',
    label: 'Holes',
    glyph: 'holes',
    tiles: [tile('cut', 'holes', 'Cut', 'holes', 'B', 'Drag to cut holes in the ground (caves, tunnels, models below).', false), tile('fill', 'holes', 'Fill', 'fill', 'X', 'Drag over holes to close them.', true)],
    tools: ['holes'],
    hint: 'Drag on the ground to cut holes; hold Ctrl to fill them.',
  },
  { id: 'rules', label: 'Material rules', glyph: 'rules', tiles: [], tools: [], hint: 'Pick a rule to see where it applies; bake when it looks right.' },
  {
    id: 'scatter',
    label: 'Scatter',
    glyph: 'scatter',
    tiles: [tile('place', 'scatter', 'Place', 'scatter', 'B', "Drag to put the chosen rule's copies under the brush, whatever its conditions.", false), tile('takeoff', 'scatter', 'Take off', 'erase', 'X', "Drag to take the chosen rule's copies off.", true)],
    tools: ['scatter'],
    hint: 'Add scatter rules and bake them; drag to place copies by hand.',
  },
  {
    id: 'stack',
    label: 'Stack',
    glyph: 'stack',
    tiles: [
      tile('stamp', 'stamp', 'Stamp', 'stamp', 'W', 'Click the ground to place the heightmap as a stamp (its side is the brush size).'),
      tile('erode', 'erode', 'Erode', 'erode', 'E', 'Click the ground to erode the square under the brush.'),
    ],
    // With no tool (Navigate) a click picks a stamp and the picked one's handles drag it: the `stamps` tool.
    tools: ['stamps', 'stamp', 'erode'],
    hint: 'Click the ground to place a stamp or erode; drag a stamp to move it.',
  },
  { id: 'tiles', label: 'Tiles', glyph: 'tiles', tiles: [], tools: ['tiles'], hint: 'Click an empty square beside the terrain to add a tile; click a tile to pick it.' },
  { id: 'settings', label: 'Settings', glyph: 'settings', tiles: [], tools: [], hint: 'The terrain\'s size, detail and collision.' },
]);

/** The mode a tool belongs to. */
export function terrainModeOf(tool: TerrainToolId): TerrainMode | undefined {
  return TERRAIN_MODES.find((m) => m.tools.includes(tool));
}

/** The terrain's own settings beside the shared brush (one set for every tool; each reads its own). */
export interface TerrainBrushState {
  /** paint: the material layer (0–255). */
  layer: number;
  /** noise: the bumps' size (metres) and seed. */
  scale: number;
  seed: number;
  /** scatter: the scatter rule whose copies the brush edits ('': none chosen). */
  rule: string;
}

export const DEFAULT_TERRAIN_BRUSH: TerrainBrushState = Object.freeze({ layer: 1, scale: 16, seed: 1, rule: '' }) as TerrainBrushState;

/** The settings' bounds in the panel (the command's per-request bounds cap them). */
export const TERRAIN_BRUSH_UI = Object.freeze({ scaleMax: TERRAIN_BRUSH_LIMITS.noiseScaleMax });

/** The shared brush's bounds on a terrain: a size up to the command's widest radius, a height step up to its most metres a dab. */
export const TERRAIN_BRUSH_BOUNDS: BrushBounds = Object.freeze({ size: [0.5, 2 * TERRAIN_BRUSH_LIMITS.radiusMax] as const, heightStep: [0.01, TERRAIN_BRUSH_LIMITS.heightStrengthMax] as const });

/** The shared settings each tool uses (the brush panel's rows, the keys, what its stroke sends). */
export function terrainToolUses(tool: TerrainToolId): readonly BrushUse[] {
  switch (tool) {
    case 'raise':
    case 'lower':
      return ['heightStep', 'size', 'strength', 'falloff', 'spacing', 'invert', 'mask'];
    case 'noise':
      return ['heightStep', 'size', 'strength', 'falloff', 'spacing', 'mask'];
    case 'smooth':
    case 'flatten':
      return ['size', 'strength', 'falloff', 'spacing', 'mask'];
    case 'ramp':
      return ['size', 'strength', 'falloff'];
    case 'paint':
      return ['size', 'strength', 'opacity', 'falloff', 'spacing', 'invert', 'mask'];
    case 'holes':
    case 'scatter':
      return ['size', 'spacing', 'invert'];
    case 'stamp':
    case 'erode':
      return ['size'];
    case 'stamps':
    case 'tiles':
      return [];
  }
}

/** What inverting does with each tool, in plain words (the toggle and the keys say it). */
export const TERRAIN_INVERT_LABELS: Readonly<Partial<Record<TerrainToolId, string>>> = Object.freeze({ raise: 'Lower', lower: 'Raise', paint: 'Erase', holes: 'Fill', scatter: 'Take off' });

/** The kind a stroke of `tool` stores, with Ctrl or the panel's invert (raise and lower trade places). */
export function strokeKind(tool: TerrainToolId, invert: boolean): TerrainToolId {
  if (!invert) return tool;
  if (tool === 'raise') return 'lower';
  if (tool === 'lower') return 'raise';
  return tool;
}

/** Metres between a drag's dabs: the brush's spacing (a share of its size), at least half a sample. */
export function terrainDabSpacing(b: Pick<BrushSettings, 'size' | 'spacing'>, sampleSpacing: number): number {
  return Math.max(sampleSpacing * 0.5, b.size * b.spacing);
}

/** The most dabs one stroke may hold at this radius (the command's bounds on dabs and on the samples they cover). */
export function strokeDabLimit(radius: number, spacing: number): number {
  return Math.max(1, Math.min(TERRAIN_BRUSH_LIMITS.dabs, Math.floor(TERRAIN_BRUSH_LIMITS.samples / terrainDabSamples(radius, spacing))));
}

/** The points from `last` toward `to` (x, z) a drag passes at `step` apart (`last` itself excluded); the new last point. */
export function dabsAlong(last: readonly [number, number], to: readonly [number, number], step: number): { points: [number, number][]; last: [number, number] } {
  const dx = to[0] - last[0];
  const dz = to[1] - last[1];
  const n = Math.floor(Math.hypot(dx, dz) / step);
  if (n === 0) return { points: [], last: [last[0], last[1]] };
  const points: [number, number][] = [];
  for (let i = 1; i <= n; i++) points.push([last[0] + (dx * i) / n, last[1] + (dz * i) / n]);
  return { points, last: points[n - 1]! };
}

/** What a stroke stores besides its points: flatten's level, a ramp's ends (world). */
export interface StrokeExtra {
  height?: number;
  from?: [number, number, number];
  to?: [number, number, number];
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** The metres a sculpt dab moves the ground at its centre: the height step at the brush's strength. */
const sculptMetres = (b: BrushSettings): number => Math.max(1e-4, r4(b.heightStep * b.strength));

/** One dab of the preview, as the stroke stores it (null: the tool has no preview — the scatter brush). */
export function previewDab(tool: TerrainToolId, b: BrushSettings, tb: TerrainBrushState, at: readonly [number, number], invert: boolean, extra: StrokeExtra): TerrainPreviewDab | null {
  const kind = strokeKind(tool, invert);
  if (!previewedTool(kind)) return null;
  const more = brushStrokeExtras(b, terrainToolUses(kind));
  const base = { kind, at: [r4(at[0]), r4(at[1])] as [number, number], radius: brushRadius(b), falloff: b.falloff, ...more };
  switch (kind) {
    case 'raise':
    case 'lower':
      return { ...base, strength: sculptMetres(b) };
    case 'noise':
      return { ...base, strength: sculptMetres(b), scale: tb.scale, seed: tb.seed };
    case 'smooth':
      return { ...base, strength: b.strength };
    case 'flatten':
      return { ...base, strength: b.strength, height: extra.height ?? 0 };
    case 'ramp':
      return { kind, radius: brushRadius(b), falloff: b.falloff, ...more, strength: b.strength, from: extra.from ?? [at[0], 0, at[1]], to: extra.to ?? [at[0], 0, at[1]] };
    case 'paint':
      return { ...base, strength: b.strength, layer: tb.layer, ...(invert ? { erase: true } : {}) };
    case 'holes':
      return { kind, at: base.at, radius: brushRadius(b), ...(invert ? { erase: true } : {}) };
  }
}

/** The `editTerrain` args of a stroke (its dabs' points in world metres). */
export function strokeArgs(entityId: string, tool: TerrainToolId, b: BrushSettings, tb: TerrainBrushState, dabs: readonly (readonly [number, number])[], invert: boolean, extra: StrokeExtra): Record<string, unknown> {
  const kind = strokeKind(tool, invert);
  const points = dabs.map((d) => [r4(d[0]), r4(d[1])]);
  const radius = brushRadius(b);
  const more = brushStrokeExtras(b, terrainToolUses(kind));
  switch (kind) {
    case 'raise':
    case 'lower':
      return { entityId, kind, dabs: points, radius, strength: sculptMetres(b), falloff: b.falloff, ...more };
    case 'noise':
      return { entityId, kind, dabs: points, radius, strength: sculptMetres(b), falloff: b.falloff, scale: tb.scale, seed: tb.seed, ...more };
    case 'smooth':
      return { entityId, kind, dabs: points, radius, strength: b.strength, falloff: b.falloff, ...more };
    case 'flatten':
      return { entityId, kind, dabs: points, radius, strength: b.strength, falloff: b.falloff, height: extra.height ?? 0, ...more };
    case 'ramp':
      return { entityId, kind, from: extra.from, to: extra.to, radius, strength: b.strength, falloff: b.falloff, ...more };
    case 'paint':
      return { entityId, kind, dabs: points, radius, strength: b.strength, falloff: b.falloff, layer: tb.layer, ...(invert ? { erase: true } : {}), ...more };
    case 'holes':
      return { entityId, kind, dabs: points, radius, ...(invert ? { erase: true } : {}) };
    case 'scatter':
      return { entityId, kind, rule: tb.rule, dabs: points, radius, ...(invert ? { erase: true } : {}) };
    case 'stamp':
    case 'erode':
    case 'stamps':
    case 'tiles':
      return { entityId, kind };
  }
}

/** The stamp tool's settings (its side is twice the brush radius). */
export interface StampToolState {
  /** The texture asset whose first channel is the shape ('': none chosen). */
  asset: string;
  height: number;
  rotation: number;
  mode: TerrainStamp['mode'] & string;
  falloff: number;
  /** The stamps layer placed into ('': the first, or a new one). */
  layer: string;
}

export const DEFAULT_STAMP_TOOL: StampToolState = Object.freeze({ asset: '', height: 30, rotation: 0, mode: 'add', falloff: 0.15, layer: '' }) as StampToolState;

/** A free layer id from `base` ("stamps", "stamps-2", …). */
export function freeLayerId(layers: readonly TerrainLayer[], base: string): string {
  const taken = new Set(layers.map((l) => l.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * The layers after a stamp is placed at world (x, z): into the chosen
 * stamps layer, else the first, else a new one on top (under the splines).
 */
export function layersWithStamp(layers: readonly TerrainLayer[], st: StampToolState, at: readonly [number, number], radius: number): TerrainLayer[] {
  const stamp: TerrainStamp = { asset: st.asset, at: [r4(at[0]), r4(at[1])], size: r4(radius * 2), height: st.height, ...(st.rotation !== 0 ? { rotation: st.rotation } : {}), ...(st.mode !== 'add' ? { mode: st.mode } : {}), falloff: st.falloff };
  const target = layers.find((l) => l.kind === 'stamps' && (st.layer === '' || l.id === st.layer));
  if (target === undefined) {
    const made: TerrainLayer = { id: freeLayerId(layers, 'stamps'), kind: 'stamps', stamps: [stamp] };
    const splines = layers.findIndex((l) => l.kind === 'splines');
    return splines < 0 ? [...layers, made] : [...layers.slice(0, splines), made, ...layers.slice(splines)];
  }
  return layers.map((l) => (l === target && l.kind === 'stamps' ? { ...l, stamps: [...l.stamps, stamp] } : l));
}

/** A stamp of the terrain's stamps layers: the layer, its place in the list, the stamp. */
export interface StampRef {
  readonly layer: string;
  readonly index: number;
  readonly stamp: TerrainStamp;
}

/** Every stamp of the terrain's stamps layers, in the layers' order. */
export function terrainStamps(layers: readonly TerrainLayer[]): StampRef[] {
  return layers.flatMap((l) => (l.kind === 'stamps' ? l.stamps.map((stamp, index) => ({ layer: l.id, index, stamp })) : []));
}

/** The layers with one stamp changed (moved, turned, resized, retuned); a rotation of 0 is left out, as a new stamp's is. */
export function layersWithStampChanged(layers: readonly TerrainLayer[], layer: string, index: number, patch: Partial<TerrainStamp>): TerrainLayer[] {
  return layers.map((l) => {
    if (l.id !== layer || l.kind !== 'stamps') return l;
    return {
      ...l,
      stamps: l.stamps.map((st, i) => {
        if (i !== index) return st;
        const next: TerrainStamp = { ...st, ...patch };
        if (next.at !== undefined) next.at = [r4(next.at[0]), r4(next.at[1])];
        next.size = r4(next.size);
        if (next.rotation !== undefined) {
          const turn = r4((((next.rotation % 360) + 540) % 360) - 180);
          if (turn === 0) delete next.rotation;
          else next.rotation = turn;
        }
        return next;
      }),
    };
  });
}

/** The layers without one stamp. */
export function layersWithoutStamp(layers: readonly TerrainLayer[], layer: string, index: number): TerrainLayer[] {
  return layers.map((l) => (l.id === layer && l.kind === 'stamps' ? { ...l, stamps: l.stamps.filter((_s, i) => i !== index) } : l));
}

/** The erode tool's settings: each run on or off, with every one of its settings (the command's defaults to start). */
export interface ErodeToolState {
  hydraulic: boolean;
  /** Hydraulic: droplets per sample, how fast they take up and drop ground, how much they carry, dry up, keep their way, live, and the radius they wear. */
  droplets: number;
  erosion: number;
  deposition: number;
  capacity: number;
  evaporation: number;
  inertia: number;
  lifetime: number;
  radius: number;
  thermal: boolean;
  /** Thermal: passes, the angle of repose (degrees), the share of the excess moved a pass. */
  iterations: number;
  talus: number;
  amount: number;
  seed: number;
}

export const DEFAULT_ERODE_TOOL: ErodeToolState = Object.freeze({ hydraulic: true, ...HYDRAULIC_DEFAULTS, thermal: true, ...THERMAL_DEFAULTS, seed: 1 }) as ErodeToolState;

/** The `editTerrain` erode args for a click at world (x, z): the square of side twice the radius. */
export function erodeArgs(entityId: string, e: ErodeToolState, at: readonly [number, number], radius: number): Record<string, unknown> {
  const settings: ErosionSettings = {
    ...(e.hydraulic ? { hydraulic: { droplets: e.droplets, erosion: e.erosion, deposition: e.deposition, capacity: e.capacity, evaporation: e.evaporation, inertia: e.inertia, lifetime: e.lifetime, radius: e.radius } } : {}),
    ...(e.thermal ? { thermal: { iterations: e.iterations, talus: e.talus, amount: e.amount } } : {}),
  };
  return { entityId, kind: 'erode', rect: [r4(at[0] - radius), r4(at[1] - radius), r4(at[0] + radius), r4(at[1] + radius)], ...settings, seed: e.seed };
}
