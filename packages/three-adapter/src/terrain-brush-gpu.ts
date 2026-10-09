/**
 * A terrain brush dab drawn on the GPU: the editor's stroke preview.
 *
 * A dab changes the drawn tiles' texels in place — the same texture arrays
 * the terrain is drawn from (`terrain-texels.ts`) — so a stroke previews with
 * no CPU re-mesh, no re-packing and no round trip per dab: for each tile the
 * dab reaches, one small pass draws the new texels of the rectangle it
 * covers into a scratch target (reading the tile's texels as they were
 * before the dab), then the rectangle is copied into the tile's texture
 * layer. Every tile's pass runs before any copy, so a dab reads the heights
 * as they were before it everywhere, as the command's brush cores do
 * (`terrain-edit.ts`).
 *
 * Heights follow the cores' arithmetic: a dab moves a sample by its delta
 * rounded to whole 16-bit steps (an integer step plus a rounded delta is the
 * core's rounding of the sum), with the cores' falloffs, value noise (the
 * same integer hash) and ramp; normals are written again from the new heights
 * as the packer writes them (across a tile edge from the neighbour's samples).
 * So the preview's heights are the committed heights but for a float's
 * rounding at a half step. Paint moves the drawn weights toward the painted
 * layer's channel and names the layer there (the drawn weights hold no hand
 * paint of their own: on ground painted with one layer this is what the core
 * stores; elsewhere the commit settles it); an erase moves them toward layer
 * 0, what ground without rules bakes. Holes set the cell's hole bit exactly.
 *
 * Tiles on another texture page than the one a pass reads are left out of
 * its cross-tile reads (smoothing and normals then take the tile's own
 * samples there, until the commit).
 *
 * The target's rows are memory rows on both renderers: WebGL 2 draws a
 * target bottom-up, so the pass names its row from the other end there.
 *
 * Browser-only (three's WebGPURenderer, WebGPU or WebGL 2).
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { NodeMaterial, QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { TERRAIN_NOISE_HASH, type BrushFalloff } from '@thirdlight/runtime';

import type { N } from './effects-tsl';
import { stepOf } from './terrain-material';

/** TSL untyped: three's typings lag the node API used here. */
const TSL: N = TSLTyped;
const { Fn, clamp, float, floor, int, ivec2, max, screenCoordinate, select, sqrt, textureLoad, uint, uniform, vec4 } = TSL;

export type TerrainBrushKind = 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise' | 'ramp' | 'paint' | 'holes';

/** One dab in the terrain's own frame (metres from its object; heights as 16-bit steps). */
export interface TerrainBrushDab {
  kind: TerrainBrushKind;
  /** The centre (unused by a ramp). */
  cx: number;
  cz: number;
  radius: number;
  falloff: BrushFalloff;
  /** raise, lower, noise: steps at the centre; the others: the blend at the centre (0–1]. */
  strength: number;
  /** flatten: the step levelled to (unrounded). */
  target: number;
  /** noise: the bumps' size (metres) and seed (a whole number). */
  scale: number;
  seed: number;
  /** ramp: its ends (x, z metres, height as an unrounded step). */
  from: readonly [number, number, number];
  to: readonly [number, number, number];
  /** paint: the layer painted; paint and holes: erase. */
  layer: number;
  erase: boolean;
}

/** A tile a dab reaches: its page textures and layer, and the rectangle of samples written. */
export interface TerrainBrushTile {
  heights: THREE.DataArrayTexture;
  layers: THREE.DataArrayTexture;
  indices: THREE.DataArrayTexture;
  layer: number;
  /** Cells along a side (samples − 1). */
  cells: number;
  spacing: number;
  /** Metres one step stands for. */
  metresPerStep: number;
  /** The tile's min corner (metres, the terrain's frame). */
  ox: number;
  oz: number;
  /** The texture layers of the 3 × 3 tiles around it on its page (index (dz + 1) · 3 + dx + 1; −1: none there). */
  around: readonly number[];
  /** Samples written, inclusive: [x0, z0, x1, z1] in the tile. */
  rect: readonly [number, number, number, number];
}

/** The page textures a dab writes. */
export type TerrainBrushPart = 'heights' | 'layers' | 'indices';

/** Which textures a kind writes. */
export function terrainBrushParts(kind: TerrainBrushKind): readonly TerrainBrushPart[] {
  if (kind === 'paint') return ['layers', 'indices'];
  if (kind === 'holes') return ['layers'];
  return ['heights'];
}

/** Samples of margin a kind's rectangle takes past its footprint (normals read a neighbour; paint names its layer one sample out). */
export function terrainBrushMargin(kind: TerrainBrushKind): number {
  return kind === 'paint' ? 2 : kind === 'holes' ? 0 : 1;
}

type Variant = 'point' | 'smooth' | 'weights' | 'indices' | 'holes' | 'copy';

/** The passes a kind draws per tile. */
function variantsOf(kind: TerrainBrushKind): Variant[] {
  return kind === 'paint' ? ['weights', 'indices'] : kind === 'holes' ? ['holes'] : kind === 'smooth' ? ['smooth'] : ['point'];
}

const FALLOFF_CODE: Readonly<Record<BrushFalloff, number>> = { smooth: 0, linear: 1, constant: 2 };
const POINT_CODE: Readonly<Record<string, number>> = { raise: 0, lower: 1, flatten: 2, noise: 3, ramp: 4 };

/** The noise hash's lattice offset: keeps the lattice coordinates positive in unsigned arithmetic (the cores' `Math.imul` wraps the same). */
const HASH_BIAS = 1 << 20;
const HASH_K = TERRAIN_NOISE_HASH as readonly [number, number, number, number, number];

const pow2AtLeast = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

export interface TerrainBrushStats {
  /** Passes drawn and rectangles copied since the brush was made. */
  passes: number;
  copies: number;
}

export class TerrainBrushGpu {
  private readonly renderer: WebGPURenderer;
  private readonly quad = new QuadMesh(null as never);
  private readonly materials = new Map<string, NodeMaterial>();
  private readonly targets = new Map<number, THREE.RenderTarget[]>();
  private readonly u = {
    rect: uniform(new THREE.Vector2()),
    flip: uniform(0),
    rows: uniform(1),
    cells: uniform(16),
    spacing: uniform(1),
    mps: uniform(1),
    layer: uniform(0),
    around0: uniform(new THREE.Vector3(-1, -1, -1)),
    around1: uniform(new THREE.Vector3(-1, -1, -1)),
    around2: uniform(new THREE.Vector3(-1, -1, -1)),
    origin: uniform(new THREE.Vector2()),
    centre: uniform(new THREE.Vector2()),
    radius: uniform(1),
    falloff: uniform(0),
    kind: uniform(0),
    strength: uniform(0),
    target: uniform(0),
    scale: uniform(1),
    /** The seed's hash lane (Math.imul(seed, K) as two 16-bit halves: a float holds each exactly). */
    seedHi: uniform(0),
    seedLo: uniform(0),
    rampA: uniform(new THREE.Vector3()),
    rampB: uniform(new THREE.Vector3()),
    paintLayer: uniform(0),
    erase: uniform(0),
  };
  readonly stats: TerrainBrushStats = { passes: 0, copies: 0 };
  private readonly unlisten = new Map<THREE.Texture, () => void>();
  /** Kinds whose passes were built ahead, per page ("kind:heights uuid"). */
  private readonly warmed = new Set<string>();

  constructor(renderer: WebGPURenderer) {
    this.renderer = renderer;
    this.u.flip.value = (renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend === true ? 1 : 0;
  }

  /**
   * Draw one dab into the tiles it reaches (`tiles`: each with its
   * rectangle). The textures are changed on the GPU only: their CPU copies
   * keep the stored tile, which a cancel uploads again.
   */
  dab(dab: TerrainBrushDab, tiles: readonly TerrainBrushTile[]): void {
    if (tiles.length === 0) return;
    const r = this.renderer;
    const saved = r.getRenderTarget();
    const variants = variantsOf(dab.kind);
    const used = new Map<number, number>();
    const copies: { from: THREE.RenderTarget; to: THREE.DataArrayTexture; tile: TerrainBrushTile; w: number; h: number }[] = [];
    this.setDab(dab);
    for (const t of tiles) {
      const [x0, z0, x1, z1] = t.rect;
      const w = x1 - x0 + 1;
      const h = z1 - z0 + 1;
      if (w <= 0 || h <= 0) continue;
      const size = pow2AtLeast(Math.max(w, h));
      this.setTile(t, size, dab);
      for (const v of variants) {
        const k = used.get(size) ?? 0;
        used.set(size, k + 1);
        const rt = this.target(size, k);
        this.quad.material = this.material(v, v === 'point' || v === 'smooth' ? t.heights : t.layers, t);
        r.setRenderTarget(rt);
        this.quad.render(r);
        this.stats.passes += 1;
        copies.push({ from: rt, to: v === 'point' || v === 'smooth' ? t.heights : v === 'indices' ? t.indices : t.layers, tile: t, w, h });
      }
    }
    r.setRenderTarget(saved);
    // Copied after every pass: each pass read the texels as they were before the dab.
    const region = new THREE.Box2(new THREE.Vector2(0, 0), new THREE.Vector2());
    const at = new THREE.Vector3();
    for (const c of copies) {
      region.max.set(c.w, c.h);
      at.set(c.tile.rect[0], c.tile.rect[1], c.tile.layer);
      r.copyTextureToTexture(c.from.texture, c.to, region, at);
      this.stats.copies += 1;
    }
  }

  /**
   * Build a kind's passes for a page ahead — each drawn once into a texel of
   * scratch (WebGL 2 links a program at its first draw, whatever was
   * compiled before) — so a stroke's first dab builds nothing on its frame;
   * the cost falls on the frame the tool or terrain was chosen.
   */
  warm(page: { heights: THREE.DataArrayTexture; layers: THREE.DataArrayTexture; indices: THREE.DataArrayTexture }, kind: TerrainBrushKind): void {
    const key = `${kind}:${page.heights.uuid}`;
    if (this.warmed.has(key)) return;
    this.warmed.add(key);
    for (const v of variantsOf(kind)) {
      const m = this.material(v, v === 'point' || v === 'smooth' ? page.heights : page.layers, { ...page, layer: 0, cells: 16, spacing: 1, metresPerStep: 1, ox: 0, oz: 0, around: [], rect: [0, 0, 0, 0] });
      const saved = this.renderer.getRenderTarget();
      this.quad.material = m;
      this.renderer.setRenderTarget(this.target(1, 0));
      this.quad.render(this.renderer);
      this.renderer.setRenderTarget(saved);
    }
    // And a copy (the copy's framebuffers are made at the first).
    this.renderer.copyTextureToTexture(this.target(1, 0).texture, this.target(1, 1).texture);
  }

  /**
   * Read a rectangle of a tile's texture layer back from the GPU (RGBA8 rows
   * of `w` texels, memory order). A check of the preview against the stored
   * tile; never on a stroke's way.
   */
  async read(texture: THREE.DataArrayTexture, layer: number, rect: readonly [number, number, number, number]): Promise<Uint8Array> {
    const [x0, z0, x1, z1] = rect;
    const w = x1 - x0 + 1;
    const h = z1 - z0 + 1;
    const rt = new THREE.RenderTarget(w, h, { depthBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    rt.texture.colorSpace = THREE.NoColorSpace;
    try {
      // Drawn by a pass that reads the layer (the dabs' own way to the GPU's texels).
      const u = this.u;
      (u.rect.value as THREE.Vector2).set(x0, z0);
      u.rows.value = h;
      u.layer.value = layer;
      const saved = this.renderer.getRenderTarget();
      this.quad.material = this.material('copy', texture, null);
      this.renderer.setRenderTarget(rt);
      this.quad.render(this.renderer);
      this.renderer.setRenderTarget(saved);
      const raw = (await this.renderer.readRenderTargetPixelsAsync(rt, 0, 0, w, h)) as unknown as Uint8Array;
      // WebGPU pads each row to 256 bytes.
      const row = w * 4;
      const stride = h > 1 ? (raw.length - row) / (h - 1) : row;
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) out.set(raw.subarray(y * stride, y * stride + row), y * row);
      return out;
    } finally {
      rt.dispose();
    }
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    for (const list of this.targets.values()) for (const t of list) t.dispose();
    this.targets.clear();
    for (const off of this.unlisten.values()) off();
    this.unlisten.clear();
  }

  // ---- uniforms --------------------------------------------------------------------------

  private setDab(d: TerrainBrushDab): void {
    const u = this.u;
    u.radius.value = d.radius;
    u.falloff.value = FALLOFF_CODE[d.falloff];
    u.kind.value = POINT_CODE[d.kind] ?? 0;
    u.strength.value = d.strength;
    u.target.value = d.target;
    u.scale.value = d.scale;
    const lane = Math.imul(d.seed | 0, HASH_K[2]) >>> 0;
    u.seedHi.value = lane >>> 16;
    u.seedLo.value = lane & 0xffff;
    u.paintLayer.value = d.erase ? 0 : d.layer;
    u.erase.value = d.erase ? 1 : 0;
  }

  private setTile(t: TerrainBrushTile, size: number, d: TerrainBrushDab): void {
    const u = this.u;
    (u.rect.value as THREE.Vector2).set(t.rect[0], t.rect[1]);
    u.rows.value = size;
    u.cells.value = t.cells;
    u.spacing.value = t.spacing;
    u.mps.value = t.metresPerStep;
    u.layer.value = t.layer;
    const a = t.around;
    (u.around0.value as THREE.Vector3).set(a[0]!, a[1]!, a[2]!);
    (u.around1.value as THREE.Vector3).set(a[3]!, a[4]!, a[5]!);
    (u.around2.value as THREE.Vector3).set(a[6]!, a[7]!, a[8]!);
    (u.origin.value as THREE.Vector2).set(t.ox, t.oz);
    // Relative to the tile's corner: small numbers, so single precision keeps the falloff close to the cores' doubles.
    (u.centre.value as THREE.Vector2).set(d.cx - t.ox, d.cz - t.oz);
    (u.rampA.value as THREE.Vector3).set(d.from[0] - t.ox, d.from[1] - t.oz, d.from[2]);
    (u.rampB.value as THREE.Vector3).set(d.to[0] - t.ox, d.to[1] - t.oz, d.to[2]);
  }

  private target(size: number, k: number): THREE.RenderTarget {
    let list = this.targets.get(size);
    if (list === undefined) this.targets.set(size, (list = []));
    while (list.length <= k) {
      const rt = new THREE.RenderTarget(size, size, { depthBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
      rt.texture.colorSpace = THREE.NoColorSpace;
      list.push(rt);
    }
    return list[k]!;
  }

  // ---- materials -------------------------------------------------------------------------

  /** A variant's material for a page (made once per page texture; let go with it). */
  private material(v: Variant, src: THREE.DataArrayTexture, t: TerrainBrushTile | null): NodeMaterial {
    const key = `${v}:${src.uuid}`;
    let m = this.materials.get(key);
    if (m === undefined) {
      m = new NodeMaterial();
      m.outputNode = v === 'copy' ? this.copyNode(src) : this.node(v, t!);
      m.depthTest = false;
      m.depthWrite = false;
      m.blending = THREE.NoBlending;
      m.toneMapped = false;
      this.materials.set(key, m);
      if (!this.unlisten.has(src)) {
        // A page grown or dropped disposes its textures: its materials go with them.
        const onDispose = (): void => {
          for (const [k, mat] of [...this.materials]) {
            if (!k.endsWith(`:${src.uuid}`)) continue;
            mat.dispose();
            this.materials.delete(k);
          }
          src.removeEventListener('dispose', onDispose);
          this.unlisten.delete(src);
        };
        src.addEventListener('dispose', onDispose);
        this.unlisten.set(src, () => src.removeEventListener('dispose', onDispose));
      }
    }
    return m;
  }

  /** The sample this fragment writes (its column, and its row counted the target's memory way), in the tile. */
  private sampleXZ(): { lx: N; lz: N } {
    const u = this.u;
    const col = int(floor(screenCoordinate.x));
    const sy = floor(screenCoordinate.y);
    const row = int(select(u.flip.greaterThan(0.5), u.rows.sub(1).sub(sy), sy));
    return { lx: int(u.rect.x).add(col), lz: int(u.rect.y).add(row) };
  }

  private copyNode(src: THREE.DataArrayTexture): N {
    const { lx, lz } = this.sampleXZ();
    return textureLoad(src, ivec2(lx, lz)).depth(int(this.u.layer));
  }

  private node(v: Variant, t: TerrainBrushTile): N {
    const u = this.u;
    const heights = t.heights;
    const layers = t.layers;
    const indices = t.indices;
    const n = int(u.cells);
    const sp = u.spacing;
    const layer = int(u.layer);
    const { lx, lz } = this.sampleXZ();
    const byte = (x: N): N => floor(x.mul(255).add(0.5)).div(255);
    const falloff = (d2: N): N => {
      const r2 = u.radius.mul(u.radius);
      const k = float(1).sub(d2.div(r2));
      const f = select(u.falloff.greaterThan(1.5), float(1), select(u.falloff.greaterThan(0.5), float(1).sub(sqrt(d2).div(u.radius)), k.mul(k)));
      return select(d2.lessThanEqual(r2), f, float(0));
    };
    const d2At = (x: N, z: N): N => {
      const dx = float(x).mul(sp).sub(u.centre.x);
      const dz = float(z).mul(sp).sub(u.centre.y);
      return dx.mul(dx).add(dz.mul(dz));
    };
    if (v === 'point' || v === 'smooth') {
      /** A sample's stored step and whether a tile holds it (local samples of this tile, one tile out at most). */
      const fetch = (x: N, z: N): { step: N; present: N } => {
        const ox = select(x.lessThan(int(0)), int(-1), select(x.greaterThan(n), int(1), int(0)));
        const oz = select(z.lessThan(int(0)), int(-1), select(z.greaterThan(n), int(1), int(0)));
        const rowOf = select(oz.lessThan(int(0)), u.around0, select(oz.greaterThan(int(0)), u.around2, u.around1));
        const l = select(ox.lessThan(int(0)), rowOf.x, select(ox.greaterThan(int(0)), rowOf.z, rowOf.y));
        const px = clamp(x.sub(ox.mul(n)), int(0), n);
        const pz = clamp(z.sub(oz.mul(n)), int(0), n);
        const tx = textureLoad(heights, ivec2(px, pz)).depth(int(max(l, float(0))));
        return { step: stepOf(tx), present: l.greaterThanEqual(0) };
      };
      const hash = (ix: N, iz: N): N => {
        const lane = (i: N, k: number): N => uint(i.add(int(HASH_BIAS))).mul(uint(k >>> 0)).sub(uint(Math.imul(HASH_BIAS, k) >>> 0));
        const seedLane = uint(u.seedHi).shiftLeft(uint(16)).bitOr(uint(u.seedLo));
        let h = lane(ix, HASH_K[0]).bitXor(lane(iz, HASH_K[1])).bitXor(seedLane);
        h = h.bitXor(h.shiftRight(uint(15))).mul(uint(HASH_K[3] >>> 0));
        h = h.bitXor(h.shiftRight(uint(13))).mul(uint(HASH_K[4] >>> 0));
        h = h.bitXor(h.shiftRight(uint(16)));
        return float(h).div(4294967296);
      };
      const noise = (x: N, z: N): N => {
        const fx0 = floor(x);
        const fz0 = floor(z);
        const ix = int(fx0);
        const iz = int(fz0);
        const fx = x.sub(fx0);
        const fz = z.sub(fz0);
        const sx = fx.mul(fx).mul(float(3).sub(fx.mul(2)));
        const sz = fz.mul(fz).mul(float(3).sub(fz.mul(2)));
        const a = hash(ix, iz);
        const b = hash(ix.add(int(1)), iz);
        const c = hash(ix, iz.add(int(1)));
        const d = hash(ix.add(int(1)), iz.add(int(1)));
        const top = a.add(b.sub(a).mul(sx));
        const bottom = c.add(d.sub(c).mul(sx));
        return top.add(bottom.sub(top).mul(sz)).mul(2).sub(1);
      };
      /** A sample's step after the dab (the cores' rounding: an integer step plus its rounded delta), and whether it is held. */
      const after = (x: N, z: N): { step: N; present: N } => {
        const here = fetch(x, z);
        const st = here.step;
        let delta: N;
        if (v === 'smooth') {
          let sum: N = float(0);
          let count: N = float(0);
          for (let b = -1; b <= 1; b++)
            for (let a = -1; a <= 1; a++) {
              const q = fetch(x.add(int(a)), z.add(int(b)));
              const on = select(q.present, float(1), float(0));
              sum = sum.add(q.step.mul(on));
              count = count.add(on);
            }
          delta = u.strength.mul(falloff(d2At(x, z))).mul(sum.div(max(count, 1)).sub(st));
        } else {
          const f = falloff(d2At(x, z));
          // A ramp: the slope between its ends, by the point's place along it.
          const px = float(x).mul(sp).sub(u.rampA.x);
          const pz = float(z).mul(sp).sub(u.rampA.y);
          const ux = u.rampB.x.sub(u.rampA.x);
          const uz = u.rampB.y.sub(u.rampA.y);
          const len2 = ux.mul(ux).add(uz.mul(uz));
          const along = select(len2.greaterThan(0), clamp(px.mul(ux).add(pz.mul(uz)).div(max(len2, 1e-12)), 0, 1), float(0));
          const rx = px.sub(along.mul(ux));
          const rz = pz.sub(along.mul(uz));
          const fr = falloff(rx.mul(rx).add(rz.mul(rz)));
          const slope = u.rampA.z.add(along.mul(u.rampB.z.sub(u.rampA.z)));
          const k = u.kind;
          const wx = u.origin.x.add(float(x).mul(sp)).div(u.scale);
          const wz = u.origin.y.add(float(z).mul(sp)).div(u.scale);
          delta = select(
            k.lessThan(0.5),
            u.strength.mul(f),
            select(
              k.lessThan(1.5),
              u.strength.mul(f).negate(),
              select(k.lessThan(2.5), u.strength.mul(f).mul(u.target.sub(st)), select(k.lessThan(3.5), u.strength.mul(f).mul(noise(wx, wz)), u.strength.mul(fr).mul(slope.sub(st)))),
            ),
          );
        }
        return { step: clamp(st.add(floor(delta.add(0.5))), 0, 65535), present: here.present };
      };
      return Fn(() => {
        const c = after(lx, lz);
        const v0 = c.step.toVar();
        const l = after(lx.sub(int(1)), lz);
        const r = after(lx.add(int(1)), lz);
        const b = after(lx, lz.sub(int(1)));
        const a = after(lx, lz.add(int(1)));
        // As the packer: across an edge from the neighbour, else one-sided.
        const x0 = select(l.present, l.step, v0);
        const x1 = select(r.present, r.step, v0);
        const z0 = select(b.present, b.step, v0);
        const z1 = select(a.present, a.step, v0);
        const dxn = select(l.present, float(1), float(0)).add(select(r.present, float(1), float(0)));
        const dzn = select(b.present, float(1), float(0)).add(select(a.present, float(1), float(0)));
        const gx = select(dxn.greaterThan(0), x1.sub(x0).mul(u.mps).div(max(dxn, 1).mul(sp)), float(0));
        const gz = select(dzn.greaterThan(0), z1.sub(z0).mul(u.mps).div(max(dzn, 1).mul(sp)), float(0));
        const inv = float(1).div(sqrt(gx.mul(gx).add(1).add(gz.mul(gz))));
        const hi = floor(v0.div(256));
        const lo = v0.sub(hi.mul(256));
        return vec4(hi.div(255), lo.div(255), byte(gx.negate().mul(inv).mul(0.5).add(0.5)), byte(gz.negate().mul(inv).mul(0.5).add(0.5)));
      })();
    }
    const texel = textureLoad(layers, ivec2(lx, lz)).depth(layer);
    if (v === 'holes') {
      // The cell whose min corner the sample is: cut (or filled) when its centre is within the radius.
      const dx = float(lx).add(0.5).mul(sp).sub(u.centre.x);
      const dz = float(lz).add(0.5).mul(sp).sub(u.centre.y);
      const inside = dx.mul(dx).add(dz.mul(dz)).lessThanEqual(u.radius.mul(u.radius)).and(lx.lessThan(n)).and(lz.lessThan(n));
      return vec4(texel.r, texel.g, texel.b, select(inside, float(1).sub(u.erase), texel.a));
    }
    const chan = floor(u.paintLayer.add(0.5)).mod(4);
    const one = (c: number): N => select(chan.equal(c), float(1), float(0));
    const amount = clamp(u.strength.mul(falloff(d2At(lx, lz))), 0, 1);
    const w = vec4(texel.r, texel.g, texel.b, max(float(1).sub(texel.r).sub(texel.g).sub(texel.b), 0));
    if (v === 'weights') {
      const toward = vec4(one(0), one(1), one(2), one(3));
      const moved = w.add(toward.sub(w).mul(amount));
      return vec4(byte(moved.x), byte(moved.y), byte(moved.z), texel.a);
    }
    // Indices: the painted layer where it is painted, and one sample around where its channel is empty (filtered weight shows it).
    const ids = textureLoad(indices, ivec2(lx, lz)).depth(layer);
    const reach = u.radius.add(sp.mul(1.5));
    const wc = select(chan.equal(0), w.x, select(chan.equal(1), w.y, select(chan.equal(2), w.z, w.w)));
    const set = amount.greaterThan(0).or(d2At(lx, lz).lessThanEqual(reach.mul(reach)).and(wc.mul(255).lessThan(0.5)));
    const id = u.paintLayer.div(255);
    const pick = (c: number, cur: N): N => select(set.and(chan.equal(c)), id, cur);
    return vec4(pick(0, ids.x), pick(1, ids.y), pick(2, ids.z), pick(3, ids.w));
  }
}
