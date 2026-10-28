/**
 * The wind every foliage vertex reads: the scene's global wind, the wind
 * zones laid over it, and a gust pattern scrolled over the world from above.
 *
 * - The zones round the view are baked into a small map centred on the
 *   camera (`WIND_MAP_TEXELS`² texels of `WIND_MAP_TEXEL_M` metres; two
 *   half-float textures: direction, strength, gusts; pattern speed, size,
 *   turbulence and how far a zone moved the pattern). It is filled again
 *   only when a zone, the global wind or the camera's map square changes.
 *   Shaders read it with no per-zone uniform, so nothing caps the zones.
 *   Past the map (and where no zone reaches it) the global uniforms hold.
 * - The gust pattern is a tiling noise texture (the scene's, or the
 *   engine's neutral one made here), read twice: at its size and at a
 *   finer second layer. Under the global wind it scrolls by offsets worked
 *   out on the page in double precision (exact over hours). Where a zone
 *   changes its direction, speed or size, the pattern flows the way flow
 *   maps do: two reads half a period apart, each restarting while its weight
 *   is zero, so a pattern that differs from place to place never shears.
 */
import { fillWindMap, orderWindZones, placeWindZone, WIND_DEFAULTS, WIND_MAP_CHANNELS, windValues, type PlacedWindZone, type WindValues, type WindZoneComponent } from '@thirdlight/runtime';
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';
import { untransformedTexture } from './texel-texture-node';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, If, abs, clamp, float, floor, fract, length, max, min, mix, select, sqrt, texture, uniform, vec2, vec4 } = TSL;

/** Texels a side of the wind map (64 × 4 m: 256 m round the camera, far past where grass is drawn). */
export const WIND_MAP_TEXELS = 64;
/** Metres a wind map texel spans: a zone's edge is no sharper than this. */
export const WIND_MAP_TEXEL_M = 4;
/** The map's centre moves in steps of this many metres (it is filled again only then). */
const WIND_MAP_STEP_M = 32;
/** Texels a side of the engine's neutral gust pattern. */
export const WIND_NOISE_TEXELS = 128;
/** Seconds of one flow period where a zone moves the pattern (each read restarts once a period, unseen). */
const WIND_FLOW_PERIOD_S = 6;
/** How much of the gust pattern each layer gives (sums to 1). */
const WIND_LAYER_SHARE = [0.65, 0.35] as const;
/** Where the second layer is read from (a shift, so the two layers never start in step). */
const SECOND_LAYER_SHIFT = [0.37, 0.71] as const;

/** The wind as the renderer takes it (project-model `WindConfig`). */
export interface WindFieldWind {
  readonly direction: readonly [number, number];
  readonly strength: number;
  readonly gust: number;
  readonly gustFrequency: number;
  readonly turbulence: number;
  readonly noise?: string;
  readonly speed?: number;
  readonly scale?: number;
  readonly octave?: { readonly scale: number; readonly speed: number };
}

/** A zone in the scene now: its object's id, component and world matrix. */
export interface WindZoneLike {
  readonly key: string;
  readonly zone: WindZoneComponent;
  readonly matrix: ArrayLike<number>;
}

const hash2 = (x: number, y: number, seed: number): number => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/**
 * The engine's neutral gust pattern: tiling value noise (three octaves on
 * lattices that divide the tile), stretched to the full 0–255 range.
 * Deterministic; no look of its own beyond soft blobs.
 */
export function makeWindNoise(size = WIND_NOISE_TEXELS): Uint8Array {
  const out = new Float32Array(size * size);
  const octaves: readonly [number, number][] = [[4, 0.55], [8, 0.3], [16, 0.15]];
  for (const [cells, amp] of octaves) {
    const step = size / cells;
    for (let y = 0; y < size; y += 1) {
      const gy = y / step;
      const y0 = Math.floor(gy);
      const ty = gy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x += 1) {
        const gx = x / step;
        const x0 = Math.floor(gx);
        const tx = gx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const v = (i: number, j: number): number => hash2((x0 + i) % cells, (y0 + j) % cells, cells);
        const top = v(0, 0) + (v(1, 0) - v(0, 0)) * sx;
        const bottom = v(0, 1) + (v(1, 1) - v(0, 1)) * sx;
        out[y * size + x]! += (top + (bottom - top) * sy) * amp;
      }
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of out) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const bytes = new Uint8Array(size * size);
  for (let i = 0; i < out.length; i += 1) bytes[i] = Math.round(((out[i]! - lo) / Math.max(1e-6, hi - lo)) * 255);
  return bytes;
}

function halfTexture(n: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint16Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function noiseTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(makeWindNoise(), WIND_NOISE_TEXELS, WIND_NOISE_TEXELS, THREE.RedFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const sameMatrix = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  for (let i = 0; i < 16; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

export class WindField {
  /** The global wind's values: [dirX, dirZ, strength, gust] and [speed, scale, turbulence, 0]. */
  private readonly globalA = uniform(new THREE.Vector4(1, 0, 0.5, 0.4)).setGroup(TSL.renderGroup);
  private readonly globalB = uniform(new THREE.Vector4(6, WIND_DEFAULTS.scale, 0.3, 0)).setGroup(TSL.renderGroup);
  /** The global pattern's scroll now, each layer's (tile units, wrapped): [layer 1 u, v, layer 2 u, v]. */
  private readonly scroll = uniform(new THREE.Vector4()).setGroup(TSL.renderGroup);
  /** The second layer's size and speed shares. */
  private readonly octave = uniform(new THREE.Vector2(WIND_DEFAULTS.octave.scale, WIND_DEFAULTS.octave.speed)).setGroup(TSL.renderGroup);
  /** The map: [x0, z0, 1 / side metres, 1 when a zone reaches it]. */
  private readonly rect = uniform(new THREE.Vector4()).setGroup(TSL.renderGroup);
  private readonly mapA = halfTexture(WIND_MAP_TEXELS);
  private readonly mapB = halfTexture(WIND_MAP_TEXELS);
  private readonly ownNoise = noiseTexture();
  // Read at explicit places only: no texture transform per read and draw.
  private readonly noiseNode = untransformedTexture(this.ownNoise);
  private readonly floats = new Float32Array(WIND_MAP_TEXELS * WIND_MAP_TEXELS * WIND_MAP_CHANNELS);
  private values: WindValues = windValues({ direction: [1, 0], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 });
  private octaveShares: { scale: number; speed: number } = { ...WIND_DEFAULTS.octave };
  private zones: { key: string; zone: WindZoneComponent; matrix: Float64Array }[] = [];
  private placed: PlacedWindZone[] = [];
  private mapX = NaN;
  private mapZ = NaN;
  private dirty = true;
  /** Fills of the map so far (the diagnostics' count, the tests'). */
  fills = 0;
  /** The noise texture asset in use (null: the engine's). */
  private noiseId: string | null = null;
  private noiseAsset: THREE.Texture | null = null;
  /** The scroll (pattern widths) at clock `scrollFrom`, and its rate since (null: not ticked yet). */
  private readonly scrollAnchor = [0, 0, 0, 0];
  private readonly scrollRate = [0, 0, 0, 0];
  private scrollFrom: number | null = null;

  /**
   * `time`: the shared clock uniform (seconds). `loadNoise`: a texture
   * asset (held until `releaseNoise`).
   */
  constructor(
    private readonly time: N,
    private readonly loadNoise: (assetId: string) => Promise<THREE.Texture | null>,
    private readonly releaseNoise: () => void,
    private readonly onChange: () => void,
  ) {}

  /** The scene's wind (null: the engine's default breeze). */
  setGlobal(w: WindFieldWind | null): void {
    const v = windValues((w ?? { direction: [1, 0], strength: 0.5, gust: 0.4, gustFrequency: 0.3, turbulence: 0.3 }) as never);
    this.values = v;
    this.octaveShares = { scale: w?.octave?.scale ?? WIND_DEFAULTS.octave.scale, speed: w?.octave?.speed ?? WIND_DEFAULTS.octave.speed };
    (this.globalA.value as THREE.Vector4).set(v.dirX, v.dirZ, v.strength, v.gust);
    (this.globalB.value as THREE.Vector4).set(v.speed, v.scale, v.turbulence, 0);
    (this.octave.value as THREE.Vector2).set(this.octaveShares.scale, this.octaveShares.speed);
    this.setNoise(w?.noise ?? null);
    this.dirty = true;
  }

  private setNoise(id: string | null): void {
    if (id === this.noiseId) return;
    this.noiseId = id;
    this.noiseNode.value = this.ownNoise;
    this.noiseAsset?.dispose();
    this.noiseAsset = null;
    this.releaseNoise();
    if (id === null) return;
    void this.loadNoise(id).then((t) => {
      if (t === null || this.noiseId !== id) return;
      // Its own copy: the pattern repeats over the world whatever the asset's sampler says.
      const c = t.clone();
      c.wrapS = THREE.RepeatWrapping;
      c.wrapT = THREE.RepeatWrapping;
      c.colorSpace = THREE.NoColorSpace;
      c.needsUpdate = true;
      this.noiseAsset = c;
      this.noiseNode.value = c;
      this.onChange();
    });
  }

  /** The zones in the loaded scenes now (their order does not matter). */
  setZones(list: readonly WindZoneLike[]): void {
    const was = this.zones;
    let same = was.length === list.length;
    for (let i = 0; same && i < list.length; i += 1) {
      const a = was[i]!;
      const b = list[i]!;
      same = a.key === b.key && a.zone === b.zone && sameMatrix(a.matrix, b.matrix);
    }
    if (same) return;
    this.zones = list.map((z) => ({ key: z.key, zone: z.zone, matrix: Float64Array.from(z.matrix as ArrayLike<number>) }));
    this.placed = orderWindZones(this.zones.map((z) => placeWindZone(z.zone, z.key, z.matrix)));
    this.dirty = true;
  }

  /** The camera's place this frame: the map follows it in steps, and is filled again when anything it holds changed. */
  setEye(x: number, z: number): void {
    const half = (WIND_MAP_TEXELS * WIND_MAP_TEXEL_M) / 2;
    const x0 = Math.round(x / WIND_MAP_STEP_M) * WIND_MAP_STEP_M - half;
    const z0 = Math.round(z / WIND_MAP_STEP_M) * WIND_MAP_STEP_M - half;
    if (x0 !== this.mapX || z0 !== this.mapZ) {
      this.mapX = x0;
      this.mapZ = z0;
      this.dirty = true;
    }
    if (this.dirty) this.fill();
  }

  /**
   * The clock: the global pattern's scroll, worked out here in double
   * precision. Under a steady wind it is a function of the clock alone; when
   * the wind changes (a blend changes it every frame) the scroll so far is
   * kept and the new velocity carries on from there, as the clouds' travel
   * does, so the pattern never jumps or races.
   */
  tick(seconds: number): void {
    const v = this.values;
    const s2 = v.scale * this.octaveShares.scale;
    const u2 = v.speed * this.octaveShares.speed;
    const u = this.scrollRate;
    const ux = (v.dirX * v.speed) / v.scale;
    const uz = (v.dirZ * v.speed) / v.scale;
    const wx = (v.dirX * u2) / s2;
    const wz = (v.dirZ * u2) / s2;
    const a = this.scrollAnchor;
    if (this.scrollFrom === null) {
      this.scrollFrom = seconds;
      a[0] = fract1(ux * seconds);
      a[1] = fract1(uz * seconds);
      a[2] = fract1(wx * seconds);
      a[3] = fract1(wz * seconds);
    } else if (ux !== u[0] || uz !== u[1] || wx !== u[2] || wz !== u[3]) {
      const dt = seconds - this.scrollFrom;
      for (let i = 0; i < 4; i++) a[i] = fract1(a[i]! + u[i]! * dt);
      this.scrollFrom = seconds;
    }
    u[0] = ux;
    u[1] = uz;
    u[2] = wx;
    u[3] = wz;
    const dt = seconds - this.scrollFrom;
    (this.scroll.value as THREE.Vector4).set(fract1(a[0]! + ux * dt), fract1(a[1]! + uz * dt), fract1(a[2]! + wx * dt), fract1(a[3]! + wz * dt));
  }

  /** The global wind now (unit direction, speed in metres per second): what the sky's clouds drift with. */
  global(): Readonly<WindValues> {
    return this.values;
  }

  /** The largest wind a vertex may read now (strength and full gusts, any zone's): what bounds a draw's sway. */
  maxAmount(): number {
    const g = this.values;
    let most = Math.max(0, g.strength) + Math.max(0, g.gust);
    for (const z of this.placed) most = Math.max(most, Math.max(0, z.set.strength ?? g.strength) + Math.max(0, z.set.gust ?? g.gust));
    return most;
  }

  /** What the map holds now (diagnostics). */
  state(): { zones: number; mapOn: boolean; centre: [number, number]; fills: number } {
    return { zones: this.placed.length, mapOn: (this.rect.value as THREE.Vector4).w > 0, centre: [this.mapX + (WIND_MAP_TEXELS * WIND_MAP_TEXEL_M) / 2, this.mapZ + (WIND_MAP_TEXELS * WIND_MAP_TEXEL_M) / 2], fills: this.fills };
  }

  private fill(): void {
    this.dirty = false;
    const side = WIND_MAP_TEXELS * WIND_MAP_TEXEL_M;
    const rect = this.rect.value as THREE.Vector4;
    const reaching = this.placed.filter((z) => {
      const r = z.shape === 'sphere' ? z.radius : Math.hypot(z.halfX, z.halfZ);
      return z.x + r > this.mapX && z.x - r < this.mapX + side && z.z + r > this.mapZ && z.z - r < this.mapZ + side;
    });
    rect.set(this.mapX, this.mapZ, 1 / side, reaching.length > 0 ? 1 : 0);
    if (reaching.length === 0) return;
    this.fills += 1;
    fillWindMap(this.floats, this.values, reaching, this.mapX, this.mapZ, WIND_MAP_TEXEL_M, WIND_MAP_TEXELS);
    const a = this.mapA.image.data as Uint16Array;
    const b = this.mapB.image.data as Uint16Array;
    const h = THREE.DataUtils.toHalfFloat;
    for (let k = 0; k < WIND_MAP_TEXELS * WIND_MAP_TEXELS; k += 1) {
      const o = k * WIND_MAP_CHANNELS;
      const f = this.floats;
      a[k * 4] = h(f[o]!);
      a[k * 4 + 1] = h(f[o + 1]!);
      a[k * 4 + 2] = h(f[o + 2]!);
      a[k * 4 + 3] = h(f[o + 3]!);
      b[k * 4] = h(f[o + 4]!);
      b[k * 4 + 1] = h(f[o + 5]!);
      b[k * 4 + 2] = h(f[o + 6]!);
      b[k * 4 + 3] = h(f[o + 7]!);
    }
    this.mapA.needsUpdate = true;
    this.mapB.needsUpdate = true;
  }

  /** The gust pattern at a ground point for a pattern moved `offset` metres, with the layers' reads shifted by `shift` (tile units). */
  private pattern(p: N, offset: N, scale: N, shift: N): N {
    const o = this.octave;
    const first = this.noiseNode.sample(p.sub(offset).div(scale).add(shift)).level(0).r;
    const second = this.noiseNode.sample(p.sub(offset.mul(o.y)).div(scale.mul(o.x)).add(shift).add(vec2(SECOND_LAYER_SHIFT[0], SECOND_LAYER_SHIFT[1]))).level(0).r;
    return first.mul(WIND_LAYER_SHARE[0]).add(second.mul(WIND_LAYER_SHARE[1]));
  }

  /**
   * The wind at a world ground point `p` (vec2 x, z), in the vertex stage:
   * vec4(direction x, direction z, strength with gusts, turbulence).
   */
  readonly sample = Fn(([p]: [N]): N => {
    const a = vec4(this.globalA).toVar();
    const b = vec4(this.globalB).toVar();
    const rect = this.rect;
    If(rect.w.greaterThan(0), () => {
      const uv = p.sub(rect.xy).mul(rect.z);
      const edge = min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y))).mul(WIND_MAP_TEXELS);
      // The outermost texel fades back to the global wind, so the map's edge leaves no line.
      const inside = clamp(edge.sub(0.5), 0, 1);
      If(inside.greaterThan(0), () => {
        a.assign(mix(this.globalA, texture(this.mapA, uv).level(0), inside));
        b.assign(mix(this.globalB, texture(this.mapB, uv).level(0), inside));
      });
    });
    const len = length(a.xy);
    const dir = select(len.greaterThan(1e-4), a.xy.div(max(len, 1e-4)), this.globalA.xy);
    const gb = this.globalB;
    // The global pattern: its scroll is the page's (exact), so it reads the same everywhere zones leave it.
    const s = this.scroll;
    const first = this.noiseNode.sample(p.div(gb.y).sub(s.xy)).level(0).r;
    const second = this.noiseNode.sample(p.div(gb.y.mul(this.octave.x)).sub(s.zw).add(vec2(SECOND_LAYER_SHIFT[0], SECOND_LAYER_SHIFT[1]))).level(0).r;
    const gust = first.mul(WIND_LAYER_SHARE[0]).add(second.mul(WIND_LAYER_SHARE[1])).toVar();
    // Where a zone moved the pattern: two flowing reads half a period apart, blended in by the zone's weight.
    If(b.w.greaterThan(0), () => {
      const phase = this.time.div(WIND_FLOW_PERIOD_S);
      const flow = (k: number): { n: N; w: N } => {
        const f = fract(phase.add(k));
        const restart = fract(floor(phase.add(k)).mul(vec2(0.37, 0.61)));
        const n = this.pattern(p, dir.mul(b.x).mul(f).mul(WIND_FLOW_PERIOD_S), b.y, restart);
        return { n, w: float(1).sub(abs(f.mul(2).sub(1))) };
      };
      const r0 = flow(0);
      const r1 = flow(0.5);
      const norm = sqrt(r0.w.mul(r0.w).add(r1.w.mul(r1.w)));
      const local = clamp(r0.n.mul(r0.w).add(r1.n.mul(r1.w)).sub(0.5).div(max(norm, 1e-3)).add(0.5), 0, 1);
      gust.assign(mix(gust, local, b.w));
    });
    return vec4(dir, a.z.add(a.w.mul(gust)), b.z);
  });

  dispose(): void {
    this.mapA.dispose();
    this.mapB.dispose();
    this.ownNoise.dispose();
    this.noiseAsset?.dispose();
    this.releaseNoise();
  }
}

const fract1 = (v: number): number => v - Math.floor(v);
