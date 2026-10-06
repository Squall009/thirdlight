/**
 * Local lights per vertex (project-model local-lights.ts has the data rules).
 *
 * three.js shades every point and spot light per pixel on every lit
 * material. Dense foliage pays that for every one of its many small
 * triangles; Unity's "Not Important" lights and Godot's vertex shading
 * evaluate such lights at the vertices instead and interpolate. Here:
 *
 * - **Which build sees which lights.** The renderer's lights node (installed
 *   by `registerProbeLighting`) asks `splitLocalLights` before it builds a
 *   material's lights: per the material build's mode and each light's
 *   importance, a local light is shaded per pixel (three's own light node, as
 *   before), per vertex (summed here), or left out. Per-vertex lights add
 *   their diffuse light (N·L × colour × falloff, at the vertex, interpolated)
 *   to the surface's ambient irradiance — every lighting model (standard,
 *   kit, foliage, water, graph PBR, Custom-lit's Ambient input) takes it
 *   without a hook; there are no highlights and no shadows, as in Unity. The
 *   light's colour uniform still changes every frame (flicker shows) and
 *   carries the light-layer test (light-layers.ts) like a per-pixel light's.
 *   The effect light pool (effect-lights.ts) is a local light too.
 * - **Which build an object gets.** A program can't depend on the object
 *   drawn (three keys programs by material, geometry and lights), so an
 *   object whose mode is not per pixel draws with a *mode variant* of its
 *   material: an object made with `Object.create(material)` — it reads every
 *   value of the material through the prototype (a colour, a texture, a
 *   version bump all reach it), carries only its mode and a program key that
 *   says so. `installLocalLightModes` swaps it in for each draw in
 *   `renderer.renderObject`; `mesh.material` never changes, so looks,
 *   lightmaps and material swaps keep owning it. Variants of equal materials
 *   share programs (their key is the material's key plus the mode): a mode
 *   adds at most one program per program it modifies, and light layers add
 *   none (they are a per-object uniform), so modes × layers do not multiply.
 * - **The default.** An object's `localLights` (`LOCAL_LIGHTS_KEY` in a
 *   drawable's `userData`), else its material's, else
 *   `INSTANCES_LOCAL_LIGHTS_DEFAULT` for an instance set's draws
 *   (`INSTANCE_SET_KEY`) and per pixel for the rest.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { INSTANCES_LOCAL_LIGHTS_DEFAULT, lightImportanceOf, localLightModeOf, type LightImportance, type LocalLightMode } from '@thirdlight/runtime';

import type { N } from './effects-tsl';
import { INSTANCE_SET_KEY } from './instancing';
import { isLayeredLight, lightsObject } from './light-layers';
import { effectLightsVertexIrradiance, type EffectLights } from './effect-lights';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { abs, getDistanceAttenuation, max, normalLocal, positionView, renderGroup, smoothstep, transformNormalToView, uniform, varyingProperty, vec3 } = TSL;

/** `object.userData[LOCAL_LIGHTS_KEY]` / `material.userData[LOCAL_LIGHTS_KEY]`: a set local-light mode. */
export const LOCAL_LIGHTS_KEY = '__tlLocalLights';
/** `light.userData[LIGHT_IMPORTANCE_KEY]`: a local light's importance when not auto. */
export const LIGHT_IMPORTANCE_KEY = '__tlLightImportance';
/** The own property of a mode variant holding its mode. */
const VARIANT_MODE = 'tlLocalLightMode';

/** The page flag that shades every local light per pixel (`?vertexLights=off`: modes and importances ignored, a diagnostic comparison). */
export const VERTEX_LIGHTS_URL_PARAM = 'vertexLights';

/** Whether a page's query string leaves per-vertex lights on (the default) — `vertexLights=off` or `0` turns them off. */
export function vertexLightsFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(VERTEX_LIGHTS_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}

/** Put an object's local-light mode on every mesh under `root` (undefined: not set). Returns whether any changed. */
export function applyObjectLocalLights(root: THREE.Object3D, mode: LocalLightMode | undefined): boolean {
  let changed = false;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh !== true || o.userData[LOCAL_LIGHTS_KEY] === mode) return;
    changed = true;
    if (mode === undefined) delete o.userData[LOCAL_LIGHTS_KEY];
    else o.userData[LOCAL_LIGHTS_KEY] = mode;
  });
  return changed;
}

/** The local-light mode an entity's box, model or instance set sets (undefined: none). */
export function localLightsOfComponents(components: unknown): LocalLightMode | undefined {
  const c = components as { box?: { localLights?: unknown }; model?: { localLights?: unknown }; instances?: { localLights?: unknown } } | undefined;
  return localLightModeOf((c?.box ?? c?.model ?? c?.instances)?.localLights);
}

/** The mode a drawable set (undefined: not set), for grouping keys (batches, merged cells keep modes apart). */
export function objectLocalLights(o: THREE.Object3D): LocalLightMode | undefined {
  return o.userData[LOCAL_LIGHTS_KEY] as LocalLightMode | undefined;
}

/** Set (or clear, for auto) a light's importance. */
export function setLightImportance(light: THREE.Object3D, importance: LightImportance): void {
  if (importance === 'auto') delete light.userData[LIGHT_IMPORTANCE_KEY];
  else light.userData[LIGHT_IMPORTANCE_KEY] = importance;
}

function importanceOf(light: THREE.Object3D | undefined): LightImportance {
  return light === undefined ? 'auto' : lightImportanceOf(light.userData[LIGHT_IMPORTANCE_KEY]);
}

/** The mode `object` draws `material` with. */
export function drawMode(object: THREE.Object3D, material: THREE.Material): LocalLightMode {
  const own = object.userData[LOCAL_LIGHTS_KEY] as LocalLightMode | undefined;
  if (own !== undefined) return own;
  const m = material.userData[LOCAL_LIGHTS_KEY] as LocalLightMode | undefined;
  if (m !== undefined) return m;
  return object.userData[INSTANCE_SET_KEY] !== undefined ? INSTANCES_LOCAL_LIGHTS_DEFAULT : 'pixel';
}

// ---------------------------------------------------------------------------------------------------------------
// Mode variants

type Keyed = THREE.Material & { customProgramCacheKey(): string; lights?: boolean; isNodeMaterial?: boolean };

type LitFlags = { lights?: boolean; isNodeMaterial?: boolean; isMeshBasicNodeMaterial?: boolean; isMeshStandardMaterial?: boolean; isMeshLambertMaterial?: boolean; isMeshPhongMaterial?: boolean; isMeshToonMaterial?: boolean };

/**
 * Whether a material is shaded by lights (it has local lights to split): a
 * lit node material, or a plain lit material three converts to one (a model
 * file's own). Basic materials take only lightmaps.
 */
function isLit(material: THREE.Material): boolean {
  const m = material as THREE.Material & LitFlags;
  if (m.isNodeMaterial === true) return m.lights === true && m.isMeshBasicNodeMaterial !== true;
  return m.isMeshStandardMaterial === true || m.isMeshLambertMaterial === true || m.isMeshPhongMaterial === true || m.isMeshToonMaterial === true;
}

/**
 * A material's program key the way three's render object computes it from
 * the material's own values (`RenderObject.getMaterialCacheKey`): a variant
 * has none of its own, so its key spells them out — two variants of equal
 * materials then share a program, as the materials do.
 */
function materialValuesKey(m: THREE.Material): string {
  let key = '';
  for (const property of Object.keys(m)) {
    if (/^(is[A-Z]|_)|^(visible|version|uuid|name|opacity|userData)$/.test(property)) continue;
    const value = (m as unknown as Record<string, unknown>)[property];
    if (value === null || value === undefined) key += `${String(value)},`;
    else if (typeof value === 'number') key += property === 'side' ? `${value},` : value !== 0 ? '1,' : '0,';
    else if (typeof value === 'object') {
      const t = value as THREE.Texture;
      key += t.isTexture === true ? `{${t.mapping}${t.magFilter}${t.minFilter}${t.wrapS}${t.wrapT}${(t as unknown as { wrapR?: number }).wrapR ?? ''}},` : '{},';
    } else if (typeof value === 'function') key += 'f,';
    else key += `${String(value)},`;
  }
  return key;
}

const variants = new WeakMap<THREE.Material, Map<LocalLightMode, THREE.Material>>();

/** Variants made so far (diagnostics). */
let variantCount = 0;

/** The mode variant of `material` (made once, dropped when the material is disposed). */
export function localLightVariant(material: THREE.Material, mode: Exclude<LocalLightMode, 'pixel'>): THREE.Material {
  let byMode = variants.get(material);
  const seen = byMode?.get(mode);
  if (seen !== undefined) return seen;
  const base = material as Keyed;
  const v = Object.create(base) as Keyed & Record<string, unknown>;
  // Own listeners: three's render objects listen for the variant's dispose, never the material's.
  v['_listeners'] = {};
  v[VARIANT_MODE] = mode;
  v.customProgramCacheKey = function variantKey(): string {
    return `${base.customProgramCacheKey()}|${materialValuesKey(base)}|tlLocalLights=${mode}`;
  };
  if (byMode === undefined) {
    byMode = new Map();
    variants.set(material, byMode);
    material.addEventListener('dispose', () => {
      const made = variants.get(material);
      variants.delete(material);
      for (const m of made?.values() ?? []) m.dispatchEvent({ type: 'dispose' });
    });
  }
  byMode.set(mode, v);
  variantCount += 1;
  return v;
}

/** Variants made since the page loaded (diagnostics). */
export function localLightVariantCount(): number {
  return variantCount;
}

/** The mode a material build shades with (a variant's, else per pixel). */
function buildMode(builder: { material?: unknown }): LocalLightMode {
  return ((builder.material as Record<string, unknown> | undefined)?.[VARIANT_MODE] as LocalLightMode | undefined) ?? 'pixel';
}

type RenderObjectFn = (object: THREE.Object3D, scene: THREE.Scene, camera: THREE.Camera, geometry: THREE.BufferGeometry, material: THREE.Material, ...rest: unknown[]) => void;

/** Whether vertex lights are on for this renderer (`installLocalLightModes`); off: every build shades per pixel. */
const enabledRenderers = new WeakSet<object>();

/**
 * Draw each object with the variant of its mode. Shadow and other override
 * passes draw with their own material and are left alone; unlit materials
 * have no lights to split.
 */
export function installLocalLightModes(renderer: { renderObject: RenderObjectFn }, enabled: boolean): void {
  if (!enabled) return;
  enabledRenderers.add(renderer);
  installVertexLightStage();
  const base = renderer.renderObject;
  renderer.renderObject = function renderObjectWithMode(this: unknown, object, scene, camera, geometry, material, ...rest) {
    if (scene.overrideMaterial === null && isLit(material)) {
      const mode = drawMode(object, material);
      if (mode !== 'pixel') {
        const v = localLightVariant(material, mode);
        base.call(this, object, scene, camera, geometry, v, ...rest);
        // A transparent double-sided draw sets `side` on the material it draws and back: keep reading the material's.
        if (Object.prototype.hasOwnProperty.call(v, 'side')) delete (v as unknown as Record<string, unknown>)['side'];
        return;
      }
    }
    base.call(this, object, scene, camera, geometry, material, ...rest);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The lights of one build

type LightNodeLike = { readonly light?: THREE.Light; build(builder: unknown): unknown };
type LocalFlags = { isPointLight?: boolean; isSpotLight?: boolean; isEffectLights?: boolean; map?: unknown; colorNode?: unknown };

function isLocal(l: THREE.Light | undefined): boolean {
  const f = l as (THREE.Light & LocalFlags) | undefined;
  return f !== undefined && (f.isPointLight === true || f.isSpotLight === true || f.isEffectLights === true);
}

/**
 * Whether the light can be shaded per vertex: a projected cookie (a spot
 * light's map or colour node) is a texture read best kept per pixel.
 */
function canShadePerVertex(l: THREE.Light): boolean {
  const f = l as THREE.Light & LocalFlags;
  return !(f.isSpotLight === true && (f.map != null || f.colorNode != null));
}

/** Whether a build shades `light` per vertex (true), per pixel (false) or not at all (null). */
function shading(mode: LocalLightMode, light: THREE.Light): boolean | null {
  if (!isLocal(light)) return false;
  if (mode === 'none') return null;
  const imp = importanceOf(light);
  return (imp === 'auto' ? mode : imp) === 'vertex' && canShadePerVertex(light);
}

function splitOn(builder: { renderer?: unknown }): boolean {
  return builder.renderer !== undefined && enabledRenderers.has(builder.renderer as object);
}

/**
 * How each light node of a build is shaded: the per-pixel ones and the
 * per-vertex ones (the rest are left out). Per-vertex ones count only when
 * the build's vertex stage summed them (`sumVertexLights`).
 */
export function splitLocalLights<T extends LightNodeLike>(builder: { material?: unknown; renderer?: unknown }, nodes: readonly T[]): { pixel: T[]; vertex: T[] } {
  if (!splitOn(builder)) return { pixel: [...nodes], vertex: [] };
  const mode = buildMode(builder);
  const vertexDone = summed.has(builder);
  const pixel: T[] = [];
  const vertex: T[] = [];
  for (const n of nodes) {
    const how = n.light === undefined ? false : shading(mode, n.light);
    if (how === null) continue;
    if (how && vertexDone) vertex.push(n);
    else pixel.push(n);
  }
  return { pixel, vertex };
}

/** The part of a lights node's program key the importances decide (lights shaded per vertex in every build). */
export function localLightsCacheKey(lights: readonly THREE.Light[]): number {
  let h = 0;
  for (const l of lights) {
    const imp = importanceOf(l);
    if (imp !== 'auto') h = (Math.imul(h, 31) + l.id * 4 + (imp === 'pixel' ? 1 : 2)) | 0;
  }
  return h;
}

/**
 * A light's values as the vertex stage reads them: uniforms of their own,
 * written from the light every render. Not its per-pixel light node's: that
 * node's colour is swapped for a shadowed one by whichever build set up its
 * shadow last, and it updates only where it is built.
 */
interface VertexLightUniforms {
  readonly colour: N;
  readonly position: N;
  readonly cutoff: N;
  readonly decay: N;
  /** Spot lights: the cone's axis (view space, towards the light) and its cosines. */
  readonly axis: N;
  readonly coneCos: N;
  readonly penumbraCos: N;
  /** Layered lights: 1 for an object the light lights, else 0 (light-layers.ts), per drawn object. */
  readonly layer: N | null;
}

const vertexUniforms = new WeakMap<THREE.Light, VertexLightUniforms>();
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();

function vertexUniformsOf(light: THREE.Light): VertexLightUniforms {
  const seen = vertexUniforms.get(light);
  if (seen !== undefined) return seen;
  const l = light as THREE.SpotLight;
  const u: VertexLightUniforms = {
    colour: uniform(new THREE.Color()).setGroup(renderGroup).onRenderUpdate((_: unknown, self: { value: THREE.Color }) => {
      self.value.copy(l.color).multiplyScalar(l.intensity);
    }),
    position: uniform(new THREE.Vector3()).setGroup(renderGroup).onRenderUpdate(({ camera }: { camera: THREE.Camera }, self: { value: THREE.Vector3 }) => {
      self.value.setFromMatrixPosition(l.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    }),
    cutoff: uniform(0).setGroup(renderGroup).onRenderUpdate(() => l.distance),
    decay: uniform(2).setGroup(renderGroup).onRenderUpdate(() => l.decay),
    axis: uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup).onRenderUpdate(({ camera }: { camera: THREE.Camera }, self: { value: THREE.Vector3 }) => {
      if (l.isSpotLight !== true) return;
      _p.setFromMatrixPosition(l.matrixWorld);
      _t.setFromMatrixPosition(l.target.matrixWorld);
      self.value.subVectors(_p, _t).transformDirection(camera.matrixWorldInverse);
    }),
    coneCos: uniform(0).setGroup(renderGroup).onRenderUpdate(() => (l.isSpotLight === true ? Math.cos(l.angle) : 0)),
    penumbraCos: uniform(0).setGroup(renderGroup).onRenderUpdate(() => (l.isSpotLight === true ? Math.cos(l.angle * (1 - l.penumbra)) : 0)),
    layer: isLayeredLight(light) ? uniform(1).onObjectUpdate(({ object }: { object: THREE.Object3D }) => (lightsObject(light, object) ? 1 : 0)) : null,
  };
  vertexUniforms.set(light, u);
  return u;
}

/** A point or spot light's diffuse irradiance at a vertex (view space), without its shadow (shadows are per pixel only). */
function analyticVertexIrradiance(light: THREE.Light, normal: N, position: N, twoSided: boolean): N {
  const u = vertexUniformsOf(light);
  const toLight = u.position.sub(position);
  const distance = toLight.length();
  const direction = toLight.div(max(distance, 1e-4));
  let c = u.colour.mul(getDistanceAttenuation({ lightDistance: distance, cutoffDistance: u.cutoff, decayExponent: u.decay }));
  if ((light as { isSpotLight?: boolean }).isSpotLight === true) c = c.mul(smoothstep(u.coneCos, u.penumbraCos, direction.dot(u.axis)));
  if (u.layer !== null) c = c.mul(u.layer);
  const nl = normal.dot(direction);
  return c.mul(twoSided ? abs(nl) : max(nl, 0));
}

/** The per-vertex lights' summed irradiance: assigned in the vertex stage, read (interpolated) in the fragment stage. */
const VERTEX_LIGHTS = varyingProperty('vec3', 'tlVertexLights');

/** Builds whose vertex stage summed their per-vertex lights (the fragment stage reads them only then). */
const summed = new WeakSet<object>();

/** Record that a build's vertex stage summed its per-vertex lights. */
export function markVertexLightsSummed(builder: object): void {
  summed.add(builder);
}

/**
 * The vertex stage's part: after the vertex position is final (instance
 * columns, skinning, morphs, the material's offset), sum the build's
 * per-vertex lights at the vertex into `VERTEX_LIGHTS`. Statements (the
 * effect light pool loops over the slots in use) can only go in the vertex
 * stage's own flow, which is why this runs here rather than with the lights.
 * Double-sided surfaces (leaves, grass cards) take a light from either side:
 * a vertex can't tell which face the pixel shows.
 */
function sumVertexLights(builder: N): void {
  const material = builder.material as THREE.Material | undefined;
  if (material === undefined || builder.lightsNode == null || !splitOn(builder) || !isLit(material)) return;
  const mode = buildMode(builder);
  // The scene's lights (their light nodes are set up with the fragment stage's lighting, later).
  const lights = (builder.lightsNode.getLights() as THREE.Light[]).filter((l) => shading(mode, l) === true);
  if (lights.length === 0) return;
  const twoSided = material.side === THREE.DoubleSide;
  const normal = transformNormalToView(normalLocal).normalize().toVar('tlVertexNormal');
  const position = positionView.toVar('tlVertexPosition');
  let total: N = vec3(0);
  for (const l of lights) {
    total = total.add((l as THREE.Light & LocalFlags).isEffectLights === true ? effectLightsVertexIrradiance(l as EffectLights, normal, position, twoSided) : analyticVertexIrradiance(l, normal, position, twoSided));
  }
  VERTEX_LIGHTS.assign(total);
  markVertexLightsSummed(builder);
}

let stageInstalled = false;

/** Teach every node material's vertex stage to sum its per-vertex lights (idempotent). */
function installVertexLightStage(): void {
  if (stageInstalled) return;
  stageInstalled = true;
  const proto = THREE.NodeMaterial.prototype as unknown as { setupPosition(builder: unknown): unknown };
  const base = proto.setupPosition;
  proto.setupPosition = function setupPositionWithVertexLights(this: unknown, builder: unknown): unknown {
    const out = base.call(this, builder);
    sumVertexLights(builder);
    return out;
  };
}

/** The fragment stage's part: the interpolated per-vertex light joins the surface's ambient irradiance (before the probes take theirs: probes replace only the ambient light they hold). */
export function buildVertexLights(builder: N, nodes: readonly LightNodeLike[]): void {
  if (nodes.length === 0 || !summed.has(builder)) return;
  builder.context.irradiance.addAssign(VERTEX_LIGHTS);
}
