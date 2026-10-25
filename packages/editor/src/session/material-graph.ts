/**
 * The editor side of graph materials (pure).
 *
 * - the port context a material graph (or a material function) is edited in:
 *   the project's standalone graphs for Function call nodes and the
 *   material's parameters for Parameter nodes — project-model's own
 *   `materialGraphContext` / `graphDocumentsContext`, the lookups the backend
 *   validates with;
 * - the graph of a new graph material (one PBR output);
 * - "Convert to graph": a shader-type material as an equivalent graph, and
 *   the built-in templates (every shader type, pixel-tested against
 *   the shader rendering).
 */
import type { GraphContext, GraphData, GraphDocument, GraphKindDef, MaterialDef, MaterialParameter } from '@thirdlight/project-model';
import { graphDocumentsContext } from '@thirdlight/project-model/graph';
import { GraphBuilder, layeredMaterial, type GraphOut } from '@thirdlight/project-model/layered-surface';
import { materialGraphContext, materialParameterPortType } from '@thirdlight/project-model/material-schema';

// The layered surface is project-model's (the renderer draws trim materials as one): the editor's names for it.
export { BIPLANAR_DISTANCE, BIPLANAR_EXTRA_READS, LAYER_READS, LAYER_SETTINGS, LAYERED_TEXTURES, layeredMaterial, TEMPLATE_LAYERS, TEMPLATE_READS, UV_SOURCES } from '@thirdlight/project-model/layered-surface';

/** The port type a parameter feeds into a graph (a colour is a vec3). */
export const parameterPortType: (type: string) => string | null = materialParameterPortType;

/** Standalone graphs by kind and id (Function call nodes read their ports from them). */
export function graphsPortContext(graphs: readonly GraphDocument[], kinds: Readonly<Record<string, GraphKindDef>>): GraphContext {
  return graphDocumentsContext(kinds, graphs);
}

/** A material graph's context: the project's graphs plus its own parameters. */
export function materialPortContext(parameters: readonly MaterialParameter[] | undefined, graphs: readonly GraphDocument[], kinds: Readonly<Record<string, GraphKindDef>>): GraphContext {
  return materialGraphContext(parameters, graphDocumentsContext(kinds, graphs));
}

/** A new graph material's graph: one PBR output (a lit surface, every input at its default). */
export function newMaterialGraph(): GraphData {
  return { nodes: [{ id: 'output', type: 'pbr', position: [400, 0] }], edges: [] };
}

/** The default value of a new parameter of `type`. */
export function parameterDefault(type: MaterialParameter['type']): MaterialParameter['default'] {
  switch (type) {
    case 'float':
      return 0;
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return [0, 0, 0];
    case 'vec4':
      return [0, 0, 0, 0];
    case 'color':
      return '#ffffff';
    case 'texture':
      return '';
    case 'data':
      // Every cell starts transparent black (RGBA bytes).
      return [0, 0, 0, 0];
  }
}

/** Every shader type converts (the five built-in templates). */
export const CONVERTIBLE_SHADERS: readonly string[] = ['standard', 'foliage', 'kit', 'unlit', 'water'];

type Data = Record<string, number | string | boolean | number[]>;
type Out = GraphOut;

/** The value of a shader parameter or the value the renderer draws with when the material leaves it unset (on a box: three's standard material). */
function valueOf(p: MaterialDef['params'], key: string, drawn: number): number {
  return typeof p[key] === 'number' ? (p[key] as number) : drawn;
}

/**
 * A shader-type material as a graph material (the built-in templates): the same values and textures wired so the graph draws what
 * the shader draws — the pixel parity e2e compares both on WebGL 2 and
 * WebGPU. Unset values are what the renderer draws with on a box (three's
 * standard material: roughness 1, emissive intensity 1, normal scale 1; the
 * water shader's own 0.1 roughness and 0.8 opacity); on a model, a shader
 * material also starts from the file's own material — a graph uses only what
 * it contains (the file's values and textures are not part of it). Wind,
 * world-UV and water values become public exposed parameters (objects may
 * override them). Keeps `shader`, `params` and `textures` (the way back:
 * Remove graph).
 *
 * - standard / foliage / kit → PBR output: colour × map, roughness and
 *   metalness × the ORM map's G / B, AO = lerp(1, ORM R, intensity), the
 *   normal map × normal scale, emissive colour × intensity (× map); UVs ×
 *   tiling + offset; opacity × the map's alpha unless opaque, alpha clip.
 * - foliage adds the wind as a world-space vertex offset (COLOR_0 as data:
 *   R bend root→tip, G phase, B flutter; the global wind with gusts) and a
 *   translucency term (base colour × subsurface × COLOR_0 A × 0.25) to the
 *   emissive; double-sided unless switched off.
 * - kit shifts the colour, normal and ORM UVs by the object's (or
 *   instance's) world X ÷ the UV period, and blends a macro normal map on
 *   UV1 over the detail normal (whiteout); AO and emission keep their UVs.
 * - water: a normal map on UV × wave scale + flow × time, the base colour a
 *   fresnel blend from the shallow colour (face-on) to the water colour,
 *   transparent.
 * - unlit → Unlit output: colour × map (× vertex colour when tinted).
 * - standard with `paintTint`: the base colour × lerp(white, vertex paint
 *   RGB, paint A).
 */
export function convertToGraph(m: MaterialDef): { ok: true; material: MaterialDef } | { ok: false; reason: string } {
  if (m.graph !== undefined) return { ok: false, reason: 'this material already has a graph' };
  if (!CONVERTIBLE_SHADERS.includes(m.shader)) return { ok: false, reason: `unknown shader "${m.shader}"` };
  const b = new GraphBuilder(m.parameters ?? []);
  const p = m.params;
  const shader = m.shader;
  const tiling: [number, number] = Array.isArray(p['tiling']) ? (p['tiling'] as [number, number]) : [1, 1];
  const offset: [number, number] = Array.isArray(p['offset']) ? (p['offset'] as [number, number]) : [0, 0];
  const alphaMode = typeof p['alphaMode'] === 'string' ? p['alphaMode'] : 'opaque';
  const doubleSided = p['doubleSided'] === true || (shader === 'foliage' && p['doubleSided'] !== false);
  const transparent = alphaMode === 'blend' || shader === 'water';
  const flags: Data = { ...(doubleSided ? { doubleSided: true } : {}), ...(transparent ? { transparent: true } : {}) };
  const outId = b.add('output', shader === 'unlit' ? 'unlit' : 'pbr', flags);

  // UV = uv0 × tiling + offset (only when the material moves or repeats its textures); null = the mesh's UV0.
  let uvT: Out | null | undefined;
  const uvTiled = (): Out | null => {
    if (uvT !== undefined) return uvT;
    if (tiling[0] === 1 && tiling[1] === 1 && offset[0] === 0 && offset[1] === 0) return (uvT = null);
    const scaled = b.op('multiply', 'uvScale', [b.add('uv', 'uv'), 'uv'], [b.add('tiling', 'vec2', { value: [tiling[0], tiling[1]] }), 'value']);
    uvT = b.op('add', 'uvOffset', scaled, [b.add('offset', 'vec2', { value: [offset[0], offset[1]] }), 'value']);
    return uvT;
  };
  // Kit: the colour, normal and ORM UVs shifted by the object's world X ÷ the UV period.
  let uvK: Out | null = null;
  const uvMain = (): Out | null => {
    if (shader !== 'kit') return uvTiled();
    if (uvK !== null) return uvK;
    const x = b.add('objectX', 'split');
    b.wire([b.add('objectPosition', 'objectPosition'), 'position'], x, 'in');
    const shift = b.op('divide', 'shift', [x, 'x'], b.param('uvPeriod', 'float', valueOf(p, 'uvPeriod', 4)));
    const along = b.add('shiftX', 'combine');
    b.wire(shift, along, 'x');
    uvK = b.op('add', 'uvShifted', uvTiled() ?? [b.add('uv', 'uv'), 'uv'], [along, 'xy']);
    return uvK;
  };
  const sample = (id: string, texture: string, colorSpace: 'srgb' | 'linear', uv: Out | null): string => {
    const s = b.add(id, 'sampleTexture', { texture, ...(colorSpace === 'linear' ? { colorSpace } : {}) });
    if (uv !== null) b.wire(uv, s, 'uv');
    return s;
  };

  /** The albedo sample (its alpha feeds the opacity when the material is not opaque). */
  let albedo: string | null = null;
  const baseColor = (): Out => {
    const c = b.color('baseColor', typeof p['color'] === 'string' ? (p['color'] as string) : '#ffffff');
    const map = m.textures['map'];
    if (map === undefined) return c;
    albedo = sample('albedo', map, 'srgb', uvMain());
    return b.op('multiply', 'tint', [albedo, 'rgb'], c);
  };

  if (shader === 'unlit') {
    let rgb = baseColor();
    if (p['vertexTint'] === true) rgb = b.op('multiply', 'vertexTint', rgb, [b.add('vertexColor', 'vertexColor'), 'rgb']);
    b.wire(rgb, outId, 'color');
  } else if (shader === 'water') {
    // Base colour: the shallow colour face-on, the water colour at grazing angles (fresnel of the unmapped normal).
    const f = b.add('fresnel', 'fresnel');
    b.wire([b.add('normalView', 'normal', { space: 'view' }), 'normal'], f, 'normal');
    b.wire([b.add('viewDir', 'viewDirection', { space: 'view' }), 'direction'], f, 'view');
    b.wire(b.param('fresnel', 'float', valueOf(p, 'fresnel', 3)), f, 'power');
    const t = b.add('fresnelBlend', 'saturate');
    b.wire(b.op('multiply', 'fresnelScale', [f, 'out'], b.float('fresnelGain', 1.5)), t, 'in');
    const mix = b.add('waterColor', 'lerp');
    b.wire(b.param('shallowColor', 'color', typeof p['shallowColor'] === 'string' ? (p['shallowColor'] as string) : '#4fb3c9'), mix, 'a');
    b.wire(b.param('color', 'color', typeof p['color'] === 'string' ? (p['color'] as string) : '#1d5f8a'), mix, 'b');
    b.wire([t, 'out'], mix, 't');
    b.wire([mix, 'out'], outId, 'baseColor');
    b.wire(b.float('roughness', valueOf(p, 'roughness', 0.1)), outId, 'roughness');
    b.wire(b.float('metalness', 0), outId, 'metalness');
    const normal = m.textures['normalMap'];
    if (normal !== undefined) {
      // UV × wave scale + flow × time.
      const waves = b.op('multiply', 'waveUv', [b.add('uv', 'uv'), 'uv'], b.param('waveScale', 'float', valueOf(p, 'waveScale', 2)));
      const flow = Array.isArray(p['flow']) ? (p['flow'] as number[]) : [0.05, 0.02];
      const drift = b.op('multiply', 'drift', b.param('flow', 'vec2', [flow[0]!, flow[1]!]), [b.add('time', 'time'), 'time']);
      const uv = b.op('add', 'flowUv', waves, drift);
      const n = b.add('normalMap', 'normalMap', { texture: normal });
      b.wire(uv, n, 'uv');
      b.wire(b.float('normalScale', valueOf(p, 'normalScale', 1)), n, 'strength');
      b.wire([n, 'normal'], outId, 'normal');
    }
    b.wire(b.float('opacity', valueOf(p, 'opacity', 0.8)), outId, 'opacity');
  } else {
    // standard, foliage, kit: the PBR surface.
    let base = baseColor();
    if (shader === 'standard' && p['paintTint'] === true) {
      // Vertex paint tint: × lerp(white, paint RGB, paint A).
      const paint = b.add('paint', 'vertexColor', { set: 'paint' });
      const tint = b.add('paintTint', 'lerp');
      b.wire([b.add('paintWhite', 'color', { color: '#ffffff' }), 'rgb'], tint, 'a');
      b.wire([paint, 'rgb'], tint, 'b');
      b.wire([paint, 'alpha'], tint, 't');
      base = b.op('multiply', 'paintTinted', base, [tint, 'out']);
    }
    b.wire(base, outId, 'baseColor');
    const orm = m.textures['ormMap'];
    const ormSample = orm !== undefined ? sample('orm', orm, 'linear', uvMain()) : null;
    // Roughness and metalness: the value, times the ORM map's G / B channel (as three.js does).
    for (const [key, drawn, channel] of [['roughness', 1, 'g'], ['metalness', 0, 'b']] as const) {
      const v = b.float(key, valueOf(p, key, drawn));
      b.wire(ormSample === null ? v : b.op('multiply', `${key}Map`, v, [ormSample, channel]), outId, key);
    }
    if (ormSample !== null) {
      // Ambient occlusion = lerp(1, ORM.r, intensity) — a kit keeps the unshifted UV for it.
      const aoSample = shader === 'kit' ? sample('ormAo', orm!, 'linear', uvTiled()) : ormSample;
      const lerp = b.add('ao', 'lerp');
      b.wire(b.float('aoOne', 1), lerp, 'a');
      b.wire([aoSample, 'r'], lerp, 'b');
      b.wire(b.float('aoIntensity', valueOf(p, 'aoIntensity', 1)), lerp, 't');
      b.wire([lerp, 'out'], outId, 'ao');
    }
    const normal = m.textures['normalMap'];
    const scale = valueOf(p, 'normalScale', 1);
    const macro = shader === 'kit' ? m.textures['macroNormalMap'] : undefined;
    if (normal !== undefined && macro !== undefined) {
      // Whiteout blend of the macro normal (UV1) over the detail normal, then the normal scale on xy.
      // Both decoded by Normal map nodes at strength 1 (their green follows the mesh's tangent frame).
      const decode = (id: string, texture: string, uv: Out | null, data: Data = {}): Out => {
        const n = b.add(id, 'normalMap', { texture, ...data });
        if (uv !== null) b.wire(uv, n, 'uv');
        return [n, 'normal'];
      };
      const detail = decode('detailNormal', normal, uvMain());
      // The kit shader samples the macro map on UV1 as loaded (clamped at the edges).
      const big = decode('macroNormal', macro, [b.add('uv1', 'uv', { set: 'uv1' }), 'uv'], { wrap: 'clamp' });
      const d = b.add('detailSplit', 'split');
      const g = b.add('macroSplit', 'split');
      b.wire(detail, d, 'in');
      b.wire(big, g, 'in');
      const macroScale = b.param('macroNormalScale', 'float', valueOf(p, 'macroNormalScale', 1));
      const bx = b.op('add', 'blendX', [d, 'x'], b.op('multiply', 'macroX', [g, 'x'], macroScale));
      const by = b.op('add', 'blendY', [d, 'y'], b.op('multiply', 'macroY', [g, 'y'], macroScale));
      const bz = b.op('multiply', 'blendZ', [d, 'z'], [g, 'z']);
      const joined = b.add('blend', 'combine');
      b.wire(bx, joined, 'x');
      b.wire(by, joined, 'y');
      b.wire(bz, joined, 'z');
      const unit = b.add('blendNormal', 'normalize');
      b.wire([joined, 'xyz'], unit, 'in');
      const u = b.add('blendSplit', 'split');
      b.wire([unit, 'out'], u, 'in');
      const s = b.float('normalScale', scale);
      const out = b.add('scaledNormal', 'combine');
      b.wire(b.op('multiply', 'scaledX', [u, 'x'], s), out, 'x');
      b.wire(b.op('multiply', 'scaledY', [u, 'y'], s), out, 'y');
      b.wire([u, 'z'], out, 'z');
      b.wire([out, 'xyz'], outId, 'normal');
    } else if (normal !== undefined) {
      const n = b.add('normalMap', 'normalMap', { texture: normal });
      const uv = uvMain();
      if (uv !== null) b.wire(uv, n, 'uv');
      b.wire(b.float('normalScale', scale), n, 'strength');
      b.wire([n, 'normal'], outId, 'normal');
    }
    // Emissive = colour × intensity (× the emissive map, on its own UV).
    const intensity = valueOf(p, 'emissiveIntensity', 1);
    const emissive = typeof p['emissive'] === 'string' ? (p['emissive'] as string) : '#000000';
    const emissiveMap = m.textures['emissiveMap'];
    let emission: Out | null = null;
    if (intensity > 0 && emissive !== '#000000') {
      emission = b.op('multiply', 'emission', [b.add('emissive', 'color', { color: emissive }), 'rgb'], b.float('emissiveIntensity', intensity));
      if (emissiveMap !== undefined) emission = b.op('multiply', 'emissionMap', emission, [sample('emissiveTex', emissiveMap, 'srgb', uvTiled()), 'rgb']);
    }
    if (shader === 'foliage') {
      const vc = b.add('windData', 'vertexColor', { absent: 'zero' });
      const ch = b.add('windChannels', 'split');
      b.wire([vc, 'rgba'], ch, 'in');
      // Translucency: base colour × subsurface × thinness (COLOR_0 A) × 0.25, added to the emissive.
      const thin = b.op('multiply', 'thin', b.op('multiply', 'translucency', base, b.param('subsurface', 'float', valueOf(p, 'subsurface', 0.3))), [ch, 'w']);
      const glow = b.op('multiply', 'translucencyGain', thin, b.float('translucencyScale', 0.25));
      emission = emission === null ? glow : b.op('add', 'emissionTotal', emission, glow);
      // The wind: bend weight R² × height above the plant's root × bend, phase G × 2π, flutter B (the foliage
      // shader, term by term).
      const wx = b.add('worldSplit', 'split');
      b.wire([b.add('worldPosition', 'position', { space: 'world' }), 'position'], wx, 'in');
      const rootSplit = b.add('rootSplit', 'split');
      b.wire([b.add('root', 'objectPosition'), 'position'], rootSplit, 'in');
      const height = b.op('max', 'heightAboveRoot', b.op('subtract', 'rise', [wx, 'y'], [rootSplit, 'y']), b.float('ground', 0));
      const wind = b.add('wind', 'wind');
      const time = b.add('time', 'time');
      const bendWeight = b.op('multiply', 'bendWeight', b.op('multiply', 'bendTall', b.op('multiply', 'bendSquare', [ch, 'x'], [ch, 'x']), height), b.param('windBend', 'float', valueOf(p, 'windBend', 1)));
      const phase = b.op('multiply', 'phase', [ch, 'y'], b.float('tau', 6.2831853));
      // sway = sin(time × 1.7 + phase + worldX × 0.4 × turbulence) × 0.35
      const swayArg = b.op('add', 'swayArg', b.op('add', 'swayTime', b.op('multiply', 'swayRate', [time, 'time'], b.float('swaySpeed', 1.7)), phase), b.op('multiply', 'swaySpread', b.op('multiply', 'swayX', [wx, 'x'], b.float('swayScale', 0.4)), [wind, 'turbulence']));
      const swaySin = b.add('swaySin', 'sin');
      b.wire(swayArg, swaySin, 'in');
      const sway = b.op('multiply', 'sway', [swaySin, 'out'], b.float('swayAmount', 0.35));
      // bent = direction × strength × (sway + 0.65) × bend weight × 0.12
      const bent = b.op('multiply', 'bent', b.op('multiply', 'bentWeighted', b.op('multiply', 'bentSway', b.op('multiply', 'bentStrength', [wind, 'direction'], [wind, 'strength']), b.op('add', 'swayBias', sway, b.float('swayOffset', 0.65))), bendWeight), b.float('bendScale', 0.12));
      // sagged = bent − (0, |bent| × 0.35, 0)
      const len = b.add('bentLength', 'length');
      b.wire(bent, len, 'in');
      const sagY = b.add('sag', 'combine');
      b.wire(b.op('multiply', 'sagAmount', [len, 'out'], b.float('sagScale', 0.35)), sagY, 'y');
      const sagged = b.op('subtract', 'sagged', bent, [sagY, 'xyz']);
      // flutter = sin(time × frequency + phase × 3 + worldX × 2.3) × B × flutter × 0.015 × (strength + 0.5), along the world normal
      const flArg = b.op('add', 'flutterArg', b.op('add', 'flutterTime', b.op('multiply', 'flutterRate', [time, 'time'], b.param('flutterFrequency', 'float', valueOf(p, 'flutterFrequency', 6))), b.op('multiply', 'flutterPhase', phase, b.float('three', 3))), b.op('multiply', 'flutterX', [wx, 'x'], b.float('flutterSpread', 2.3)));
      const flSin = b.add('flutterSin', 'sin');
      b.wire(flArg, flSin, 'in');
      const flutter = b.op('multiply', 'flutter', b.op('multiply', 'flutterScaled', b.op('multiply', 'flutterAmount', b.op('multiply', 'flutterWeight', [flSin, 'out'], [ch, 'z']), b.param('windFlutter', 'float', valueOf(p, 'windFlutter', 1))), b.float('flutterGain', 0.015)), b.op('add', 'flutterStrength', [wind, 'strength'], b.float('flutterBias', 0.5)));
      const along = b.op('multiply', 'flutterAlong', [b.add('worldNormal', 'normal', { space: 'world' }), 'normal'], flutter);
      const vo = b.add('windOffset', 'vertexOffset', { space: 'world' });
      b.wire(b.op('add', 'windTotal', sagged, along), vo, 'offset');
    }
    if (emission !== null) b.wire(emission, outId, 'emissive');
  }
  // Opacity and alpha clip (both output kinds). As three.js: alpha = the albedo map's alpha × opacity (the map's alpha only matters when not opaque).
  if (shader !== 'water') {
    const opacity = valueOf(p, 'opacity', 1);
    const a: string | null = albedo;
    if (a !== null && alphaMode !== 'opaque') b.wire(opacity === 1 ? [a, 'a'] : b.op('multiply', 'alpha', [a, 'a'], b.float('opacity', opacity)), outId, 'opacity');
    else if (opacity !== 1) b.wire(b.float('opacity', opacity), outId, 'opacity');
    if (alphaMode === 'cutout') b.wire(b.float('alphaCutoff', valueOf(p, 'alphaCutoff', 0.5)), outId, 'alphaClip');
  }
  b.layout();
  const parameters = b.parameters;
  return { ok: true, material: { ...m, ...(parameters.length > 0 ? { parameters } : {}), graph: { nodes: b.nodes, edges: b.edges } } };
}

/** A new graph material from a shader type's built-in template (the shader's defaults). */
export function templateMaterial(shader: string, materialId: string, name: string): MaterialDef {
  if (shader === 'layers') return layeredMaterial(materialId, name);
  if (shader === 'river') return riverMaterial(materialId, name);
  const base: MaterialDef = { materialId, name, shader: (CONVERTIBLE_SHADERS.includes(shader) ? shader : 'standard') as MaterialDef['shader'], params: {}, textures: {} };
  const r = convertToGraph(base);
  return r.ok ? r.material : { ...base, graph: newMaterialGraph() };
}

/**
 * The river template — for a spline's water mesh, which carries its flow
 * along the curve (UV1: texture units a second) and its banks (COLOR_0 red:
 * 1 at the edges). Ripples are gradient noise moved along the flow in two
 * phases half a cycle apart, each faded out as it resets (`flowCycle`
 * seconds), so the water runs without stretching or jumping (two-phase
 * flow). Foam gathers at the banks and where the water is shallow (the
 * Scene depth: how far the ground lies behind the surface, `foamDepth`
 * metres), broken up by the ripples; the water fades out over `shoreFade`
 * metres of depth, so it meets the ground without a hard line. Colours: deep
 * water, shallow water toward the shores, foam.
 */
export function riverMaterial(materialId: string, name: string): MaterialDef {
  const b = new GraphBuilder([]);
  const out = b.add('output', 'pbr', { transparent: true });
  const uv: Out = [b.add('uv', 'uv'), 'uv'];
  const flow: Out = [b.add('flow', 'uv', { set: 'uv1' }), 'uv'];
  const time: Out = [b.add('time', 'time'), 'time'];
  const cycle = b.param('flowCycle', 'float', 2);
  const phaseOf = (id: string, shift: number): Out => {
    const f = b.add(id, 'fract');
    b.wire(b.op('add', `${id}Shifted`, b.op('divide', `${id}Cycles`, time, cycle), b.float(`${id}Shift`, shift)), f, 'in');
    return [f, 'out'];
  };
  const a = phaseOf('phaseA', 0);
  const c = phaseOf('phaseB', 0.5);
  const tiled = b.op('multiply', 'rippleUv', uv, b.param('rippleTiling', 'float', 3));
  /** The ripples read along the flow by one phase (UV − flow × phase × cycle). */
  const ripples = (id: string, phase: Out, offset: number): Out => {
    const moved = b.op('subtract', `${id}Uv`, b.op('add', `${id}Offset`, tiled, b.float(`${id}Shift`, offset)), b.op('multiply', `${id}Drift`, flow, b.op('multiply', `${id}Seconds`, phase, cycle)));
    const n = b.add(id, 'noise', { noise: 'gradient' });
    b.wire(moved, n, 'uv');
    b.wire(b.float(`${id}Scale`, 6), n, 'scale');
    return [n, 'value'];
  };
  // Phase B shows as phase A resets: its weight |1 − 2 × phase A|.
  const weight = b.add('phaseWeight', 'abs');
  b.wire(b.op('subtract', 'phaseCentre', b.float('one', 1), b.op('multiply', 'phaseTwice', a, b.float('two', 2))), weight, 'in');
  const mixed = b.add('ripples', 'lerp');
  b.wire(ripples('ripplesA', a, 0), mixed, 'a');
  b.wire(ripples('ripplesB', c, 0.5), mixed, 'b');
  b.wire([weight, 'out'], mixed, 't');
  // Shallow: where the ground lies close behind the surface (1 at the shore).
  const depth = b.add('sceneDepth', 'sceneDepth');
  const shallow = b.add('shallow', 'oneMinus');
  const deepness = b.add('deepness', 'saturate');
  b.wire(b.op('divide', 'depthOverFoam', [depth, 'behind'], b.param('foamDepth', 'float', 0.4)), deepness, 'in');
  b.wire([deepness, 'out'], shallow, 'in');
  const banks: Out = [b.add('banks', 'vertexColor', { absent: 'zero' }), 'rgb'];
  const bankSplit = b.add('bankSplit', 'split');
  b.wire(banks, bankSplit, 'in');
  const edge = b.op('max', 'edge', [bankSplit, 'x'], [shallow, 'out']);
  const foam = b.add('foam', 'saturate');
  b.wire(b.op('multiply', 'foamSharp', b.op('add', 'foamBroken', b.op('subtract', 'foamEdge', edge, b.float('foamCut', 0.45)), b.op('multiply', 'foamNoise', [mixed, 'out'], b.float('foamNoiseAmount', 0.35))), b.float('foamGain', 3)), foam, 'in');
  const water = b.add('waterColour', 'lerp');
  b.wire(b.param('deepColor', 'color', '#123f57'), water, 'a');
  b.wire(b.param('shallowColor', 'color', '#2f8a8f'), water, 'b');
  b.wire([shallow, 'out'], water, 't');
  const colour = b.add('colour', 'lerp');
  b.wire([water, 'out'], colour, 'a');
  b.wire(b.param('foamColor', 'color', '#e8f1f2'), colour, 'b');
  b.wire([foam, 'out'], colour, 't');
  b.wire([colour, 'out'], out, 'baseColor');
  b.wire(b.op('add', 'roughness', b.float('roughWater', 0.06), b.op('multiply', 'roughFoam', [foam, 'out'], b.float('roughFoamAmount', 0.6))), out, 'roughness');
  b.wire(b.float('metalness', 0), out, 'metalness');
  // Soft shores: the water fades out where the ground comes up to its surface.
  const shore = b.add('shore', 'saturate');
  b.wire(b.op('divide', 'depthOverFade', [depth, 'behind'], b.param('shoreFade', 'float', 0.3)), shore, 'in');
  b.wire(b.op('multiply', 'opacity', [shore, 'out'], b.op('max', 'opacityFoam', b.param('opacity', 'float', 0.85), [foam, 'out'])), out, 'opacity');
  b.layout();
  return { materialId, name, shader: 'standard', params: {}, textures: {}, parameters: b.parameters, graph: { nodes: b.nodes, edges: b.edges } };
}
