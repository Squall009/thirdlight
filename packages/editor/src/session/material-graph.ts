/**
 * Phase 18.0/18.1: the editor side of graph materials (pure; the editor may
 * import project-model types only).
 *
 * - the port context a material graph (or a material function) is edited in:
 *   the project's standalone graphs for Function call nodes and the
 *   material's parameters for Parameter nodes — the same lookups the backend
 *   validates with (project-model `materialGraphContext` /
 *   `graphDocumentsContext`);
 * - the graph of a new graph material (one PBR output);
 * - "Convert to graph": a shader-type material as an equivalent graph (the
 *   standard and unlit shaders; the other shader types get built-in
 *   templates with pixel tests in 18.2).
 */
import type { GraphContext, GraphData, GraphDocument, GraphEdge, GraphKindDef, GraphNode, MaterialDef, MaterialParameter } from '@thirdlight/project-model';

/** The port type a parameter feeds into a graph (a colour is a vec3) — project-model `materialParameterPortType`. */
export function parameterPortType(type: string): string | null {
  if (type === 'color') return 'vec3';
  return ['float', 'vec2', 'vec3', 'vec4', 'texture'].includes(type) ? type : null;
}

/** Standalone graphs by kind and id (Function call nodes read their ports from them). */
export function graphsPortContext(graphs: readonly GraphDocument[], kinds: Readonly<Record<string, GraphKindDef>>): GraphContext {
  return {
    graph(kind, id) {
      const d = graphs.find((g) => g.graphId === id && g.kind === kind);
      const k = kinds[kind];
      return d !== undefined && k !== undefined ? { kind: k, graph: d.graph } : null;
    },
  };
}

/** A material graph's context: the project's graphs plus its own parameters. */
export function materialPortContext(parameters: readonly MaterialParameter[] | undefined, graphs: readonly GraphDocument[], kinds: Readonly<Record<string, GraphKindDef>>): GraphContext {
  const base = graphsPortContext(graphs, kinds);
  return {
    ...(base.graph !== undefined ? { graph: base.graph } : {}),
    lookup(name, value) {
      if (name !== 'parameter') return null;
      const p = (parameters ?? []).find((x) => x.key === value);
      return p !== undefined ? parameterPortType(p.type) : null;
    },
  };
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
  }
}

/** Shader types "Convert to graph" rebuilds exactly (the others become 18.2 templates). */
export const CONVERTIBLE_SHADERS: readonly string[] = ['standard', 'unlit'];

/**
 * A shader-type material as a graph material: the same values and textures
 * wired into a PBR (standard) or Unlit output. Keeps `shader`, `params` and
 * `textures` (the renderer draws them until the graph compiler lands, and
 * they are the way back). Values the material does not set use the shader's
 * defaults; on a model, a shader material also starts from the file's own
 * material — a graph uses only what it contains (the file's textures are not
 * part of it).
 */
export function convertToGraph(m: MaterialDef): { ok: true; material: MaterialDef } | { ok: false; reason: string } {
  if (m.graph !== undefined) return { ok: false, reason: 'this material already has a graph' };
  if (!CONVERTIBLE_SHADERS.includes(m.shader)) return { ok: false, reason: `the ${m.shader} shader becomes a built-in graph template in phase 18.2 (convert a standard or unlit material)` };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let row = 0;
  const add = (id: string, type: string, data: Record<string, number | string | boolean | number[]> = {}, col = 0): string => {
    nodes.push({ id, type, position: [col * 220 - 440, row++ * 110 - 200], ...(Object.keys(data).length > 0 ? { data } : {}) });
    return id;
  };
  const wire = (from: string, fromPort: string, to: string, toPort: string): void => {
    edges.push({ id: `w${edges.length + 1}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
  };
  const p = m.params;
  const num = (k: string, d: number): number => (typeof p[k] === 'number' ? (p[k] as number) : d);
  const tiling: [number, number] = Array.isArray(p['tiling']) ? (p['tiling'] as [number, number]) : [1, 1];
  const offset: [number, number] = Array.isArray(p['offset']) ? (p['offset'] as [number, number]) : [0, 0];
  // UV = uv0 × tiling + offset (only when the material moves or repeats its textures).
  let uv: string | null = null;
  /** The albedo sample (its alpha feeds the opacity when the material is not opaque). */
  let albedo: string | null = null;
  const uvFor = (): string | null => {
    if (uv !== null || (tiling[0] === 1 && tiling[1] === 1 && offset[0] === 0 && offset[1] === 0)) return uv;
    const u = add('uv', 'uv');
    const t = add('tiling', 'vec2', { value: [tiling[0], tiling[1]] });
    const o = add('offset', 'vec2', { value: [offset[0], offset[1]] });
    const mul = add('uvScale', 'multiply', {}, 1);
    const sum = add('uvOffset', 'add', {}, 1);
    wire(u, 'uv', mul, 'a');
    wire(t, 'value', mul, 'b');
    wire(mul, 'out', sum, 'a');
    wire(o, 'value', sum, 'b');
    uv = sum;
    return uv;
  };
  const sample = (id: string, texture: string, colorSpace: 'srgb' | 'linear'): string => {
    const s = add(id, 'sampleTexture', { texture, ...(colorSpace === 'linear' ? { colorSpace } : {}) }, 1);
    const u = uvFor();
    if (u !== null) wire(u, 'out', s, 'uv');
    return s;
  };
  const colorTimesMap = (outNode: string, outPort: string): void => {
    const color = typeof p['color'] === 'string' ? (p['color'] as string) : '#ffffff';
    const c = add('baseColor', 'color', color !== '#ffffff' ? { color } : {});
    const map = m.textures['map'];
    if (map === undefined) {
      wire(c, 'rgb', outNode, outPort);
      return;
    }
    const s = sample('albedo', map, 'srgb');
    albedo = s;
    const mul = add('tint', 'multiply', {}, 2);
    wire(s, 'rgb', mul, 'a');
    wire(c, 'rgb', mul, 'b');
    wire(mul, 'out', outNode, outPort);
  };
  const alphaMode = typeof p['alphaMode'] === 'string' ? p['alphaMode'] : 'opaque';
  const flags = { ...(p['doubleSided'] === true ? { doubleSided: true } : {}), ...(alphaMode === 'blend' ? { transparent: true } : {}) };
  const outId = 'output';
  if (m.shader === 'unlit') {
    nodes.push({ id: outId, type: 'unlit', position: [440, 0], ...(Object.keys(flags).length > 0 ? { data: flags } : {}) });
    const color = typeof p['color'] === 'string' ? (p['color'] as string) : '#ffffff';
    const c = add('baseColor', 'color', color !== '#ffffff' ? { color } : {});
    let rgb: [string, string] = [c, 'rgb'];
    const map = m.textures['map'];
    if (map !== undefined) {
      const s = sample('albedo', map, 'srgb');
      albedo = s;
      const mul = add('tint', 'multiply', {}, 2);
      wire(s, 'rgb', mul, 'a');
      wire(rgb[0], rgb[1], mul, 'b');
      rgb = [mul, 'out'];
    }
    if (p['vertexTint'] === true) {
      const v = add('vertexColor', 'vertexColor');
      const mul = add('vertexTint', 'multiply', {}, 2);
      wire(rgb[0], rgb[1], mul, 'a');
      wire(v, 'rgb', mul, 'b');
      rgb = [mul, 'out'];
    }
    wire(rgb[0], rgb[1], outId, 'color');
  } else {
    nodes.push({ id: outId, type: 'pbr', position: [440, 0], ...(Object.keys(flags).length > 0 ? { data: flags } : {}) });
    colorTimesMap(outId, 'baseColor');
    const orm = m.textures['ormMap'];
    const ormSample = orm !== undefined ? sample('orm', orm, 'linear') : null;
    // Roughness and metalness: the value, times the ORM map's G / B channel (as three.js does).
    for (const [key, d, channel] of [['roughness', 0.8, 'g'], ['metalness', 0, 'b']] as const) {
      const v = add(key, 'float', { value: num(key, d) });
      if (ormSample === null) wire(v, 'value', outId, key);
      else {
        const mul = add(`${key}Map`, 'multiply', {}, 2);
        wire(v, 'value', mul, 'a');
        wire(ormSample, channel, mul, 'b');
        wire(mul, 'out', outId, key);
      }
    }
    if (ormSample !== null) {
      // Ambient occlusion = lerp(1, ORM.r, intensity).
      const one = add('aoOne', 'float', { value: 1 });
      const k = add('aoIntensity', 'float', { value: num('aoIntensity', 1) });
      const lerp = add('ao', 'lerp', {}, 2);
      wire(one, 'value', lerp, 'a');
      wire(ormSample, 'r', lerp, 'b');
      wire(k, 'value', lerp, 't');
      wire(lerp, 'out', outId, 'ao');
    }
    const normal = m.textures['normalMap'];
    if (normal !== undefined) {
      const n = add('normalMap', 'normalMap', { texture: normal }, 1);
      const u = uvFor();
      if (u !== null) wire(u, 'out', n, 'uv');
      const s = add('normalScale', 'float', { value: num('normalScale', 1) });
      wire(s, 'value', n, 'strength');
      wire(n, 'normal', outId, 'normal');
    }
    // Emissive = colour × intensity (× the emissive map).
    const intensity = num('emissiveIntensity', 0);
    const emissive = typeof p['emissive'] === 'string' ? (p['emissive'] as string) : '#000000';
    const emissiveMap = m.textures['emissiveMap'];
    if (intensity > 0 && (emissive !== '#000000' || emissiveMap !== undefined)) {
      const c = add('emissive', 'color', { color: emissive });
      const k = add('emissiveIntensity', 'float', { value: intensity });
      const mul = add('emission', 'multiply', {}, 2);
      wire(c, 'rgb', mul, 'a');
      wire(k, 'value', mul, 'b');
      let out: [string, string] = [mul, 'out'];
      if (emissiveMap !== undefined) {
        const s = sample('emissiveTex', emissiveMap, 'srgb');
        const mul2 = add('emissionMap', 'multiply', {}, 2);
        wire(mul, 'out', mul2, 'a');
        wire(s, 'rgb', mul2, 'b');
        out = [mul2, 'out'];
      }
      wire(out[0], out[1], outId, 'emissive');
    }
  }
  // Opacity and alpha clip (both output kinds have them).
  // As three.js: alpha = the albedo map's alpha × opacity (the map's alpha only matters when not opaque).
  const opacity = num('opacity', 1);
  const a: string | null = albedo;
  if (a !== null && alphaMode !== 'opaque') {
    if (opacity === 1) wire(a, 'a', outId, 'opacity');
    else {
      const mul = add('alpha', 'multiply', {}, 2);
      wire(a, 'a', mul, 'a');
      wire(add('opacity', 'float', { value: opacity }), 'value', mul, 'b');
      wire(mul, 'out', outId, 'opacity');
    }
  } else if (opacity !== 1) wire(add('opacity', 'float', { value: opacity }), 'value', outId, 'opacity');
  if (alphaMode === 'cutout') wire(add('alphaCutoff', 'float', { value: num('alphaCutoff', 0.5) }), 'value', outId, 'alphaClip');
  return { ok: true, material: { ...m, graph: { nodes, edges } } };
}
