/**
 * The light clusters of a frame: the local lights gathered, one grid built
 * and packed per drawing camera (`cluster-build.ts`, `cluster-pack.ts`),
 * and the camera drawn now uploaded (`cluster-gpu.ts`), every frame, on
 * both renderers alike.
 *
 * - **The lights.** Every realized point and spot light that is on and the
 *   clusters draw (`drawsClustered`: no shadow, no cookie), and every area
 *   light of the realized entities, unless it is hidden, held by a bake, or
 *   in a room no portal shows. Point and spot lights are read from their
 *   three.js lights (scripts move, dim and switch them there); area lights
 *   from their entities, their list every `DOC_LIGHTS_MS` and their place
 *   every frame.
 * - **The light that draws them** (`ClusteredLights`, cluster-lights.ts) is
 *   in the scene while any point or spot light is realized (`syncLight`,
 *   after each selection of the lights), so the first lamp builds the lit
 *   programs once and later ones build nothing.
 * - **One grid per camera**, its builder and packed data kept with it; the
 *   GPU textures (one pair a renderer) take the camera drawn now.
 * - **A budget, not a count**: past `CLUSTER_INDEX_MIB` the lowest-ranked
 *   lights leave the cells that did not fit, and one console warning names
 *   the scenes it happened in.
 * - **Diagnostics** (`renderer.clusters`): lights, packed, indices,
 *   overflow, and the gathering's, build's and upload's main-thread ms and
 *   bytes a frame
 *   (means over the last `CLUSTER_STATS_FRAMES` frames, also on the canvas
 *   as `data-tl-clusters` for pages without another diagnostics surface).
 */
import * as THREE from 'three';
import { LIGHT_LAYERS_ALL, lightLayerMaskOf } from '@thirdlight/runtime';

import type { EntityDoc } from './adapter-entities';
import { DOC_LIGHTS_MS } from './adapter-surface-cache';
import { ClusterBuilder, ClusterLights, CLUSTER_SLICES, CLUSTER_TILES_X, clusterTilesY, type ClusterLightValue } from './cluster-build';
import { ClusterGpu, type ClusterUploadRenderer } from './cluster-gpu';
import { ClusterHeatLight } from './cluster-heat';
import { ClusteredLights, drawsClustered } from './cluster-lights';
import { CLUSTER_INDEX_MIB, CLUSTER_INDEX_WORDS, ClusterTextures } from './cluster-pack';
import { isLayeredLight, roomKeyOf } from './light-layers';
import type { SceneLights } from './lights-shadows';
import { lightReachOf } from './surface-changes';

/** Frames the diagnostics' means are taken over. */
export const CLUSTER_STATS_FRAMES = 60;

/** What the clusters did, as the diagnostics report it (means over the last `CLUSTER_STATS_FRAMES` frames). */
export interface ClusterDiagnostics {
  /** Local lights handed in (not hidden, not baked, in a room shown), packed (in view), and the cells' list entries. */
  readonly lights: number;
  readonly packed: number;
  readonly indices: number;
  /** Lights left out of some cell they reach (the list budget was full). */
  readonly overflow: number;
  /** Main-thread ms a frame: gathering the lights, building and packing the lists, and uploading them. */
  readonly gatherMs: number;
  readonly buildMs: number;
  readonly uploadMs: number;
  /** Bytes uploaded a frame. */
  readonly uploadBytes: number;
  /** The grid (tiles across, tiles up, slices) and the packed texture's rows. */
  readonly grid: readonly [number, number, number];
  readonly rows: number;
  /** Whether the heat map is drawn. */
  readonly heatView: boolean;
}

export interface AdapterClustersDeps {
  readonly scene: THREE.Scene;
  readonly lights: SceneLights;
  readonly docs: ReadonlyMap<string, EntityDoc>;
  readonly graph: { worldMatrixOf(id: string, out: THREE.Matrix4): boolean; node(id: string): THREE.Object3D | undefined };
  readonly hidden: () => ReadonlySet<string>;
  readonly roomSeen: (key: number | undefined) => boolean;
  readonly bakedLight: (id: string) => boolean;
  /** The scenes loaded now (the overflow warning names them). */
  readonly sceneNames: () => readonly string[];
  readonly canvas: { setAttribute?(name: string, value: string): void } | null;
  /** The view's programs changed (the heat map went on or off): built ahead, and drawn again. */
  readonly shadingChanged: () => void;
}

interface ClusterView {
  readonly builder: ClusterBuilder;
  readonly textures: ClusterTextures;
  /** Lights the last pack wrote (none twice: nothing to write or send). */
  packed: number;
}

/** An area light's document, as the gathering reads it. */
interface AreaDoc {
  readonly id: string;
  readonly light: { color?: string; intensity?: number; range?: number; shape?: string; width?: number; height?: number; twoSided?: boolean; lightMask?: number };
}

/** A light value written in place for each light (nothing allocated per light and frame). */
function scratchValue(): ClusterLightValue & { position: Float64Array; color: Float64Array; direction: Float64Array; u: Float64Array; v: Float64Array } {
  return { kind: 'point', position: new Float64Array(3), reach: 0, color: new Float64Array(3), direction: new Float64Array(3), u: new Float64Array(3), v: new Float64Array(3), decay: 2, cosOuter: -1, cosInner: -1, mask: LIGHT_LAYERS_ALL, room: -1, shadow: -1, cookie: -1, visible: true, twoSided: false, unbounded: false };
}

export class AdapterClusters {
  private readonly input = new ClusterLights();
  private readonly views = new WeakMap<THREE.Camera, ClusterView>();
  /** The lists on the renderer drawn last (made again for another renderer). */
  private gpu = new ClusterGpu(new ClusterTextures());
  private gpuRenderer: unknown = null;
  /** The light whose node draws the clustered lights (in the scene while any point or spot light is realized). */
  private light: ClusteredLights | null = null;
  private readonly heat: { wanted: boolean; light: ClusterHeatLight | null } = { wanted: false, light: null };
  private areas: AreaDoc[] = [];
  private areasAt = -Infinity;
  private readonly value = scratchValue();
  private readonly m = new THREE.Matrix4();
  private readonly viewInverse = new THREE.Matrix4();
  private readonly colour = new THREE.Color();
  private readonly warned = new Set<string>();
  /** The last frame's numbers and the sums toward the next means. */
  private readonly last = { lights: 0, packed: 0, indices: 0, overflow: 0, rows: 1, tilesY: clusterTilesY(16 / 9) };
  private sums = { frames: 0, gatherMs: 0, buildMs: 0, uploadMs: 0, uploadBytes: 0 };
  private means = { gatherMs: 0, buildMs: 0, uploadMs: 0, uploadBytes: 0 };
  private framed = false;
  /** The counts the canvas attribute holds. */
  private readonly written = { lights: -1, packed: -1 };

  constructor(private readonly d: AdapterClustersDeps, heatView = false) {
    this.heat.wanted = heatView;

  }

  /** The heat map on or off (the lighting's debug views). */
  setHeatView(on: boolean): void {
    if (this.heat.wanted === on) return;
    this.heat.wanted = on;
    this.syncHeat();
  }

  get heatView(): boolean {
    return this.heat.wanted;
  }

  /**
   * The clustered lights' object in the scene while any point or spot light is
   * realized, testing layers while any of them is layered (after the lights
   * were selected: realized, released, hidden, or turned plain or layered).
   */
  syncLight(): void {
    // The entities changed: the area lights are read again on the next frame (not only every `DOC_LIGHTS_MS`).
    this.areasAt = -Infinity;
    let any = false;
    let layered = false;
    this.d.lights.forEachLight((_id, kind, light) => {
      if (kind !== 'point' && kind !== 'spot') return;
      any = true;
      if (isLayeredLight(light) && drawsClustered(light)) layered = true;
    });
    if (any && this.light === null) {
      this.light = new ClusteredLights(this.gpu);
      this.light.layered = layered;
      this.d.scene.add(this.light);
      this.d.shadingChanged();
    } else if (!any && this.light !== null) {
      this.light.removeFromParent();
      this.light.dispose();
      this.light = null;
      this.d.shadingChanged();
    } else if (this.light !== null && this.light.layered !== layered) {
      this.light.layered = layered;
      this.d.shadingChanged();
    }
  }

  /** Lights the heat map draws the lists of (0 while it is off). */
  heatLights(): number {
    return this.heat.light !== null ? this.last.packed : 0;
  }

  /** Before the draw (after the view's cull and rooms): the lights gathered, `camera`'s lists built and on the GPU. */
  frame(renderer: ClusterUploadRenderer, camera: THREE.Camera & { near: number; far: number }): void {
    const t0 = performance.now();
    if (this.gpuRenderer !== null && renderer !== this.gpuRenderer) this.dropGpu();
    this.gather(t0);
    const tg = performance.now();
    let view = this.views.get(camera);
    if (view === undefined) {
      view = { builder: new ClusterBuilder(), textures: new ClusterTextures(), packed: -1 };
      this.views.set(camera, view);
    }
    const gpu = this.gpu;
    this.gpuRenderer = renderer;
    camera.updateMatrixWorld();
    this.viewInverse.copy(camera.matrixWorld).invert();
    const input = this.input;
    // No light now nor at the last pack: the headers are all empty already.
    let bytes = 0;
    let t1 = tg;
    if (input.count > 0 || view.packed !== 0) {
      const build = view.builder.build(input, { view: this.viewInverse.elements, projection: camera.projectionMatrix.elements, near: camera.near, far: camera.far }, CLUSTER_INDEX_WORDS);
      const packed = view.textures.pack(build, input);
      view.packed = build.packed;
      t1 = performance.now();
      bytes = gpu.upload(renderer, build.grid, view.textures, packed, camera.projectionMatrix.elements);
      const l = this.last;
      l.lights = build.lights;
      l.packed = build.packed;
      l.indices = build.entries;
      l.overflow = build.overflow;
      l.rows = packed.rows;
      l.tilesY = build.grid.tilesY;
      if (build.overflow > 0) this.warnOverflow(build.overflow);
    } else {
      t1 = performance.now();
      const l = this.last;
      l.lights = l.packed = l.indices = l.overflow = 0;
    }
    this.framed = true;
    if (this.light !== null && this.light.gpu !== gpu) this.light.gpu = gpu;
    this.light?.rebind();
    this.syncHeat();
    this.count(tg - t0, t1 - tg, performance.now() - t1, bytes);
  }

  diagnostics(): ClusterDiagnostics | null {
    if (!this.framed) return null;
    const l = this.last;
    return { lights: l.lights, packed: l.packed, indices: l.indices, overflow: l.overflow, gatherMs: this.means.gatherMs, buildMs: this.means.buildMs, uploadMs: this.means.uploadMs, uploadBytes: this.means.uploadBytes, grid: [CLUSTER_TILES_X, l.tilesY, CLUSTER_SLICES], rows: l.rows, heatView: this.heat.light !== null };
  }

  dispose(): void {
    this.heat.wanted = false;
    this.syncHeat();
    this.light?.removeFromParent();
    this.light?.dispose();
    this.light = null;
    this.gpu.dispose();
  }

  /** The heat map's light in the scene while wanted and the lists are on a GPU; its objects rebind after new textures. */
  private syncHeat(): void {
    const h = this.heat;
    const gpu = this.gpu;
    if (h.wanted && this.gpuRenderer !== null) {
      if (h.light === null) {
        h.light = new ClusterHeatLight(gpu);
        this.d.scene.add(h.light);
        this.d.shadingChanged();
      }
      if (h.light.gpu !== gpu) h.light.gpu = gpu;
      h.light.rebind();
    } else if (h.light !== null) {
      h.light.removeFromParent();
      h.light.dispose();
      h.light = null;
      this.d.shadingChanged();
    }
  }

  /** A new renderer: the textures were the old one's (every camera's lists are sent whole to the new ones). */
  private dropGpu(): void {
    this.gpu.dispose();
    this.gpu = new ClusterGpu(new ClusterTextures());
    this.gpuRenderer = null;
  }

  private count(gatherMs: number, buildMs: number, uploadMs: number, bytes: number): void {
    const s = this.sums;
    s.frames += 1;
    s.gatherMs += gatherMs;
    s.buildMs += buildMs;
    s.uploadMs += uploadMs;
    s.uploadBytes += bytes;
    const l = this.last;
    // The counts are written when they change too: a view drawn only on a change (the editor's) may never reach the means.
    const changed = l.lights !== this.written.lights || l.packed !== this.written.packed;
    if (s.frames < CLUSTER_STATS_FRAMES && !changed) return;
    if (s.frames >= CLUSTER_STATS_FRAMES) {
      this.means = { gatherMs: s.gatherMs / s.frames, buildMs: s.buildMs / s.frames, uploadMs: s.uploadMs / s.frames, uploadBytes: Math.round(s.uploadBytes / s.frames) };
      this.sums = { frames: 0, gatherMs: 0, buildMs: 0, uploadMs: 0, uploadBytes: 0 };
    }
    this.written.lights = l.lights;
    this.written.packed = l.packed;
    this.d.canvas?.setAttribute?.('data-tl-clusters', `${l.lights}|${l.packed}|${l.indices}|${l.overflow}|${this.means.gatherMs.toFixed(3)}|${this.means.buildMs.toFixed(3)}|${this.means.uploadMs.toFixed(3)}|${this.means.uploadBytes}`);
  }

  private warnOverflow(overflow: number): void {
    const names = this.d.sceneNames().join(', ');
    if (this.warned.has(names)) return;
    this.warned.add(names);
    console.warn(`Light clusters: ${overflow} light(s) left out of some cells they reach in ${names === '' ? 'this view' : `scene ${names}`}: the lists' ${CLUSTER_INDEX_MIB} MiB budget is full (the lowest-ranked lights go first).`);
  }

  /** The local lights now, into `input`. */
  private gather(now: number): void {
    const input = this.input;
    input.clear();
    const hidden = this.d.hidden();
    const v = this.value;
    this.d.lights.forEachLight((id, kind, light) => {
      // Three's own node draws a light with a shadow or a cookie.
      if ((kind !== 'point' && kind !== 'spot') || !drawsClustered(light)) return;
      const e = light.matrixWorld.elements;
      const k = light.intensity;
      v.kind = kind;
      v.position[0] = e[12]!;
      v.position[1] = e[13]!;
      v.position[2] = e[14]!;
      v.color[0] = light.color.r * k;
      v.color[1] = light.color.g * k;
      v.color[2] = light.color.b * k;
      const point = light as THREE.PointLight;
      v.reach = lightReachOf(point.distance, v.color);
      v.unbounded = !(point.distance > 0);
      v.decay = point.decay;
      // A layered light lights its layers and its room alone; a plain one lights everything.
      const layered = isLayeredLight(light);
      v.mask = layered ? light.lightMask : LIGHT_LAYERS_ALL;
      v.room = layered ? (roomKeyOf(light) ?? -1) : -1;
      // Off: switched off by the selection (its entity hidden, or past a quality level's budget).
      v.visible = light.visible && !hidden.has(id) && this.d.roomSeen(roomKeyOf(light));
      v.twoSided = false;
      if (kind === 'spot') {
        const s = light as THREE.SpotLight;
        // Its axis: toward its target (a child of the light, placed and turned with it).
        const t = s.target.matrixWorld.elements;
        const ax = t[12]! - e[12]!;
        const ay = t[13]! - e[13]!;
        const az = t[14]! - e[14]!;
        const l = Math.hypot(ax, ay, az) || 1;
        v.direction[0] = ax / l;
        v.direction[1] = ay / l;
        v.direction[2] = az / l;
        v.cosOuter = Math.cos(s.angle);
        v.cosInner = Math.cos(s.angle * (1 - s.penumbra));
      } else {
        v.cosOuter = -1;
        v.cosInner = -1;
      }
      input.add(v);
    });
    if (now - this.areasAt >= DOC_LIGHTS_MS) {
      this.areasAt = now;
      this.readAreas();
    }
    for (const a of this.areas) this.addArea(a, hidden);
  }

  /** The realized entities' area lights (not those a bake holds). */
  private readAreas(): void {
    const out: AreaDoc[] = [];
    for (const [id, e] of this.d.docs) {
      const l = (e.components as { light?: AreaDoc['light'] & { type?: string; mode?: string } } | undefined)?.light;
      if (l?.type !== 'area' || (l.mode === 'baked' && this.d.bakedLight(id))) continue;
      out.push({ id, light: l });
    }
    this.areas = out;
  }

  /** An area light: its rectangle in its entity's local XZ plane, facing local −Y; a line along local X. */
  private addArea(a: AreaDoc, hidden: ReadonlySet<string>): void {
    if (!this.d.graph.worldMatrixOf(a.id, this.m)) return;
    const e = this.m.elements;
    const l = a.light;
    const v = this.value;
    const line = l.shape === 'line';
    const hw = (l.width ?? 1) / 2;
    const hh = line ? 0 : (l.height ?? 0.5) / 2;
    this.colour.set(l.color ?? '#ffffff');
    const k = l.intensity ?? 1;
    v.kind = line ? 'line' : 'rect';
    for (let i = 0; i < 3; i += 1) {
      v.position[i] = e[12 + i]!;
      v.u[i] = e[i]! * hw;
      v.v[i] = e[8 + i]! * hh;
      v.direction[i] = -e[4 + i]!;
    }
    const fl = Math.hypot(v.direction[0]!, v.direction[1]!, v.direction[2]!) || 1;
    for (let i = 0; i < 3; i += 1) v.direction[i] = v.direction[i]! / fl;
    v.color[0] = this.colour.r * k;
    v.color[1] = this.colour.g * k;
    v.color[2] = this.colour.b * k;
    v.reach = lightReachOf(l.range ?? 0, v.color);
    v.decay = 2;
    v.twoSided = l.twoSided === true;
    v.unbounded = false;
    v.mask = lightLayerMaskOf(l.lightMask);
    v.room = -1;
    const node = this.d.graph.node(a.id);
    v.visible = !hidden.has(a.id) && this.d.roomSeen(node === undefined ? undefined : roomKeyOf(node));
    this.input.add(v);
  }
}
