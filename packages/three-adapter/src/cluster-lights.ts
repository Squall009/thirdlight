/**
 * The local lights as ONE light: every point, spot and area light and every
 * effect light the clusters list (`cluster-frame.ts` gathers, builds and
 * uploads them) is shaded by a single light node that loops over the
 * pixel's cell's list, on WebGPU and WebGL 2 alike.
 *
 * three.js unrolls a node per light into every lit program and keys the
 * program by the set of lights: sixteen lamps made sixteen copies of the
 * light code in every shader, and a lamp added, switched or turned plain or
 * layered built every lit program again. Here the scene holds one
 * `ClusteredLights` object whose node three builds into every lit material
 * like any light's (standard, Lambert, graph PBR and custom-lit, layered,
 * terrain, kit, foliage, water, decals, instanced and skinned draws), and
 * the renderer's lights node (`probe-lighting.ts`) leaves the point and spot
 * lights it draws out of three's own list, so their count, their switching
 * and their values never shape a program.
 *
 * - **Which lights.** A point or spot light that casts no shadow and
 *   projects no cookie (`drawsClustered`); every area light (rect and line);
 *   the effects' lights. A point or spot light with a shadow or a cookie is
 *   still drawn by three's own node with its own map, until those move to
 *   the shared atlases; the gathering leaves it out of the lists, so nothing
 *   is lit twice.
 * - **The loop.** The pixel's cell from its view position through the lists'
 *   projection (`clusterCellAt`), then each listed record: a range test,
 *   then per kind the material's own lighting model, as three's lights call
 *   it. A point or spot light: three's distance attenuation (with its window
 *   toward the light's range, none for a light without one), a spot's cone
 *   as three's `smoothstep`, and `direct`. An area light: three's rectangle
 *   light maths (`cluster-area.ts`). The light-layer and room test runs per
 *   pixel against the drawn object's layers and room (per-object uniforms; a
 *   mesh spanning rooms per vertex), and is built only while some listed
 *   light is layered (`layered`, part of the lit programs' key).
 * - **Surfaces reading the surface cache** (`surface-cache-read.ts`) build
 *   the same loop: the cache holds the diffuse light of the scene's lights,
 *   so the reading build keeps only their highlights, and their unshadowed
 *   diffuse light for the cache's visibility ratio; an effect's light
 *   (`CLUSTER_UNCACHED`) is not in the cache and goes whole to the sums the
 *   build hands in (`UNCACHED_LIGHT_CONTEXT`).
 * - **Program shape.** One whatever the number of lights: the object is in
 *   the scene while any local light or effect light pool is there (the
 *   first one builds the lit programs once, as any first light did), and its
 *   textures are rebound when they are made again (`rebind`, as the probe
 *   light does). Three flags shape it (the lit programs' key): `layered`,
 *   `areas` (the area kinds' code) and `uncached` (a reading build's
 *   separate sums), each built only while a light needs it.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { LIGHT_LAYERS_ALL } from '@thirdlight/runtime';

import { ltcNodes, shadeAreaLight } from './cluster-area';
import { CLUSTER_RECT, CLUSTER_SPOT, CLUSTER_TWO_SIDED, CLUSTER_UNBOUNDED, CLUSTER_UNCACHED } from './cluster-build';
import { clusterCellAt, clusterIndexAt, clusterLightTexel, clusterList, clusterNodes, type ClusterGpu, type ClusterNodes } from './cluster-gpu';
import { CLUSTER_DECAY_STEPS, CLUSTER_KIND_STEP, CLUSTER_ROOM_SHIFT } from './cluster-pack';
import type { N } from './effects-tsl';
import { objectLightLayers, ROOM_ATTRIBUTE, ROOM_KEY, SURFACE_ANCHOR } from './light-layers';

const TSL: N = TSLTyped;
const { If, Loop, NodeUpdateType, attribute, float, getDistanceAttenuation, int, positionView, round, select, smoothstep, uniform, vec3 } = TSL;

/**
 * `builder.context[UNCACHED_LIGHT_CONTEXT]`: set by a build reading the
 * surface cache while its local lights build: the sums the lights the cache
 * does not hold go to (the reading build keeps them whole, and only the
 * highlights of the others).
 */
export const UNCACHED_LIGHT_CONTEXT = 'tlUncachedLight';

/** A diffuse and a specular sum (vec3 variables). */
export interface LightSums {
  readonly diffuse: N;
  readonly specular: N;
  /** Where the build's lighting model puts diffuse light of its own accord (a custom-lit graph's), or null. */
  readonly modelSink: N | null;
}

/** The clustered local lights in the scene: its node reads the lists `gpu` holds. */
export class ClusteredLights extends THREE.Light {
  readonly isClusteredLights = true;
  /** Some listed light lights fewer than every layer, or only its room: the loop tests each record (part of the lit programs' key). */
  layered = false;
  /**
   * Some area light is realized: the loop draws the area kinds (part of the
   * key). Their code in the loop costs every lit pixel of a scene without
   * one (registers and size; 0.5–1.5 ms on the Iris Xe at the cap), so it is
   * built only while one is there.
   */
  areas = false;
  /** Some light the surface cache does not hold (an effect light pool) is in the scene: a reading build sums those apart (part of the key). */
  uncached = false;

  constructor(public gpu: ClusterGpu) {
    super(0xffffff, 1);
    this.name = 'clustered lights';
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    // As the probe light: three binds an unchanged object's textures again (WebGL 2) only when a light's data
    // changes, and a shadow map's size is that data; the textures' revision stands in for it. It casts nothing.
    this.castShadow = true;
    (this as unknown as { shadow: { mapSize: { width: number; height: number } } }).shadow = { mapSize: { width: 0, height: 0 } };
  }

  /** Make every lit object take the current textures again (after they were made again, or the renderer changed). */
  rebind(): void {
    (this as unknown as { shadow: { mapSize: { width: number } } }).shadow.mapSize.width = this.gpu.revision;
  }
}

/** Whether `light` is the clustered lights' object. */
export function isClusteredLights(light: unknown): light is ClusteredLights {
  return (light as { isClusteredLights?: boolean } | null)?.isClusteredLights === true;
}

type LocalLight = { isPointLight?: boolean; isSpotLight?: boolean; castShadow?: boolean; map?: unknown };

/** Whether a realized point or spot light is drawn through the clusters: no shadow and no cookie (those keep three's own node). */
export function drawsClustered(light: unknown): boolean {
  const l = light as LocalLight | null;
  if (l === null || (l.isPointLight !== true && l.isSpotLight !== true)) return false;
  return l.castShadow !== true && (l.map ?? null) === null;
}

/** The drawn object's room key (-1: none, every light lights it). */
function objectRoom(o: THREE.Object3D): number {
  return (o.userData[ROOM_KEY] as number | undefined) ?? -1;
}

class ClusterLightsNode extends (THREE.Node as unknown as new () => { updateType: string; [k: string]: unknown }) {
  static get type(): string {
    return 'ClusterLightsNode';
  }
  readonly isClusterLightsNode = true;
  private readonly t: ClusterNodes;
  private readonly objectLayers: N;
  private readonly objectRoom: N;
  private readonly ltc = ltcNodes();

  constructor(readonly light: ClusteredLights) {
    super();
    this.t = clusterNodes(light.gpu);
    this.objectLayers = uniform(LIGHT_LAYERS_ALL).onObjectUpdate(({ object }: { object: THREE.Object3D }) => objectLightLayers(object));
    this.objectRoom = uniform(-1).onObjectUpdate(({ object }: { object: THREE.Object3D }) => objectRoom(object));
    this.updateType = NodeUpdateType.RENDER;
  }

  update(): void {
    this.t.sync(this.light.gpu);
  }

  /** 1 where a record's layer word lets it light this pixel's object (its layers, and its room or the vertex's), else 0. */
  private layerTest(builder: N, word: N): N {
    const w = int(word);
    const layers = w.bitAnd(int(this.objectLayers)).bitAnd((1 << CLUSTER_ROOM_SHIFT) - 1);
    const lightRoom = w.shiftRight(CLUSTER_ROOM_SHIFT).sub(1);
    // A mesh spanning rooms carries the room each face looks into per vertex.
    const room = builder.hasGeometryAttribute(ROOM_ATTRIBUTE) === true ? int(round(attribute(ROOM_ATTRIBUTE, 'float'))) : int(this.objectRoom);
    const roomOk = lightRoom.lessThan(0).or(room.lessThan(0)).or(room.equal(lightRoom));
    return select(layers.notEqual(0).and(roomOk), float(1), float(0));
  }

  setup(builder: N): void {
    const t = this.t;
    const { lightingModel, reflectedLight } = builder.context;
    const surface = builder.context.positionView ?? positionView;
    const layered = this.light.layered;
    const areas = this.light.areas;
    const ltc = this.ltc;
    // A build reading the surface cache: the lights the cache does not hold go to its own sums (kept whole there).
    const uncachedSums = this.light.uncached ? ((builder.context[UNCACHED_LIGHT_CONTEXT] as LightSums | undefined) ?? null) : null;
    const diffuse = vec3(0).toVar('tlClusterLightsDiffuse');
    const specular = vec3(0).toVar('tlClusterLightsSpecular');
    const cell = clusterCellAt(t, surface).toVar('tlClusterLightsCell');
    // The surface values in the condition: set before the branch, so lights built after this node read them.
    If(cell.greaterThanEqual(0).and(SURFACE_ANCHOR), () => {
      const { at, count } = clusterList(t, cell, 'tlClusterLights');
      Loop(count, ({ i }: { i: N }) => {
        const index = clusterIndexAt(t, at.add(i)).toVar();
        const r0 = clusterLightTexel(t, index, 0);
        const toLight = r0.xyz.sub(surface).toVar();
        const distance = toLight.length().toVar();
        const r1 = clusterLightTexel(t, index, 1);
        const field = int(r1.w).toVar();
        const kind = field.bitAnd(3);
        // Without area lights the lists hold none: the point and spot kinds alone.
        If(areas ? distance.lessThan(r0.w) : distance.lessThan(r0.w).and(kind.lessThan(CLUSTER_RECT)), () => {
          const r2 = clusterLightTexel(t, index, 2);
          const r3 = clusterLightTexel(t, index, 3);
          const gate = layered ? this.layerTest(builder, r2.w) : null;
          // Each light's terms on their own where the cache's lights and the others are summed apart.
          const one = uncachedSums !== null ? { directDiffuse: vec3(0).toVar(), directSpecular: vec3(0).toVar() } : { directDiffuse: diffuse, directSpecular: specular };
          const sinkBefore = uncachedSums !== null && uncachedSums.modelSink !== null ? vec3(uncachedSums.modelSink).toVar() : null;
          const pointOrSpot = (): void => {
            const decay = float(field.div(CLUSTER_KIND_STEP)).div(CLUSTER_DECAY_STEPS);
            const cutoff = select(field.bitAnd(CLUSTER_UNBOUNDED).notEqual(0), float(0), r0.w);
            const direction = toLight.div(distance.max(1e-6)).toVar();
            const colour = r1.xyz.mul(getDistanceAttenuation({ lightDistance: distance, cutoffDistance: cutoff, decayExponent: decay })).toVar();
            If(kind.equal(CLUSTER_SPOT), () => {
              // t2 holds the way it shines; three's cone compares the way back to the light.
              colour.mulAssign(smoothstep(r3.x, r3.y, direction.dot(r2.xyz.negate())));
            });
            if (gate !== null) colour.mulAssign(gate);
            lightingModel.direct({ lightDirection: direction, lightColor: colour, lightNode: { light: {}, shadowNode: null }, reflectedLight: one }, builder);
          };
          if (!areas) pointOrSpot();
          else
            If(kind.lessThan(CLUSTER_RECT), pointOrSpot).Else(() => {
              shadeAreaLight({ builder, ltc, centre: r0.xyz, reach: r0.w, colour: r1.xyz, u: r2.xyz, v: r3.xyz, twoSided: field.bitAnd(CLUSTER_TWO_SIDED).notEqual(0), toLight, distance, gate, reflectedLight: one });
            });
          if (uncachedSums !== null) {
            const uncached = field.bitAnd(CLUSTER_UNCACHED).notEqual(0);
            const u = select(uncached, float(1), float(0));
            diffuse.addAssign(one.directDiffuse.mul(u.oneMinus()));
            specular.addAssign(one.directSpecular.mul(u.oneMinus()));
            uncachedSums.diffuse.addAssign(one.directDiffuse.mul(u));
            uncachedSums.specular.addAssign(one.directSpecular.mul(u));
            if (sinkBefore !== null && uncachedSums.modelSink !== null) {
              // Moved out of the model's own sink: the reading build puts that sink back where the cache was found.
              const moved = vec3(uncachedSums.modelSink).sub(sinkBefore).mul(u).toVar();
              uncachedSums.modelSink.subAssign(moved);
              uncachedSums.diffuse.addAssign(moved);
            }
          }
        });
      });
    });
    reflectedLight.directDiffuse.addAssign(diffuse);
    reflectedLight.directSpecular.addAssign(specular);
  }
}

/** Whether a light node is the clustered lights' node. */
export function isClusterLightsNode(n: unknown): boolean {
  return (n as { isClusterLightsNode?: boolean } | null)?.isClusterLightsNode === true;
}

/** Teach a renderer the clustered lights. */
export function registerClusteredLights(renderer: { library: { addLight(node: unknown, light: unknown): void } }): void {
  renderer.library.addLight(ClusterLightsNode, ClusteredLights);
}
