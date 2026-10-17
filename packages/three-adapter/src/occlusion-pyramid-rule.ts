/**
 * The depth pyramid's layout and reduction rule, without a GPU: what the
 * compute passes in `occlusion-pyramid.ts` build and what a culling test
 * reads, and the CPU reference the tests hold them to.
 *
 * Level 0 is half the scene depth's size, rounded up; each next level half
 * the last, rounded up, down to 1 × 1. A texel holds the farthest depth of
 * the 2 × 2 texels under it (of the depth's pixels for level 0; of every
 * sample of a pixel when the depth is multisampled), so whatever a texel
 * says is in front of a box is in front of every pixel the box covers.
 * Rounding up covers odd sizes: a last row or column of a level reduces the
 * one texel left under it (the read is clamped to the edge), so every source
 * texel belongs to exactly one texel above it.
 *
 * "Farthest" depends on the depth buffer: the largest value for standard and
 * logarithmic depth, the smallest for reversed Z. Depth is stored as written
 * (no conversion that could round a far value nearer).
 *
 * `_OCC` stand-ins never write the scene's depth (ambient occlusion, fog and
 * transparent draws read it, and through a cut-out's gaps they must see what
 * is behind). They go into level 0 only: each stand-in fragment records, per
 * level-0 texel, which of its 2 × 2 pixels a stand-in covered and the
 * farthest stand-in depth among them. A covered pixel's depth is then the
 * nearer of its scene depth and that farthest stand-in depth: never nearer
 * than the stand-in that covers it, so the rule stays conservative.
 */

/** One level of the pyramid in its buffer: `width` × `height` texels, row-major from `offset`. */
export interface PyramidLevel {
  readonly width: number;
  readonly height: number;
  readonly offset: number;
}

export interface PyramidLayout {
  /** The scene depth's size the pyramid was laid out for. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly levels: readonly PyramidLevel[];
  /** Texels of every level together (the buffer's length in 32-bit values). */
  readonly texels: number;
}

/** The levels for a scene depth of `width` × `height` pixels (at least one level, 1 × 1 last). */
export function pyramidLayout(width: number, height: number): PyramidLayout {
  const w0 = Math.max(1, Math.floor(width));
  const h0 = Math.max(1, Math.floor(height));
  const levels: PyramidLevel[] = [];
  let w = Math.ceil(w0 / 2);
  let h = Math.ceil(h0 / 2);
  let offset = 0;
  for (;;) {
    levels.push({ width: w, height: h, offset });
    offset += w * h;
    if (w === 1 && h === 1) break;
    w = Math.ceil(w / 2);
    h = Math.ceil(h / 2);
  }
  return { sourceWidth: w0, sourceHeight: h0, levels, texels: offset };
}

/** The farther of two depths (reversed Z: the smaller). */
export function fartherDepth(a: number, b: number, reversed: boolean): number {
  return reversed ? Math.min(a, b) : Math.max(a, b);
}

/** The nearer of two depths (reversed Z: the larger). */
export function nearerDepth(a: number, b: number, reversed: boolean): number {
  return reversed ? Math.max(a, b) : Math.min(a, b);
}

/** What the stand-ins left for level 0: per texel, the covered pixels (bit `j * 2 + i` for pixel (2x + i, 2y + j)) and the farthest stand-in depth over them. */
export interface StandinCoverage {
  readonly mask: Uint8Array;
  readonly depth: Float32Array;
}

/**
 * The CPU reference: the whole pyramid of a scene depth (`samples` values a
 * pixel, sample-major inside a pixel; pixels row-major), with what the
 * stand-ins covered (absent: none). Returns every level in one array, laid
 * out as `pyramidLayout` says.
 */
export function reducePyramid(depth: ArrayLike<number>, width: number, height: number, reversed: boolean, samples = 1, standins?: StandinCoverage): Float32Array {
  const layout = pyramidLayout(width, height);
  const out = new Float32Array(layout.texels);
  const W = layout.sourceWidth;
  const H = layout.sourceHeight;
  const pixel = (x: number, y: number): number => {
    const p = (Math.min(y, H - 1) * W + Math.min(x, W - 1)) * samples;
    let d = depth[p]!;
    for (let s = 1; s < samples; s++) d = fartherDepth(d, depth[p + s]!, reversed);
    return d;
  };
  const l0 = layout.levels[0]!;
  for (let y = 0; y < l0.height; y++) {
    for (let x = 0; x < l0.width; x++) {
      const t = y * l0.width + x;
      const mask = standins?.mask[t] ?? 0;
      const covered = standins?.depth[t] ?? 0;
      let far: number | null = null;
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          let d = pixel(2 * x + i, 2 * y + j);
          if ((mask & (1 << (j * 2 + i))) !== 0) d = nearerDepth(d, covered, reversed);
          far = far === null ? d : fartherDepth(far, d, reversed);
        }
      }
      out[l0.offset + t] = far!;
    }
  }
  for (let k = 1; k < layout.levels.length; k++) {
    const src = layout.levels[k - 1]!;
    const dst = layout.levels[k]!;
    for (let y = 0; y < dst.height; y++) {
      for (let x = 0; x < dst.width; x++) {
        const at = (sx: number, sy: number): number => out[src.offset + Math.min(sy, src.height - 1) * src.width + Math.min(sx, src.width - 1)]!;
        const a = fartherDepth(at(2 * x, 2 * y), at(2 * x + 1, 2 * y), reversed);
        const b = fartherDepth(at(2 * x, 2 * y + 1), at(2 * x + 1, 2 * y + 1), reversed);
        out[dst.offset + y * dst.width + x] = fartherDepth(a, b, reversed);
      }
    }
  }
  return out;
}

/**
 * Whether `pyramid` keeps the rule level over level (each texel the farthest
 * of the 2 × 2 under it): what a read-back from the GPU is checked with when
 * its source depth cannot be read. Returns the first texel that breaks it.
 */
export function pyramidBreaks(pyramid: ArrayLike<number>, layout: PyramidLayout, reversed: boolean): { level: number; x: number; y: number; value: number; expected: number } | null {
  for (let k = 1; k < layout.levels.length; k++) {
    const src = layout.levels[k - 1]!;
    const dst = layout.levels[k]!;
    for (let y = 0; y < dst.height; y++) {
      for (let x = 0; x < dst.width; x++) {
        const at = (sx: number, sy: number): number => pyramid[src.offset + Math.min(sy, src.height - 1) * src.width + Math.min(sx, src.width - 1)]!;
        const expected = fartherDepth(fartherDepth(at(2 * x, 2 * y), at(2 * x + 1, 2 * y), reversed), fartherDepth(at(2 * x, 2 * y + 1), at(2 * x + 1, 2 * y + 1), reversed), reversed);
        const value = pyramid[dst.offset + y * dst.width + x]!;
        if (value !== expected) return { level: k, x, y, value, expected };
      }
    }
  }
  return null;
}
