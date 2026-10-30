/**
 * The material-graph compiler's data shapes: the structural graph,
 * parameter and function shapes it reads, what a compile is given
 * (globals, environment, a self-placing surface) and what it returns.
 */

import type * as THREE from 'three';

import type { DecalDraw } from './mesh-decals';
import type { LocalLightMode, TrimSheet } from '@thirdlight/project-model';

// TSL's typings do not follow values whose width is known only at run time.
export type N = any;

// ---- structural data (project-model shapes; three-adapter does not import it) ----------

export interface MaterialGraphNodeLike {
  readonly id: string;
  readonly type: string;
  readonly position?: readonly [number, number] | readonly number[];
  readonly data?: Readonly<Record<string, unknown>>;
}
export interface MaterialGraphEdgeLike {
  readonly id?: string;
  readonly from: { readonly node: string; readonly port: string };
  readonly to: { readonly node: string; readonly port: string };
}
export interface MaterialGraphLike {
  readonly nodes: readonly MaterialGraphNodeLike[];
  readonly edges: readonly MaterialGraphEdgeLike[];
}
export interface MaterialParameterLike {
  readonly key: string;
  readonly type: string;
  readonly default: number | readonly number[] | string;
  readonly visibility?: string;
  /** Data parameters: the grid's cells [width, height]. */
  readonly size?: readonly number[];
  /** A vec4 per-layer setting's values for layers 4, 5, … (read through {@link GraphSurface.perLayer}). */
  readonly extraLayers?: readonly number[];
}
/** A standalone graph document (only `material-function` ones are called). */
export interface MaterialFunctionLike {
  readonly graphId: string;
  readonly kind: string;
  readonly name?: string;
  readonly graph: MaterialGraphLike;
}

export type ValueType = 'float' | 'vec2' | 'vec3' | 'vec4';
/** `data` — a data parameter's cell grid (feeds only Sample data). */
export type PortType = ValueType | 'texture' | 'data';

export interface SamplerLike {
  readonly colorSpace: 'srgb' | 'linear';
  readonly wrap: 'repeat' | 'clamp' | 'mirror';
  readonly filter: 'linear' | 'nearest';
}

/** The shared uniforms every graph material reads (the library's clock, wind and the scene's wetness). */
export interface GraphGlobals {
  readonly time: N;
  /** The clock as the last frame drawn read it (absent: none kept): a vertex offset's previous place, for motion vectors. */
  readonly timePrevious?: N;
  readonly windDir: N;
  readonly strength: N;
  readonly gust: N;
  readonly gustFreq: N;
  readonly turb: N;
  readonly wetness: N;
  /** The wind field at a world ground point (vec2 x, z): vec4(direction x, z, strength with gusts, turbulence). Absent: the global uniforms above. */
  readonly windAt?: (p: N) => N;
}

export interface GraphCompileEnv {
  readonly globals: GraphGlobals;
  /**
   * A texture asset prepared for a sampler (colour space, wrapping, filter):
   * the texture, `'loading'` while it is on its way, or null when the
   * project has no such texture.
   */
  texture(assetId: string, sampler: SamplerLike): THREE.Texture | 'loading' | null;
  /**
   * While `assetId` is loading: a texture already drawn that it replaces (the
   * same parameter's previous texture) and that texture's id, drawn meanwhile
   * instead of nothing; null when there is none. The compile still waits for
   * `assetId` (it is pending) and samples the stand-in's id too, so its
   * holder keeps the stand-in until the compile that replaces it.
   */
  standIn?(assetId: string, sampler: SamplerLike): { readonly assetId: string; readonly texture: THREE.Texture } | null;
  /** A material function by graph id, or null. */
  fn(graphId: string): MaterialFunctionLike | null;
  /**
   * The key objects store their overrides under (`mesh.userData[OVERRIDES_KEY][paramKey]`);
   * absent = parameters are plain uniforms.
   */
  readonly overrideKey?: string;
  /** A surface that makes its own vertices (a terrain): its inputs stand in for the mesh's attributes. */
  readonly surface?: GraphSurface;
}

/**
 * A drawn surface whose vertices are made in its own vertex shader (a
 * terrain's grid placed and raised from its height textures), not read from
 * vertex attributes: what a graph reads as mesh data comes from it instead.
 * The graph's own vertex offset is not applied (the surface places the
 * vertices).
 */
export interface GraphSurface {
  /** Tells compiles for different surfaces apart (part of the compile's key). */
  readonly key: string;
  /** UV set 0 and 1 (vec2). */
  uv(set: 0 | 1): N;
  /** A vertex colour set (`color`: COLOR_0, `color_1`: COLOR_1) as vec4, or null where the surface has none. */
  vertexColor(name: 'color' | 'color_1'): N | null;
  /** The local position the vertex shader places (the material's position node). */
  readonly position: N;
  /** False where a pixel is cut away (the material's mask node), or null. */
  readonly mask: N | null;
  /**
   * The texture-array layer a graph's array layer (a layer slot, 0–3) reads
   * at a pixel (a terrain's per-sample layer indices: any number of layers
   * draws through four slots); absent: the graph's layer as it is.
   */
  readonly arrayLayer?: (slot: N) => N;
  /**
   * A per-layer setting (a vec4 parameter, one component per layer slot,
   * with values for layers past the fourth) as the slots read it at a pixel:
   * each slot takes the value of the layer it draws there. Absent: the
   * vector as it is.
   */
  readonly perLayer?: (value: N, extra: readonly number[]) => N;
}

export interface GraphProblem {
  /** The node of the material graph (a problem inside a function names the call node). */
  readonly nodeId?: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface CompiledMaterialGraph {
  /** The surface output kind (null: none — the material draws as a plain white PBR surface). */
  readonly surface: 'pbr' | 'unlit' | 'customLit' | null;
  readonly slots: {
    readonly color: N | null;
    readonly metalness: N | null;
    readonly roughness: N | null;
    readonly normal: N | null;
    readonly emissive: N | null;
    readonly ao: N | null;
    /** PBR specular intensity and colour, only when connected (then the material is a physical one). */
    readonly specularIntensity: N | null;
    readonly specularColor: N | null;
    readonly opacity: N | null;
    readonly alphaTest: N | null;
    readonly position: N | null;
    /** What a vertex offset that reads the clock had moved the vertex by on the last frame (object space; null: none, or a steady one). */
    readonly positionPreviousOffset: N | null;
    /** False where a pixel is cut away (a surface's holes), or null. */
    readonly mask: N | null;
    /** Custom-lit: the graph's colour and emissive (computed after the lights are gathered). */
    readonly litColor: N | null;
    readonly litEmissive: N | null;
    /** Custom-lit alpha that reads lighting inputs (then `opacity`/`alphaTest` are null). */
    readonly litOpacity: N | null;
    readonly litAlphaTest: N | null;
  };
  /** `localLights`: the output's local-light mode when it sets one (local-lights.ts); `decal`: drawn as a mesh decal (mesh-decals.ts). */
  readonly flags: { readonly doubleSided: boolean; readonly transparent: boolean; readonly castShadows: boolean; readonly localLights?: LocalLightMode; readonly decal?: DecalDraw };
  /** Reads the clock or the wind (the host keeps rendering). */
  readonly animated: boolean;
  /** Reads the object's own frame (object-space position or normal, its origin, an object-space offset): never merged with others (static batching). */
  readonly objectFrame: boolean;
  /** Reads mesh UVs in block cells (see {@link readsCellUv}). */
  readonly cellUv: boolean;
  /**
   * The row table its mesh-UV reads stay inside (a trim material's, a
   * layered surface's trim layers'): such a material draws trim strips, so a
   * block layer gives it strip UVs instead of its metres (`block-cell-uv.ts`).
   * Known from the definition, before any texture arrives. Null: none.
   */
  readonly trimStrips: TrimSheet | null;
  /** Compiled for a surface that places its own vertices from data it reports changing ({@link GraphSurface}). */
  readonly steadyShape: boolean;
  /** Reads a Lighting input under a Custom-lit output. */
  readonly usesLight: boolean;
  /** Texture assets it samples (loaded or not). */
  readonly textures: readonly string[];
  /** Textures still loading (a recompile after they arrive draws them). */
  readonly pending: readonly string[];
  readonly problems: readonly GraphProblem[];
  /** The number of catalogue nodes compiled (function bodies once per call). */
  readonly nodeCount: number;
  /** Textures the compile made (data parameters' placeholders); released with the compile. */
  readonly ownedTextures: readonly THREE.Texture[];
}
