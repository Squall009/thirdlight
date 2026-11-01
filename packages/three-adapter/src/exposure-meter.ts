/**
 * The auto-exposure meter: the frame's luminance on a small grid, read back
 * without a stall.
 *
 * Two small passes after the frame, one TSL program each, the same on
 * WebGPU and WebGL 2:
 *
 * 1. a 128 × 64 grid across the scene colour (linear, before exposure,
 *    bloom and tone mapping): each texel the mean log2 luminance of 4 × 4
 *    filtered taps spread over its share of the frame;
 * 2. that grid down to `METER_WIDTH × METER_HEIGHT`: each texel the mean of
 *    an 8 × 8 block (texel loads: both grids are full float, which need not
 *    be filterable).
 *
 * The small grid (128 texels) is read back asynchronously (three's
 * `readRenderTargetPixelsAsync`: a mapped buffer on WebGPU, a pixel-pack
 * buffer and a fence on WebGL 2); one read is in flight at a time and the
 * newest reading is kept, so the exposure follows the frame a frame or two
 * late and the main thread never waits. The weighting (centre or average) is
 * applied on the CPU (runtime `meteredLogLuminance`), so a blend of metering
 * modes changes no program.
 */
import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { METER_MIN_LUMINANCE } from '@thirdlight/runtime';

import type { N } from './effects-tsl';

const TSL = TSLTyped as unknown as Record<string, N>;
const { Fn, clamp, float, ivec2, log2, luminance, screenCoordinate, texture, uv, vec2, vec4 } = TSL;

/** The metered grid read back (texels across and down). */
export const METER_WIDTH = 16;
export const METER_HEIGHT = 8;
/** The first pass's grid: this many of the read-back texels' width and height each. */
const BLOCK = 8;
/** Filtered taps across (and down) a texel of the first pass. */
const TAPS = 4;
/** Half-float's largest value: a hotter pixel (a sun disc, an overflow) meters as this. */
const MAX_LUMINANCE = 65504;

interface ReadingRenderer {
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(t: THREE.RenderTarget | null): void;
  readRenderTargetPixelsAsync(t: THREE.RenderTarget, x: number, y: number, w: number, h: number): Promise<ArrayBufferView>;
}

/** A pass whose texels are the mean of `n` × `n` samples `f(i, j)`, written to red. */
function meanPass(name: string, n: number, f: (i: number, j: number) => N): THREE.QuadMesh {
  const material = new THREE.NodeMaterial();
  material.name = name;
  material.outputNode = Fn(() => {
    let sum: N = float(0);
    for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) sum = sum.add(f(i, j));
    return vec4(sum.div(n * n), 0, 0, 1);
  })();
  material.depthTest = false;
  material.depthWrite = false;
  return new THREE.QuadMesh(material);
}

// Both grids alike (full float RGBA, no depth): three draws them in one render context, timed as one pass.
const target = (w: number, h: number): THREE.RenderTarget =>
  new THREE.RenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, generateMipmaps: false });

export class ExposureMeter {
  /** The newest metered grid (mean log2 luminance per texel, RGBA floats: red read) and how many readings came. */
  latest: Float32Array | null = null;
  readings = 0;
  private readonly source: N = texture(new THREE.Texture());
  private readonly fine = target(METER_WIDTH * BLOCK, METER_HEIGHT * BLOCK);
  private readonly coarse = target(METER_WIDTH, METER_HEIGHT);
  // Taps spread over each texel's share of the frame (filtered: each a 2 × 2 pixel mean of the scene colour).
  private readonly finePass = meanPass('exposure-meter', TAPS, (i, j) => {
    const at = uv().add(vec2(((i + 0.5) / TAPS - 0.5) / (METER_WIDTH * BLOCK), ((j + 0.5) / TAPS - 0.5) / (METER_HEIGHT * BLOCK)));
    return log2(clamp(luminance(this.source.sample(at).rgb), METER_MIN_LUMINANCE, MAX_LUMINANCE));
  });
  // The block of the fine grid under each texel (rows may come mirrored on one backend: a whole block either way).
  private readonly coarsePass = meanPass('exposure-reduce', BLOCK, (i, j) => texture(this.fine.texture).load(ivec2(screenCoordinate.xy).mul(BLOCK).add(ivec2(i, j))).r);
  private busy = false;
  private disposed = false;

  /** Meter `scene` (the scene pass's colour, just drawn) and start a read-back unless one is in flight. */
  measure(renderer: unknown, scene: THREE.Texture): void {
    if (this.disposed) return;
    const r = renderer as ReadingRenderer;
    this.source.value = scene;
    const was = r.getRenderTarget();
    try {
      r.setRenderTarget(this.fine);
      this.finePass.render(renderer as THREE.Renderer);
      r.setRenderTarget(this.coarse);
      this.coarsePass.render(renderer as THREE.Renderer);
    } finally {
      r.setRenderTarget(was);
    }
    if (this.busy) return;
    this.busy = true;
    r.readRenderTargetPixelsAsync(this.coarse, 0, 0, METER_WIDTH, METER_HEIGHT).then(
      (px) => {
        this.busy = false;
        if (this.disposed) return;
        this.latest = px instanceof Float32Array ? px : new Float32Array((px as Float32Array).buffer);
        this.readings += 1;
      },
      () => {
        this.busy = false;
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    this.fine.dispose();
    this.coarse.dispose();
    (this.finePass.material as THREE.Material).dispose();
    (this.coarsePass.material as THREE.Material).dispose();
  }
}
