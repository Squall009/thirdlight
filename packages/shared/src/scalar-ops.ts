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

/**
 * {@link CPU_SCALAR_OPS} rounded to 32-bit floats after every operation: the
 * CPU twin of a shader's `f32` arithmetic, so steps whose operations a GPU
 * rounds correctly (add, subtract, multiply, compare) give the same bits on
 * both. Divide and square root are not correctly rounded on every GPU.
 */
export const F32_SCALAR_OPS: ScalarOps<number, boolean> = {
  n: (v) => Math.fround(v),
  add: (a, b) => Math.fround(a + b),
  sub: (a, b) => Math.fround(a - b),
  mul: (a, b) => Math.fround(a * b),
  div: (a, b) => Math.fround(a / b),
  min: Math.min,
  max: Math.max,
  sqrt: (a) => Math.fround(Math.sqrt(a)),
  floor: Math.floor,
  lt: (a, b) => a < b,
  select: (c, a, b) => (c ? a : b),
};

/** A float as a WGSL `f32` literal (finite only). */
export function wgslFloat(v: number): string {
  if (!Number.isFinite(v)) throw new RangeError(`no WGSL literal for ${v}`);
  const s = Math.fround(v).toString();
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/**
 * Steps written over {@link ScalarOps} as WGSL text: each operation is one
 * `let` statement of the body being written (`lines`), so a value used twice
 * is computed once and the text grows with the steps, not with their nesting.
 * Values and conditions are the names of those `let`s; `arg` names an input.
 */
export interface WgslScalarWriter {
  readonly ops: ScalarOps<string, string>;
  readonly lines: string[];
}

/** A writer whose `let` names start with `prefix` (unique within the function it writes). */
export function wgslScalarWriter(prefix = 's'): WgslScalarWriter {
  const lines: string[] = [];
  let k = 0;
  const put = (type: 'f32' | 'bool', expr: string): string => {
    const name = `${prefix}${k++}`;
    lines.push(`let ${name}: ${type} = ${expr};`);
    return name;
  };
  const ops: ScalarOps<string, string> = {
    n: (v) => wgslFloat(v),
    add: (a, b) => put('f32', `${a} + ${b}`),
    sub: (a, b) => put('f32', `${a} - ${b}`),
    mul: (a, b) => put('f32', `${a} * ${b}`),
    div: (a, b) => put('f32', `${a} / ${b}`),
    min: (a, b) => put('f32', `min(${a}, ${b})`),
    max: (a, b) => put('f32', `max(${a}, ${b})`),
    sqrt: (a) => put('f32', `sqrt(${a})`),
    floor: (a) => put('f32', `floor(${a})`),
    lt: (a, b) => put('bool', `${a} < ${b}`),
    select: (c, a, b) => put('f32', `select(${b}, ${a}, ${c})`),
  };
  return { ops, lines };
}
