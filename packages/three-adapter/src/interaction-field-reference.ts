/**
 * Test-only: the interaction field on the CPU — the pass and the foliage
 * read of `interaction-field.ts` run with numbers over the same steps
 * (`stampSteps`, `decaySteps`, `bendPushSteps`, `bendOffsetSteps`) and the
 * same window (`CameraWindow`), with float32 state and the sampler's
 * bilinear filter (clamped to the edge). NOT part of the public surface —
 * imported only by .test.ts files.
 */
import { CameraWindow, scrolledSourceAt } from './camera-window';
import { CPU_SCALAR_OPS } from '@thirdlight/shared';
import { bendCapacity, bendOffsetSteps, bendPushSteps, decaySteps, INTERACTION_CELL_M, INTERACTION_TEXELS, PRESSED_EPSILON, stampSteps, STAMP_FLOATS, type InteractionStamps } from './interaction-field';

export class InteractionFieldReference {
  readonly window: CameraWindow;
  /** A: velocity x, z, pressed, foot; B: top, rate, radius, press as stamped (heights relative to `base`). */
  a: Float32Array;
  b: Float32Array;
  base: number | null = null;

  constructor(readonly texels = INTERACTION_TEXELS, readonly cellM = INTERACTION_CELL_M) {
    this.window = new CameraWindow({ texels, cellM });
    this.a = new Float32Array(texels * texels * 4);
    this.b = new Float32Array(texels * texels * 4);
  }

  /** One pass: scroll and decay, then the stamps (heights absolute). */
  step(stamps: InteractionStamps, eye: readonly [number, number, number], dt: number): void {
    const T = this.texels;
    this.window.follow(eye[0], eye[2]);
    const base = Math.round(eye[1]);
    const shift = this.base === null ? 0 : this.base - base;
    this.base = base;
    const a = new Float32Array(T * T * 4);
    const b = new Float32Array(T * T * 4);
    for (let j = 0; j < T; j++) {
      for (let i = 0; i < T; i++) {
        const o = (j * T + i) * 4;
        const src = scrolledSourceAt(i, j, this.window.moved, T);
        if (src !== null) {
          const s = (src[1] * T + src[0]) * 4;
          const pressed = this.a[s + 2]!;
          const left = decaySteps(CPU_SCALAR_OPS, pressed, this.b[s + 1]!, dt);
          const keep = pressed > PRESSED_EPSILON ? left / Math.max(pressed, PRESSED_EPSILON) : 0;
          a.set([this.a[s]! * keep, this.a[s + 1]! * keep, left, this.a[s + 3]! + shift], o);
          b.set([this.b[s]! + shift, this.b[s + 1]!, this.b[s + 2]!, this.b[s + 3]!], o);
        }
        const [px, pz] = this.window.texelCentre(i, j);
        for (let k = 0; k < stamps.count; k++) {
          const q = stamps.packed.subarray(k * STAMP_FLOATS, (k + 1) * STAMP_FLOATS);
          const foot = q[4]! - base;
          const top = q[5]! - base;
          const st = stampSteps(CPU_SCALAR_OPS, px, pz, { ax: q[0]!, az: q[1]!, bx: q[2]!, bz: q[3]!, radius: q[6]!, strength: q[7]! });
          if (st.value > a[o + 2]!) {
            a.set([q[8]!, q[9]!, st.value, foot], o);
            b.set([top, st.value * q[10]!, q[6]!, st.value], o);
          } else if (a[o + 2]! < PRESSED_EPSILON && st.d < q[6]! + this.cellM * 2) {
            a[o + 3] = foot;
            b[o] = top;
            b[o + 2] = q[6]!;
          }
        }
      }
    }
    this.a = a;
    this.b = b;
  }

  /** Channel `c` of state `which` sampled bilinearly at (u, v), as the GPU's linear sampler clamped to the edge. */
  sample(which: 'a' | 'b', c: number, u: number, v: number): number {
    const T = this.texels;
    const data = which === 'a' ? this.a : this.b;
    const x = u * T - 0.5;
    const y = v * T - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (i: number, j: number): number => data[(Math.min(T - 1, Math.max(0, j)) * T + Math.min(T - 1, Math.max(0, i))) * 4 + c]!;
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  }

  /** The bend offset (world) of a foliage vertex at `p`, `height` above its root, bend weight `weight` (null: none), rule factor `ruleBend`. */
  bendAt(p: readonly [number, number, number], height: number, weight: number | null, ruleBend = 1): [number, number, number] {
    const [u, v] = this.window.uvAt(p[0], p[2]);
    const T = this.texels;
    const edge = Math.min(Math.min(u, v), Math.min(1 - u, 1 - v)) * T;
    const pressed = this.sample('a', 2, u, v);
    if (edge <= 1 || pressed <= PRESSED_EPSILON || this.base === null) return [0, 0, 0];
    const e = 1 / T;
    const read = { pressed, gx: this.sample('b', 3, u + e, v) - this.sample('b', 3, u - e, v), gz: this.sample('b', 3, u, v + e) - this.sample('b', 3, u, v - e), foot: this.sample('a', 3, u, v), top: this.sample('b', 0, u, v), radius: this.sample('b', 2, u, v) };
    const h = Math.max(height, 0);
    const push = bendPushSteps(CPU_SCALAR_OPS, read, p[1] - this.base, bendCapacity(weight, h) * ruleBend);
    const o = bendOffsetSteps(CPU_SCALAR_OPS, push, h);
    return [o.x, o.y, o.z];
  }
}
