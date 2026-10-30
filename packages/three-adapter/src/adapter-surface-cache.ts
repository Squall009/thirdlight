/**
 * The adapter's surface cache (`surface-cache-host.ts`): fed from the level
 * views (block layers, terrains, architecture) and the static model objects
 * the entities realized, with their rows' distance-field files.
 */
import * as THREE from 'three';
import { DEFAULT_SURFACE_CACHE_MIB, GLOW_MODE_DEFAULT, LIGHT_LAYERS_ALL, lightLayerMaskOf } from '@thirdlight/project-model';

import type { AdapterEntities, EntityDoc } from './adapter-entities';
import type { AdapterLevel } from './adapter-level';
import type { SceneAdapterOptions } from './adapter-types';
import { lightLayersOfComponents } from './light-layers';
import type { SceneLights } from './lights-shadows';
import type { SceneAdapterModelAsset } from './models';
import type { RenderGraph } from './render-graph';
import type { CacheLight } from './surface-changes';
import { SURFACE_CACHE_KEY, SurfaceCacheHost, type SurfaceHostModel } from './surface-cache-host';
import { SURFACE_READ } from './surface-cache-lookup';
import { SURFACE_READ_KEY, SURFACE_SLOT_KEY } from './surface-cache-read';
import { GLOW_LIGHT_MARK } from './surface-highlights';
import { INSTANCE_SET_KEY } from './instancing';
import { MODEL_PIECE_KEY } from './pieces';

/** Bytes in a MiB (the quality level names its budget in MiB). */
const MIB = 1024 * 1024;

export function createAdapterSurfaceCache(d: { opts: SceneAdapterOptions; scene: THREE.Scene; level: AdapterLevel; entities: AdapterEntities; docs: ReadonlyMap<string, EntityDoc>; graph: RenderGraph; matrix: THREE.Matrix4 }): SurfaceCacheHost | null {
  const { opts, level, entities, docs, graph } = d;
  if (opts.surfaceCache === false) return null;
  let rows: Map<string, SceneAdapterModelAsset> | null = null;
  const rowOf = (assetId: string): SceneAdapterModelAsset | undefined => {
    rows ??= new Map((opts.models?.assets ?? []).map((a) => [a.assetId, a]));
    return rows.get(assetId) ?? opts.models?.rowOf?.(assetId);
  };
  // An entity's light layers, when not every layer (the cache's lights light what shares one with their mask).
  const layersOf = (id: string): { layers?: number } => {
    const mask = lightLayersOfComponents(docs.get(id)?.components);
    return mask === LIGHT_LAYERS_ALL ? {} : { layers: mask };
  };
  const models = (): SurfaceHostModel[] => {
    const out: SurfaceHostModel[] = [];
    for (const id of entities.staticScopes.keys()) {
      const model = (docs.get(id)?.components as { model?: { asset?: { assetId?: string }; piece?: string } } | undefined)?.model;
      const assetId = model?.asset?.assetId;
      if (assetId === undefined) continue;
      const row = rowOf(assetId);
      if (row?.bricks !== true || !graph.worldMatrixOf(id, d.matrix)) continue;
      out.push({ id, assetId, version: row.version, piece: model?.piece ?? null, world: d.matrix.elements.slice(), ...layersOf(id) });
    }
    return out;
  };
  const host = new SurfaceCacheHost(
    {
      layers: () => level.blockView.drawnLayers().map((l) => ({ id: l.id, origin: l.origin, grid: l.grid, version: l.surfaceVersion, chunks: l.chunks, opaque: l.opaque, ...layersOf(l.id) })),
      terrains: () => level.terrains.ids().flatMap((id) => {
        const field = level.terrains.field(id);
        return field !== null ? [{ id, field, ...layersOf(id) }] : [];
      }),
      architecture: () => level.architecture.surfaceObjects().map((a) => ({ ...a, ...layersOf(a.id) })),
      models,
      bricks: (assetId, version) => opts.models?.resolveBricks?.(assetId, version) ?? null,
      rooms: () => level.archHost.rooms.lighting(),
      modelAlive: (id) => docs.has(id) && entities.staticScopes.has(id),
      building: () => level.blockView.meshing(),
    },
    DEFAULT_SURFACE_CACHE_MIB * MIB,
  );
  d.scene.userData[SURFACE_CACHE_KEY] = { diagnostics: () => host.diagnostics() };
  return host;
}

/**
 * A static model object's meshes, once attached: they read the surface
 * cache by its slot when its row has a distance-field file (the cache holds
 * light only for such models).
 */
export function markStaticModelRead(host: SurfaceCacheHost | null, opts: SceneAdapterOptions, docs: ReadonlyMap<string, EntityDoc>, id: string, root: THREE.Object3D): void {
  if (host === null) return;
  const assetId = (docs.get(id)?.components as { model?: { asset?: { assetId?: string } } } | undefined)?.model?.asset?.assetId;
  if (assetId === undefined) return;
  const row = opts.models?.assets.find((a) => a.assetId === assetId) ?? opts.models?.rowOf?.(assetId);
  if (row?.bricks !== true) return;
  root.traverse((o) => {
    // An instance set's copies stand elsewhere than the object (the cache holds the object's own placement only).
    if ((o as THREE.InstancedMesh).isInstancedMesh === true || o.userData[INSTANCE_SET_KEY] !== undefined) return;
    if ((o as THREE.Mesh).isMesh !== true) return;
    o.userData[SURFACE_READ_KEY] = SURFACE_READ.model;
    // Each piece its own slot: a multi-piece model's meshes read their own piece's light.
    const piece = o.userData[MODEL_PIECE_KEY] as string | undefined;
    o.userData[SURFACE_SLOT_KEY] = host.modelSlots.slotOf(id, piece ?? '');
  });
}

/** A level's surface-cache budget in bytes. */
export function surfaceCacheBytes(mib: number | undefined): number {
  return (mib ?? DEFAULT_SURFACE_CACHE_MIB) * MIB;
}

/** How often (ms) the lights and glowing surfaces are read again from the entities (realized lights are read every frame). */
export const DOC_LIGHTS_MS = 250;
/** A glowing box's face smaller than this share of its largest face lights nothing worth tracing (a sign's edges). */
const EMITTER_FACE_SHARE = 0.05;

type V3 = [number, number, number];
interface LightDoc {
  type?: string;
  color?: string;
  intensity?: number;
  direction?: readonly number[];
  range?: number;
  angle?: number;
  penumbra?: number;
  castShadow?: boolean;
  lightMask?: number;
  shadowCasterMask?: number;
  shape?: string;
  mode?: string;
  width?: number;
  height?: number;
  twoSided?: boolean;
}

const linear = (hex: string | undefined, k: number, c: THREE.Color): number[] => {
  c.set(hex ?? '#ffffff');
  return [c.r * k, c.g * k, c.b * k];
};

/**
 * The cache's lights, read from the scene's entities: every point, spot,
 * area and directional light, whether three draws it or not (lights past
 * the per-pixel cap, baked lights and area lights light the cache all the
 * same), and every static glowing box as area lights over its faces. A
 * light three draws is read from its three.js light every frame (scripts
 * switch, dim and move them there); the rest from the entities every
 * `DOC_LIGHTS_MS`.
 */
export class SurfaceLights {
  private fromDocs: CacheLight[] = [];
  private docIds = new Set<string>();
  private readAt = -Infinity;
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();
  /** Ids of the directional lights three draws per pixel this frame (none held by a bake). */
  drawnSuns: ReadonlySet<string> = new Set();

  constructor(private readonly docs: ReadonlyMap<string, EntityDoc>, private readonly graph: RenderGraph) {}

  now(lights: SceneLights, t = performance.now()): CacheLight[] {
    if (t - this.readAt >= DOC_LIGHTS_MS) {
      this.readAt = t;
      this.readDocs();
    }
    const drawn = surfaceLightsOf(lights);
    this.drawnSuns = new Set(drawn.filter((l) => l.on && l.kind === 'directional').map((l) => l.id));
    const byId = new Map(drawn.map((l) => [l.id, l]));
    const out: CacheLight[] = [];
    for (const l of this.fromDocs) {
      const d = byId.get(l.id);
      // three's state (on, colour, place) with the entity's shape, shadows and masks.
      out.push(d === undefined ? l : { ...l, on: d.on, color: d.color, position: d.position, direction: d.direction, range: d.range, cone: d.cone, penumbra: d.penumbra });
    }
    for (const d of drawn) if (!this.docIds.has(d.id)) out.push(d);
    return out;
  }

  private readDocs(): void {
    const out: CacheLight[] = [];
    this.docIds = new Set();
    for (const [id, e] of this.docs) {
      const comps = e.components as { light?: LightDoc; surface?: { emissive?: string; emissiveIntensity?: number; emissiveMode?: CacheLight['mode'] }; box?: { size?: readonly number[] } };
      const l = comps.light;
      if (l !== undefined && (l.type === 'point' || l.type === 'spot' || l.type === 'directional' || l.type === 'area')) {
        if (!this.graph.worldMatrixOf(id, this.m)) continue;
        this.docIds.add(id);
        out.push(this.lightOf(id, l));
      }
      const glow = comps.surface;
      if (glow?.emissive !== undefined && (glow.emissiveIntensity ?? 0) > 0 && (e as { static?: boolean }).static === true && comps.box?.size !== undefined) {
        const radiance = linear(glow.emissive, glow.emissiveIntensity ?? 0, this.c);
        if (Math.max(...radiance) > 0 && this.graph.worldMatrixOf(id, this.m)) out.push(...this.glowingBox(id, comps.box.size, radiance, glow.emissiveMode ?? GLOW_MODE_DEFAULT));
      }
    }
    this.fromDocs = out;
  }

  private lightOf(id: string, l: LightDoc): CacheLight {
    const m = this.m.elements;
    const axis = (k: number): V3 => [m[k * 4]!, m[k * 4 + 1]!, m[k * 4 + 2]!];
    const unit = (v: readonly number[]): V3 => {
      const n = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
      return [(v[0] ?? 0) / n, (v[1] ?? 0) / n, (v[2] ?? 0) / n];
    };
    const pos: V3 = [m[12]!, m[13]!, m[14]!];
    const masks = { lightMask: lightLayerMaskOf(l.lightMask), casterMask: lightLayerMaskOf(l.shadowCasterMask) };
    const mode: Pick<CacheLight, 'mode'> = l.mode === 'baked' || l.mode === 'mixed' ? { mode: l.mode } : {};
    const base = { id, on: true, position: pos, color: linear(l.color, l.intensity ?? 1, this.c), range: l.range ?? 0, cone: 0, penumbra: 0, ...masks, ...mode };
    if (l.type === 'directional') {
      const d = unit(l.direction ?? [0, -1, 0]);
      return { ...base, kind: 'directional', direction: [-d[0], -d[1], -d[2]], range: 0, shadows: l.castShadow === true };
    }
    if (l.type === 'area') {
      // Its rectangle in the local XZ plane, facing local −Y; a line along local X.
      const x = axis(0);
      const y = axis(1);
      const z = axis(2);
      const hw = (l.width ?? 1) / 2;
      const hh = l.shape === 'line' ? 0 : (l.height ?? 0.5) / 2;
      const facing = unit([-y[0], -y[1], -y[2]]);
      return { ...base, kind: 'area', direction: facing, shadows: l.castShadow !== false, area: { u: x.map((v) => v * hw), v: z.map((v) => v * hh), twoSided: l.twoSided === true } };
    }
    // A spot's axis: its direction, turned with the entity.
    const dir = l.direction ?? [0, -1, 0];
    const w = unit([0, 1, 2].map((r) => m[r]! * dir[0]! + m[4 + r]! * dir[1]! + m[8 + r]! * dir[2]!));
    const spot = l.type === 'spot';
    return { ...base, kind: spot ? 'spot' : 'point', direction: w, cone: spot ? Math.cos(((l.angle ?? 30) * Math.PI) / 180) : 0, penumbra: spot ? (l.penumbra ?? 0.2) : 0, shadows: l.castShadow === true };
  }

  /** A glowing box's faces as one-sided rectangle lights of its glow's mode, each as bright as the box's surface glows. */
  private glowingBox(id: string, size: readonly number[], radiance: readonly number[], mode: NonNullable<CacheLight['mode']>): CacheLight[] {
    const m = this.m.elements;
    const axes = [0, 1, 2].map((k) => [m[k * 4]! * (size[k] ?? 1) / 2, m[k * 4 + 1]! * (size[k] ?? 1) / 2, m[k * 4 + 2]! * (size[k] ?? 1) / 2]);
    const len = axes.map((a) => Math.hypot(a[0]!, a[1]!, a[2]!));
    const area = (k: number): number => 4 * len[(k + 1) % 3]! * len[(k + 2) % 3]!;
    const largest = Math.max(area(0), area(1), area(2));
    const out: CacheLight[] = [];
    for (let k = 0; k < 3; k += 1) {
      const a = area(k);
      if (a < largest * EMITTER_FACE_SHARE || len[k] === 0) continue;
      for (const sign of [1, -1]) {
        const n = axes[k]!.map((v) => (v * sign) / len[k]!);
        out.push({
          id: `${id}${GLOW_LIGHT_MARK}${k}${sign > 0 ? '+' : '-'}`,
          kind: 'area',
          on: true,
          position: [m[12]! + axes[k]![0]! * sign, m[13]! + axes[k]![1]! * sign, m[14]! + axes[k]![2]! * sign],
          direction: n,
          // Its whole intensity along its normal: radiance × area.
          color: radiance.map((v) => v * a),
          range: 0,
          cone: 0,
          penumbra: 0,
          shadows: true,
          ...(mode !== 'realtime' ? { mode } : {}),
          area: { u: axes[(k + 1) % 3]!, v: axes[(k + 2) % 3]!, twoSided: false },
        });
      }
    }
    return out;
  }
}

/**
 * The page's point, spot and directional lights three draws, as the cache's
 * change tracking reads them (once a frame; their world matrices as last drawn).
 */
export function surfaceLightsOf(lights: SceneLights): CacheLight[] {
  const out: CacheLight[] = [];
  lights.forEachLight((id, kind, light, direction) => {
    if (kind !== 'point' && kind !== 'spot' && kind !== 'directional') return;
    const m = light.matrixWorld.elements;
    const k = light.intensity;
    const color = [light.color.r * k, light.color.g * k, light.color.b * k];
    const on = light.visible;
    if (kind === 'directional') {
      // Toward the light: against the way its light travels.
      const d = direction ?? [0, -1, 0];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
      out.push({ id, kind, on, position: [m[12]!, m[13]!, m[14]!], direction: [-d[0]! / l, -d[1]! / l, -d[2]! / l], color, range: 0, cone: 0, penumbra: 0 });
      return;
    }
    const spot = kind === 'spot' ? (light as THREE.SpotLight) : null;
    // A spot's axis: toward its target (a child of the light, placed and turned with it).
    let axis = [0, -1, 0];
    if (spot !== null) {
      const t = spot.target.matrixWorld.elements;
      const a = [t[12]! - m[12]!, t[13]! - m[13]!, t[14]! - m[14]!];
      const l = Math.hypot(a[0]!, a[1]!, a[2]!);
      if (l > 1e-9) axis = [a[0]! / l, a[1]! / l, a[2]! / l];
    }
    out.push({
      id,
      kind,
      on,
      position: [m[12]!, m[13]!, m[14]!],
      direction: axis,
      color,
      range: (light as THREE.PointLight).distance ?? 0,
      cone: spot === null ? 0 : Math.cos(spot.angle),
      penumbra: spot?.penumbra ?? 0,
    });
  });
  return out;
}
