/**
 * The block editor's modes and tools, as data: the rail (Build, Shape,
 * Paint, Regions, Rooms & buildings, Rules), each mode's tool tiles with
 * the letter that picks them, which shared brush settings each round brush
 * uses, how those settings (metres) become a dab in the layer's cells, and
 * what the paint palette's tiles mean on the block types' material.
 *
 * - **Build** places and removes blocks: single, line, rect, box, flood,
 *   column, erase, pick, replace, stamp, paste, and the selection a copy,
 *   move or stamp starts from.
 * - **Shape** sculpts the ground's tops (raise, lower, smooth, flatten).
 * - **Paint** paints the four material layers and the wetness on the tops
 *   and walls through the shared brush (opacity, falloff, noise mask).
 * - **Regions** paints named regions and cell metadata; a region's cut-away
 *   and theme are set beside it.
 * - **Rooms & buildings** draws generated architecture on the layer.
 * - **Rules** holds the material rules and the scatter rules, with the
 *   scatter brush.
 *
 * Pure: no DOM, no React.
 */
import type { MaterialDef } from '@thirdlight/project-model';
import { MATERIAL_SHADER_LABELS, materialReads } from '@thirdlight/project-model/material-reads';
import { PAINT_BRUSH_LIMITS, SCULPT_LIMITS } from '@thirdlight/runtime';

import type { BlockToolId, DabBrush } from './block-brush';
import { DEFAULT_BRUSH as SHARED_BRUSH, brushRadius, type BrushBounds, type BrushSettings, type BrushUse } from './brush';
import type { PaletteLayer } from './layer-palette';
import { TEMPLATE_LAYERS } from './material-graph';

export type BlockModeId = 'build' | 'shape' | 'paint' | 'regions' | 'rooms' | 'rules';

/** One tile of a mode's tool grid: the tool it arms (and, for tiles that share a brush, whether it inverts). */
export interface BlockToolTile {
  readonly id: string;
  readonly tool: BlockToolId;
  readonly label: string;
  readonly glyph: string;
  readonly key?: string;
  readonly hint: string;
  /** Tiles of one brush that differ by its invert (raise / lower, paint / erase): the invert this one sets. */
  readonly invert?: boolean;
}

export interface BlockMode {
  readonly id: BlockModeId;
  readonly label: string;
  readonly glyph: string;
  /** What to do in it, in one plain sentence (the status line). */
  readonly hint: string;
  readonly tiles: readonly BlockToolTile[];
}

export const BLOCK_MODES: readonly BlockMode[] = Object.freeze([
  {
    id: 'build',
    label: 'Build',
    glyph: 'block-build',
    hint: 'Pick a block type, then drag on the layer to build with it.',
    tiles: [
      { id: 'single', tool: 'single', label: 'Single', glyph: 'block-single', key: 'Q', hint: 'Drag over cells to put the block in each; an edge piece (wall, door, fence) goes on the cell edges you drag along.' },
      { id: 'line', tool: 'line', label: 'Line', glyph: 'block-line', key: 'L', hint: 'Drag a straight line of blocks; an edge piece runs along the grid line between two corners.' },
      { id: 'rect', tool: 'rect', label: 'Rect', glyph: 'block-rect', key: 'R', hint: "Drag a rectangle one cell thick on the slice; an edge piece draws its outline (a room's walls)." },
      { id: 'box', tool: 'box', label: 'Box', glyph: 'block-box', key: 'B', hint: 'Drag a rectangle: it fills up to the box height. An edge piece draws walls that tall.' },
      { id: 'flood', tool: 'flood', label: 'Flood', glyph: 'block-flood', key: 'G', hint: 'Click a cell: the connected cells like it become the block.' },
      { id: 'column', tool: 'column', label: 'Column', glyph: 'block-column', key: 'U', hint: 'Drag over columns to raise each by a cell of the block (Ctrl held: lower them).' },
      { id: 'erase', tool: 'erase', label: 'Erase', glyph: 'erase', key: 'X', hint: 'Drag over cells to empty them; with an edge piece picked, the edges you drag along.' },
      { id: 'eyedropper', tool: 'eyedropper', label: 'Pick', glyph: 'block-pick', key: 'I', hint: "Click a cell: its block, turn and look become the brush's." },
      { id: 'replace', tool: 'replace', label: 'Replace', glyph: 'block-replace', key: 'H', hint: "Click a cell: every block of its type in the layer becomes the brush's." },
      { id: 'stamp', tool: 'stamp', label: 'Stamp', glyph: 'stamp', key: 'K', hint: 'Click to place the picked stamp with its corner at the cell.' },
      { id: 'paste', tool: 'paste', label: 'Paste', glyph: 'block-paste', key: 'V', hint: 'Click to paste the copied cells with their corner at the cell.' },
      { id: 'select', tool: 'select', label: 'Select', glyph: 'box', key: 'S', hint: 'Drag a box of cells; then copy, move, mirror, turn, delete or save it as a stamp.' },
    ],
  },
  {
    id: 'shape',
    label: 'Shape',
    glyph: 'sculpt',
    hint: 'Drag on the ground to shape its tops into slopes.',
    tiles: [
      { id: 'raise', tool: 'height', invert: false, label: 'Raise', glyph: 'raise', key: 'Q', hint: 'Drag on the ground to raise it under the brush: the tops slope.' },
      { id: 'lower', tool: 'height', invert: true, label: 'Lower', glyph: 'lower', key: 'W', hint: 'Drag on the ground to lower it under the brush.' },
      { id: 'smooth', tool: 'smooth', label: 'Smooth', glyph: 'smooth', key: 'E', hint: 'Drag to even the ground out: slopes soften, cliffs wear down.' },
      { id: 'flatten', tool: 'flatten', label: 'Flatten', glyph: 'flatten', key: 'R', hint: 'Drag to level the ground to the height where the drag starts.' },
    ],
  },
  {
    id: 'paint',
    label: 'Paint',
    glyph: 'paint',
    hint: 'Drag on the layer to paint the picked material layer.',
    tiles: [
      { id: 'paint', tool: 'paint', invert: false, label: 'Paint', glyph: 'paint', key: 'B', hint: 'Drag on the tops or walls to paint the picked layer.' },
      { id: 'erase', tool: 'paint', invert: true, label: 'Erase', glyph: 'erase', key: 'X', hint: 'Drag to take the picked layer off again.' },
    ],
  },
  {
    id: 'regions',
    label: 'Regions',
    glyph: 'block-regions',
    hint: 'Paint named regions (cut-aways, themes) and cell metadata.',
    tiles: [
      { id: 'region', tool: 'region', label: 'Region', glyph: 'block-regions', key: 'R', hint: 'Drag a rectangle to add it to the picked region (Ctrl held: take it out).' },
      { id: 'meta', tool: 'meta', label: 'Metadata', glyph: 'block-meta', key: 'M', hint: "Drag over cells to give them the picked field's value." },
    ],
  },
  {
    id: 'rooms',
    label: 'Rooms & buildings',
    glyph: 'block-rooms',
    hint: 'Draw rooms, paths and buildings of generated architecture on the layer.',
    // Every tile arms the Rooms tool; its id is the tool's mode (`RoomToolMode`).
    tiles: [
      { id: 'rect', tool: 'room', label: 'Rect', glyph: 'room-rect', key: 'R', hint: "Drag a room from corner to corner on the slice's floor." },
      { id: 'polygon', tool: 'room', label: 'Polygon', glyph: 'room-polygon', key: 'P', hint: 'Click the corners (Arc bends the next side); click the first corner, double-click or Enter to close.' },
      { id: 'path', tool: 'room', label: 'Path', glyph: 'room-path', key: 'L', hint: 'Click the points of a rail, fence or pipe; double-click or Enter to finish.' },
      { id: 'building', tool: 'room', label: 'Building', glyph: 'room-building', key: 'B', hint: "Click a building's footprint corners (an L or T too): it gets the facade preset and a hip roof; close it on the first corner." },
      { id: 'door', tool: 'room', label: 'Door', glyph: 'room-door', key: 'D', hint: "Click a room's wall to put a door there (the kit's door piece when one is picked)." },
      { id: 'window', tool: 'room', label: 'Window', glyph: 'room-window', key: 'W', hint: "Click a room's wall to put a window there (the kit's window piece when one is picked)." },
      { id: 'arch', tool: 'room', label: 'Arch', glyph: 'room-arch', key: 'A', hint: "Click a room's wall: an opening two cells wide, no door." },
      { id: 'walls', tool: 'room', label: 'Move walls', glyph: 'room-walls', key: 'M', hint: 'Drag a straight wall across by whole cells (a shared wall moves with both rooms); click a room to pick it.' },
      { id: 'piece', tool: 'room', label: 'Wall piece', glyph: 'room-piece', key: 'O', hint: "Click a wall segment: the kit's wall piece replaces it (Ctrl+click takes it off)." },
      { id: 'corner', tool: 'room', label: 'Corner piece', glyph: 'room-corner', key: 'K', hint: "Click a corner of the walls: the kit's corner piece stands there (Ctrl+click takes it off)." },
    ],
  },
  {
    id: 'rules',
    label: 'Rules',
    glyph: 'rules',
    hint: 'Paint the layers and place models on the tops by rules.',
    tiles: [{ id: 'scatter', tool: 'scatter', label: 'Scatter', glyph: 'scatter', key: 'B', hint: "Drag on the tops to put the picked rule's copies there (Ctrl held: take them off)." }],
  },
] satisfies BlockMode[]);

export function blockModeOf(id: string): BlockMode {
  return BLOCK_MODES.find((m) => m.id === id) ?? BLOCK_MODES[0]!;
}

/** The round brushes (their settings are the shared brush's, one store per tool). */
export type BlockBrushTool = 'height' | 'smooth' | 'flatten' | 'paint' | 'scatter';

export const isBlockBrushTool = (tool: BlockToolId): tool is BlockBrushTool => tool === 'height' || tool === 'smooth' || tool === 'flatten' || tool === 'paint' || tool === 'scatter';

/** The shared brush settings a block tool uses (none: it is no round brush). */
export function blockToolUses(tool: BlockToolId): readonly BrushUse[] {
  switch (tool) {
    case 'height':
      return ['heightStep', 'size', 'strength', 'spacing', 'invert'];
    case 'smooth':
    case 'flatten':
      return ['size', 'strength', 'spacing'];
    case 'paint':
      return ['size', 'strength', 'opacity', 'falloff', 'spacing', 'invert', 'mask'];
    case 'scatter':
      return ['size', 'spacing', 'invert'];
    default:
      return [];
  }
}

/** What inverting a round brush does, in plain words. */
export const BLOCK_INVERT_LABELS: Readonly<Partial<Record<BlockToolId, string>>> = Object.freeze({ height: 'Lower', paint: 'Erase', scatter: 'Take off' });

/** Sizes across (metres) and height steps a block brush may have: twice the edits' radius bounds at 1 m cells. */
export const BLOCK_BRUSH_BOUNDS: BrushBounds = Object.freeze({ size: [2 * PAINT_BRUSH_LIMITS.radiusMin, 2 * PAINT_BRUSH_LIMITS.radiusMax] as const, heightStep: [0.05, SCULPT_LIMITS.strengthMax] as const });

/** A block brush to start from: 6 m across (three cells either way), a soft third of the way per dab. */
export const BLOCK_DEFAULT_BRUSH: BrushSettings = Object.freeze({ ...SHARED_BRUSH, size: 6, strength: 0.35, heightStep: 0.5 }) as BrushSettings;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The least a height dab moves the ground (cells): the edits' corner step. */
const SCULPT_STRENGTH_MIN = 1 / 64;

/**
 * A dab of a round block brush in the layer's cells, from the shared
 * settings: the radius is half the size across, in cells across x; a
 * height dab moves the ground by height step × strength (metres, in rows),
 * the others blend by the strength.
 */
export function blockDab(tool: BlockBrushTool, b: BrushSettings, cellSize: readonly number[]): DabBrush {
  const cw = cellSize[0] ?? 1;
  const r = brushRadius(b) / cw;
  const radius = tool === 'paint' ? clamp(r, PAINT_BRUSH_LIMITS.radiusMin, PAINT_BRUSH_LIMITS.radiusMax) : clamp(r, SCULPT_LIMITS.radiusMin, SCULPT_LIMITS.radiusMax);
  const strength = tool === 'height' ? clamp((b.heightStep * b.strength) / (cellSize[1] ?? 1), SCULPT_STRENGTH_MIN, SCULPT_LIMITS.strengthMax) : b.strength;
  return { radius, strength };
}

/** How far (cells) the brush moves between dabs: the spacing's share of the size, at least a quarter cell. */
export function blockDabStep(b: Pick<BrushSettings, 'size' | 'spacing'>, cellSize: readonly number[]): number {
  return Math.max(0.25, (b.size * b.spacing) / (cellSize[0] ?? 1));
}

// ---- the paint palette ------------------------------------------------------------------

/** The paint channel a block layer's wetness takes (0-3 are its material layers' weights). */
export const BLOCK_WET_CHANNEL = 4;

export interface BlockPaintChannels {
  /** The material reads the layer's painted weights (a layered surface). */
  readonly reads: boolean;
  readonly material: MaterialDef | null;
  /** The palette's tiles, Base, 2, 3, 4 and Wet; each tile's channel is its place (Wet: `BLOCK_WET_CHANNEL`). */
  readonly tiles: readonly PaletteLayer[];
  /** The material in a few words. */
  readonly summary: string;
}

const STAND_IN_COLOURS = ['#8a8a8a', '#a8524a', '#5d8a4a', '#4a6a9a'] as const;

/**
 * What a block layer's paint means on the material its block types wear
 * (`layers`: that material's palette tiles, named and pictured; absent or
 * empty: stand-ins named by number). A material that reads the painted
 * weights (`layerWeights`: a layered surface) shows its layers as Base and
 * layers 2–4 plus Wet; anything else reads no paint.
 */
export function blockPaintChannels(material: MaterialDef | null, materials: readonly MaterialDef[], layers?: readonly PaletteLayer[]): BlockPaintChannels {
  const reads = material !== null && materialReads(material, 'layerWeights', { materials });
  const shown: readonly PaletteLayer[] = layers !== undefined && layers.length > 0 ? layers : Array.from({ length: TEMPLATE_LAYERS }, (_, i): PaletteLayer => ({ index: i, name: '', texture: null, colour: STAND_IN_COLOURS[i]! }));
  // The base keeps its texture's name; without one it is called what it is (the others: their numbers).
  const tiles: PaletteLayer[] = shown.slice(0, TEMPLATE_LAYERS).map((l, i) => ({ ...l, index: i, name: i === 0 && (l.texture === null || l.name === '') ? 'Base' : l.name !== '' ? l.name : `Layer ${i + 1}`, sub: i === 0 ? 'base' : `layer ${i + 1}`, ...(i === 0 ? { badge: 'B' } : {}), aria: `paint layer ${i + 1}` }));
  tiles.push({ index: BLOCK_WET_CHANNEL, name: 'Wet', texture: null, sub: 'wetness', badge: 'W', wet: true, aria: 'paint wetness' });
  const shader = material === null ? null : (MATERIAL_SHADER_LABELS[material.shader] ?? material.shader);
  const summary = material === null ? 'no material: the stand-in colours' : reads ? `Layered surface · ${Math.min(TEMPLATE_LAYERS, shown.length)} layers + wetness` : `${material.graph !== undefined ? 'Graph material' : shader} · reads no paint`;
  return { reads, material, tiles, summary };
}
