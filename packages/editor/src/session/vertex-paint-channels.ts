/**
 * What an object's vertex paint means, read from the material it draws
 * with (its "*" mapping) and that material's declaration (`materialReads`):
 * the vertex paint editor's palette, its channel view and its "doesn't
 * read paint" warning all come from here, so the four bytes are never shown
 * as bare R, G, B and A where the material gives them a meaning.
 *
 * - **A layered surface** (it mixes layers by the painted weights): the
 *   base (layer 1, what the others leave), layers 2–4 on R, G and B, and
 *   wetness on A. The tiles take the layers' names and pictures.
 *   Painting the base takes layers 2–4 off at once.
 * - **A trim sheet** keeps its own meaning: G is grime, B is wetness.
 * - **A standard material with paint tint**: R, G, B tint the colour, A is
 *   how much.
 * - **A graph that reads the paint otherwise**: the bytes as its Vertex
 *   colour (paint) node gives them.
 * - **Anything else reads no paint**: painting would change nothing seen.
 *
 * Pure.
 */
import type { MaterialDef } from '@thirdlight/project-model';
import { MATERIAL_SHADER_LABELS, materialReads } from '@thirdlight/project-model/material-reads';

import { paletteLayers, paletteSource, type PaletteLayer } from './layer-palette';
import { TEMPLATE_LAYERS } from './material-graph';

/** What the paint means on a material. */
export type PaintMeaning = 'layers' | 'trim' | 'tint' | 'raw' | 'none';

/** The bytes a palette tile paints: its channel and the ones painted alike with it; `erases`: its strokes always take paint off. */
export interface PaintTarget {
  readonly channel: number;
  readonly channels?: readonly number[];
  readonly erases?: boolean;
}

/** One entry of the channel view: what it shows as grey (null: the material as drawn). */
export interface PaintView {
  readonly label: string;
  readonly channel: number | null;
}

export interface PaintChannels {
  readonly meaning: PaintMeaning;
  /** The material the object draws with for all of its meshes (null: its model's own). */
  readonly material: MaterialDef | null;
  /** The palette's tiles (index = the tile's place) and what each paints. */
  readonly tiles: readonly PaletteLayer[];
  readonly targets: readonly PaintTarget[];
  /** The channel view's entries, "Final" first. */
  readonly views: readonly PaintView[];
  /** The material in a few words ("Layered surface · 4 layers + wetness"). */
  readonly summary: string;
  /** One line under the palette: what the tiles mean. */
  readonly hint: string;
}

/** The paint channel wetness takes (A) on a layered surface; layers 2–4 take R, G and B. */
export const PAINT_WET_CHANNEL = 3;
/** The vertex paint channels a layered surface's layers 2–4 take (R, G, B). */
const LAYER_CHANNELS = [0, 1, 2] as const;

/** The colour the stand-in tiles of a material without pictures show, by channel (dull, so a real texture reads as one). */
const CHANNEL_COLOURS = ['#a8524a', '#5d8a4a', '#4a6a9a', '#8a8a8a'] as const;
const WET: Pick<PaletteLayer, 'wet'> = { wet: true };

/** Four layers named by number in plain colours (a graph that mixes its own layers, or a material not yet paintable). */
const standIns = (): PaletteLayer[] => Array.from({ length: TEMPLATE_LAYERS }, (_, i): PaletteLayer => ({ index: i, name: i === 0 ? 'Base' : `Layer ${i + 1}`, texture: null, colour: CHANNEL_COLOURS[i === 0 ? 3 : i - 1]! }));

/** The layered surface's tiles from its palette layers (the first four): Base, 2, 3, 4, Wet. */
function layerTiles(layers: readonly PaletteLayer[]): { tiles: PaletteLayer[]; targets: PaintTarget[]; views: PaintView[] } {
  const four = layers.slice(0, TEMPLATE_LAYERS);
  const tiles: PaletteLayer[] = [];
  const targets: PaintTarget[] = [];
  const views: PaintView[] = [{ label: 'Final', channel: null }];
  four.forEach((l, i) => {
    const plain = { ...l, index: tiles.length, sub: i === 0 ? 'base' : `layer ${i + 1}` };
    if (i === 0) {
      tiles.push({ ...plain, badge: 'B' });
      // The base is what R, G and B leave: painting it takes all three off.
      targets.push({ channel: LAYER_CHANNELS[0], channels: [LAYER_CHANNELS[1], LAYER_CHANNELS[2]], erases: true });
      return;
    }
    const channel = LAYER_CHANNELS[i - 1]!;
    tiles.push(plain);
    targets.push({ channel });
    views.push({ label: l.name, channel });
  });
  tiles.push({ index: tiles.length, name: 'Wet', texture: null, sub: 'wetness', badge: 'W', ...WET });
  targets.push({ channel: PAINT_WET_CHANNEL });
  views.push({ label: 'Wetness', channel: PAINT_WET_CHANNEL });
  return { tiles, targets, views };
}

/** Tiles named by channel (a tint, a graph's raw bytes): one each, with its channel's colour. */
function channelTiles(names: readonly (readonly [number, string, string])[]): { tiles: PaletteLayer[]; targets: PaintTarget[]; views: PaintView[] } {
  return {
    tiles: names.map(([channel, name, sub], index) => ({ index, name, texture: null, sub, ...(name === 'Wetness' ? { badge: 'W', ...WET } : { colour: CHANNEL_COLOURS[channel]!, badge: 'RGBA'[channel]! }) })),
    targets: names.map(([channel]) => ({ channel })),
    views: [{ label: 'Final', channel: null }, ...names.map(([channel, name]) => ({ label: name, channel }))],
  };
}

/**
 * What vertex paint means on an object with this material mapping, given the
 * project's materials (`layers`: the layer palette's tiles of its material,
 * named and badged as the palette shows them; absent: read from the material).
 */
export function paintChannels(mapping: Readonly<Record<string, string>> | undefined, materials: readonly MaterialDef[], layers?: readonly PaletteLayer[]): PaintChannels {
  const source = paletteSource(mapping, materials);
  const material = source.material;
  const ctx = { materials };
  const reads = material !== null && materialReads(material, 'vertexPaint', ctx);
  if (material !== null && reads && materialReads(material, 'layerWeights', ctx)) {
    // A layered surface: its layers by name and picture (a graph of its own mixes by number: stand-ins named by number).
    const shown = source.kind === 'none' ? standIns() : (layers ?? paletteLayers(source.material, () => undefined, null));
    const t = layerTiles(shown);
    return { meaning: 'layers', material, ...t, summary: `Layered surface · ${Math.min(TEMPLATE_LAYERS, shown.length)} layers + wetness`, hint: 'Base is what the other layers leave: paint it to take them off. Wetness darkens and adds shine on top of any layer.' };
  }
  const shader = material !== null ? (MATERIAL_SHADER_LABELS[material.shader] ?? material.shader) : null;
  if (material !== null && reads && material.graph === undefined && material.shader === 'trim') {
    const grime = typeof material.params['grimeColor'] === 'string' ? material.params['grimeColor'] : '#3b3328';
    const t = channelTiles([
      [1, 'Grime', 'G'],
      [2, 'Wetness', 'B'],
    ]);
    const tiles = t.tiles.map((x, i) => (i === 0 ? { ...x, colour: grime } : x));
    return { meaning: 'trim', material, ...t, tiles, summary: `${shader} · grime and wetness`, hint: 'A trim sheet reads paint as grime (G) and wetness (B). For layers of other materials on it, make it a layered surface (Material).' };
  }
  if (material !== null && reads && material.graph === undefined) {
    const t = channelTiles([
      [0, 'Tint red', 'R'],
      [1, 'Tint green', 'G'],
      [2, 'Tint blue', 'B'],
      [3, 'Tint amount', 'A'],
    ]);
    return { meaning: 'tint', material, ...t, summary: `${shader} · paint tint`, hint: 'Paint tint: R, G and B are the tint\'s colour, A how much of it covers the material (A alone darkens it).' };
  }
  if (material !== null && reads) {
    const t = channelTiles([0, 1, 2, 3].map((c) => [c, `Paint ${'RGBA'[c]!}`, 'as the graph reads it'] as const));
    return { meaning: 'raw', material, ...t, summary: 'Graph material · reads the paint', hint: 'The graph reads the paint through its Vertex colour (paint) node: what each channel does is the graph\'s.' };
  }
  // Reads no paint: the layered surface's tiles as the editor would paint them once it is made paintable.
  const t = layerTiles(standIns());
  return { meaning: 'none', material, ...t, summary: material === null ? 'No material of the project\'s' : `${material.graph !== undefined ? 'Graph' : shader} material`, hint: 'Painting is off: this material reads no paint.' };
}

/**
 * The material an object's paint is read by, from its material mapping: its
 * "*" slot's; else, when its named slots name one material between them (a
 * spline's `spline`, a model's slots all alike), that one; else its first
 * named slot's (null: no mapping — the model's own materials). `slots`: the
 * named slots naming it (they are drawn before "*", so a material put in
 * its place goes there too).
 */
export function paintMaterialSlots(mapping: Readonly<Record<string, string>> | undefined): { materialId: string; slots: string[] } | null {
  if (mapping === undefined) return null;
  const named = Object.keys(mapping).filter((k) => k !== '*').sort();
  const id = mapping['*'] ?? (named.length > 0 ? mapping[named[0]!] : undefined);
  return id === undefined ? null : { materialId: id, slots: named.filter((k) => mapping[k] === id) };
}

/** The tile whose strokes paint `target` (its place in the palette; -1: none). */
export function tileOf(c: PaintChannels, target: PaintTarget): number {
  return c.targets.findIndex((t) => t.channel === target.channel && (t.channels ?? []).join() === (target.channels ?? []).join());
}
