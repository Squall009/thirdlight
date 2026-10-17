/**
 * The depth pyramid on WebGPU: compute passes that reduce the scene pass's
 * depth after the frame's first pass (occlusion-passes.ts), level by level,
 * into one storage buffer, by the rule and layout of
 * `occlusion-pyramid-rule.ts`. A culling test reads it from the same buffer.
 *
 * - Two dispatches in one compute pass (WebGPU orders them and makes the
 *   first's writes visible to the second). The first works in 16 × 16 tiles
 *   of level 0 (32 × 32 depth pixels, 2 × 2 texels a thread): a tile reads the depth texture (every
 *   sample of a multisampled one) and what `_OCC` stand-ins recorded for it,
 *   then reduces itself in workgroup memory down to level 4 (one texel),
 *   writing each level on the way. The second, one workgroup, reduces the
 *   rest from level 4 down to 1 × 1. So the deep levels never go through
 *   memory between dispatches, and the CPU encodes two dispatches a frame
 *   whatever the size. A tile's texels past a level's edge are reduced from
 *   clamped reads, so they repeat the edge's own inputs and never change a
 *   texel inside.
 * - Stand-ins draw with {@link DepthPyramid.standinMaterial}: no colour, no
 *   depth test, no depth write; each fragment records into two small buffers
 *   which of its level-0 texel's pixels it covers and the farthest stand-in
 *   depth over them. Level 0 folds them in and clears them for the next
 *   frame. They are made only once a stand-in draws (a scene without `_OCC`
 *   nodes holds the pyramid alone).
 * - The buffer is laid out for the largest depth it has been asked to reduce
 *   (the scene pass at full resolution), so a lower render scale or dynamic
 *   resolution reuses it; a larger size makes the buffer and the passes
 *   again.
 *
 * Depth is reduced as written: standard and logarithmic depth keep the
 * largest value, reversed Z the smallest (`renderer.reversedDepthBuffer`,
 * read when the passes are made: three falls back to standard depth where
 * the device has no reversed Z).
 */
import type * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';

import { releaseStorage } from './dispose';
import type { N } from './effects-tsl';
import { pyramidLayout, type PyramidLayout } from './occlusion-pyramid-rule';

/** TSL untyped (see effects-tsl.ts). */
const TSL: N = TSLTyped;

/** Level-0 texels a side of the first dispatch's tiles (its workgroup is TILE / 2 × TILE / 2 threads, 2 × 2 texels each). */
const TILE = 16;
/** Levels the first dispatch writes: a tile reduces to one texel at level log2(TILE). */
const TILE_LEVELS = 5;
/** Threads of the second dispatch's one workgroup. */
const TAIL_THREADS = 256;
/** Level-0 texels whose stand-in coverage (4 bits each) one 32-bit word holds. */
const MASK_TEXELS_PER_WORD = 8;
/** The "no stand-in yet" value of a texel's farthest stand-in depth, as float bits: 0 for standard depth, +infinity for reversed Z (they keep the largest, the smallest). */
const STANDIN_EMPTY = { standard: 0, reversed: 0x7f800000 } as const;

/** What the pyramid is reduced from: the scene pass's depth after the first pass. */
export interface PyramidSource {
  readonly depth: THREE.Texture;
  /** The depth's size in pixels (the scene pass's internal size). */
  readonly width: number;
  readonly height: number;
  /** MSAA samples of the depth (0 or 1: one). */
  readonly samples: number;
}

/** A read-back of the pyramid (an e2e check against the rule). */
export interface PyramidReadback {
  readonly layout: PyramidLayout;
  readonly reversed: boolean;
  readonly data: Float32Array;
}

interface Standins {
  /** Level-0 texels the buffers hold. */
  readonly texels: number;
  /** Per texel the farthest stand-in depth (float bits; atomic), per 8 texels their covered pixels (4 bits each; atomic). */
  readonly depthBits: N;
  readonly mask: N;
  readonly material: MeshBasicNodeMaterial;
}

/**
 * The depth buffer's value at view-space z (TSL): the formula three's own
 * materials and projection use for the camera's kind and the depth buffer
 * (what the pyramid holds and a culling test compares with).
 */
export function depthOfViewZNode(z: N, near: N, far: N, kind: { readonly perspective: boolean; readonly reversed: boolean; readonly logarithmic: boolean }): N {
  if (kind.perspective) {
    if (kind.logarithmic) return TSL.viewZToLogarithmicDepth(z, near, far);
    return kind.reversed ? TSL.viewZToReversedPerspectiveDepth(z, near, far) : TSL.viewZToPerspectiveDepth(z, near, far);
  }
  return kind.reversed ? TSL.viewZToReversedOrthographicDepth(z, near, far) : TSL.viewZToOrthographicDepth(z, near, far);
}

/** Farther / nearer of two depths in the shader, for reversed Z or not. */
function fartherOf(reversed: boolean): (a: N, b: N) => N {
  return reversed ? (a, b) => TSL.min(a, b) : (a, b) => TSL.max(a, b);
}
function nearerOf(reversed: boolean): (a: N, b: N) => N {
  return reversed ? (a, b) => TSL.max(a, b) : (a, b) => TSL.min(a, b);
}

export class DepthPyramid {
  /** The layout of the last reduction (null before the first). */
  private current: PyramidLayout | null = null;
  /** Texels the buffer holds, and the level-0 size it was made for. */
  private capacity = 0;
  private capacityLevel0 = 0;
  private buffer: N = null;
  /** The two dispatches, made again when the buffer, the stand-ins, the depth or its samples change. */
  private tiles: N = null;
  private tail: N = null;
  private passKey = '';
  /** The depth's size and the levels the tiles write (width, height, offset each; past the last level: 0). */
  private readonly size = { width: TSL.uniform(1, 'uint'), height: TSL.uniform(1, 'uint'), width0: TSL.uniform(1, 'uint'), height0: TSL.uniform(1, 'uint') };
  private readonly tileLevels = Array.from({ length: TILE_LEVELS }, () => ({ width: TSL.uniform(0, 'uint'), height: TSL.uniform(0, 'uint'), offset: TSL.uniform(0, 'uint') }));
  /** Levels in all (the tail reduces from the last tile level to the end). */
  private readonly levelCount = TSL.uniform(1, 'uint');
  private standins: Standins | null = null;
  /** Bumped when the buffer is made again (whatever reads it binds the new one). */
  generation = 0;
  private disposed = false;

  constructor(private readonly renderer: WebGPURenderer) {}

  /** Whether depth is reversed Z on this renderer (farthest = smallest). */
  get reversed(): boolean {
    return (this.renderer as { reversedDepthBuffer?: boolean }).reversedDepthBuffer === true;
  }

  layout(): PyramidLayout | null {
    return this.current;
  }

  /** The buffer every level is in (float per texel; null before the first reduction). */
  storage(): THREE.BufferAttribute | null {
    return (this.buffer?.value as THREE.BufferAttribute | undefined) ?? null;
  }

  /** GPU memory the pyramid and the stand-ins' records hold, in bytes. */
  bytes(): number {
    const standins = this.standins === null ? 0 : this.standins.texels * 4 + Math.ceil(this.standins.texels / MASK_TEXELS_PER_WORD) * 4;
    return this.capacity * 4 + standins;
  }

  /**
   * Reduce `source` into the pyramid (after the first pass, before the
   * second). `then` may give a compute node that reads the pyramid: it runs in
   * the same compute pass, after the reduction (one submit a frame).
   */
  build(source: PyramidSource, then?: () => N | null): void {
    if (this.disposed) return;
    const layout = pyramidLayout(source.width, source.height);
    const l0 = layout.levels[0]!;
    if (layout.texels > this.capacity || l0.width * l0.height > this.capacityLevel0) this.allocate(layout);
    const samples = Math.max(1, source.samples);
    const key = `${this.generation}|${samples}|${this.standins?.texels ?? 0}|${source.depth.uuid}|${this.reversed}`;
    if (key !== this.passKey) this.makePasses(source.depth, samples);
    this.size.width.value = layout.sourceWidth;
    this.size.height.value = layout.sourceHeight;
    this.size.width0.value = l0.width;
    this.size.height0.value = l0.height;
    this.tileLevels.forEach((u, k) => {
      const lv = layout.levels[k];
      u.width.value = lv?.width ?? 0;
      u.height.value = lv?.height ?? 0;
      u.offset.value = lv?.offset ?? 0;
    });
    this.levelCount.value = layout.levels.length;
    this.tiles.dispatchSize = [Math.ceil(l0.width / TILE), Math.ceil(l0.height / TILE), 1];
    const nodes: N[] = layout.levels.length > TILE_LEVELS ? [this.tiles, this.tail] : [this.tiles];
    this.current = layout;
    const after = then?.() ?? null;
    if (after !== null) nodes.push(after);
    void this.renderer.compute(nodes);
  }

  /**
   * The material `_OCC` stand-ins draw with while the pyramid is built: they
   * record into level 0 only (the scene's depth never sees them). Made, with
   * its buffers, the first time a stand-in asks after the first reduction
   * (null before it: level 0's size is not known yet). Made again when level
   * 0 grows: ask each frame.
   */
  standinMaterial(): MeshBasicNodeMaterial | null {
    if (this.capacityLevel0 === 0 || this.disposed) return null;
    if (this.standins === null) this.standins = this.makeStandins(this.capacityLevel0);
    return this.standins.material;
  }

  /** The pyramid as last reduced, read back from the GPU (null before the first reduction). */
  async read(): Promise<PyramidReadback | null> {
    const layout = this.current;
    const attr = this.storage();
    if (layout === null || attr === null) return null;
    const bytes = await this.renderer.getArrayBufferAsync(attr as never);
    return { layout, reversed: this.reversed, data: new Float32Array(bytes.slice(0, layout.texels * 4)) };
  }

  /**
   * A colour node that shows level `level` over the screen (`?occlusion=pyramid`): near is bright, far and the
   * sky dark, by view distance on a log scale up to the camera's far plane. `near` / `far` are the drawn camera's.
   */
  viewNode(level: number, camera: { near: N; far: N }, logarithmic: boolean): N {
    const layout = this.current;
    const attr = this.storage();
    if (layout === null || attr === null) return TSL.vec4(0, 0, 0, 1);
    const lv = layout.levels[Math.max(0, Math.min(layout.levels.length - 1, Math.floor(level)))]!;
    const reversed = this.reversed;
    const read: N = TSL.storage(attr, 'float', this.capacity).toReadOnly();
    return TSL.Fn(() => {
      const t = TSL.uvec2(TSL.screenUV.mul(TSL.vec2(lv.width, lv.height)).floor());
      const x = TSL.min(t.x, TSL.uint(lv.width - 1));
      const y = TSL.min(t.y, TSL.uint(lv.height - 1));
      const d = read.element(TSL.uint(lv.offset).add(y.mul(lv.width)).add(x));
      const viewZ = logarithmic ? TSL.logarithmicDepthToViewZ(d, camera.near, camera.far) : TSL.perspectiveDepthToViewZ(reversed ? TSL.float(1).sub(d) : d, camera.near, camera.far);
      const shade = TSL.float(1).sub(TSL.log2(TSL.float(1).add(viewZ.negate().max(0))).div(TSL.log2(TSL.float(1).add(camera.far))));
      return TSL.vec4(TSL.vec3(TSL.clamp(shade, 0, 1)), 1);
    })();
  }

  dispose(): void {
    this.disposed = true;
    this.freePasses();
    this.freeStandins();
    if (this.buffer !== null) releaseStorage(this.renderer, [this.buffer.value]);
    this.buffer = null;
    this.capacity = 0;
    this.capacityLevel0 = 0;
  }

  private allocate(layout: PyramidLayout): void {
    if (this.buffer !== null) releaseStorage(this.renderer, [this.buffer.value]);
    this.capacity = Math.max(this.capacity, layout.texels);
    const l0 = layout.levels[0]!;
    this.capacityLevel0 = Math.max(this.capacityLevel0, l0.width * l0.height);
    this.buffer = TSL.instancedArray(this.capacity, 'float');
    this.generation += 1;
    // The stand-ins' records follow level 0's size (a stand-in's material binds them: it is made again).
    if (this.standins !== null && this.standins.texels < this.capacityLevel0) {
      this.freeStandins();
      this.standins = this.makeStandins(this.capacityLevel0);
    }
  }

  private makeStandins(texels: number): Standins {
    const reversed = this.reversed;
    const empty = reversed ? STANDIN_EMPTY.reversed : STANDIN_EMPTY.standard;
    const depthBits: N = TSL.instancedArray(new Uint32Array(texels).fill(empty), 'uint');
    const mask: N = TSL.instancedArray(Math.ceil(texels / MASK_TEXELS_PER_WORD), 'uint');
    const depthAtomic: N = TSL.storage(depthBits.value, 'uint', texels).toAtomic();
    const maskAtomic: N = TSL.storage(mask.value, 'uint', Math.ceil(texels / MASK_TEXELS_PER_WORD)).toAtomic();
    const material = new MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
    material.name = 'tl-occluder-standin-pyramid';
    const { width0, height0 } = this.size;
    const logarithmic = (this.renderer as { logarithmicDepthBuffer?: boolean }).logarithmicDepthBuffer === true;
    // The depth this fragment would have: the formula three's own materials and projection use, for this camera and depth buffer.
    const fragmentDepth = TSL.Fn((_: unknown, builder: { camera: { isPerspectiveCamera?: boolean } }) =>
      depthOfViewZNode(TSL.positionView.z, TSL.cameraNear, TSL.cameraFar, { perspective: builder.camera.isPerspectiveCamera === true, reversed, logarithmic }),
    );
    material.colorNode = TSL.Fn(() => {
      const px = TSL.uvec2(TSL.screenCoordinate.floor());
      const tx = px.x.shiftRight(1);
      const ty = px.y.shiftRight(1);
      TSL.If(tx.lessThan(width0).and(ty.lessThan(height0)), () => {
        const t = ty.mul(width0).add(tx);
        const bit = px.y.bitAnd(1).mul(2).add(px.x.bitAnd(1));
        TSL.atomicOr(maskAtomic.element(t.div(MASK_TEXELS_PER_WORD)), TSL.uint(1).shiftLeft(t.mod(MASK_TEXELS_PER_WORD).mul(4).add(bit)));
        const bits = TSL.floatBitsToUint(fragmentDepth());
        if (reversed) TSL.atomicMin(depthAtomic.element(t), bits);
        else TSL.atomicMax(depthAtomic.element(t), bits);
      });
      return TSL.vec4(0);
    })();
    return { texels, depthBits, mask, material };
  }

  private makePasses(depth: THREE.Texture, samples: number): void {
    this.freePasses();
    const reversed = this.reversed;
    const farther = fartherOf(reversed);
    const nearer = nearerOf(reversed);
    const out: N = this.buffer;
    const { width, height, width0, height0 } = this.size;
    const s = this.standins;
    const empty = reversed ? STANDIN_EMPTY.reversed : STANDIN_EMPTY.standard;
    const depthAtomic: N = s === null ? null : TSL.storage(s.depthBits.value, 'uint', s.texels).toAtomic();
    const maskAtomic: N = s === null ? null : TSL.storage(s.mask.value, 'uint', Math.ceil(s.texels / MASK_TEXELS_PER_WORD)).toAtomic();
    const depthTexture: N = TSL.texture(depth);
    const levels = this.tileLevels;
    const levelCount = this.levelCount;
    // Level 1 onwards in workgroup memory, ping-pong: level k reads one array and writes the other.
    const shared = [TSL.workgroupArray('float', (TILE * TILE) / 4), TSL.workgroupArray('float', (TILE * TILE) / 16)];
    const half = TILE / 2;
    this.tiles = TSL.Fn(() => {
      const lx = TSL.localId.x;
      const ly = TSL.localId.y;
      // Each thread reduces 2 × 2 texels of level 0 (4 × 4 depth pixels) and from them one texel of level 1.
      const texels: { t: N; inside: N; word: N; nibble: N; v: N }[] = [];
      for (let b = 0; b < 2; b++) {
        for (let a = 0; a < 2; a++) {
          const gx = TSL.workgroupId.x.mul(TILE).add(lx.mul(2)).add(a);
          const gy = TSL.workgroupId.y.mul(TILE).add(ly.mul(2)).add(b);
          // Past the edge: the edge texel again (it lies in this tile), so it repeats the edge's own inputs.
          const x = TSL.min(gx, width0.sub(1));
          const y = TSL.min(gy, height0.sub(1));
          const t = y.mul(width0).add(x).toVar();
          const word = t.div(MASK_TEXELS_PER_WORD);
          const nibble = t.mod(MASK_TEXELS_PER_WORD).mul(4);
          const covered: N = s === null ? null : TSL.atomicLoad(maskAtomic.element(word)).shiftRight(nibble).toVar();
          const standinDepth: N = s === null ? null : TSL.uintBitsToFloat(TSL.atomicLoad(depthAtomic.element(t))).toVar();
          let far: N = null;
          for (let j = 0; j < 2; j++) {
            for (let k = 0; k < 2; k++) {
              const coord = TSL.ivec2(TSL.min(x.mul(2).add(k), width.sub(1)), TSL.min(y.mul(2).add(j), height.sub(1)));
              // On a multisampled depth the level is the sample.
              let d: N = depthTexture.load(coord).level(TSL.int(0));
              for (let m = 1; m < samples; m++) d = farther(d, depthTexture.load(coord).level(TSL.int(m)));
              if (s !== null) d = TSL.select(covered.bitAnd(1 << (j * 2 + k)).notEqual(0), nearer(d, standinDepth), d);
              far = far === null ? d : farther(far, d);
            }
          }
          const v = TSL.float(far).toVar();
          const inside = gx.lessThan(width0).and(gy.lessThan(height0));
          TSL.If(inside, () => {
            out.element(levels[0]!.offset.add(t)).assign(v);
          });
          texels.push({ t, inside, word, nibble, v });
        }
      }
      const v1 = farther(farther(texels[0]!.v, texels[1]!.v), farther(texels[2]!.v, texels[3]!.v)).toVar();
      shared[0]!.element(ly.mul(half).add(lx)).assign(v1);
      const l1 = levels[1]!;
      const x1 = TSL.workgroupId.x.mul(half).add(lx);
      const y1 = TSL.workgroupId.y.mul(half).add(ly);
      TSL.If(TSL.uint(1).lessThan(levelCount).and(x1.lessThan(l1.width)).and(y1.lessThan(l1.height)), () => {
        out.element(l1.offset.add(y1.mul(l1.width)).add(x1)).assign(v1);
      });
      // Every read of this tile's stand-in records is done before the texels inside clear them for the next frame.
      TSL.workgroupBarrier();
      if (s !== null) {
        for (const tx of texels) {
          TSL.If(tx.inside, () => {
            TSL.atomicStore(depthAtomic.element(tx.t), TSL.uint(empty));
            TSL.atomicAnd(maskAtomic.element(tx.word), TSL.uint(0xf).shiftLeft(tx.nibble).bitNot());
          });
        }
      }
      for (let k = 2; k < TILE_LEVELS; k++) {
        const side = TILE >> k;
        const src = shared[k % 2]!;
        const dst = shared[(k + 1) % 2]!;
        TSL.If(lx.lessThan(side).and(ly.lessThan(side)), () => {
          const at = (dx: number, dy: number): N => src.element(ly.mul(2).add(dy).mul(side * 2).add(lx.mul(2).add(dx)));
          const v = farther(farther(at(0, 0), at(1, 0)), farther(at(0, 1), at(1, 1))).toVar();
          dst.element(ly.mul(side).add(lx)).assign(v);
          const gx = TSL.workgroupId.x.mul(side).add(lx);
          const gy = TSL.workgroupId.y.mul(side).add(ly);
          const lv = levels[k]!;
          TSL.If(TSL.uint(k).lessThan(levelCount).and(gx.lessThan(lv.width)).and(gy.lessThan(lv.height)), () => {
            out.element(lv.offset.add(gy.mul(lv.width)).add(gx)).assign(v);
          });
        });
        TSL.workgroupBarrier();
      }
    })().compute([1, 1, 1], [half, half]);
    const last = levels[TILE_LEVELS - 1]!;
    this.tail = TSL.Fn(() => {
      const id = TSL.localId.x;
      const srcOffset = TSL.uint(last.offset).toVar();
      const srcWidth = TSL.uint(last.width).toVar();
      const srcHeight = TSL.uint(last.height).toVar();
      TSL.Loop({ start: TSL.uint(TILE_LEVELS), end: levelCount, type: 'uint', condition: '<', name: 'level' }, () => {
        const dstOffset = srcOffset.add(srcWidth.mul(srcHeight)).toVar();
        const dstWidth = srcWidth.add(1).div(2).toVar();
        const dstHeight = srcHeight.add(1).div(2).toVar();
        TSL.Loop({ start: id, end: dstWidth.mul(dstHeight), type: 'uint', condition: '<', update: TAIL_THREADS, name: 'texel' }, ({ texel: i }: { texel: N }) => {
          const x = i.mod(dstWidth).mul(2);
          const y = i.div(dstWidth).mul(2);
          const at = (dx: number, dy: number): N => out.element(srcOffset.add(TSL.min(y.add(dy), srcHeight.sub(1)).mul(srcWidth)).add(TSL.min(x.add(dx), srcWidth.sub(1))));
          out.element(dstOffset.add(i)).assign(farther(farther(at(0, 0), at(1, 0)), farther(at(0, 1), at(1, 1))));
        });
        // This level is written before the next reads it.
        TSL.storageBarrier();
        srcOffset.assign(dstOffset);
        srcWidth.assign(dstWidth);
        srcHeight.assign(dstHeight);
      });
    })().compute([1, 1, 1], [TAIL_THREADS]);
    this.passKey = `${this.generation}|${samples}|${s?.texels ?? 0}|${depth.uuid}|${reversed}`;
  }

  private freePasses(): void {
    this.tiles?.dispose?.();
    this.tail?.dispose?.();
    this.tiles = null;
    this.tail = null;
    this.passKey = '';
  }

  private freeStandins(): void {
    if (this.standins === null) return;
    this.standins.material.dispose();
    releaseStorage(this.renderer, [this.standins.depthBits.value, this.standins.mask.value]);
    this.standins = null;
    // Level 0 bound them.
    this.passKey = '';
  }
}
