/**
 * The layered surface: the one material layout terrain, block ground and
 * walls, generated architecture, splines and painted props wear. It is a
 * graph (the editor's "Layered surface" default, `layeredMaterial`), so a
 * user customizes it like any graph material, and the renderer compiles it
 * like any graph — there is no second shader for walls.
 *
 * Up to four layers (a terrain draws more through `extraLayers`), each a
 * texture set — albedo with height in alpha, normal map, ORM — read from
 * three texture arrays at the layer's index, with its own UV source, tiling,
 * normal strength and height contrast and offset (the vec4 parameters of
 * {@link LAYER_SETTINGS}, one component per layer). The layers are mixed by
 * a Height blend of their weights; wetness goes on top.
 *
 * UV sources ({@link UV_SOURCES}):
 * - `top`: UV0 ÷ tiling — terrain and block ground's UVs are world metres, so
 *   this is the view from above;
 * - `world`: the world plane the surface faces most, in metres — from above
 *   on flat ground, from the side on walls and cliffs (one read, no stretch).
 *   Derived from the world position, so no mesh needs a second UV set: the
 *   meshes that wear it (architecture, block walls, splines, merged statics)
 *   stand still. A moving prop's world layers slide over it — give a prop
 *   `geometry` layers;
 * - `biplanar`: the top and the side plane blended by the slope near the
 *   camera (two reads there);
 * - `geometry`: the mesh's own UV0 as made — a generated wall's trim strips, a
 *   model's unwrap — never tiled; with a trim sheet's rows
 *   (`layerSheets`) the read keeps its mip level inside the row
 *   (`trimMaxFootprint`).
 *
 * Weights (the Layer weights node, compiled per mesh): a terrain's and a
 * painted block layer's stored weights; otherwise the vertex paint as layers
 * — the base (layer 1) is what the others leave, 1 − (R + G + B) clamped,
 * then R, G, B are layers 2–4 and A is the wetness; an unpainted mesh shows
 * its base, or its own vertex colours as weights where it has them.
 * Generated architecture's trim data (R occlusion, G grime, B wetness: the
 * trim sheet's convention) adds its wetness to the paint's, its occlusion
 * darkens the indirect light, and its grime (the block layer's path paint
 * under the building) pulls the colour toward a grime colour and the
 * surface toward matte — grime, not a layer, whatever the layers are.
 *
 * Only the layers a material uses are read: a material with a trim layer
 * draws up to its last filled colour slot (`layeredForDraw`). Layers with a
 * `geometry` UV source (trim sheets) and the rest (tiling textures) each make
 * their own arrays, so a trim group at the sheet's size and a tiling group at
 * its own size never force each other's size: at most two arrays per map.
 *
 * The old `trim` shader draws as a layered surface with one trim layer
 * (`trimSurfaceMaterial`): same reads, same pixels, its grime a layer of
 * grime colour.
 *
 * Pure (graph data only): the editor, the backend and the renderer share it
 * (`@thirdlight/project-model/layered-surface`).
 */
import type { GraphEdge, GraphNode } from './graph';
import type { MaterialDef, MaterialParameter } from './materials';
import type { TrimRow, TrimSheet } from './trim-sheet';

/**
 * The wet look (the layered surface and the trim material drawn as one): the albedo darkens by this factor and
 * the roughness goes toward this value as wetness reaches 1.
 */
export const WET_ALBEDO_SCALE = 0.55;
export const WET_ROUGHNESS = 0.1;

type Data = Record<string, number | string | boolean | number[]>;
/** A node's output: [node id, port id]. */
export type GraphOut = readonly [string, string];

/** Builds a graph node by node; `layout` places the nodes in columns by their distance to the outputs. */
export class GraphBuilder {
  readonly nodes: GraphNode[] = [];
  readonly edges: GraphEdge[] = [];
  readonly parameters: MaterialParameter[];
  private readonly taken: Set<string>;
  constructor(existing: readonly MaterialParameter[]) {
    this.parameters = [...existing];
    this.taken = new Set(existing.map((p) => p.key));
  }
  add(id: string, type: string, data: Data = {}): string {
    let unique = id;
    for (let i = 2; this.nodes.some((n) => n.id === unique); i++) unique = `${id}${i}`;
    this.nodes.push({ id: unique, type, position: [0, 0], ...(Object.keys(data).length > 0 ? { data } : {}) });
    return unique;
  }
  wire(from: GraphOut, to: string, toPort: string): void {
    this.edges.push({ id: `w${this.edges.length + 1}`, from: { node: from[0], port: from[1] }, to: { node: to, port: toPort } });
  }
  /** A binary maths node over two outputs (or constants). */
  op(type: string, id: string, a: GraphOut, b: GraphOut): GraphOut {
    const n = this.add(id, type);
    this.wire(a, n, 'a');
    this.wire(b, n, 'b');
    return [n, 'out'];
  }
  float(id: string, value: number): GraphOut {
    return [this.add(id, 'float', { value }), 'value'];
  }
  color(id: string, color: string): GraphOut {
    return [this.add(id, 'color', color !== '#ffffff' ? { color } : {}), 'rgb'];
  }
  /**
   * A public exposed parameter of the template (objects may override it), or
   * the plain constant when the material already declares that key for
   * something else.
   */
  param(key: string, type: 'float' | 'vec2' | 'vec4' | 'color', value: number | number[] | string, visibility: 'public' | 'private' = 'public'): GraphOut {
    if (this.taken.has(key)) return type === 'float' ? this.float(key, value as number) : type === 'color' ? this.color(key, value as string) : [this.add(key, type, { value: value as number[] }), 'value'];
    this.taken.add(key);
    this.parameters.push({ key, type, default: value, ...(visibility === 'private' ? { visibility } : {}) });
    return [this.add(key, 'parameter', { key }), 'value'];
  }
  /** A public texture parameter (a texture array for the layered template); '' = none yet. */
  textureParam(key: string, value = ''): GraphOut {
    this.taken.add(key);
    this.parameters.push({ key, type: 'texture', default: value });
    return [this.add(key, 'parameter', { key }), 'value'];
  }
  layout(): void {
    // Column = the longest path from the node to an output (outputs in column 0, on the right).
    const outgoing = new Map<string, string[]>();
    for (const e of this.edges) outgoing.set(e.from.node, [...(outgoing.get(e.from.node) ?? []), e.to.node]);
    const depth = new Map<string, number>();
    const depthOf = (id: string, seen: Set<string>): number => {
      const have = depth.get(id);
      if (have !== undefined) return have;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = Math.max(0, ...(outgoing.get(id) ?? []).map((t) => depthOf(t, seen) + 1));
      depth.set(id, d);
      return d;
    };
    const rows = new Map<number, number>();
    for (const n of this.nodes) {
      const d = depthOf(n.id, new Set());
      const r = rows.get(d) ?? 0;
      rows.set(d, r + 1);
      n.position = [-d * 240, r * 120];
    }
  }
}

/** The UV sources a layer reads by (the values of its `layerProjection` component). */
export const UV_SOURCES = { top: 0, world: 1, biplanar: 2, geometry: 3 } as const;

/**
 * The layered template's per-layer settings: a vec4 parameter each, one
 * component per layer. `min` is the smallest value the editor's layer table
 * takes (a tiling of 0 would repeat endlessly); null: any.
 */
export const LAYER_SETTINGS = [
  { key: 'layerTiling', label: 'tiling (m)', title: 'Metres per repeat of the layer\'s textures (a mesh-UV layer keeps the mesh\'s own UVs)', fill: 1, min: 0.01 },
  { key: 'layerNormalStrength', label: 'normal strength', title: 'How strongly the layer\'s normal map bends the light (0: flat)', fill: 1, min: null },
  { key: 'layerContrast', label: 'height contrast', title: 'Stretches the layer\'s height around its middle: above 1 its peaks and cracks stand further apart in the blend', fill: 1, min: null },
  { key: 'layerOffset', label: 'height offset', title: 'Lifts the layer\'s height in the blend (it shows over the others sooner)', fill: 0, min: null },
  {
    key: 'layerProjection',
    label: 'UV source',
    title:
      'Where the layer\'s textures get their coordinates: top (the mesh\'s metre UVs — terrain and block ground: the world from above), world (the world plane the surface faces most: from above on the ground, from the side on walls and cliffs — tiling layers on buildings), biplanar (top and side blended by the slope: two reads within the biplanar distance), or mesh UVs (the mesh\'s own UVs as made: a trim sheet\'s strips on generated walls, a model\'s unwrap)',
    fill: 0,
    min: 0,
    options: [
      { value: UV_SOURCES.top, label: 'top' },
      { value: UV_SOURCES.world, label: 'world' },
      { value: UV_SOURCES.biplanar, label: 'biplanar' },
      { value: UV_SOURCES.geometry, label: 'mesh UVs' },
    ],
  },
] as const;

/** The extra texture reads a pixel of a biplanar layer pays where both planes show, within the biplanar distance (albedo, normal, ORM). */
export const BIPLANAR_EXTRA_READS = 3;
/** The texture reads a pixel of one layer of the layered template (albedo, normal, ORM). */
export const LAYER_READS = 3;
/** The number of layers of the layered template (the four components of its weights). */
export const TEMPLATE_LAYERS = 4;
/** The texture reads a pixel of the layered template with every layer used. */
export const TEMPLATE_READS = LAYER_READS * TEMPLATE_LAYERS;

/** The layered template's three texture-array parameters (the layer palette reads and fills the albedo's slots). */
export const LAYERED_TEXTURES = { albedo: 'albedoHeight', normals: 'normals', orm: 'orm' } as const;

/** Metres from the camera a biplanar layer reads both planes within (past it: the plane the ground faces most). */
export const BIPLANAR_DISTANCE = 60;

/**
 * A read node's layer index that reads nothing: it gives what it gives
 * without a texture (its `absent` value, a flat normal) — a layer the
 * material does not use, or a group whose array has no texture.
 */
export const LAYER_NOT_READ = -1;

/** The roughness grime moves toward (dust and soot are matte). */
const GRIME_ROUGHNESS = 0.95;
/** The colour grime pulls toward (a trim material's default `grimeColor`, and the layered surface's). */
export const GRIME_COLOUR = '#3b3328';

/**
 * The layered surface template — four PBR layers from three texture arrays
 * (public texture parameters `albedoHeight`: albedo RGB with the height in
 * A, colour; `normals`: normal maps; `orm`: occlusion, roughness, metalness,
 * data), layer i sampled at array layer i. A layer (or the whole array)
 * without a normal map reads a flat normal, without an ORM map unoccluded,
 * at the PBR default roughness and not metal. Per layer (the components of
 * {@link LAYER_SETTINGS}' vec4 parameters): its tiling, its UV source, its
 * normal strength, and its height's contrast and offset in the blend. The
 * weights are the Layer weights node's (see the file comment), shaped by the
 * layers' heights through a Height blend (`blendDepth`); every layer value is
 * a Weighted mix. Wetness — the stored or painted one or the `wetness`
 * parameter (rain on this material), the larger, plus the scene's — pools in
 * the low parts of the blended height first (`wetPooling`), darkens the
 * albedo and smooths the surface (the albedo × 0.55, roughness toward 0.1)
 * and flattens the normal maps (`wetFlatten`). The mesh's vertex occlusion
 * (generated architecture's) darkens the indirect light (`occlusion`).
 * Per-layer values and wetness change no texture reads: twelve samples, as
 * with one shared value — but a biplanar layer reads three more where both
 * its planes show near the camera.
 */
export function layeredMaterial(materialId: string, name: string): MaterialDef {
  const b = new GraphBuilder([]);
  const out = b.add('output', 'pbr');
  const albedoArr = b.textureParam(LAYERED_TEXTURES.albedo);
  const normalArr = b.textureParam(LAYERED_TEXTURES.normals);
  const ormArr = b.textureParam(LAYERED_TEXTURES.orm);
  // The UV source is the material's own (private): the compile reads it, so a layer that never leaves the top reads once.
  const setting = (key: (typeof LAYER_SETTINGS)[number]['key']): GraphOut => {
    const s = LAYER_SETTINGS.find((x) => x.key === key)!;
    return b.param(key, 'vec4', Array.from({ length: TEMPLATE_LAYERS }, () => s.fill), key === 'layerProjection' ? 'private' : 'public');
  };
  const layers = [0, 1, 2, 3];
  const comp = ['x', 'y', 'z', 'w'] as const;
  // Per layer: its tiling (kept above the smallest the editor takes: a 0 from a script stays finite) and UV source.
  const tiling = b.add('tilingSplit', 'split');
  b.wire(b.op('max', 'tilingFloor', setting('layerTiling'), b.float('tilingMin', LAYER_SETTINGS[0].min)), tiling, 'in');
  const projection = b.add('projectionSplit', 'split');
  b.wire(setting('layerProjection'), projection, 'in');
  const near: GraphOut = b.param('biplanarDistance', 'float', BIPLANAR_DISTANCE);
  const strength = b.add('strengthSplit', 'split');
  b.wire(setting('layerNormalStrength'), strength, 'in');
  const source = b.add('layerWeights', 'layerWeights');
  const layerNodes = layers.map((i) => b.float(`layer${i + 1}`, i));
  /** Layer i of an array, read as its UV source says (UV0 ÷ tiling at the top). */
  const read = (id: string, arr: GraphOut, i: number, data: Record<string, string> = {}): string => {
    const s = b.add(id, 'projectedSample', data);
    b.wire(arr, s, 'tex');
    b.wire([tiling, comp[i]!], s, 'scale');
    b.wire([projection, comp[i]!], s, 'mode');
    b.wire(near, s, 'near');
    b.wire(layerNodes[i]!, s, 'layer');
    return s;
  };
  const albedos = layers.map((i) => read(`albedo${i + 1}`, albedoArr, i));
  const heights = b.add('heights', 'combine');
  comp.forEach((c, i) => b.wire([albedos[i]!, 'a'], heights, c));
  const blend = b.add('heightBlend', 'heightBlend');
  b.wire([source, 'weights'], blend, 'weights');
  b.wire([heights, 'xyzw'], blend, 'heights');
  b.wire(b.param('blendDepth', 'float', 0.2), blend, 'depth');
  b.wire(setting('layerContrast'), blend, 'contrast');
  b.wire(setting('layerOffset'), blend, 'offset');
  const mix = (id: string, values: GraphOut[]): GraphOut => {
    const m = b.add(id, 'weightedMix');
    ['a', 'b', 'c', 'd'].forEach((port, i) => b.wire(values[i]!, m, port));
    b.wire([blend, 'weights'], m, 'weights');
    return [m, 'out'];
  };
  // The base layer's tint (white: its texture as it is). A trim material put over generated architecture tinted its
  // sheet by the architecture's stand-in colour; a trim sheet made a layered surface's base keeps that look here.
  const baseTint = b.op('multiply', 'baseTinted', [albedos[0]!, 'rgb'], b.param('color', 'color', '#ffffff'));
  const layered = mix('albedoMix', albedos.map((s, i) => (i === 0 ? baseTint : ([s, 'rgb'] as GraphOut))));
  // Generated architecture's grime (0 on every other mesh): toward the grime colour and matte, by the `grime` amount.
  const grimeAmount = b.add('grimeAmount', 'saturate');
  b.wire(b.op('multiply', 'grimeScaled', [source, 'grime'], b.param('grime', 'float', 1)), grimeAmount, 'in');
  const grimed = b.add('grimeColourMix', 'lerp');
  b.wire(layered, grimed, 'a');
  b.wire(b.param('grimeColor', 'color', GRIME_COLOUR), grimed, 'b');
  b.wire([grimeAmount, 'out'], grimed, 't');
  const albedo: GraphOut = [grimed, 'out'];
  // Wetness: the stored or painted one, or the parameter (rain on this material), whichever is larger, plus the scene's.
  const wetLocal = b.op('max', 'wet', [source, 'wetness'], b.param('wetness', 'float', 0));
  const wetAll = b.add('wetTotal', 'saturate');
  b.wire(b.op('add', 'wetWithScene', wetLocal, [b.add('sceneWet', 'sceneWetness'), 'wetness']), wetAll, 'in');
  // Pooling: water fills the low parts of the blended height first (wet + (wet − height) × pooling).
  const height = b.add('wetHeight', 'dot');
  b.wire([blend, 'weights'], height, 'a');
  b.wire([heights, 'xyzw'], height, 'b');
  const pooled = b.op('multiply', 'wetPool', b.op('subtract', 'wetAboveHeight', [wetAll, 'out'], [height, 'out']), b.param('wetPooling', 'float', 0.5));
  const wetPixel = b.add('wetPooled', 'saturate');
  b.wire(b.op('add', 'wetPooledSum', [wetAll, 'out'], pooled), wetPixel, 'in');
  const wet: GraphOut = [wetPixel, 'out'];
  // Normal flattening: water fills the bumps, so a wet surface's normal maps fade.
  const flat = b.add('wetFlat', 'oneMinus');
  b.wire(b.op('multiply', 'wetFlatAmount', wet, b.param('wetFlatten', 'float', 0.7)), flat, 'in');
  const normals = layers.map((i) => {
    const n = read(`normal${i + 1}`, normalArr, i, { decode: 'normal', colorSpace: 'linear' });
    b.wire(b.op('multiply', `strength${i + 1}`, [strength, comp[i]!], [flat, 'out']), n, 'strength');
    return [n, 'normal'] as GraphOut;
  });
  const orms = layers.map((i) => [read(`orm${i + 1}`, ormArr, i, { colorSpace: 'linear', absent: 'orm' }), 'rgb'] as GraphOut);
  const orm = b.add('ormSplit', 'split');
  b.wire(mix('ormMix', orms), orm, 'in');
  const darken = b.add('wetDarken', 'lerp');
  b.wire(b.float('dry', 1), darken, 'a');
  b.wire(b.float('wetAlbedo', WET_ALBEDO_SCALE), darken, 'b');
  b.wire(wet, darken, 't');
  b.wire(b.op('multiply', 'wetColour', albedo, [darken, 'out']), out, 'baseColor');
  const matte = b.add('grimeRoughMix', 'lerp');
  b.wire([orm, 'y'], matte, 'a');
  b.wire(b.float('grimeRoughness', GRIME_ROUGHNESS), matte, 'b');
  b.wire([grimeAmount, 'out'], matte, 't');
  const gloss = b.add('wetGloss', 'lerp');
  b.wire([matte, 'out'], gloss, 'a');
  b.wire(b.float('wetRoughness', WET_ROUGHNESS), gloss, 'b');
  b.wire(wet, gloss, 't');
  b.wire([gloss, 'out'], out, 'roughness');
  b.wire([orm, 'z'], out, 'metalness');
  // The layers' occlusion, darkened by the mesh's own (generated architecture's baked corners).
  const open = b.add('vertexOpen', 'oneMinus');
  const shut = b.add('vertexShut', 'saturate');
  b.wire(b.op('multiply', 'vertexOcclusion', [source, 'occlusion'], b.param('occlusion', 'float', 1)), shut, 'in');
  b.wire([shut, 'out'], open, 'in');
  b.wire(b.op('multiply', 'occluded', [orm, 'x'], [open, 'out']), out, 'ao');
  b.wire(mix('normalMix', normals), out, 'normal');
  b.layout();
  return { materialId, name, shader: 'standard', params: {}, textures: {}, parameters: b.parameters, graph: { nodes: b.nodes, edges: b.edges } };
}

const numOf = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const colourOf = (v: unknown, d: string): string => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);

/**
 * A `trim` shader material as the layered surface it draws as: one layer —
 * the sheet, read at the mesh's UVs (the strips) with the row-safe mip limit
 * of its row table — and a layer of grime colour over it. The trim
 * material's own data stays as it is (`shader`, `params`, `textures`, `trim`:
 * the generator, the decal cells and the editor read those); the graph and
 * its parameters are added, so the renderer draws it as a graph.
 *
 * What it draws is the trim shader's, term by term: the trim data (generated
 * architecture's, else a model's COLOR_0) is the trim convention's (R occlusion, G grime, B wetness; none: clean, dry,
 * unoccluded) with the vertex paint's G added to the grime and its B to the
 * wetness (the trim material's paint keeps the meaning it was painted
 * with); the grime colour layer's weight is that grime × `grime`, taking the
 * ORM's crevices first (× (2 − occlusion)), mixing the colour toward the grime
 * colour and the roughness toward matte; wetness (the vertex's or the
 * material's, the larger, plus the scene's) darkens the albedo, smooths the
 * surface and flattens the normal map; occlusion is the ORM's (× its
 * intensity) times the vertex's.
 */
export function trimSurfaceMaterial(m: MaterialDef): MaterialDef {
  const b = new GraphBuilder([]);
  const p = m.params;
  const alphaMode = p['alphaMode'] === 'cutout' ? 'cutout' : 'opaque';
  const localLights = typeof p['localLights'] === 'string' && p['localLights'] !== 'object' ? p['localLights'] : null;
  const out = b.add('output', 'pbr', { ...(p['doubleSided'] === true ? { doubleSided: true } : {}), ...(localLights !== null ? { localLights } : {}) });
  const mode = b.float('uvSource', UV_SOURCES.geometry);
  const layer = b.float('layer1', 0);
  /** The sheet's texture in a slot, read at the strips' UVs (null: the material has none there). */
  const read = (id: string, slot: string, key: string, data: Record<string, string>): string | null => {
    const asset = m.textures[slot];
    if (asset === undefined || asset === '') return null;
    const s = b.add(id, 'projectedSample', data);
    b.wire(b.textureParam(key, asset), s, 'tex');
    b.wire(mode, s, 'mode');
    b.wire(layer, s, 'layer');
    return s;
  };
  const albedo = read('albedo1', 'map', LAYERED_TEXTURES.albedo, {});
  const ormRead = read('orm1', 'ormMap', LAYERED_TEXTURES.orm, { colorSpace: 'linear' });
  // Without an ORM: unoccluded, the roughness and metalness values as they are on a dielectric (no metal).
  const orm = b.add('ormSplit', 'split');
  b.wire(ormRead !== null ? [ormRead, 'rgba'] : [b.add('ormNone', 'vec4', { value: [1, 1, 0, 1] }), 'value'], orm, 'in');
  const data = b.add('trimData', 'split');
  b.wire([b.add('vertexData', 'vertexColor', { absent: 'zero', set: 'trim' }), 'rgba'], data, 'in');
  const paint = b.add('paintSplit', 'split');
  b.wire([b.add('paint', 'vertexColor', { set: 'paint' }), 'rgba'], paint, 'in');
  const capped = (id: string, a: GraphOut, c: GraphOut): GraphOut => b.op('min', id, b.op('add', `${id}Sum`, a, c), b.float(`${id}Cap`, 1));
  const grimeIn = capped('grimeVertex', [data, 'y'], [paint, 'y']);
  const wetIn = capped('wetVertex', [data, 'z'], [paint, 'z']);
  const wetAll = b.add('wetTotal', 'saturate');
  b.wire(b.op('add', 'wetWithScene', b.op('max', 'wet', wetIn, b.param('wetness', 'float', numOf(p['wetness'], 0))), [b.add('sceneWet', 'sceneWetness'), 'wetness']), wetAll, 'in');
  const wet: GraphOut = [wetAll, 'out'];
  // The grime colour layer's weight: crevices first (at the ORM's full occlusion grime counts double).
  const grime = b.add('grimeWeight', 'saturate');
  b.wire(b.op('multiply', 'grimeCrevices', b.op('multiply', 'grimeScaled', grimeIn, b.param('grime', 'float', numOf(p['grime'], 1))), b.op('subtract', 'creviceGain', b.float('two', 2), [orm, 'x'])), grime, 'in');
  const weights = b.add('layerWeights', 'combine');
  b.wire(b.op('subtract', 'sheetWeight', b.float('one', 1), [grime, 'out']), weights, 'x');
  b.wire([grime, 'out'], weights, 'y');
  const layerMix = (id: string, sheet: GraphOut, grimeValue: GraphOut): GraphOut => {
    const n = b.add(id, 'weightedMix');
    b.wire(sheet, n, 'a');
    b.wire(grimeValue, n, 'b');
    b.wire([weights, 'xyzw'], n, 'weights');
    return [n, 'out'];
  };
  const tint = b.param('color', 'color', colourOf(p['color'], '#ffffff'));
  const sheetColour: GraphOut = albedo !== null ? b.op('multiply', 'tint', [albedo, 'rgb'], tint) : tint;
  const colour = layerMix('colourMix', sheetColour, b.param('grimeColor', 'color', colourOf(p['grimeColor'], GRIME_COLOUR)));
  const darken = b.add('wetDarken', 'lerp');
  b.wire(b.float('dry', 1), darken, 'a');
  b.wire(b.float('wetAlbedo', WET_ALBEDO_SCALE), darken, 'b');
  b.wire(wet, darken, 't');
  b.wire(b.op('multiply', 'wetColour', colour, [darken, 'out']), out, 'baseColor');
  // Roughness and metalness scale the ORM's (1: the sheet's own), as three's maps do.
  const rough = layerMix('roughMix', b.op('multiply', 'roughness', b.param('roughness', 'float', numOf(p['roughness'], 1)), [orm, 'y']), b.float('grimeRoughness', GRIME_ROUGHNESS));
  const gloss = b.add('wetGloss', 'lerp');
  b.wire(rough, gloss, 'a');
  b.wire(b.float('wetRoughness', WET_ROUGHNESS), gloss, 'b');
  b.wire(wet, gloss, 't');
  b.wire([gloss, 'out'], out, 'roughness');
  b.wire(b.op('multiply', 'metalness', b.param('metalness', 'float', numOf(p['metalness'], 1)), [orm, 'z']), out, 'metalness');
  // three's aoMapIntensity rule (r − 1) × intensity + 1, then the vertex occlusion.
  const sheetAo = b.op('add', 'sheetAo', b.op('multiply', 'aoScaled', b.op('subtract', 'aoLess', [orm, 'x'], b.float('aoOne', 1)), b.param('aoIntensity', 'float', numOf(p['aoIntensity'], 1))), b.float('aoBase', 1));
  const shut = b.add('vertexShut', 'saturate');
  b.wire(b.op('multiply', 'vertexOcclusion', [data, 'x'], b.param('occlusion', 'float', numOf(p['occlusion'], 1))), shut, 'in');
  const open = b.add('vertexOpen', 'oneMinus');
  b.wire([shut, 'out'], open, 'in');
  b.wire(b.op('multiply', 'occluded', sheetAo, [open, 'out']), out, 'ao');
  const normal = read('normal1', 'normalMap', LAYERED_TEXTURES.normals, { decode: 'normal', colorSpace: 'linear' });
  if (normal !== null) {
    const flat = b.add('wetFlat', 'oneMinus');
    b.wire(b.op('multiply', 'wetFlatAmount', wet, b.param('wetFlatten', 'float', numOf(p['wetFlatten'], 0.7))), flat, 'in');
    b.wire(b.op('multiply', 'normalStrength', b.param('normalScale', 'float', numOf(p['normalScale'], 1)), [flat, 'out']), normal, 'strength');
    b.wire([normal, 'normal'], out, 'normal');
  }
  if (alphaMode === 'cutout' && albedo !== null) {
    b.wire([albedo, 'a'], out, 'opacity');
    b.wire(b.float('alphaCutoff', numOf(p['alphaCutoff'], 0.5)), out, 'alphaClip');
  }
  b.layout();
  return { ...m, parameters: b.parameters, graph: { nodes: b.nodes, edges: b.edges } };
}

/**
 * The row table a layered material's trim layers follow: the table a build
 * wrote onto it (`trim`), else its first trim sheet's (`layerSheets`, each
 * looked up with `sheetOf`: a trim material's table, null for anything
 * else). Null: no sheet — mesh-UV layers then read the full mip chain, and
 * generated architecture lays its strips on the starter sheet.
 */
export function layerSheetRows(m: { readonly trim?: TrimSheet; readonly layerSheets?: readonly string[] }, sheetOf: (materialId: string) => TrimSheet | null): TrimSheet | null {
  if (m.trim !== undefined) return m.trim;
  for (const id of m.layerSheets ?? []) {
    if (id === '') continue;
    const rows = sheetOf(id);
    if (rows !== null) return rows;
  }
  return null;
}

/** What tells two rows apart (their slot names them). */
const rowText = (r: TrimRow): string => `${r.top}-${r.bottom}${r.texelDensity !== undefined ? `@${r.texelDensity}` : ''}${r.tileV === true ? ' tileV' : ''}`;

/**
 * Where a layered material's trim sheets disagree with its first one: per
 * other layer whose sheet's row table differs, the sheet, and the rows (by
 * slot) that differ — missing on one side, or at other pixels or density —
 * plus `size`, `padding` or `texelDensity` when those differ. One table is
 * read for every trim layer, so a differing sheet draws its strips from the
 * wrong rows. A sheet that names no trim material is left to the reference
 * check.
 */
export function layerSheetMismatches(m: { readonly layerSheets?: readonly string[] }, sheetOf: (materialId: string) => TrimSheet | null): { layer: number; sheet: string; differ: string[] }[] {
  const named = (m.layerSheets ?? []).map((id, layer) => ({ id, layer, rows: id === '' ? null : sheetOf(id) })).filter((x): x is { id: string; layer: number; rows: TrimSheet } => x.rows !== null);
  const first = named[0];
  if (first === undefined) return [];
  const out: { layer: number; sheet: string; differ: string[] }[] = [];
  const rowsOf = (t: TrimSheet): Map<string, string> => new Map(t.rows.map((r) => [r.slot, rowText(r)]));
  const base = rowsOf(first.rows);
  for (const x of named.slice(1)) {
    if (x.id === first.id) continue;
    const differ: string[] = [];
    if (x.rows.size[0] !== first.rows.size[0] || x.rows.size[1] !== first.rows.size[1]) differ.push('size');
    if (x.rows.padding !== first.rows.padding) differ.push('padding');
    if (x.rows.texelDensity !== first.rows.texelDensity) differ.push('texelDensity');
    const other = rowsOf(x.rows);
    for (const slot of new Set([...base.keys(), ...other.keys()])) if (base.get(slot) !== other.get(slot)) differ.push(slot);
    if (differ.length > 0) out.push({ layer: x.layer, sheet: x.id, differ });
  }
  return out;
}

/**
 * The materials a build hands the runtime: each layered material naming trim
 * sheets carries their row table itself (`trim`, from `all`, the project's
 * materials), so the runtime reads the rows and the sheets need not ship.
 */
export function withLayerSheetRows<M extends { readonly trim?: TrimSheet; readonly layerSheets?: readonly string[] }>(materials: readonly M[], all: readonly { readonly materialId: string; readonly shader?: string; readonly trim?: TrimSheet }[]): M[] {
  const sheetOf = (id: string): TrimSheet | null => {
    const s = all.find((x) => x.materialId === id);
    return s?.shader === 'trim' && s.trim !== undefined ? s.trim : null;
  };
  return materials.map((m) => {
    if (m.layerSheets === undefined || m.trim !== undefined) return m;
    const rows = layerSheetRows(m, sheetOf);
    return rows === null ? m : { ...m, trim: rows };
  });
}
