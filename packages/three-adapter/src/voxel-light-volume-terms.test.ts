/**
 * The light volume's spot cone and area light terms (voxel-light-volume-terms.ts) against the clustered per-pixel
 * light's: a line-by-line CPU copy of the three nodes that light a pixel there (`smoothstep` of the cone as
 * cluster-lights.ts calls it; three's `LTC_Evaluate` with the identity matrix, its frame round the normal from a view
 * direction, and the window and radiance of cluster-area.ts's `shadeAreaLight`), over points inside, at the edge of and
 * outside a cone, and in front of, beside and behind a rectangle and a line light. The update's WGSL is written from
 * the same steps as the CPU run here (`volumeLampTermsWgsl`).
 */
import { describe, expect, it } from 'vitest';
import { CPU_SCALAR_OPS } from '@thirdlight/shared';

import { ClusterLights } from './cluster-build';
import { areaLightSteps, spotConeSteps, volumeLampTermsWgsl } from './voxel-light-volume-terms';
import { volumeUpdateWgsl } from './voxel-light-volume-wgsl';

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V): number => Math.sqrt(dot(a, a));
const unit = (a: V): V => mul(a, 1 / len(a));

/** A seeded sequence in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    s ^= s >>> 12;
    return (s >>> 0) / 4294967296;
  };
}
const dirOf = (r: () => number): V => {
  const z = 2 * r() - 1;
  const t = 2 * Math.PI * r();
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(t), s * Math.sin(t), z];
};

/** three's `smoothstep` (WGSL's): clamped Hermite between the edges. */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** three's `LTC_EdgeVectorFormFactor`, line for line. */
function ltcEdge(v1: V, v2: V): V {
  const x = dot(v1, v2);
  const y = Math.abs(x);
  const a = (y * 0.0145206 + 0.4965155) * y + 0.8543985;
  const b = (y + 4.1616724) * y + 3.417594;
  const v = a / b;
  const ts = x > 0 ? v : 0.5 / Math.sqrt(Math.max(1 - x * x, 1e-7)) - v;
  return mul(cross(v1, v2), ts);
}

/** three's `LTC_Evaluate` with `mInv` the identity, line for line (its frame round N built from V). */
function ltcEvaluate(N: V, Vw: V, P: V, p0: V, p1: V, p2: V, p3: V): number {
  const lightNormal = cross(sub(p1, p0), sub(p3, p0));
  if (!(dot(lightNormal, sub(P, p0)) >= 0)) return 0;
  const T1 = unit(sub(Vw, mul(N, dot(Vw, N))));
  const T2 = mul(cross(N, T1), -1);
  // mat3(T1, T2, N) has them as columns; its transpose takes a vector to (T1·x, T2·x, N·x).
  const to = (x: V): V => unit([dot(T1, x), dot(T2, x), dot(N, x)]);
  const c = [to(sub(p0, P)), to(sub(p1, P)), to(sub(p2, P)), to(sub(p3, P))];
  let f: V = [0, 0, 0];
  for (let i = 0; i < 4; i++) f = add(f, ltcEdge(c[i]!, c[(i + 1) % 4]!));
  const l = len(f);
  return Math.max((l * l + f[2]) / (l + 1), 0);
}

/**
 * The diffuse irradiance cluster-area.ts's `shadeAreaLight` gives a Lambert surface (`direct` with colour × π F / max(N·L,
 * 0.05), times the model's N·L), per unit of colour: π × window × F / area where the centre is above the horizon by
 * more than the clamp, as a physical model's `directRectArea` gives everywhere (L × F, times π for irradiance).
 */
function perPixelArea(p: V, n: V, view: V, c: V, u: V, v: V, twoSided: boolean, reach: number): number {
  const toLight = sub(c, p);
  const back = twoSided && dot(toLight, cross(u, v)) > 0;
  const w = back ? v : mul(v, -1);
  const d2 = dot(toLight, toLight);
  const window = Math.min(Math.max(1 - (d2 / (reach * reach)) ** 2, 0), 1) ** 2;
  const area = Math.max(len(u) * len(v) * 4, 1e-8);
  const p0 = sub(add(c, u), w);
  const p1 = sub(sub(c, u), w);
  const p2 = add(sub(c, u), w);
  const p3 = add(add(c, u), w);
  return (Math.PI * window * ltcEvaluate(n, view, p, p0, p1, p2, p3)) / area;
}

const ops = CPU_SCALAR_OPS;

/** An area light as `ClusterLights` keeps it (u × v along its facing; a line's v the strip across it). */
function areaRecord(kind: 'rect' | 'line', facing: V, u: V, v: V | undefined, twoSided: boolean): { u: V; v: V } {
  const l = new ClusterLights();
  l.add({ kind, position: [0, 0, 0], reach: 10, color: [1, 1, 1], direction: facing, u, ...(v !== undefined ? { v } : {}), twoSided });
  return { u: [l.u[0]!, l.u[1]!, l.u[2]!], v: [l.v[0]!, l.v[1]!, l.v[2]!] };
}

/**
 * Points round an area light: in front of it (along its facing, within its reach), beside it (near its plane, past
 * its edges) and behind it, each with a random unit normal facing the light half the time; `view` a random way to
 * the eye the per-pixel frame is built from.
 */
function areaCases(seed: number, c: V, u: V, v: V, reach: number, count: number): { p: V; n: V; view: V; where: 'front' | 'beside' | 'behind' }[] {
  const r = rng(seed);
  const f = unit(cross(u, v));
  const uu = unit(u);
  const vv = unit(v);
  const out: { p: V; n: V; view: V; where: 'front' | 'beside' | 'behind' }[] = [];
  for (let i = 0; i < count; i++) {
    const where = (['front', 'beside', 'behind'] as const)[i % 3]!;
    const along = where === 'front' ? 0.05 + r() * reach * 0.8 : where === 'behind' ? -(0.05 + r() * reach * 0.8) : (r() - 0.5) * 0.4;
    const across = where === 'beside' ? (len(u) + 0.1 + r() * 3) * (r() < 0.5 ? -1 : 1) : (r() - 0.5) * 4;
    const p = add(add(c, mul(f, along)), add(mul(uu, across), mul(vv, (r() - 0.5) * 4)));
    let n = dirOf(r);
    if (i % 2 === 0 && dot(n, sub(c, p)) < 0) n = mul(n, -1);
    let view = dirOf(r);
    if (Math.abs(dot(view, n)) > 0.99) view = unit(add(view, [0.3, 0.2, 0.1]));
    out.push({ p, n, view, where });
  }
  return out;
}

describe('the light volume lamp terms against the per-pixel light', () => {
  it("a spot's cone: three's smoothstep over 600 surfaces inside, at the edge of and outside it", () => {
    const r = rng(7);
    let inside = 0;
    let edge = 0;
    let outside = 0;
    for (let i = 0; i < 600; i++) {
      const outer = (5 + r() * 80) * (Math.PI / 180);
      const penumbra = [0.05, 0.2, 0.5, 1][i % 4]!;
      const cosOuter = Math.cos(outer);
      const cosInner = Math.cos(outer * (1 - penumbra));
      const axis = dirOf(r);
      // An angle from the axis: a third inside the inner cone, a third in the soft edge, a third outside.
      const k = i % 3;
      const a = k === 0 ? r() * outer * (1 - penumbra) : k === 1 ? outer * (1 - penumbra) + r() * outer * penumbra : outer + r() * (Math.PI - outer);
      // The way back to the light makes angle a with the axis (any turn round it).
      const side = unit(cross(axis, dirOf(r)));
      const back = add(mul(axis, Math.cos(a)), mul(side, Math.sin(a)));
      const toLight = mul(back, -1);
      const cosToAxis = dot(toLight, mul(axis, -1));
      const want = smoothstep(cosOuter, cosInner, cosToAxis);
      const got = spotConeSteps(ops, cosToAxis, cosOuter, cosInner);
      expect(Math.abs(got - want), `case ${i}`).toBeLessThan(1e-9);
      if (want === 1) inside++;
      else if (want > 0) edge++;
      else outside++;
    }
    expect([inside, edge, outside].every((n) => n >= 150), JSON.stringify([inside, edge, outside])).toBe(true);
    // No soft edge: a step at the cone (WGSL leaves smoothstep's equal edges undefined).
    expect([spotConeSteps(ops, 0.9, 0.8, 0.8), spotConeSteps(ops, 0.7, 0.8, 0.8)]).toEqual([1, 0]);
  });

  for (const [label, kind, facing, u, v, twoSided] of [
    ['a 1 × 0.5 m ceiling panel', 'rect', [0, -1, 0], [0.5, 0, 0], [0, 0, 0.25], false],
    ['a 2 × 1 m wall panel turned', 'rect', unit([0.3, 0.2, 1]), unit(cross([0.3, 0.2, 1], [0, 1, 0])), undefined, false],
    ['a two-sided 0.6 m square', 'rect', [1, 0, 0], [0, 0, 0.3], [0, 0.3, 0], true],
    ['a 1.2 m line light', 'line', [0, -1, 0], [0.6, 0, 0], undefined, false],
  ] as const) {
    it(`an area light's diffuse light: ${label}, 600 surfaces in front, beside and behind`, () => {
      const half: V = label.includes('turned') ? mul(unit(cross([0.3, 0.2, 1], [0, 1, 0])), 1) : (u as V);
      const vIn: V | undefined = label.includes('turned') ? mul(unit(cross(half, [0.3, 0.2, 1])), 0.5) : (v as V | undefined);
      const rec = areaRecord(kind, facing as V, half, vIn, twoSided);
      const c: V = [3, 2, -1];
      const reach = 8;
      let lit = 0;
      let dark = 0;
      let worst = 0;
      for (const { p, n, view, where } of areaCases(label.length * 31, c, rec.u, rec.v, reach, 600)) {
        const want = perPixelArea(p, n, view, c, rec.u, rec.v, twoSided, reach);
        const got = Math.PI * areaLightSteps(ops, p, n, c, rec.u, rec.v, twoSided ? 1 : 0, reach);
        const err = Math.abs(got - want) / Math.max(Math.abs(want), 1e-3);
        worst = Math.max(worst, err);
        expect(err, `${where} ${JSON.stringify({ p, n, want, got })}`).toBeLessThan(1e-6);
        if (want > 1e-6) lit++;
        else dark++;
        if (where === 'behind' && !twoSided) expect(got, 'one-sided: nothing behind').toBe(0);
      }
      expect(lit, 'surfaces it lights').toBeGreaterThan(100);
      expect(dark, 'surfaces it leaves dark').toBeGreaterThan(50);
    });
  }

  it("the cheaper form not chosen (a point at the centre with both facing cosines) against the exact one, recorded", () => {
    const rec = areaRecord('rect', [0, -1, 0], [0.5, 0, 0], [0, 0, 0.25], false);
    const c: V = [0, 3, 0];
    const errs: number[] = [];
    const near: number[] = [];
    for (const { p, n } of areaCases(99, c, rec.u, rec.v, 8, 1500)) {
      const exact = Math.PI * areaLightSteps(ops, p, n, c, rec.u, rec.v, 0, 8);
      if (!(exact > 1e-4)) continue;
      const to = sub(c, p);
      const d = len(to);
      const l = mul(to, 1 / d);
      const w = Math.min(Math.max(1 - (d * d / 64) ** 2, 0), 1) ** 2;
      const approx = (w * Math.max(dot(n, l), 0) * Math.max(dot(l, [0, 1, 0]), 0)) / (d * d);
      const e = Math.abs(approx - exact) / exact;
      errs.push(e);
      if (d < 1.5) near.push(e);
    }
    const q = (a: number[], f: number): number => [...a].sort((x, y) => x - y)[Math.floor(f * (a.length - 1))]!;
    console.log(`[area-term] centre approximation vs exact over ${errs.length} lit points: median ${q(errs, 0.5).toFixed(3)}, p90 ${q(errs, 0.9).toFixed(3)}, worst ${q(errs, 1).toFixed(3)}; within 1.5 m of the centre (${near.length}): median ${q(near, 0.5).toFixed(3)}, p90 ${q(near, 0.9).toFixed(3)}`);
    expect(errs.length).toBeGreaterThan(200);
  });

  it('is written into the WGSL the update includes', () => {
    const w = volumeLampTermsWgsl();
    expect(w).toContain('fn volume_spot_cone(cos_to_axis: f32, cos_outer: f32, cos_inner: f32) -> f32');
    expect(w).toContain('fn volume_area_light(p: vec3<f32>, n: vec3<f32>, c: vec3<f32>, u: vec3<f32>, v: vec3<f32>, two_sided: f32, reach: f32) -> f32');
    expect(w.match(/\blet /g)!.length).toBeGreaterThan(100);
    // The update without area lights in its table runs without their code; with them, with it.
    expect([volumeUpdateWgsl(false).includes('volume_area_light'), volumeUpdateWgsl(true).includes('volume_area_light(p, n, a.xyz')]).toEqual([false, true]);
    expect(volumeUpdateWgsl(false)).toContain('volume_spot_cone(dot(l, -c.xyz)');
  });
});
