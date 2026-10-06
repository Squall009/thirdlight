/**
 * The realized scenes' lights and shadows, for whatever draws them (a game
 * page, the editor's Scene view): one three.js light per light entity, which
 * of them are on, the key light's shadow and its square following the camera,
 * spot cookies, and the light values environment presets and scripts set.
 *
 * - Directional and ambient lights ignore their entity's transform: they
 *   hang off the scene. A hemisphere light's sky is up (+Y) whatever its
 *   entity's turn, so it hangs off the scene too. Point and spot lights ride
 *   on their entity (the host places them, `place`).
 * - The lights that are on follow the loaded scenes (`select`,
 *   scene-lights.ts): the most recently loaded scene's directional, ambient
 *   and hemisphere light, point and spot lights within the budget. A light
 *   whose entity is hidden is off.
 * - The directional light that is on is the key light: its realtime shadow
 *   is planned when it is realized (lighting.ts) and probed on the first
 *   frame that draws it; a renderer that cannot draw it turns shadows off
 *   (`shadow_unsupported`, soft degradation).
 * - A light a bake holds is not realtime (ambient and hemisphere lights
 *   always stay, for the dynamic objects).
 * - A light whose layer masks leave some objects out is a layered light
 *   (light-layers.ts); a script's mask change applies in place, or realizes
 *   the light again when it turns plain or layered.
 */
import * as THREE from 'three';
import { blendLight, type EnvironmentBlendView, type EnvironmentLightValues, type ResourceManager } from '@thirdlight/runtime';

import { CachedShadowNode, snapToLightGrid, type CachedShadowCounts } from './cached-shadow';
import { decideShadows, deriveShadowCamera, directionalShadowSettings, planSceneLights, SHADOW_PROFILE, type AuthoredLight, type ShadowOutcome, type ShadowPlan, type ShadowReason, type ShadowRegion } from './lighting';
import { selectSceneLights, type SceneLightEntry, type SceneLightKind, type SceneLightSelection } from './scene-lights';
import type { StaticShadowRevision } from './shadow-casters';
import { textureHolds } from './texture-holds';
import { markProbeHeld } from './probe-lighting';
import {
  isLayeredLight,
  LayeredAmbientLight,
  LayeredDirectionalLight,
  LayeredHemisphereLight,
  LayeredPointLight,
  LayeredSpotLight,
  lightMasksOf,
  needsLayeredLight,
  setLightMasks,
  type LightMasks,
} from './light-layers';

/** The authored light component as the realization reads it. */
interface LightLike {
  readonly type: string;
  readonly color: string;
  readonly intensity: number;
  readonly range?: number;
  readonly decay?: number;
  readonly angle?: number;
  readonly penumbra?: number;
  readonly direction?: readonly number[];
  readonly groundColor?: string;
  readonly castShadow?: boolean;
  readonly mode?: string;
  readonly cookie?: string;
  readonly lightMask?: number;
  readonly shadowCasterMask?: number;
}

/** A realized entity as the lights read it. */
/**
 * Shadow map sides of local lights, texels: a point light draws six faces
 * (512² each costs about what one 1,024² spot map does), a spot light one.
 */
export const POINT_SHADOW_MAP_SIZE = 512;
export const SPOT_SHADOW_MAP_SIZE = 1024;

export interface LightEntityLike {
  readonly id: string;
  readonly components: unknown;
  readonly tags?: number;
}

export interface SceneLightsOptions {
  readonly scene: THREE.Scene;
  /** v3/v4 scenes: the light entities' own lights; v1/v2: the accepted fixed pair. */
  readonly v3: boolean;
  /** Where the view starts (the key light's shadow square is planned around it). */
  readonly startView: readonly [number, number, number];
  /** Where cookies are decoded and held, and the decoder (null: cookies are not drawn). */
  readonly resources: ResourceManager;
  readonly loadCookie: ((assetId: string) => Promise<THREE.Texture | null>) | null;
  /** A light a bake holds (it stays out of realtime rendering). */
  readonly bakedLight: (entityId: string) => boolean;
  /** Hang a point or spot light on its entity (it moves with it). */
  readonly place: (entityId: string, light: THREE.Light) => void;
  /** A light changed the shading (a cookie arrived): its programs are built before the next present. */
  readonly shadingChanged: () => void;
  /** The project's tag registry (name → bit) presets name lights by. */
  readonly tagBits: ReadonlyMap<string, number>;
  /**
   * The static casters' revision: the key light's shadow is a cached static map with a dynamic one on top
   * (`cached-shadow.ts`). Null: one map of every caster, drawn every frame.
   */
  readonly staticShadows: StaticShadowRevision | null;
}

type KeyRec = {
  readonly id: string;
  readonly light: THREE.DirectionalLight;
  readonly authored: AuthoredLight;
  readonly settings: { mapSize: number; bias: number; normalBias: number; extent: number };
  readonly plan: ShadowPlan;
  readonly outcome: ShadowOutcome;
  /** The direction an environment preset gives (null: the authored one). */
  directionNow: [number, number, number] | null;
  /** Its shadow as a cached static map and a dynamic one (null: three's single map, or no shadow). */
  readonly cached: CachedShadowNode | null;
};

/** A light environment presets and scripts may change, with its authored values. */
type EnvLight = { light: THREE.Light; id: string; tags: number; type: string; authored: EnvironmentLightValues };

export interface LightsDiagnostics {
  shadows: 'on' | 'off';
  shadowReason?: ShadowReason;
  /** The key light's static and dynamic shadow-map draws (absent: not cached, or no key light shadow). */
  shadowMaps?: CachedShadowCounts;
  lights?: { directional: string | null; ambient: string | null; hemisphere: string | null; local: number; localOn: number; cookies: number };
}

/** What a script may write over a realized light. */
export interface LightValueOverride {
  readonly color?: string;
  readonly intensity?: number;
  readonly range?: number;
  readonly lightMask?: number;
  readonly shadowCasterMask?: number;
}

export interface SceneLights {
  /** Realize an entity's light (none when it has none, or a bake holds it). */
  realize(e: LightEntityLike): void;
  /** Release an entity's light (a scene-level one leaves the scene; one on the entity goes with its node). */
  release(entityId: string): void;
  /** Whether the entity has a realized light. */
  has(entityId: string): boolean;
  /** Switch the lights on and off: scenes by load rank (entity → its scene's rank), hidden entities off. */
  select(rankOf: (entityId: string) => number, hidden: ReadonlySet<string>): void;
  /** The key light's direction now (a preset's or the authored one). */
  keyDirection(): readonly [number, number, number] | undefined;
  /**
   * The key light's shadow square follows the camera on the ground (its X and Z; Y is up), snapped to whole
   * shadow texels in the light's frame (no shimmer).
   */
  followCamera(camera: THREE.Camera): void;
  /**
   * Before a frame: the shadow map on when a light casts one, and the key
   * light's capability probe (true: this frame is the probe).
   */
  beforeFrame(renderer: { shadowMap: { enabled: boolean; type: THREE.ShadowMapType } }): boolean;
  /** The probe frame failed: no light casts a shadow from now on. */
  disableShadows(renderer: { shadowMap: { enabled: boolean } }): void;
  /** The probe frame was not drawn (a precompile held it): it is the next one. */
  probeAgain(): void;
  /** A new renderer: the probe runs again on it. */
  rendererReplaced(): void;
  /** Bumped when the set of lights presets may change changes. */
  readonly revision: number;
  /** The blended values of an environment preset view over `base` (the runtime's blend maths). */
  applyBlend(base: Parameters<typeof blendLight>[3], presets: Parameters<typeof blendLight>[4], view: EnvironmentBlendView): void;
  /** Back to the authored values (a blend ended). */
  restore(): void;
  /**
   * The values scripts wrote: colour and intensity become the authored ones, range a light's distance, the masks
   * its light layers. True when a light was realized again (a mask turned it plain or layered): the lights that
   * are on must be selected again.
   */
  applyOverrides(overrides: ReadonlyMap<string, LightValueOverride>, blending: boolean, rangeOf: (entityId: string) => number): boolean;
  diagnostics(): LightsDiagnostics;
  dispose(): void;
}

/** A baked or mixed ambient/hemisphere light is in the probe bake (it is the sky the probes see): inside a tile the probes replace it. */
const probeHeldMode = (mode: string | undefined): boolean => mode === 'baked' || mode === 'mixed';

export function createSceneLights(o: SceneLightsOptions): SceneLights {
  const { scene } = o;
  let disposed = false;
  /** A light that stays out of realtime rendering: held by a bake (ambient/hemisphere always stay). */
  const bakedAway = (id: string, l: { type: string; mode?: string }): boolean => l.mode === 'baked' && l.type !== 'ambient' && l.type !== 'hemisphere' && o.bakedLight(id);
  /** point/spot lights casting shadows (the shadow map is enabled for them). */
  let localShadowLights = 0;
  /** Every realized light by entity, switched on and off by `select`. */
  const switchable = new Map<string, { kind: SceneLightKind; light: THREE.Light }>();
  /** The lights presets and scripts may change. */
  const envLights = new Map<string, EnvLight>();
  let revision = 0;
  let envLightsTouched = false;
  /** The spot cookies drawn (a copy of the decoded texture each, the light's own: disposed with the light, which holds the decoded one). */
  const cookies = new Map<THREE.SpotLight, THREE.Texture>();
  const cookieHolds = o.loadCookie === null ? null : textureHolds(o.resources, o.loadCookie);
  const attachCookie = (s: THREE.SpotLight, assetId: string): void => {
    if (cookieHolds === null) return;
    void cookieHolds.get(assetId, s.uuid).then(
      (decoded) => {
        if (decoded === null) return;
        // Released meanwhile (its scene unloaded, the host disposed): not drawn.
        if (disposed || ![...switchable.values()].some((r) => r.light === s)) {
          cookieHolds.releaseHolder(s.uuid);
          return;
        }
        const tex = decoded.clone();
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        s.map = tex;
        cookies.set(s, tex);
        o.shadingChanged();
      },
      () => undefined,
    );
  };
  /** A point, spot or hemisphere light for an entity (null otherwise, or when a bake holds it). */
  const localLightOf = (id: string, l: LightLike, masks: LightMasks): THREE.Light | null => {
    if (bakedAway(id, l)) return null;
    const colour = new THREE.Color(l.color);
    const layered = needsLayeredLight(masks);
    if (l.type === 'hemisphere') {
      const h = new (layered ? LayeredHemisphereLight : THREE.HemisphereLight)(colour, new THREE.Color(l.groundColor ?? '#444444'), l.intensity);
      setLightMasks(h, masks);
      markProbeHeld(h, probeHeldMode(l.mode));
      return h;
    }
    if (l.type === 'point') {
      const p = new (layered ? LayeredPointLight : THREE.PointLight)(colour, l.intensity, l.range ?? 0, l.decay ?? 2);
      setLightMasks(p, masks);
      p.castShadow = l.castShadow === true;
      if (p.castShadow) p.shadow.mapSize.set(POINT_SHADOW_MAP_SIZE, POINT_SHADOW_MAP_SIZE);
      return p;
    }
    if (l.type === 'spot') {
      const s = new (layered ? LayeredSpotLight : THREE.SpotLight)(colour, l.intensity, l.range ?? 0, THREE.MathUtils.degToRad(l.angle ?? 30), l.penumbra ?? 0.2, l.decay ?? 2);
      setLightMasks(s, masks);
      // Three puts a new SpotLight at (0, 1, 0) (Object3D.DEFAULT_UP); at its entity's origin it shines along `direction`.
      s.position.set(0, 0, 0);
      const d = l.direction ?? [0, -1, 0];
      s.target.position.set(d[0] ?? 0, d[1] ?? -1, d[2] ?? 0);
      s.castShadow = l.castShadow === true;
      if (s.castShadow) s.shadow.mapSize.set(SPOT_SHADOW_MAP_SIZE, SPOT_SHADOW_MAP_SIZE);
      // A cookie (three's SpotLight.map; the node lighting projects it through the cone on both backends).
      if (typeof l.cookie === 'string') attachCookie(s, l.cookie);
      return s;
    }
    return null;
  };

  // --- The key light and its shadow --------------------------------------------
  const directionals = new Map<string, KeyRec>();
  let keyRec: KeyRec | null = null;
  /** The first frame with shadows failed (soft degradation): no light casts a shadow from then on. */
  let shadowsUnsupported = false;
  /** The shadow state (the key light's), recorded when the key light changes (never per frame). */
  let shadowState: { shadows: 'on' | 'off'; reason?: ShadowReason } = { shadows: 'off', reason: 'cast_shadow_false' };
  let shadowProbeDone = false;
  const keyDirectionOf = (r: KeyRec | null): readonly [number, number, number] | undefined => r?.directionNow ?? r?.authored.direction;
  /** A directional light at the derived position round the view's start square. */
  const directionalLightOf = (id: string, l: AuthoredLight, masks: LightMasks): KeyRec => {
    const settings = directionalShadowSettings(l);
    const start = o.startView;
    const region: ShadowRegion = { minX: start[0] - settings.extent, maxX: start[0] + settings.extent, minY: start[1] - settings.extent, maxY: start[1] + settings.extent };
    const direction = l.direction ?? [0, -1, 0];
    const outcome = decideShadows({ webgl2: true, castShadow: l.castShadow === true, probeOk: true, region, direction });
    // `outcome` always resolves `ok: true` here (webgl2: true).
    const plan: ShadowPlan = outcome.ok ? outcome.plan : deriveShadowCamera(region, direction);
    const [planned] = planSceneLights([l], region, outcome);
    const light = new (needsLayeredLight(masks) ? LayeredDirectionalLight : THREE.DirectionalLight)(new THREE.Color(l.color), l.intensity);
    setLightMasks(light, masks);
    if (planned !== undefined && planned.kind === 'directional') {
      light.position.set(planned.position[0], planned.position[1], planned.position[2]);
      light.target.position.set(planned.target[0], planned.target[1], planned.target[2]);
    }
    // The target is not in the scene (it draws nothing): its world matrix is kept here and by the shadow follow.
    light.target.updateMatrixWorld();
    let cached: CachedShadowNode | null = null;
    if (outcome.ok && outcome.shadows === 'on' && !shadowsUnsupported) {
      // The shadow-camera parameters are set now; the shadow map is allocated only by the first-frame probe.
      light.castShadow = true;
      light.shadow.mapSize.set(settings.mapSize, settings.mapSize);
      light.shadow.bias = settings.bias;
      light.shadow.normalBias = settings.normalBias;
      light.shadow.camera.left = plan.camera.left;
      light.shadow.camera.right = plan.camera.right;
      light.shadow.camera.top = plan.camera.top;
      light.shadow.camera.bottom = plan.camera.bottom;
      light.shadow.camera.near = plan.camera.near;
      light.shadow.camera.far = plan.camera.far;
      light.shadow.camera.updateProjectionMatrix();
      if (o.staticShadows !== null) {
        cached = new CachedShadowNode(light, o.staticShadows, { mapSize: settings.mapSize, halfExtent: plan.halfExtent, near: plan.camera.near, far: plan.camera.far, distance: SHADOW_PROFILE.distance, bias: settings.bias, normalBias: settings.normalBias });
        (light.shadow as { shadowNode?: unknown }).shadowNode = cached;
      }
    }
    return { id, light, authored: l, settings, plan, outcome, directionNow: null, cached };
  };
  /** The shadow state follows the key light (a scene with a shadow-casting sun turns shadows on; the probe runs for it). */
  const applyKeyShadow = (): void => {
    const out = keyRec?.outcome;
    if (keyRec === null || out === undefined || !out.ok) shadowState = { shadows: 'off', reason: 'cast_shadow_false' };
    else if (shadowsUnsupported && keyRec.authored.castShadow === true) shadowState = { shadows: 'off', reason: 'shadow_unsupported' };
    else shadowState = out.shadows === 'on' ? { shadows: 'on' } : { shadows: 'off', reason: out.shadowReason ?? 'cast_shadow_false' };
  };

  if (!o.v3) {
    // Simple lighting for the Lambert material (no shadow pipeline for v1/v2 scenes): one directional + one ambient.
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(0.5, 1, 0.8);
    scene.add(dirLight);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  }

  let selection: SceneLightSelection | null = null;
  const followDir = new THREE.Vector3();
  const followPoint = new THREE.Vector3();
  const followCentre = new THREE.Vector3();

  function setLightValues(rec: { light: THREE.Light; id: string; type: string }, v: EnvironmentLightValues): void {
    rec.light.color.set(v.color);
    rec.light.intensity = v.intensity;
    if (v.groundColor !== undefined && (rec.light as THREE.HemisphereLight).isHemisphereLight === true) (rec.light as THREE.HemisphereLight).groundColor.set(v.groundColor);
    const d = v.direction;
    if (d === undefined) return;
    if (rec.type === 'directional') {
      // The shadow square follows the camera: the direction is applied there each frame.
      const key = directionals.get(rec.id);
      if (key !== undefined) key.directionNow = [d[0], d[1], d[2]];
    } else if ((rec.light as THREE.SpotLight).isSpotLight === true) (rec.light as THREE.SpotLight).target.position.set(d[0], d[1], d[2]);
  }
  const lightOriginals = new WeakMap<object, EnvironmentLightValues>();
  const disableShadows = (renderer: { shadowMap: { enabled: boolean } }): void => {
    try {
      renderer.shadowMap.enabled = false;
    } catch {
      /* best effort */
    }
    for (const r of directionals.values()) r.light.castShadow = false;
    shadowsUnsupported = true;
    shadowState = { shadows: 'off', reason: 'shadow_unsupported' };
  };

  /** The entity each realized light was made from (realized again when a script's mask turns it plain or layered). */
  const realizedFrom = new Map<string, LightEntityLike>();
  /** The masks scripts wrote, by light entity. */
  const maskOverrides = new Map<string, { lightMask?: number; shadowCasterMask?: number }>();
  /** A light's masks now: the authored ones under what a script wrote. */
  const masksOf = (id: string, l: LightLike): LightMasks => {
    const authored = lightMasksOf(l);
    const w = maskOverrides.get(id);
    return w === undefined ? authored : { lightMask: w.lightMask ?? authored.lightMask, shadowCasterMask: w.shadowCasterMask ?? authored.shadowCasterMask };
  };
  /** Realize a light again from its entity (a light on its entity leaves the node first: release leaves it there). */
  function replaceLight(id: string): void {
    const e = realizedFrom.get(id);
    const lit = switchable.get(id);
    if (e === undefined) return;
    releaseLight(id);
    if (lit !== undefined && (lit.kind === 'point' || lit.kind === 'spot')) {
      lit.light.removeFromParent();
      lit.light.dispose();
    }
    realizeLight(e);
  }

function realizeLight(e: LightEntityLike): void {
    const l = (e.components as { light?: LightLike }).light;
    if (l === undefined) return;
    realizedFrom.set(e.id, e);
    const tags = e.tags ?? 0;
    const masks = masksOf(e.id, l);
    const local = localLightOf(e.id, l, masks);
    if (local !== null) {
      // Environment presets may set its colour, intensity, direction and ground colour.
      const d = l.direction ?? (l.type === 'spot' ? [0, -1, 0] : undefined);
      envLights.set(e.id, {
        light: local,
        id: e.id,
        tags,
        type: l.type,
        authored: { color: l.color, intensity: l.intensity, ...(d !== undefined ? { direction: [d[0] ?? 0, d[1] ?? -1, d[2] ?? 0] as [number, number, number] } : {}), ...(l.type === 'hemisphere' ? { groundColor: l.groundColor ?? '#444444' } : {}) },
      });
      revision += 1;
      if (l.type === 'hemisphere') scene.add(local);
      else {
        // The cone's target rides on the light (both at the entity's origin and turn), so it is placed with it.
        if (local instanceof THREE.SpotLight) local.add(local.target);
        o.place(e.id, local);
      }
      if ((local as THREE.PointLight).castShadow === true) localShadowLights += 1;
      switchable.set(e.id, { kind: l.type as SceneLightKind, light: local });
      return;
    }
    // A directional or ambient light of any loaded scene: its entity's transform is irrelevant.
    if (!o.v3 || (l.type !== 'directional' && l.type !== 'ambient') || bakedAway(e.id, l)) return;
    if (l.type === 'ambient') {
      // No shadow, no position dependence; the intensity is used exactly as authored.
      const ambient = new (needsLayeredLight(masks) ? LayeredAmbientLight : THREE.AmbientLight)(new THREE.Color(l.color), l.intensity);
      setLightMasks(ambient, masks);
      markProbeHeld(ambient, probeHeldMode(l.mode));
      scene.add(ambient);
      switchable.set(e.id, { kind: 'ambient', light: ambient });
      envLights.set(e.id, { light: ambient, id: e.id, tags, type: 'ambient', authored: { color: l.color, intensity: l.intensity } });
    } else {
      const rec = directionalLightOf(e.id, l as AuthoredLight, masks);
      scene.add(rec.light);
      directionals.set(e.id, rec);
      switchable.set(e.id, { kind: 'directional', light: rec.light });
      const kd = l.direction ?? [0, -1, 0];
      envLights.set(e.id, { light: rec.light, id: e.id, tags, type: 'directional', authored: { color: l.color, intensity: l.intensity, direction: [kd[0] ?? 0, kd[1] ?? -1, kd[2] ?? 0] } });
    }
    revision += 1;
  }

function releaseLight(entityId: string): void {
    realizedFrom.delete(entityId);
  if (envLights.delete(entityId)) revision += 1;
    const lit = switchable.get(entityId);
    if (lit === undefined) return;
    switchable.delete(entityId);
    const cookie = cookies.get(lit.light as THREE.SpotLight);
    if (cookie !== undefined) {
      cookies.delete(lit.light as THREE.SpotLight);
      (lit.light as THREE.SpotLight).map = null;
      cookie.dispose();
    }
    cookieHolds?.releaseHolder(lit.light.uuid);
    if ((lit.light as THREE.PointLight).castShadow === true && (lit.kind === 'point' || lit.kind === 'spot')) localShadowLights = Math.max(0, localShadowLights - 1);
    // A light on its entity goes with the entity's node; the scene-level ones leave the scene here.
    if (lit.kind === 'directional' || lit.kind === 'ambient' || lit.kind === 'hemisphere') {
      lit.light.removeFromParent();
      if (lit.kind === 'directional') (lit.light as THREE.DirectionalLight).target.removeFromParent();
      lit.light.dispose();
      directionals.get(entityId)?.cached?.dispose();
      directionals.delete(entityId);
      if (keyRec?.id === entityId) keyRec = null;
    }
  }

  return {
    realize: realizeLight,

    release(entityId: string): void {
      releaseLight(entityId);
      maskOverrides.delete(entityId);
    },

    has: (entityId) => switchable.has(entityId),

    select(rankOf, hidden): void {
      if (!o.v3) return;
      const entries: SceneLightEntry[] = [];
      let order = 0;
      // A light whose object is hidden or switched off is off and counts for nothing (the previous scene's
      // light of its kind comes back; a point or spot light frees its place in the budget).
      for (const [id, r] of switchable) {
        if (hidden.has(id)) {
          order++;
          continue;
        }
        entries.push({ id, kind: r.kind, rank: rankOf(id), order: order++ });
      }
      selection = selectSceneLights(entries);
      for (const [id, r] of switchable) r.light.visible = selection.active.has(id);
      const next = selection.directional !== null ? (directionals.get(selection.directional) ?? null) : null;
      if (next !== keyRec || keyRec === null) {
        keyRec = next;
        // A sun that was key before saw none of the changes made while another was (only the key light's
        // map drains them): its cached map is drawn again.
        keyRec?.cached?.invalidate();
        applyKeyShadow();
      }
    },

    keyDirection: () => keyDirectionOf(keyRec),

    followCamera(camera: THREE.Camera): void {
      if (keyRec === null) return;
      const texel = (2 * keyRec.plan.halfExtent) / keyRec.settings.mapSize;
      const d = keyDirectionOf(keyRec) ?? [0, -1, 0];
      followDir.set(d[0], d[1], d[2]);
      if (followDir.lengthSq() < 1e-12) followDir.set(0, -1, 0);
      followDir.normalize();
      // The ground under the camera: walking moves the square, the camera's height does not.
      followPoint.set(camera.position.x, 0, camera.position.z);
      snapToLightGrid(followPoint, followDir, texel, followCentre);
      const light = keyRec.light;
      light.target.position.copy(followCentre);
      light.position.copy(followCentre).addScaledVector(followDir, -SHADOW_PROFILE.distance);
      light.target.updateMatrixWorld();
      keyRec.cached?.follow(followPoint, followCentre, followDir);
    },

    beforeFrame(renderer): boolean {
      // The static casters' changes this frame go to the key light's cached map (none: they are forgotten).
      if (keyRec?.cached != null) keyRec.cached.roll();
      else o.staticShadows?.drain(null);
      if (localShadowLights > 0 && !renderer.shadowMap.enabled) {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
      }
      // The first frame of a scene with shadows is the probe: shadows go on before it (and before a
      // precompile, so the programs are built with them). A scene with no shadow-casting light never
      // enables `shadowMap`.
      if (shadowState.shadows !== 'on' || !o.v3 || shadowProbeDone) return false;
      shadowProbeDone = true;
      try {
        renderer.shadowMap.enabled = true;
        // three's `THREE.PCFShadowMap` (the frozen profile row).
        renderer.shadowMap.type = THREE.PCFShadowMap;
        return true;
      } catch {
        disableShadows(renderer);
        return false;
      }
    },

    disableShadows,

    probeAgain(): void {
      shadowProbeDone = false;
    },

    rendererReplaced(): void {
      if (shadowState.shadows === 'on') shadowProbeDone = false;
      keyRec?.cached?.invalidate();
    },

    get revision(): number {
      return revision;
    },

    applyBlend(base, presets, view): void {
      envLightsTouched = true;
      for (const rec of envLights.values()) setLightValues(rec, blendLight(rec.authored, rec, o.tagBits, base, presets, view));
    },

    restore(): void {
      if (!envLightsTouched) return;
      envLightsTouched = false;
      for (const rec of envLights.values()) setLightValues(rec, rec.authored);
      for (const key of directionals.values()) key.directionNow = null;
    },

    applyOverrides(ov, blending, rangeOf): boolean {
      // The masks first: a light turning plain or layered is realized again (its values are set below).
      let replaced = false;
      for (const id of [...realizedFrom.keys()]) {
        const w = ov.get(id);
        const want = w?.lightMask === undefined && w?.shadowCasterMask === undefined ? undefined : { ...(w.lightMask !== undefined ? { lightMask: w.lightMask } : {}), ...(w.shadowCasterMask !== undefined ? { shadowCasterMask: w.shadowCasterMask } : {}) };
        const had = maskOverrides.get(id);
        if (had?.lightMask === want?.lightMask && had?.shadowCasterMask === want?.shadowCasterMask) continue;
        if (want === undefined) maskOverrides.delete(id);
        else maskOverrides.set(id, want);
        const lit = switchable.get(id);
        const l = (realizedFrom.get(id)!.components as { light?: LightLike }).light;
        if (lit === undefined || l === undefined) continue;
        const masks = masksOf(id, l);
        if (needsLayeredLight(masks) !== isLayeredLight(lit.light)) {
          replaceLight(id);
          replaced = true;
          continue;
        }
        const casters = isLayeredLight(lit.light) ? lit.light.shadowCasterMask : masks.shadowCasterMask;
        setLightMasks(lit.light, masks);
        // Other casters in the key light's cached static map.
        if (casters !== masks.shadowCasterMask) directionals.get(id)?.cached?.invalidate();
      }
      for (const rec of envLights.values()) {
        let original = lightOriginals.get(rec);
        if (original === undefined) lightOriginals.set(rec, (original = rec.authored));
        const w = ov.get(rec.id);
        rec.authored = w === undefined ? original : { ...original, ...(w.color !== undefined ? { color: w.color } : {}), ...(w.intensity !== undefined ? { intensity: w.intensity } : {}) };
        if (!blending) setLightValues(rec, rec.authored);
      }
      for (const [id, r] of switchable) {
        const l = r.light as THREE.PointLight | THREE.SpotLight;
        if ((l as THREE.PointLight).isPointLight !== true && (l as THREE.SpotLight).isSpotLight !== true) continue;
        l.distance = ov.get(id)?.range ?? rangeOf(id);
      }
      return replaced;
    },

    diagnostics(): LightsDiagnostics {
      const d: LightsDiagnostics = { shadows: shadowState.shadows };
      // `shadowReason` is present iff `shadows === 'off'`.
      if (shadowState.shadows === 'off' && shadowState.reason !== undefined) d.shadowReason = shadowState.reason;
      if (shadowState.shadows === 'on' && keyRec?.cached != null && keyRec.light.castShadow) d.shadowMaps = keyRec.cached.diagnostics();
      if (selection !== null && !disposed) d.lights = { directional: selection.directional, ambient: selection.ambient, hemisphere: selection.hemisphere, local: selection.localTotal, localOn: selection.localOn, cookies: cookies.size };
      return d;
    },

    dispose(): void {
      disposed = true;
      for (const light of cookies.keys()) cookieHolds?.releaseHolder(light.uuid);
    },
  };
}
