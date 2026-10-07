/**
 * Probe lighting: every lit material takes its indirect light from the
 * loaded probe tiles (probe-grids.ts) inside them, in place of the flat
 * ambient light, and keeps today's ambient light outside every tile.
 *
 * How it reaches every material without touching any: a `ProbeLighting`
 * light in the scene (one per scene adapter, present while any loaded scene
 * has baked probes) has its own light node, which three builds into every
 * lit node material — graph, standard, kit, foliage and water materials,
 * instance sets, block chunks and skinned meshes alike. three's light nodes
 * only add to the lighting context; replacing a term needs an order, so the
 * renderer's lights node (`ProbeOrderedLightsNode`, installed by
 * `registerProbeLighting`) builds, when the probe light is present, first
 * every light the probes do not hold, then remembers the irradiance so far,
 * then the ambient and hemisphere lights the probes hold (baked or mixed:
 * `markProbeHeld`), and the probe node last (after the environment too).
 * Inside a tile the probe node then puts the remembered irradiance plus the probes' in
 * place of the irradiance, drops the environment's diffuse light (the sky is
 * in the probes), and darkens the environment's reflections by how much
 * darker the probes are than what they replace (a closed room does not
 * mirror the sky). Without the probe light nothing changes: a scene without
 * probes builds exactly the programs it built before.
 *
 * The resident tiles (the ones nearest the camera, probe-residency.ts) share
 * one 3D texture (probe-atlas.ts: three's `LightProbeGrid` atlas layout per
 * tile, each in its own region), with a table of the tiles and a spatial
 * index (probe-index.ts). A pixel inside its object's likely tile (per-object
 * uniforms, picked on the CPU through the index) needs no lookup; one
 * outside it looks up its cell of the index and tests the few tiles listed
 * there (where tiles share a face the first one in the table, which holds
 * the same probes there) — constant work a pixel and an object however many
 * tiles are loaded. A frame samples one texture, and a new tile builds no
 * program. Probes hold
 * first-order light (four samples a pixel). The sample keeps to one side of the walls
 * the bake found between probes (`probeSamplePoint`), so light does not leak
 * through a closed wall. Probes are weighted by their validity:
 * the trilinear filter interpolates premultiplied light and weights, so a
 * probe filled from its neighbours inside a wall hardly counts next to valid
 * ones. Outside every tile the probe light fades out over one probe spacing.
 *
 * Lightmapped copies leave the probe light out (`withoutProbeLighting`,
 * node-materials.ts): their lightmap holds their indirect light.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { PROBE_ATLAS_PADDING } from '@thirdlight/runtime';

import type { N } from './effects-tsl';
import { buildVertexLights, localLightsCacheKey, splitLocalLights } from './local-lights';
import { ProbeTileStore, type ResidentProbeTile } from './probe-atlas';
import { PROBE_INDEX_WIDTH, probeRowAt } from './probe-index';
import { PACKED_LIGHT_TEXELS, TABLE_ROW_FLOATS, TABLE_ROWS_PER_LINE, TABLE_TEXELS } from './probe-pack';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Break, If, Loop, NodeUpdateType, float, int, ivec2, luminance, max, mix, normalWorld, positionWorld, property, select, smoothstep, step, texture, texture3D, uniform, vec3, vec4 } = TSL;

/** How far off a surface (a share of the spacing, along its normal) the side of a wall is decided. */
const SIDE_BIAS = 0.05;

/** `light.userData[PROBE_HELD_KEY]`: an ambient or hemisphere light whose light the probes hold (baked or mixed). */
const PROBE_HELD_KEY = '__tlProbeHeld';

/** Mark an ambient or hemisphere light as held by probes (its light is in a probe bake) or not. */
export function markProbeHeld(light: THREE.Light, held: boolean): void {
  if (held) light.userData[PROBE_HELD_KEY] = true;
  else delete light.userData[PROBE_HELD_KEY];
}

/**
 * The probe tiles as one light (not a three.js light kind: only its node
 * knows it). Its store holds the resident tiles on the GPU (probe-atlas.ts).
 */
export class ProbeLighting extends THREE.Light {
  readonly isProbeLighting = true;
  readonly store = new ProbeTileStore();

  constructor() {
    super(0xffffff, 1);
    this.name = 'probe lighting';
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
    // three uploads an unchanged object's per-object uniforms and texture bindings again (WebGL 2) only when
    // a light's data changes; a light's shadow map size is that data ("resizing a shadow map recreates its
    // textures"), so the store's revision stands in for it: a change of the tiles rebinds every lit object
    // once. The light casts nothing (its node makes no shadow).
    this.castShadow = true;
    (this as unknown as { shadow: { mapSize: { width: number; height: number } } }).shadow = { mapSize: { width: 0, height: 0 } };
  }

  /** Make every lit object take the store's current textures and its own tile again (call after a sync). */
  rebind(): void {
    (this as unknown as { shadow: { mapSize: { width: number } } }).shadow.mapSize.width = this.store.revision;
  }

  /** Tiles on the GPU. */
  get count(): number {
    return this.store.count;
  }

  /** The resident tiles in table order (the debug view draws them). */
  get tiles(): readonly ResidentProbeTile[] {
    return this.store.tiles;
  }

  /** A frame was drawn: let go of textures no frame binds any more. */
  frameDrawn(): void {
    this.store.frameDrawn();
  }

  override dispose(): void {
    this.store.dispose();
    super.dispose();
  }
}

const _centre = new THREE.Vector3();

/**
 * Each drawn object's likely tile (the one holding the middle of its bounds,
 * found through the index), as per-object uniforms: a pixel inside it needs
 * no lookup, only one outside it (an object across a tile's face, or outside
 * every tile) looks up the index. Picked once per object and frame; an
 * unchanged object uploads its uniforms again after the tiles changed
 * because the light rebinds every lit object then (`ProbeLighting.rebind`).
 */
class ObjectTile {
  readonly sc: N;
  readonly of: N;
  readonly rs: N;
  private readonly picked = new WeakMap<THREE.Object3D, { frame: number; revision: number; row: number }>();
  constructor(private readonly light: ProbeLighting) {
    const row = (object: THREE.Object3D, frame: number): number => {
      const store = this.light.store;
      const seen = this.picked.get(object);
      if (seen !== undefined && seen.frame === frame && seen.revision === store.revision) return seen.row;
      const g = (object as THREE.Mesh).geometry;
      if (g !== undefined && g.boundingSphere === null) g.computeBoundingSphere();
      _centre.copy(g?.boundingSphere?.center ?? _centre.set(0, 0, 0)).applyMatrix4(object.matrixWorld);
      const r = probeRowAt(store.indexOf, store.boxes, _centre);
      this.picked.set(object, { frame, revision: store.revision, row: r });
      return r;
    };
    const texel = (k: number) => (v: THREE.Vector4, { object, frameId }: { object: THREE.Object3D; frameId?: number }) => {
      const r = row(object, frameId ?? 0);
      if (r < 0) return v.set(0, 0, 0, 0);
      const o = r * TABLE_ROW_FLOATS + k * 4;
      const t = this.light.store.tableData;
      return v.set(t[o]!, t[o + 1]!, t[o + 2]!, t[o + 3]!);
    };
    const update = (k: number): N => {
      const u = uniform(new THREE.Vector4());
      const f = texel(k);
      return u.onObjectUpdate((frame: { object: THREE.Object3D; frameId?: number }) => f(u.value as THREE.Vector4, frame));
    };
    this.sc = update(0);
    this.of = update(1);
    this.rs = update(2);
  }
}

/** The irradiance of the lights the probes do not hold (set by the lights node before the held ones build). */
const KEPT_IRRADIANCE = property('vec3', 'tlProbeKeptIrradiance');

/** First-order spherical harmonics irradiance (the first two bands of three's `getShIrradianceAt`) from the packed light texels. */
function shIrradiance(n: N, s: N[]): N {
  const [s0, s1, s2, s3] = s as [N, N, N, N];
  const k = 2 * 0.511664;
  // Coefficients: band 0, then the y, z and x terms.
  return s0.xyz
    .mul(0.886227)
    .add(s1.xyz.mul(k).mul(n.y))
    .add(vec3(s1.w, s2.xy).mul(k).mul(n.z))
    .add(vec3(s2.zw, s3.x).mul(k).mul(n.x));
}

/** The packed texture's nodes and uniforms one light's node (and the debug view) read. */
export interface ProbeTextureNodes {
  readonly atlas: N;
  readonly table: N;
  /** The spatial index (probe-index.ts): its texture, its grid's corner, 1 / its cell size and its cells per axis. */
  readonly index: N;
  readonly indexOrigin: N;
  readonly indexInvCell: N;
  readonly indexDims: N;
  /** 1 / the packed texture's size. */
  readonly atlasScale: N;
  /** Copy the light's current textures into the nodes. */
  sync(light: ProbeLighting): void;
}

export function probeTextureNodes(light: ProbeLighting): ProbeTextureNodes {
  const s = light.store;
  const nodes: ProbeTextureNodes = {
    atlas: texture3D(s.atlas),
    table: texture(s.table),
    index: texture(s.index),
    indexOrigin: uniform(new THREE.Vector4()),
    indexInvCell: uniform(new THREE.Vector4()),
    indexDims: uniform(new THREE.Vector4()),
    atlasScale: uniform(new THREE.Vector3(1, 1, 1)),
    sync(l) {
      const st = l.store;
      nodes.atlas.value = st.atlas;
      nodes.table.value = st.table;
      nodes.index.value = st.index;
      nodes.indexOrigin.value.set(...st.indexOf.origin, 0);
      nodes.indexInvCell.value.set(...st.indexOf.invCell, 0);
      nodes.indexDims.value.set(...st.indexOf.dims, 0);
      nodes.atlasScale.value.set(1 / st.atlas.image.width, 1 / st.atlas.image.height, 1 / st.atlas.image.depth);
    },
  };
  return nodes;
}

/** Texel `k` of table row `row` (an int node): rows run `TABLE_ROWS_PER_LINE` a line of the table texture. */
export function tableTexel(t: ProbeTextureNodes, row: N, k: number): N {
  const e = row.mul(TABLE_TEXELS).add(k);
  const width = TABLE_ROWS_PER_LINE * TABLE_TEXELS;
  return t.table.load(ivec2(e.mod(width), e.div(width)));
}

/** Texel `e` (an int node) of the index texture. */
function indexTexel(t: ProbeTextureNodes, e: N): N {
  return t.index.load(ivec2(e.mod(PROBE_INDEX_WIDTH), e.div(PROBE_INDEX_WIDTH)));
}

/**
 * A packed texel of a tile's probes at probe coordinates `f` (fractional
 * probe indices) of the tile whose table texels are `of` (offset, nz) and
 * `rs` (nx, ny, its place). Explicit level: the sampling may sit in
 * non-uniform control flow.
 */
function packedTexel(t: ProbeTextureNodes, f: N, of: N, rs: N, texel: number): N {
  const z = f.z.add(PROBE_ATLAS_PADDING + 0.5).add(of.w.add(2 * PROBE_ATLAS_PADDING).mul(texel));
  return t.atlas.sample(vec3(rs.z, rs.w, z).add(vec3(f.xy.add(0.5), 0)).mul(t.atlasScale)).level(float(0));
}

export function samplePackedProbes(t: ProbeTextureNodes, f: N, of: N, rs: N): N[] {
  return Array.from({ length: PACKED_LIGHT_TEXELS }, (_, k) => packedTexel(t, f, of, rs, k));
}

/** Irradiance (validity-weighted) from the packed light texels at a world normal. */
export function packedIrradiance(s: N[], n: N): N {
  return shIrradiance(n, s).div(max(s[0].w, float(1e-4))).max(vec3(0));
}

/**
 * Where to sample the probes (probe coordinates) for a surface at probe
 * coordinates `fp` with world normal `n` in the tile `of`/`rs` (`last`: the
 * last probe's coordinates). Half a spacing along the normal, as three's grid
 * does (a surface reads the probes on its open side) — except across a wall:
 * along each axis the filter interpolates the walls of the four edges of the
 * surface's cell around the sample (from the bake: whether a surface cuts the
 * edge, and where), and where most of them are cut the sample keeps to the
 * probes on the surface's side of the cut. Light outside a closed wall never
 * reaches the inside through the interpolation, nor the back of an object
 * standing by the wall.
 */
function probeSamplePoint(t: ProbeTextureNodes, fp: N, n: N, of: N, rs: N, last: N): N {
  // The side of a cut is decided a little off the surface along its normal: a floor lying on the cut (a probe inside the
  // ground beneath it sees the same surface) belongs to the side it faces.
  const fs = fp.add(n.mul(SIDE_BIAS)).clamp(vec3(0), last);
  const cell = fs.floor().min(last.sub(1));
  const tp = fs.sub(cell);
  const f = fp.add(n.mul(0.5)).clamp(vec3(0), last);
  // (cut x, where x, cut y, where y) and (cut z, where z): the cut flags and shares, interpolated over each axis's
  // plane through the four edges around the sample.
  const ex = packedTexel(t, vec3(cell.x, f.y, f.z), of, rs, PACKED_LIGHT_TEXELS).xy;
  const ey = packedTexel(t, vec3(f.x, cell.y, f.z), of, rs, PACKED_LIGHT_TEXELS).zw;
  const ez = packedTexel(t, vec3(f.x, f.y, cell.z), of, rs, PACKED_LIGHT_TEXELS + 1).xy;
  const axis = (e: N, a: 'x' | 'y' | 'z'): N => select(e.x.greaterThanEqual(0.5), cell[a].add(step(e.y.div(max(e.x, float(1e-4))), tp[a])), f[a]);
  return vec3(axis(ex, 'x'), axis(ey, 'y'), axis(ez, 'z'));
}

/** The light node of `ProbeLighting`: finds the tile, samples it, and replaces the held indirect light. */
class ProbeLightingNode extends (THREE.Node as unknown as new () => { updateType: string; [k: string]: unknown }) {
  static get type(): string {
    return 'ProbeLightingNode';
  }
  readonly isProbeLightingNode = true;
  private readonly t: ProbeTextureNodes;
  private readonly objectTile: ObjectTile;

  constructor(readonly light: ProbeLighting) {
    super();
    this.t = probeTextureNodes(light);
    this.objectTile = new ObjectTile(light);
    this.updateType = NodeUpdateType.RENDER;
  }

  update(): void {
    this.t.sync(this.light);
  }

  setup(builder: N): void {
    const ctx = builder.context;
    const t = this.t;
    const p = positionWorld;
    const bestOut = float(1e30).toVar('tlProbeOut');
    const found = int(0).toVar('tlProbeFound');
    const sc = vec4(0).toVar('tlProbeScale');
    const of = vec4(0).toVar('tlProbeOffset');
    const rs = vec4(0).toVar('tlProbeRes');
    const ot = this.objectTile;
    // The pixel in its object's tile (probe coordinates within the probes): no lookup. Else the pixel's cell
    // of the index lists the tiles reaching into it, in table order: the first holding the pixel, else the
    // nearest (for the fade past a tile's edge).
    const at = p.mul(ot.sc.xyz).add(ot.of.xyz);
    const inObjectTile = at.greaterThanEqual(vec3(0)).all().and(at.lessThanEqual(vec3(ot.rs.x, ot.rs.y, ot.of.w).sub(1)).all()).and(ot.rs.x.greaterThan(0));
    If(inObjectTile, () => {
      bestOut.assign(0);
      found.assign(1);
      sc.assign(ot.sc);
      of.assign(ot.of);
      rs.assign(ot.rs);
    }).Else(() => {
      const cf = p.sub(t.indexOrigin.xyz).mul(t.indexInvCell.xyz).floor();
      const inIndex = cf.greaterThanEqual(vec3(0)).all().and(cf.lessThan(t.indexDims.xyz).all());
      If(inIndex, () => {
        const c = int(cf.x.add(t.indexDims.x.mul(cf.y.add(t.indexDims.y.mul(cf.z)))));
        const head = indexTexel(t, c);
        const start = int(head.x);
        Loop(int(head.y), ({ i }: { i: N }) => {
          const row = int(indexTexel(t, start.add(i)).x);
          const a = tableTexel(t, row, 0);
          const b = tableTexel(t, row, 1);
          const r = tableTexel(t, row, 2);
          const q = p.mul(a.xyz).add(b.xyz);
          // How far outside the tile, in metres.
          const out = max(q.negate(), vec3(0)).add(max(q.sub(vec3(r.x, r.y, b.w).sub(1)), vec3(0))).div(a.xyz).length();
          If(out.lessThan(bestOut), () => {
            bestOut.assign(out);
            found.assign(1);
            sc.assign(a);
            of.assign(b);
            rs.assign(r);
            If(out.lessThanEqual(0), () => {
              Break();
            });
          });
        });
      });
    });
    const w = select(found.greaterThan(0), float(1).sub(smoothstep(float(0), max(sc.w, float(1e-3)), bestOut)), float(0)).toVar('tlProbeWeight');
    const irr = vec3(0).toVar('tlProbeIrradiance');
    If(w.greaterThan(0), () => {
      const last = vec3(rs.x, rs.y, of.w).sub(1);
      const fp = p.mul(sc.xyz).add(of.xyz);
      irr.assign(packedIrradiance(samplePackedProbes(t, probeSamplePoint(t, fp, normalWorld, of, rs, last), of, rs), normalWorld));
    });
    // What the probes replace: the held ambient light and the environment's diffuse light.
    const replaced = ctx.irradiance.sub(KEPT_IRRADIANCE).add(ctx.iblIrradiance);
    const darker = luminance(irr).div(max(luminance(replaced), float(1e-4))).clamp(0, 1);
    ctx.radiance.mulAssign(mix(float(1), darker, w));
    ctx.irradiance.assign(mix(ctx.irradiance, KEPT_IRRADIANCE.add(irr), w));
    ctx.iblIrradiance.mulAssign(w.oneMinus());
  }
}

type LightNodeLike = { readonly isProbeLightingNode?: boolean; readonly light?: THREE.Light; build(builder: unknown): unknown };

const isHeld = (n: LightNodeLike): boolean => n.light?.userData[PROBE_HELD_KEY] === true;

/**
 * The scene's lights node: local lights split per the build's mode
 * (local-lights.ts); with a probe light present, the probe-held lights and
 * the probes build last (see the top).
 */
class ProbeOrderedLightsNode extends (THREE.LightsNode as unknown as new () => { setupLights(builder: N, nodes: LightNodeLike[]): void; setLights(l: THREE.Light[]): unknown; customCacheKey(): number; getLights(): THREE.Light[] }) {
  static get type(): string {
    return 'LightsNode';
  }
  /** Lights' importances decide which builds shade them per vertex: a change rebuilds the lit programs. */
  override customCacheKey(): number {
    const own = localLightsCacheKey(this.getLights());
    return own === 0 ? super.customCacheKey() : (Math.imul(super.customCacheKey(), 31) + own) | 0;
  }
  override setupLights(builder: N, all: LightNodeLike[]): void {
    // Local lights shaded per vertex (or left out) for this build's mode: they add to the irradiance the probes keep.
    const { pixel: nodes, vertex } = splitLocalLights(builder, all);
    buildVertexLights(builder, vertex);
    const probe = nodes.find((n) => n.isProbeLightingNode === true);
    if (probe === undefined) {
      super.setupLights(builder, nodes);
      return;
    }
    const later = nodes.filter((n) => n !== probe && isHeld(n));
    const first = nodes.filter((n) => n !== probe && !later.includes(n));
    for (const n of first) n.build(builder);
    KEPT_IRRADIANCE.assign(builder.context.irradiance);
    for (const n of later) n.build(builder);
    probe.build(builder);
  }
}

/** Whether `light` is the probe light. */
export function isProbeLighting(light: unknown): light is ProbeLighting {
  return (light as { isProbeLighting?: boolean } | null)?.isProbeLighting === true;
}

/** Teach a renderer the probe light and the lights node that orders it. */
export function registerProbeLighting(renderer: { library: { addLight(node: unknown, light: unknown): void }; lighting: { createNode(lights?: THREE.Light[]): unknown } }): void {
  renderer.library.addLight(ProbeLightingNode, ProbeLighting);
  renderer.lighting.createNode = (lights: THREE.Light[] = []) => new ProbeOrderedLightsNode().setLights(lights);
}

/** The page flag that draws without the baked probes (`?probes=off`: the flat ambient light, a diagnostic comparison). */
export const PROBES_URL_PARAM = 'probes';

/** Whether a page's query string leaves the probe lighting on (the default) — `probes=off` or `0` turns it off. */
export function probesFromUrl(search: string): boolean {
  const v = new URLSearchParams(search).get(PROBES_URL_PARAM);
  return v !== 'off' && v !== '0' && v !== 'false';
}
