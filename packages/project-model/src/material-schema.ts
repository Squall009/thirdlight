/**
 * The material schema: the shader types, their parameters and texture slots,
 * the default wind, and the port context a material's graph resolves in.
 * Plain tables and pure reads with no validation code, so the editor builds
 * its inspector and resolves graph ports from the very rules the model
 * validates with.
 */
import { DECAL_BLENDS, DECAL_DEFAULTS, DECAL_LIMITS } from './decals';
import type { GraphContext } from './graph';
import { MATERIAL_PARAMETER_TYPES } from './material-graph-kinds';
import { MATERIAL_LOCAL_LIGHT_MODES } from './local-lights';
import type { WindConfig } from './materials';

export const MATERIAL_SHADERS = ['standard', 'foliage', 'kit', 'unlit', 'water', 'trim', 'decal'] as const;
export type MaterialShader = (typeof MATERIAL_SHADERS)[number];

export type MaterialParamType =
  | { readonly kind: 'number'; readonly min: number; readonly max: number; readonly default: number }
  | { readonly kind: 'color'; readonly default: string }
  | { readonly kind: 'bool'; readonly default: boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly default: string }
  | { readonly kind: 'vec2'; readonly min: number; readonly max: number; readonly default: readonly [number, number] };

export type MaterialParamValue = number | boolean | string | [number, number];

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
  // How local lights reach its surfaces (local-lights.ts): `object` follows the object's mode.
  localLights: { kind: 'enum', values: MATERIAL_LOCAL_LIGHT_MODES, default: 'object' },
};

/** The parameter schema of every shader type (absent in a material = keep the file's value / the default). */
export const MATERIAL_PARAMS: Readonly<Record<MaterialShader, Readonly<Record<string, MaterialParamType>>>> = {
  // Vertex paint tints the albedo (RGB the tint, A how much; vertex-paint.ts): off by default, so a material reads no paint unless asked.
  standard: { ...SURFACE_PARAMS, paintTint: bool(false) },
  // COLOR_0 drives the wind (the engine's vertex-colour convention for any
  // swaying mesh — grass, trees, cloth, banners): R bend weight root→tip, G phase,
  // B flutter, A thinness (a cheap subsurface term).
  foliage: {
    ...SURFACE_PARAMS,
    doubleSided: bool(true),
    windBend: num(0, 4, 1),
    windFlutter: num(0, 4, 1),
    flutterFrequency: num(0, 30, 6),
    subsurface: num(0, 1, 0.3),
    // Metres from the camera the wind moves it (the foliage policy: wind only near; past it the vertices do no wind
    // work and stand still, fading out over the last fifth; 0: everywhere, the earlier look).
    windDistance: num(0, 10000, 0),
    // How far a ground-cover copy's base takes the colour of the terrain under it (0: off, its own colour; 1: the
    // ground's at the root), fading to its own colour by `rootColourHeight` (a share of COLOR_0 R, root 0 → tip 1).
    rootColour: num(0, 1, 0),
    rootColourHeight: num(0.01, 1, 0.4),
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
  // A trim sheet (`trim-sheet.ts`): its three maps read once each, the footprint capped at the sheet's safe mip
  // level; its trim data (`trim-sheet.ts`: R occlusion, A wetness) is blended with no read of its own. Roughness and metalness
  // scale the ORM's (1: the sheet's own). No grime: dirt is a painted layer of a layered surface.
  trim: {
    color: color('#ffffff'),
    roughness: num(0, 1, 1),
    metalness: num(0, 1, 1),
    normalScale: num(0, 4, 1),
    aoIntensity: num(0, 2, 1),
    // How much of the vertex occlusion (R) darkens the indirect light.
    occlusion: num(0, 1, 1),
    // Rain on this material, over the vertex wetness (trim data A, paint A); the scene's wetness adds to both.
    wetness: num(0, 1, 0),
    // How much wetness flattens the normal map.
    wetFlatten: num(0, 1, 0.7),
    alphaMode: { kind: 'enum', values: ['opaque', 'cutout'], default: 'opaque' },
    alphaCutoff: num(0, 1, 0.5),
    doubleSided: bool(false),
    localLights: { kind: 'enum', values: MATERIAL_LOCAL_LIGHT_MODES, default: 'object' },
  },
  // A decal (`decals.ts`): albedo with opacity in alpha, normal, ORM and emissive, from its own textures or one
  // decal cell of a trim sheet (`decal`). The factors multiply the textures' values (glTF's rule; roughness 1 and
  // metalness 0 with no ORM). `blend` is how a mesh or clipped decal's lit colour goes over the surface; a
  // projected decal blends channel by channel with its component's opacities instead.
  decal: {
    color: color('#ffffff'),
    opacity: num(0, 1, 1),
    roughness: num(0, 1, 1),
    metalness: num(0, 1, 0),
    normalScale: num(0, 4, 1),
    aoIntensity: num(0, 2, 1),
    emissive: color('#000000'),
    emissiveIntensity: num(0, 16, 0),
    blend: { kind: 'enum', values: DECAL_BLENDS, default: 'blend' },
    // Where a mesh or clipped decal draws among the other decals: higher draws later, over lower ones.
    sortOrder: num(DECAL_LIMITS.sortOrderMin, DECAL_LIMITS.sortOrderMax, DECAL_DEFAULTS.sortOrder),
  },
};

/** The texture slots of every shader type (values: texture asset ids). */
export const MATERIAL_TEXTURE_SLOTS: Readonly<Record<MaterialShader, readonly string[]>> = {
  standard: ['map', 'normalMap', 'ormMap', 'emissiveMap'],
  foliage: ['map', 'normalMap', 'ormMap', 'emissiveMap'],
  kit: ['map', 'normalMap', 'ormMap', 'emissiveMap', 'macroNormalMap'],
  unlit: ['map'],
  water: ['normalMap'],
  trim: ['map', 'normalMap', 'ormMap'],
  decal: ['map', 'normalMap', 'ormMap', 'emissiveMap'],
};

/** The wind when a project sets none — a light breeze along +X (0.5 with 0.4 gusts every ~3 s, a little turbulence): foliage moves a little in any scene; 0 strength stills it. */
export const DEFAULT_WIND: Readonly<WindConfig> = Object.freeze({ direction: [1, 0] as [number, number], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 });

/** The port type a parameter feeds into a graph (`color` is a vec3). */
export function materialParameterPortType(type: string): string | null {
  if (type === 'color') return 'vec3';
  return (MATERIAL_PARAMETER_TYPES as readonly string[]).includes(type) ? type : null;
}

/**
 * The context a material's graph validates in — the project's
 * standalone graphs (material-function calls) and its own parameters (the
 * Parameter node's port type).
 */
export function materialGraphContext(parameters: readonly unknown[] | undefined, graphs: GraphContext | undefined): GraphContext {
  return {
    ...(graphs?.graph !== undefined ? { graph: graphs.graph } : {}),
    lookup(name, value) {
      if (name !== 'parameter') return null;
      const p = (parameters ?? []).find((x) => typeof x === 'object' && x !== null && !Array.isArray(x) && (x as Record<string, unknown>)['key'] === value) as Record<string, unknown> | undefined;
      return typeof p?.['type'] === 'string' ? materialParameterPortType(p['type']) : null;
    },
  };
}
