/**
 * A square 2D window over the ground plane that follows the camera: the one
 * place the engine's camera-centred maps (the wind map, the interaction
 * field, and what later reads the same way) get their placement and their
 * world ↔ texel mapping.
 *
 * - The window is `texels`² cells of `cellM` metres. Its origin (the world
 *   x, z of texel (0, 0)'s corner) is snapped to whole steps of `stepCells`
 *   cells round the camera, so a texel always covers the same piece of
 *   ground: a map filled from the world stays put, and a map that carries
 *   state from frame to frame moves by whole cells (`moved`), never by a
 *   fraction that would smear it.
 * - Shaders map a world point with {@link CameraWindow.uvNode}; the CPU uses
 *   {@link CameraWindow.uvAt}; both are the same steps ({@link windowUvSteps}),
 *   so the tests' reference and the shader cannot drift.
 * - A window that carries state keeps it in {@link WindowTargets}: pairs of
 *   storage textures (a pass reads one and writes the other; the written one
 *   is copied back after the pass). A pass that scrolls reads its source
 *   texel through {@link scrolledSource}; texels entering the window have no
 *   source and start at the pass's default.
 *
 * The window itself holds no texture and costs nothing until a user makes
 * targets or reads the rect.
 */
import * as THREE from 'three';
import * as TSLTyped from 'three/tsl';
import { StorageTexture } from 'three/webgpu';

import type { N } from './effects-tsl';
import { CPU_SCALAR_OPS, TSL_SCALAR_OPS, type ScalarOps } from './field-ops';

const TSL: N = TSLTyped;

/** What a window is: its size in texels, a texel's size, and the step its origin moves by. */
export interface CameraWindowSpec {
  /** Texels a side. */
  readonly texels: number;
  /** Metres a texel spans. */
  readonly cellM: number;
  /** The origin moves in steps of this many cells (default 1: whole cells). */
  readonly stepCells?: number;
}

/** A world point (x, z) in the window's texture coordinates (0 … 1 across it): the one definition. */
export function windowUvSteps<F, B>(o: ScalarOps<F, B>, px: F, pz: F, x0: F, z0: F, inverseSide: F): { u: F; v: F } {
  return { u: o.mul(o.sub(px, x0), inverseSide), v: o.mul(o.sub(pz, z0), inverseSide) };
}

/** How many texels a point at (u, v) lies inside the window's nearest edge (negative: outside). */
export function windowEdgeSteps<F, B>(o: ScalarOps<F, B>, u: F, v: F, texels: number): F {
  const one = o.n(1);
  return o.mul(o.min(o.min(u, v), o.min(o.sub(one, u), o.sub(one, v))), o.n(texels));
}

export class CameraWindow {
  readonly texels: number;
  readonly cellM: number;
  /** Metres a side. */
  readonly side: number;
  private readonly step: number;
  /** The world x, z of texel (0, 0)'s corner (NaN until the first `follow`). */
  originX = NaN;
  originZ = NaN;
  /**
   * Whole cells the origin moved by at the last `follow` (x, z): a texel (i, j) now holds the ground texel
   * (i + moved x, j + moved z) held before. The first follow moves by the whole window (nothing carried over).
   */
  readonly moved: [number, number] = [0, 0];
  /** For shaders: [origin x, origin z, 1 / side, 1 when the window holds something to read]. */
  readonly rect: N = TSL.uniform(new THREE.Vector4()).setGroup(TSL.renderGroup);

  constructor(spec: CameraWindowSpec) {
    this.texels = spec.texels;
    this.cellM = spec.cellM;
    this.side = spec.texels * spec.cellM;
    this.step = (spec.stepCells ?? 1) * spec.cellM;
  }

  /** The origin (x, z) the window takes round a camera at (x, z). */
  private originFor(x: number, z: number): [number, number] {
    const half = this.side / 2;
    return [Math.round(x / this.step) * this.step - half, Math.round(z / this.step) * this.step - half];
  }

  /** Whether following a camera at (x, z) would move the window. */
  wouldMove(x: number, z: number): boolean {
    const [x0, z0] = this.originFor(x, z);
    return x0 !== this.originX || z0 !== this.originZ;
  }

  /** Centre the window on the camera's ground point; true when the origin moved (by `moved` cells). */
  follow(x: number, z: number): boolean {
    const [x0, z0] = this.originFor(x, z);
    if (x0 === this.originX && z0 === this.originZ) {
      this.moved[0] = 0;
      this.moved[1] = 0;
      return false;
    }
    const first = Number.isNaN(this.originX);
    this.moved[0] = first ? this.texels : Math.round((x0 - this.originX) / this.cellM);
    this.moved[1] = first ? this.texels : Math.round((z0 - this.originZ) / this.cellM);
    this.originX = x0;
    this.originZ = z0;
    const r = this.rect.value as THREE.Vector4;
    r.x = x0;
    r.y = z0;
    r.z = 1 / this.side;
    return true;
  }

  /** Whether shaders read the window (off: they take their fallback). */
  setOn(on: boolean): void {
    (this.rect.value as THREE.Vector4).w = on ? 1 : 0;
  }

  on(): boolean {
    return (this.rect.value as THREE.Vector4).w > 0;
  }

  /** The window's centre (world x, z). */
  centre(): [number, number] {
    return [this.originX + this.side / 2, this.originZ + this.side / 2];
  }

  /** A world point in texture coordinates (CPU). */
  uvAt(x: number, z: number): [number, number] {
    const { u, v } = windowUvSteps(CPU_SCALAR_OPS, x, z, this.originX, this.originZ, 1 / this.side);
    return [u, v];
  }

  /** The texel a world point lies in (null: outside the window). */
  texelAt(x: number, z: number): [number, number] | null {
    const [u, v] = this.uvAt(x, z);
    const i = Math.floor(u * this.texels);
    const j = Math.floor(v * this.texels);
    return i >= 0 && j >= 0 && i < this.texels && j < this.texels ? [i, j] : null;
  }

  /** A texel's centre (world x, z). */
  texelCentre(i: number, j: number): [number, number] {
    return [this.originX + (i + 0.5) * this.cellM, this.originZ + (j + 0.5) * this.cellM];
  }

  /** A world ground point `p` (vec2 x, z) in texture coordinates (vec2), in a shader. */
  uvNode(p: N): N {
    const r = this.rect;
    const { u, v } = windowUvSteps(TSL_SCALAR_OPS, p.x, p.y, r.x, r.y, r.z);
    return TSL.vec2(u, v);
  }

  /** Texels inside the nearest edge at `uv` (negative outside), in a shader. */
  edgeNode(uv: N): N {
    return windowEdgeSteps(TSL_SCALAR_OPS, uv.x, uv.y, this.texels);
  }

  /** A texel's centre (vec2 world x, z) from its integer coordinates (uvec2 or ivec2), in a shader. */
  texelCentreNode(texel: N): N {
    const r = this.rect;
    return TSL.vec2(r.x, r.y).add(TSL.vec2(texel).add(0.5).mul(this.cellM));
  }
}

/**
 * Where a scrolling pass reads texel `texel` (ivec2) from after the origin moved by `moved` (an ivec2 node, whole
 * cells): the source texel and whether it lies in the window (false: the texel entered and starts at the default).
 */
export function scrolledSource(texel: N, moved: N, texels: number): { source: N; inside: N } {
  const source = TSL.ivec2(texel).add(moved);
  const inside = source.x.greaterThanEqual(0).and(source.y.greaterThanEqual(0)).and(source.x.lessThan(texels)).and(source.y.lessThan(texels));
  return { source, inside };
}

/** The CPU twin of {@link scrolledSource} (tests, references). */
export function scrolledSourceAt(i: number, j: number, moved: readonly [number, number], texels: number): [number, number] | null {
  const si = i + moved[0];
  const sj = j + moved[1];
  return si >= 0 && sj >= 0 && si < texels && sj < texels ? [si, sj] : null;
}

/** Bytes a texel of each kind of target holds. */
const BYTES_PER_TEXEL: Readonly<Record<'half4', number>> = { half4: 8 };

/**
 * A window's state textures: `count` pairs of `texels`² RGBA half-float storage textures. A pass reads `read[k]`
 * and writes `write[k]`; `commit` copies each written one back, so readers bind one texture for good. Nothing
 * reaches the GPU until a pass or a reader uses them.
 */
export class WindowTargets {
  readonly read: StorageTexture[];
  readonly write: StorageTexture[];
  private used = false;

  constructor(
    readonly texels: number,
    readonly count: number,
  ) {
    const make = (name: string): StorageTexture => {
      const t = new StorageTexture(texels, texels);
      t.type = THREE.HalfFloatType;
      t.format = THREE.RGBAFormat;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearFilter;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.name = name;
      return t;
    };
    this.read = Array.from({ length: count }, (_, k) => make(`window read ${k}`));
    this.write = Array.from({ length: count }, (_, k) => make(`window write ${k}`));
  }

  /** After the pass that wrote `write`: copy each into `read` (the textures readers bind). */
  commit(renderer: { copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture): void }): void {
    this.used = true;
    for (let k = 0; k < this.count; k++) renderer.copyTextureToTexture(this.write[k]!, this.read[k]!);
  }

  /** GPU bytes held once used (0 before the first pass). */
  bytes(): number {
    return this.used ? this.count * 2 * this.texels * this.texels * BYTES_PER_TEXEL.half4 : 0;
  }

  dispose(): void {
    for (const t of [...this.read, ...this.write]) t.dispose();
    this.used = false;
  }
}
