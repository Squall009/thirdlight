/**
 * Arithmetic written once for the CPU and the GPU: a step that a shader runs
 * and the tests check is written over {@link ScalarOps}, then run with
 * numbers ({@link CPU_SCALAR_OPS}) or with shader nodes (three-adapter's
 * `TSL_SCALAR_OPS`). The two cannot drift because there is one definition of
 * the steps.
 */

/** Scalar operations over `F` (a number or a float node), comparisons giving `B`. */
export interface ScalarOps<F, B> {
  n(v: number): F;
  add(a: F, b: F): F;
  sub(a: F, b: F): F;
  mul(a: F, b: F): F;
  div(a: F, b: F): F;
  min(a: F, b: F): F;
  max(a: F, b: F): F;
  sqrt(a: F): F;
  floor(a: F): F;
  lt(a: F, b: F): B;
  select(c: B, a: F, b: F): F;
}

export const CPU_SCALAR_OPS: ScalarOps<number, boolean> = {
  n: (v) => v,
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
  floor: Math.floor,
  lt: (a, b) => a < b,
  select: (c, a, b) => (c ? a : b),
};
