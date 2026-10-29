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
 * - **Which lights.** Every realized point and spot light (`drawsClustered`),
 *   every area light (rect and line), the effects' lights. A light's shadow
 *   is its tiles of the shared shadow atlas (`shadow-atlas.ts`): a spot's
 *   one, a point light's six faces, an area light's five (six when it
 *   lights both sides), sampled through the shadow record its light record
 *   names. A spot's cookie is its tile of the cookie atlas
 *   (`cookie-atlas.ts`, the light tables' texture), projected through its
 *   shadow record's matrix. three draws none of them: no light node, shadow
 *   map or cookie texture per light.
 * - **The loop.** The pixel's cell from its view position through the lists'
 *   projection (`clusterCellAt`), then each listed record: a range test,
 *   then per kind the material's own lighting model, as three's lights call
 *   it. A point or spot light: three's distance attenuation (with its
 *   window toward the light's range, none for a light without one), a
 *   spot's cone as three's `smoothstep`, its cookie's colour inside its
 *   projection (as three's `SpotLight.map`), and `direct`. An area light:
 *   three's rectangle light maths (`cluster-area.ts`). A shadowed light is
 *   multiplied by its shadow: the pixel (moved along its normal by a share
 *   of its distance, against acne) into its tile (a spot's through its
 *   record's matrix; a point or area light's on the face it lies farthest
 *   along, as `shadow-cube.ts` picks it), four hardware depth compares
 *   2 × 2 a texel apart, clamped a texel inside the tile, the result faded
 *   by the record's strength (1 outside the tile's view). The light-layer
 *   and room test runs per
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
 *   light does). Five flags shape it (the lit programs' key): `layered`,
 *   `areas` (the area kinds' code), `uncached` (a reading build's separate
 *   sums), `shadows` (the atlas's reads and their texture unit) and
 *   `cookies` (the cookie reads), each built only while a light needs it.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { LIGHT_LAYERS_ALL } from '@thirdlight/runtime';

import { ltcNodes, shadeAreaLight } from './cluster-area';
import { CLUSTER_POINT, CLUSTER_RECT, CLUSTER_SPOT, CLUSTER_TWO_SIDED, CLUSTER_UNBOUNDED, CLUSTER_UNCACHED } from './cluster-build';
import { clusterCellAt, clusterIndexAt, clusterLightTexel, clusterList, clusterNodes, clusterTexel, type ClusterGpu, type ClusterNodes } from './cluster-gpu';
import { CLUSTER_DECAY_STEPS, CLUSTER_KIND_STEP, CLUSTER_ROOM_SHIFT } from './cluster-pack';
import { COOKIE_ATLAS_SIDE, COOKIE_COLUMNS, COOKIE_TILE } from './cookie-atlas';
import type { N } from './effects-tsl';
import { objectLightLayers, ROOM_ATTRIBUTE, ROOM_KEY, SURFACE_ANCHOR } from './light-layers';

const TSL: N = TSLTyped;
const { If, Loop, NodeUpdateType, abs, attribute, clamp, dot, float, getDistanceAttenuation, int, mix, normalView, positionView, round, select, smoothstep, uniform, vec2, vec3, vec4, viewZToLogarithmicDepth } = TSL;

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
  /** Some listed light casts a shadow: the loop reads the shadow atlas (part of the key; one texture unit). */
  shadows = false;
  /** Some spot projects a cookie: the loop reads the cookie atlas (part of the key; the light tables' unit). */
  cookies = false;

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

type LocalLight = { isPointLight?: boolean; isSpotLight?: boolean };

/** Whether a realized light is drawn through the clusters: every point and spot light (three draws none of them). */
export function drawsClustered(light: unknown): boolean {
  const l = light as LocalLight | null;
  return l !== null && (l.isPointLight === true || l.isSpotLight === true);
}

/** The depth compared at a tile: `depth` with the record's bias, three's convention (added; the other way round when reversed). */
function biased(builder: N, depth: N, bias: N): N {
  return (builder.renderer.reversedDepthBuffer === true ? depth.sub(bias) : depth.add(bias)).toVar();
}

/** Four hardware depth compares 2 × 2 a texel apart round `uv`, clamped a texel inside the tile from `corner` across `size` (shares of the atlas). */
function atlasPcf(t: ClusterNodes, uv: N, corner: N, size: N, ref: N): N {
  const texel = t.extent.w;
  const lo = corner.add(texel);
  const hi = corner.add(size).sub(texel);
  const half = texel.mul(0.5);
  const tap = (dx: number, dy: number): N => t.atlas.sample(clamp(uv.add(vec2(half.mul(dx), half.mul(dy))), lo, hi)).compare(ref);
  return tap(-1, -1).add(tap(1, -1)).add(tap(-1, 1)).add(tap(1, 1)).mul(0.25);
}

/** A spot's record at texel `at` (an int node) applied to view position `p` (vec4): the atlas place, not yet over w. */
function spotProject(t: ClusterNodes, at: N, p: N): N {
  return vec4(dot(clusterTexel(t, at), p), dot(clusterTexel(t, at.add(1)), p), dot(clusterTexel(t, at.add(2)), p), dot(clusterTexel(t, at.add(3)), p)).toVar();
}

/**
 * A spot light's shadow at view position `surface` (`distance` from the
 * light): its shadow record from texel `at` (an int node), 1 where lit, 0
 * where shadowed, faded by the record's strength.
 */
function spotShadow(builder: N, t: ClusterNodes, at: N, surface: N, distance: N): N {
  const tile = clusterTexel(t, at.add(4));
  const params = clusterTexel(t, at.add(5));
  const c = spotProject(t, at, vec4(surface.add(normalView.mul(params.w.mul(distance))), 1));
  const w = c.w.max(1e-6);
  const uv = c.xy.div(w).toVar();
  const reversed = builder.renderer.reversedDepthBuffer === true;
  const depth = builder.renderer.logarithmicDepthBuffer === true ? viewZToLogarithmicDepth(c.w.negate(), params.x, params.y) : c.z.div(w);
  const ref = biased(builder, depth, params.z);
  const lit = atlasPcf(t, uv, tile.xy, tile.z, ref);
  const inTile = uv.x.greaterThanEqual(tile.x).and(uv.y.greaterThanEqual(tile.y)).and(uv.x.lessThanEqual(tile.x.add(tile.z))).and(uv.y.lessThanEqual(tile.y.add(tile.z)));
  const inDepth = c.w.greaterThan(0).and(reversed ? ref.greaterThanEqual(0) : ref.lessThanEqual(1));
  return select(inTile.and(inDepth), mix(float(1), lit, tile.w), float(1));
}

/**
 * The shadow of a light seen through faces (a point or area light) at view
 * position `surface` (`distance` from the light): its record from texel
 * `at`, the face the pixel lies farthest along (`cubeFaceOf` in
 * `shadow-cube.ts`, line for line), 1 where lit, 0 where shadowed, faded by
 * the record's strength; 1 past the faces' depth range or on a face without
 * a tile.
 */
function cubeShadow(builder: N, t: ClusterNodes, at: N, surface: N, distance: N): N {
  const params = clusterTexel(t, at.add(3));
  const terms = clusterTexel(t, at.add(4));
  const p = vec4(surface.add(normalView.mul(params.w.mul(distance))), 1).toVar();
  const l = vec3(dot(clusterTexel(t, at), p), dot(clusterTexel(t, at.add(1)), p), dot(clusterTexel(t, at.add(2)), p)).toVar();
  const a = abs(l).toVar();
  const onX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z)).toVar();
  const onY = a.y.greaterThan(a.x).and(a.y.greaterThanEqual(a.z)).toVar();
  const face = select(onX, select(l.x.greaterThan(0), int(0), int(1)), select(onY, select(l.y.greaterThan(0), int(2), int(3)), select(l.z.greaterThan(0), int(4), int(5)))).toVar();
  const d = select(onX, a.x, select(onY, a.y, a.z)).max(1e-6).toVar();
  // The point's place on the face's image (x right, y up), as its camera sees it.
  const sx = select(onX, l.z.mul(select(l.x.greaterThan(0), float(-1), float(1))), select(onY, l.x, l.x.mul(select(l.z.greaterThan(0), float(1), float(-1)))));
  const sy = select(onX, l.y.negate(), select(onY, l.z.mul(select(l.y.greaterThan(0), float(1), float(-1))), l.y.negate()));
  const pair = clusterTexel(t, at.add(5).add(face.div(2)));
  const corner = select(face.mod(2).equal(0), pair.xy, pair.zw).toVar();
  const size = terms.w;
  // As the face's tile holds it: its texture coordinates from the top left.
  const uv = corner.add(vec2(sx.div(d).mul(0.5).add(0.5), sy.div(d).mul(-0.5).add(0.5)).mul(size)).toVar();
  const depth = builder.renderer.logarithmicDepthBuffer === true ? viewZToLogarithmicDepth(d.negate(), params.x, params.y) : terms.x.add(terms.y.div(d));
  const ref = biased(builder, depth, params.z);
  const lit = atlasPcf(t, uv, corner, size, ref);
  const inRange = d.greaterThanEqual(params.x).and(d.lessThanEqual(params.y)).and(corner.x.greaterThanEqual(0));
  return select(inRange, mix(float(1), lit, terms.z), float(1));
}

/**
 * A spot's cookie at view position `surface`: tile `tile` (an int node) of
 * the cookie atlas sampled where the spot's projection (its shadow record
 * from texel `at`) puts the pixel, as three's `SpotLight.map` is: inside the
 * projection only (the light's colour unchanged outside).
 */
function spotCookie(t: ClusterNodes, at: N, tile: N, surface: N): N {
  const rect = clusterTexel(t, at.add(4));
  const params = clusterTexel(t, at.add(5));
  const c = spotProject(t, at, vec4(surface, 1));
  const local = c.xy.div(c.w.max(1e-6)).sub(rect.xy).div(rect.z).toVar();
  const inside = local.x.greaterThanEqual(0).and(local.y.greaterThanEqual(0)).and(local.x.lessThanEqual(1)).and(local.y.lessThanEqual(1)).and(c.w.greaterThanEqual(params.x)).and(c.w.lessThanEqual(params.y));
  const share = COOKIE_TILE / COOKIE_ATLAS_SIDE;
  const half = 0.5 / COOKIE_TILE;
  const origin = vec2(float(tile.mod(COOKIE_COLUMNS)), float(tile.div(COOKIE_COLUMNS))).mul(share);
  const colour = t.tables.sample(origin.add(clamp(local, vec2(half), vec2(1 - half)).mul(share))).level(float(0)).rgb;
  return select(inside, colour, vec3(1));
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
  private readonly ltc: ReturnType<typeof ltcNodes>;

  constructor(readonly light: ClusteredLights) {
    super();
    this.t = clusterNodes(light.gpu);
    this.ltc = ltcNodes(this.t);
    this.objectLayers = uniform(LIGHT_LAYERS_ALL).onObjectUpdate(({ object }: { object: THREE.Object3D }) => objectLightLayers(object));
    this.objectRoom = uniform(-1).onObjectUpdate(({ object }: { object: THREE.Object3D }) => objectRoom(object));
    this.updateType = NodeUpdateType.RENDER;
  }

  update(): void {
    this.t.sync(this.light.gpu);
  }

  /** An area light's shadow (its record from `record`, -1: none) at `surface`, in a variable set only where it has one. */
  private areaShadow(builder: N, record: N, surface: N, distance: N): N {
    const shade = float(1).toVar();
    If(record.greaterThanEqual(0), () => {
      shade.assign(cubeShadow(builder, this.t, int(record), surface, distance));
    });
    return shade;
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
    const shadows = this.light.shadows;
    const cookies = this.light.cookies;
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
        // Most listed lights miss the pixel (a cell is larger than a pixel): only the first texel is read for them.
        If(distance.lessThan(r0.w), () => {
          const r1 = clusterLightTexel(t, index, 1).toVar();
          const field = int(r1.w).toVar();
          const kind = field.bitAnd(3);
          // Each light's terms on their own where the cache's lights and the others are summed apart.
          const one = uncachedSums !== null ? { directDiffuse: vec3(0).toVar(), directSpecular: vec3(0).toVar() } : { directDiffuse: diffuse, directSpecular: specular };
          const sinkBefore = uncachedSums !== null && uncachedSums.modelSink !== null ? vec3(uncachedSums.modelSink).toVar() : null;
          const gate = (): N | null => (layered ? this.layerTest(builder, clusterLightTexel(t, index, 2).w) : null);
          const pointOrSpot = (): void => {
            const decay = float(field.div(CLUSTER_KIND_STEP)).div(CLUSTER_DECAY_STEPS);
            const cutoff = select(field.bitAnd(CLUSTER_UNBOUNDED).notEqual(0), float(0), r0.w);
            const direction = toLight.div(distance.max(1e-6)).toVar();
            const colour = r1.xyz.mul(getDistanceAttenuation({ lightDistance: distance, cutoffDistance: cutoff, decayExponent: decay })).toVar();
            const g = gate();
            if (g !== null) colour.mulAssign(g);
            If(kind.equal(CLUSTER_SPOT), () => {
              const r2 = clusterLightTexel(t, index, 2);
              const r3 = clusterLightTexel(t, index, 3).toVar();
              // t2 holds the way it shines; three's cone compares the way back to the light.
              colour.mulAssign(smoothstep(r3.x, r3.y, direction.dot(r2.xyz.negate())));
              // Outside its cone (most of a spot's reach) a spot lights nothing: no cookie, shadow or lighting model.
              if (cookies || shadows)
                If(colour.x.add(colour.y).add(colour.z).greaterThan(0), () => {
                  if (cookies)
                    If(r3.z.greaterThanEqual(0), () => {
                      colour.mulAssign(spotCookie(t, int(r3.w), int(r3.z), surface));
                    });
                  if (shadows)
                    If(r3.w.greaterThanEqual(0), () => {
                      colour.mulAssign(spotShadow(builder, t, int(r3.w), surface, distance));
                    });
                });
            }).Else(() => {
              if (shadows) {
                const record = clusterLightTexel(t, index, 3).w.toVar();
                If(record.greaterThanEqual(0), () => {
                  colour.mulAssign(cubeShadow(builder, t, int(record), surface, distance));
                });
              }
            });
            If(colour.x.add(colour.y).add(colour.z).greaterThan(0), () => {
              lightingModel.direct({ lightDirection: direction, lightColor: colour, lightNode: { light: {}, shadowNode: null }, reflectedLight: one }, builder);
            });
          };
          // Without area lights the lists hold none: the point and spot kinds alone.
          if (!areas) If(kind.lessThan(CLUSTER_RECT), pointOrSpot);
          else
            If(kind.lessThan(CLUSTER_RECT), pointOrSpot).Else(() => {
              const r2 = clusterLightTexel(t, index, 2).toVar();
              const r3 = clusterLightTexel(t, index, 3).toVar();
              const layerGate = layered ? this.layerTest(builder, r2.w) : null;
              const shade = shadows ? this.areaShadow(builder, r3.w, surface, distance) : null;
              const areaGate = shade === null ? layerGate : layerGate === null ? shade : layerGate.mul(shade);
              shadeAreaLight({ builder, ltc, centre: r0.xyz, reach: r0.w, colour: r1.xyz, u: r2.xyz, v: r3.xyz, twoSided: field.bitAnd(CLUSTER_TWO_SIDED).notEqual(0), toLight, distance, gate: areaGate, reflectedLight: one });
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
