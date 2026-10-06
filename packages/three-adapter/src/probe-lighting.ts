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
 * Every loaded tile is packed into one 3D texture (three's `LightProbeGrid`
 * atlas layout per tile, tiles side by side), with a small table of the tiles'
 * boxes. A pixel is checked against its object's likely tile (per-object
 * uniforms, picked on the CPU); only a pixel outside it walks the table for
 * the tile holding it (where tiles share a face the first one in the table,
 * which holds the same probes there). A frame samples one texture whatever
 * the number of tiles, and a new tile builds no program. Probes hold
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
import { PROBE_ATLAS_PADDING, PROBE_FILLED, PROBE_GPU_TEXELS, PROBE_MOVED, PROBE_SH_TEXELS, PROBE_TEXELS } from '@thirdlight/runtime';

import type { N } from './effects-tsl';
import type { LoadedProbeTile } from './probe-grids';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Break, If, Loop, NodeUpdateType, float, int, ivec2, luminance, max, mix, normalWorld, positionWorld, property, select, smoothstep, step, texture, texture3D, uniform, vec3, vec4 } = TSL;

/**
 * How much a probe counts in the interpolation, by validity: a probe moved
 * out of geometry saw its light from up to half a spacing away (maybe the
 * other side of a thin wall), one filled from its neighbours inside geometry
 * is only a fallback where no valid probe is near.
 */
export const PROBE_WEIGHT_VALID = 1;
export const PROBE_WEIGHT_MOVED = 0.5;
export const PROBE_WEIGHT_FILLED = 1 / 64;
/** Largest edge of the packed probe texture (texels): WebGPU's default 3D texture limit. */
export const PROBE_PACK_MAX_EDGE = 2048;
/** How far off a surface (a share of the spacing, along its normal) the side of a wall is decided. */
const SIDE_BIAS = 0.05;
/** Texels per tile in the tile table. */
const TABLE_TEXELS = 3;

/** A probe's weight from its validity. */
export function probeWeight(validity: number): number {
  return validity === PROBE_FILLED ? PROBE_WEIGHT_FILLED : validity === PROBE_MOVED ? PROBE_WEIGHT_MOVED : PROBE_WEIGHT_VALID;
}

export interface PackedProbes {
  /** The packed atlas: RGBA half floats, width × height × depth. */
  readonly data: Uint16Array;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /**
   * Per tile three RGBA texels, what the shader needs ready-made: (scale.xyz,
   * fade), (offset.xyz, nz), (nx, ny, x offset, y offset) — a world point p
   * is at probe coordinates p × scale + offset; the fade is the tile's
   * horizontal spacing.
   */
  readonly table: Float32Array;
  /** Per tile its box (min.xyz, max.xyz), for the CPU. */
  readonly boxes: Float32Array;
  /** Tiles packed (in the given order); tiles past the texture's edge are left out (`unplaced`). */
  readonly count: number;
  readonly unplaced: number;
}

/**
 * What a probe holds in the packed texture, per texel: the first-order
 * spherical harmonics (L1: the irradiance of three's L2 terms without the
 * second band — what Unity's probe volumes draw by default, at four samples
 * instead of seven) times the probe's weight, the weight, then its walls as
 * the file has them. Each entry: a value of the file's probe (its 28 light
 * values, then its 8 wall values), 'w' (the weight) or null (0).
 */
const WALLS = PROBE_SH_TEXELS * 4;
const PACKED: readonly (readonly (number | 'w' | null)[])[] = [
  [0, 1, 2, 'w'],
  [3, 4, 5, 6],
  [7, 8, 9, 10],
  [11, null, null, null],
  [WALLS, WALLS + 1, WALLS + 2, WALLS + 3],
  [WALLS + 4, WALLS + 5, WALLS + 6, WALLS + 7],
];
/** Texels of a packed probe holding its light (the rest hold its walls). */
const PACKED_LIGHT_TEXELS = 4;
// The GPU memory the bake reports (project-model `probeGridGpuBytes`) counts this layout.
if (PACKED.length !== PROBE_GPU_TEXELS) throw new Error(`probe texels packed: ${PACKED.length}, PROBE_GPU_TEXELS ${PROBE_GPU_TEXELS}`);

/**
 * Pack tiles into one texture, side by side along x in rows along y, each
 * in three's atlas layout with `PACKED`'s texels as sub-volumes. A probe's
 * light is multiplied by its weight (the filter then interpolates weighted
 * light and weights; the shader divides).
 */
export function packProbeTiles(tiles: readonly Pick<LoadedProbeTile, 'grid' | 'atlas' | 'validity'>[], maxEdge: number = PROBE_PACK_MAX_EDGE): PackedProbes {
  const places: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 1;
  let height = 1;
  let depth = 1;
  for (const t of tiles) {
    const [nx, ny, nz] = t.grid.resolution as [number, number, number];
    if (x + nx > maxEdge) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    if (y + ny > maxEdge || nx > maxEdge) break;
    places.push({ x, y });
    x += nx;
    rowHeight = Math.max(rowHeight, ny);
    width = Math.max(width, x);
    height = Math.max(height, y + ny);
    depth = Math.max(depth, PROBE_GPU_TEXELS * (nz + 2 * PROBE_ATLAS_PADDING));
  }
  const data = new Uint16Array(width * height * depth * 4);
  const table = new Float32Array(Math.max(1, places.length) * TABLE_TEXELS * 4);
  const boxes = new Float32Array(Math.max(1, places.length) * 6);
  const toHalf = THREE.DataUtils.toHalfFloat;
  const fromHalf = THREE.DataUtils.fromHalfFloat;
  const values = new Uint16Array(PROBE_TEXELS * 4);
  places.forEach((at, k) => {
    const t = tiles[k]!;
    const [nx, ny, nz] = t.grid.resolution as [number, number, number];
    const padded = nz + 2 * PROBE_ATLAS_PADDING;
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          for (let v = 0; v < PROBE_TEXELS; v++) {
            const from = (((v * padded + PROBE_ATLAS_PADDING + iz) * ny + iy) * nx + ix) * 4;
            values.set(t.atlas.subarray(from, from + 4), v * 4);
          }
          const w = probeWeight(t.validity[ix + iy * nx + iz * nx * ny]!);
          const slices = (r: number): number[] => [r * padded + PROBE_ATLAS_PADDING + iz, ...(iz === 0 ? [r * padded] : []), ...(iz === nz - 1 ? [r * padded + PROBE_ATLAS_PADDING + nz] : [])];
          PACKED.forEach((texel, r) => {
            const weighted = r < PACKED_LIGHT_TEXELS && w !== 1;
            for (const slice of slices(r)) {
              const o = ((slice * height + at.y + iy) * width + at.x + ix) * 4;
              texel.forEach((src, ch) => {
                if (src === null) data[o + ch] = 0;
                else if (src === 'w') data[o + ch] = toHalf(w);
                else data[o + ch] = weighted ? toHalf(fromHalf(values[src]!) * w) : values[src]!;
              });
            }
          });
        }
      }
    }
    const n = [nx, ny, nz];
    const { min, max: hi } = t.grid;
    const fade = Math.max((hi[0] - min[0]) / (nx - 1), (hi[2] - min[2]) / (nz - 1));
    const scale = [0, 1, 2].map((a) => (n[a]! - 1) / (hi[a]! - min[a]!));
    table.set([scale[0]!, scale[1]!, scale[2]!, fade, -min[0] * scale[0]!, -min[1] * scale[1]!, -min[2] * scale[2]!, nz, nx, ny, at.x, at.y], k * TABLE_TEXELS * 4);
    boxes.set([min[0], min[1], min[2], hi[0], hi[1], hi[2]], k * 6);
  });
  return { data, width, height, depth, table, boxes, count: places.length, unplaced: tiles.length - places.length };
}

function atlasTexture(p: Pick<PackedProbes, 'data' | 'width' | 'height' | 'depth'>): THREE.Data3DTexture {
  const tex = new THREE.Data3DTexture(p.data, p.width, p.height, p.depth);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

function tableTexture(table: Float32Array): THREE.DataTexture {
  const tex = new THREE.DataTexture(table, table.length / 4, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** `light.userData[PROBE_HELD_KEY]`: an ambient or hemisphere light whose light the probes hold (baked or mixed). */
const PROBE_HELD_KEY = '__tlProbeHeld';

/** Mark an ambient or hemisphere light as held by probes (its light is in a probe bake) or not. */
export function markProbeHeld(light: THREE.Light, held: boolean): void {
  if (held) light.userData[PROBE_HELD_KEY] = true;
  else delete light.userData[PROBE_HELD_KEY];
}

/** The probe tiles as one light (not a three.js light kind: only its node knows it). */
export class ProbeLighting extends THREE.Light {
  readonly isProbeLighting = true;
  /** The packed tiles and their table (placeholders while none is loaded). */
  atlas: THREE.Data3DTexture = atlasTexture({ data: new Uint16Array(4), width: 1, height: 1, depth: 1 });
  table: THREE.DataTexture = tableTexture(new Float32Array(TABLE_TEXELS * 4));
  /** Tiles in the table; the tiles last packed (the debug view draws them). */
  count = 0;
  tiles: readonly LoadedProbeTile[] = [];
  /** The table as packed, and the tiles' boxes (the CPU picks each object's likely tile from them). */
  tableData: Float32Array = new Float32Array(TABLE_TEXELS * 4);
  boxes: Float32Array = new Float32Array(6);
  unplaced = 0;
  /** The packed textures' size (bytes). */
  gpuBytes = 0;
  /** Textures replaced, disposed once no frame can still bind them. */
  private retired: { texture: THREE.Texture; frames: number }[] = [];

  constructor() {
    super(0xffffff, 1);
    this.name = 'probe lighting';
    this.matrixAutoUpdate = false;
    this.matrixWorldAutoUpdate = false;
  }

  /** Pack these tiles (the loaded set changed). */
  setTiles(tiles: readonly LoadedProbeTile[]): void {
    const packed = packProbeTiles(tiles);
    for (const texture of [this.atlas, this.table]) this.retired.push({ texture, frames: 2 });
    this.atlas = atlasTexture(packed);
    this.table = tableTexture(packed.table);
    this.gpuBytes = packed.data.byteLength;
    this.count = packed.count;
    this.tableData = packed.table;
    this.boxes = packed.boxes;
    this.tiles = tiles.slice(0, packed.count);
    this.unplaced = packed.unplaced;
  }

  /** A frame was drawn: let go of textures no frame binds any more. */
  frameDrawn(): void {
    if (this.retired.length === 0) return;
    for (const r of this.retired) if (--r.frames <= 0) r.texture.dispose();
    this.retired = this.retired.filter((r) => r.frames > 0);
  }

  override dispose(): void {
    for (const r of this.retired) r.texture.dispose();
    this.retired = [];
    this.atlas.dispose();
    this.table.dispose();
    super.dispose();
  }
}

/**
 * The table row of the tile holding `point` — the first one containing it,
 * else the nearest (the shader picks the same way) — or -1 with no tiles.
 */
export function probeTileAt(boxes: Float32Array, count: number, point: THREE.Vector3): number {
  let best = -1;
  let bestOut = Infinity;
  for (let k = 0; k < count; k++) {
    const o = k * 6;
    const dx = Math.max(boxes[o]! - point.x, 0, point.x - boxes[o + 3]!);
    const dy = Math.max(boxes[o + 1]! - point.y, 0, point.y - boxes[o + 4]!);
    const dz = Math.max(boxes[o + 2]! - point.z, 0, point.z - boxes[o + 5]!);
    const out = Math.hypot(dx, dy, dz);
    if (out < bestOut) {
      best = k;
      bestOut = out;
      if (out <= 0) break;
    }
  }
  return best;
}

const _centre = new THREE.Vector3();

/**
 * Each drawn object's likely tile (the one holding the middle of its bounds),
 * as per-object uniforms: the shader checks a pixel against it first and
 * walks the table only when the pixel lies outside it (an object across a
 * tile's face, or outside every tile). Picked once per object and frame.
 */
class ObjectTile {
  readonly sc: N;
  readonly of: N;
  readonly rs: N;
  private readonly picked = new WeakMap<THREE.Object3D, { frame: number; row: number }>();
  constructor(private readonly light: ProbeLighting) {
    const row = (object: THREE.Object3D, frame: number): number => {
      const seen = this.picked.get(object);
      if (seen !== undefined && seen.frame === frame) return seen.row;
      const g = (object as THREE.Mesh).geometry;
      if (g !== undefined && g.boundingSphere === null) g.computeBoundingSphere();
      _centre.copy(g?.boundingSphere?.center ?? _centre.set(0, 0, 0)).applyMatrix4(object.matrixWorld);
      const r = probeTileAt(this.light.boxes, this.light.count, _centre);
      this.picked.set(object, { frame, row: r });
      return r;
    };
    const texel = (k: number) => (v: THREE.Vector4, { object, frameId }: { object: THREE.Object3D; frameId?: number }) => {
      const r = row(object, frameId ?? 0);
      if (r < 0) return v.set(0, 0, 0, 0);
      const o = (r * TABLE_TEXELS + k) * 4;
      const t = this.light.tableData;
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
  readonly count: N;
  /** 1 / the packed texture's size. */
  readonly atlasScale: N;
  /** Copy the light's current textures and counts into the nodes. */
  sync(light: ProbeLighting): void;
}

export function probeTextureNodes(light: ProbeLighting): ProbeTextureNodes {
  const nodes: ProbeTextureNodes = {
    atlas: texture3D(light.atlas),
    table: texture(light.table),
    count: uniform(0, 'int'),
    atlasScale: uniform(new THREE.Vector3(1, 1, 1)),
    sync(l) {
      nodes.atlas.value = l.atlas;
      nodes.table.value = l.table;
      nodes.count.value = l.count;
      nodes.atlasScale.value.set(1 / l.atlas.image.width, 1 / l.atlas.image.height, 1 / l.atlas.image.depth);
    },
  };
  return nodes;
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
    // The pixel in the object's tile (its probe coordinates within the probes), else the first tile holding it or the nearest.
    const at = p.mul(ot.sc.xyz).add(ot.of.xyz);
    const inObjectTile = at.greaterThanEqual(vec3(0)).all().and(at.lessThanEqual(vec3(ot.rs.x, ot.rs.y, ot.of.w).sub(1)).all()).and(ot.rs.x.greaterThan(0));
    If(inObjectTile, () => {
      bestOut.assign(0);
      found.assign(1);
      sc.assign(ot.sc);
      of.assign(ot.of);
      rs.assign(ot.rs);
    }).Else(() => {
      Loop(t.count, ({ i }: { i: N }) => {
        const base = i.mul(TABLE_TEXELS);
        const a = t.table.load(ivec2(base, int(0)));
        const b = t.table.load(ivec2(base.add(1), int(0)));
        const r = t.table.load(ivec2(base.add(2), int(0)));
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

/** The scene's lights node: with a probe light present, the probe-held lights and the probes build last (see the top). */
class ProbeOrderedLightsNode extends (THREE.LightsNode as unknown as new () => { setupLights(builder: N, nodes: LightNodeLike[]): void; setLights(l: THREE.Light[]): unknown }) {
  static get type(): string {
    return 'LightsNode';
  }
  override setupLights(builder: N, nodes: LightNodeLike[]): void {
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
