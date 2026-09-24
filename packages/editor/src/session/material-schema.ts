/**
 * Phase 9.4: the editor's copy of the material schema (project-model
 * `materials.ts`): the shader types, their parameters and texture slots, and
 * the default wind. The editor may use project-model types only (it has no
 * second mutation path), so the table is copied here like the surface
 * presets; `tests/material-schema-parity.test.ts` keeps the two identical.
 */
import type { MaterialParamType, MaterialShader, WindConfig } from '@thirdlight/project-model';

export const MATERIAL_SHADERS: readonly MaterialShader[] = ['standard', 'foliage', 'kit', 'unlit', 'water'];

const num = (min: number, max: number, d: number): MaterialParamType => ({ kind: 'number', min, max, default: d });
const color = (d: string): MaterialParamType => ({ kind: 'color', default: d });
const bool = (d: boolean): MaterialParamType => ({ kind: 'bool', default: d });
const vec2 = (min: number, max: number, d: [number, number]): MaterialParamType => ({ kind: 'vec2', min, max, default: d });

const SURFACE_PARAMS: Readonly<Record<string, MaterialParamType>> = {
  color: color('#ffffff'),
  roughness: num(0, 1, 0.8),
  metalness: num(0, 1, 0),
  emissive: color('#000000'),
  emissiveIntensity: num(0, 16, 0),
  alphaMode: { kind: 'enum', values: ['opaque', 'cutout', 'blend'], default: 'opaque' },
  alphaCutoff: num(0, 1, 0.5),
  opacity: num(0, 1, 1),
  doubleSided: bool(false),
  tiling: vec2(0.001, 1000, [1, 1]),
  offset: vec2(-1000, 1000, [0, 0]),
  normalScale: num(0, 4, 1),
  aoIntensity: num(0, 2, 1),
};

/** The parameter schema of every shader type (absent in a material = keep the file's value / the default). */
export const MATERIAL_PARAMS: Readonly<Record<MaterialShader, Readonly<Record<string, MaterialParamType>>>> = {
  standard: SURFACE_PARAMS,
  // COLOR_0 drives the wind (Sprout's rule): R bend weight root→tip, G phase,
  // B flutter, A thinness (a cheap subsurface term).
  foliage: {
    ...SURFACE_PARAMS,
    doubleSided: bool(true),
    windBend: num(0, 4, 1),
    windFlutter: num(0, 4, 1),
    flutterFrequency: num(0, 30, 6),
    subsurface: num(0, 1, 0.3),
  },
  // uv0.x += worldX / uvPeriod so the detail atlas flows across joins; a macro
  // normal on UV1 is blended over the detail normal (whiteout).
  kit: {
    ...SURFACE_PARAMS,
    uvPeriod: num(0.25, 64, 4),
    macroNormalScale: num(0, 4, 1),
  },
  unlit: {
    color: color('#ffffff'),
    opacity: num(0, 1, 1),
    alphaMode: { kind: 'enum', values: ['opaque', 'cutout', 'blend'], default: 'opaque' },
    alphaCutoff: num(0, 1, 0.5),
    doubleSided: bool(false),
    tiling: vec2(0.001, 1000, [1, 1]),
    offset: vec2(-1000, 1000, [0, 0]),
    vertexTint: bool(false),
  },
  water: {
    color: color('#1d5f8a'),
    shallowColor: color('#4fb3c9'),
    opacity: num(0, 1, 0.8),
    roughness: num(0, 1, 0.1),
    normalScale: num(0, 4, 0.6),
    flow: vec2(-10, 10, [0.05, 0.02]),
    waveScale: num(0.01, 100, 2),
    fresnel: num(0, 10, 3),
    doubleSided: bool(false),
  },
};

/** The texture slots of every shader type (values: texture asset ids). */
export const MATERIAL_TEXTURE_SLOTS: Readonly<Record<MaterialShader, readonly string[]>> = {
  standard: ['map', 'normalMap', 'ormMap', 'emissiveMap'],
  foliage: ['map', 'normalMap', 'ormMap', 'emissiveMap'],
  kit: ['map', 'normalMap', 'ormMap', 'emissiveMap', 'macroNormalMap'],
  unlit: ['map'],
  water: ['normalMap'],
};


export const DEFAULT_WIND: Readonly<WindConfig> = Object.freeze({ direction: [1, 0] as [number, number], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 });
