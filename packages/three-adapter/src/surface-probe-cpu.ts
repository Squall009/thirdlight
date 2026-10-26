/**
 * The probe pass's CPU twin (`surface-probe-wgsl.ts` line for line, the same
 * random turn per probe and update): one update of a set of probes on the
 * CPU through the CPU tracer. The checks hold the bounce it builds up to
 * references; the GPU pass is held to it on the page.
 *
 * Pure (no three.js, no device).
 */
import { NO_ROOM, ROOM_EXIT_MARGIN, closedPortalCpu, roomExitCpu } from './surface-rooms';
import { BOUNCE_ALBEDO, PROBE_AXIS_RAYS, PROBE_BLEND_MIN, PROBE_FLOATS, PROBE_HIT_LIFT, PROBE_RAY_SPACINGS, PROBE_RAYS, PROBE_SH_RAYS, SH_Y0, SH_Y1, probesIrradianceAt, shIrradiance, type LiveProbes } from './surface-probes';
import { EXACT_TRACE } from './tracer-cpu-math';
import { sceneView, traceRayCpu } from './tracer-cpu';
import { TRACE_MISS, TRACE_UNFINISHED, type PackedTraceScene } from './tracer-scene';

type V3 = [number, number, number];

function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

/** Direction `k` of probe `probe`'s update with `seed` (the shaders' `probeRay`). */
export function probeRayCpu(probe: number, k: number, seed: number): V3 {
  if (k < PROBE_AXIS_RAYS) {
    const a: V3 = [0, 0, 0];
    a[k >> 1] = (k & 1) === 1 ? -1 : 1;
    return a;
  }
  const i = k - PROBE_AXIS_RAYS;
  const z = 1 - (2 * i + 1) / PROBE_SH_RAYS;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = i * GOLDEN_ANGLE;
  const v: V3 = [r * Math.cos(phi), z, r * Math.sin(phi)];
  let s = pcg((probe ^ Math.imul(seed, 0x9e3779b9)) >>> 0);
  const rnd = (): number => {
    s = pcg(s);
    return Math.fround(s) / 4294967296;
  };
  const u1 = rnd();
  const u2 = rnd() * 6.2831853;
  const u3 = rnd() * 6.2831853;
  const q = [Math.sqrt(1 - u1) * Math.sin(u2), Math.sqrt(1 - u1) * Math.cos(u2), Math.sqrt(u1) * Math.sin(u3), Math.sqrt(u1) * Math.cos(u3)];
  const c1 = cross(q, v);
  const c2 = cross(q, [c1[0] + q[3]! * v[0], c1[1] + q[3]! * v[1], c1[2] + q[3]! * v[2]]);
  const out: V3 = [v[0] + 2 * c2[0], v[1] + 2 * c2[1], v[2] + 2 * c2[2]];
  const l = Math.hypot(out[0], out[1], out[2]);
  return [out[0] / l, out[1] / l, out[2] / l];
}

export interface ProbeUpdateInput {
  readonly probes: LiveProbes;
  /** The probes to update. */
  readonly slots: Uint32Array;
  /** The sky's four RGB coefficients (band 0, then y, z, x). */
  readonly sky: Float32Array;
  /** Packed rooms (`SurfaceRooms.words`; null: none). */
  readonly rooms: Uint32Array | null;
  readonly seed: number;
  readonly scene: PackedTraceScene;
  /** A hit's direct light from its cache texel (irradiance). */
  readonly direct: (point: V3, normal: V3) => V3;
}

/**
 * One update of `slots` as the pass makes it: each probe's new record
 * (`PROBE_FLOATS`, in `slots` order). The probes' records it reads at the
 * hits are `probes.state` as they were before the update.
 */
export function probeUpdateCpu(input: ProbeUpdateInput): Float32Array {
  const { probes, slots, sky, rooms, seed } = input;
  const view = sceneView(input.scene);
  const state = probes.state;
  const rayMax = PROBE_RAY_SPACINGS * probes.spacing;
  const out = new Float32Array(slots.length * PROBE_FLOATS);
  const e: number[] = [0, 0, 0];
  for (let s = 0; s < slots.length; s += 1) {
    const probe = slots[s]!;
    const room = probes.rooms[probe]!;
    const o: V3 = [probes.positions[probe * 3]!, probes.positions[probe * 3 + 1]!, probes.positions[probe * 3 + 2]!];
    const base = probe * PROBE_FLOATS;
    const c = new Float64Array(12);
    let back = 0;
    const along = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < PROBE_RAYS; k += 1) {
      const d = probeRayCpu(probe, k, seed);
      let tmax = rayMax;
      let held = false;
      if (rooms !== null) {
        if (room !== NO_ROOM) {
          const ex = roomExitCpu(rooms, room, o, d);
          if (!ex.open && ex.t + ROOM_EXIT_MARGIN < tmax) {
            tmax = ex.t + ROOM_EXIT_MARGIN;
            held = true;
          }
        }
        const door = closedPortalCpu(rooms, o, d, tmax);
        if (door < tmax) {
          tmax = door;
          held = true;
        }
      }
      const h = traceRayCpu(view, o, d, 0, tmax, EXACT_TRACE);
      let L: V3 = [0, 0, 0];
      if (h.kind === TRACE_MISS || h.kind === TRACE_UNFINISHED) {
        if (held) {
          shIrradiance(state, base, [-d[0], -d[1], -d[2]], e);
          L = [0, 1, 2].map((q) => (BOUNCE_ALBEDO / Math.PI) * Math.max(0, e[q]!)) as V3;
        } else {
          L = [0, 1, 2].map((q) => Math.max(0, SH_Y0 * sky[q]! + SH_Y1 * (sky[3 + q]! * d[1] + sky[6 + q]! * d[2] + sky[9 + q]! * d[0]))) as V3;
        }
      } else {
        const n = h.normal as V3;
        if (k < PROBE_AXIS_RAYS) along[k] = h.t;
        if (n[0] * d[0] + n[1] * d[1] + n[2] * d[2] > 0) {
          if (k >= PROBE_AXIS_RAYS) back += 1;
        } else {
          const p: V3 = [o[0] + d[0] * h.t, o[1] + d[1] * h.t, o[2] + d[2] * h.t];
          const dl = input.direct(p, n);
          const ind = probesIrradianceAt(probes.grids, state, [p[0] + n[0] * PROBE_HIT_LIFT, p[1] + n[1] * PROBE_HIT_LIFT, p[2] + n[2] * PROBE_HIT_LIFT], n, [0, 0, 0], rooms);
          L = [0, 1, 2].map((q) => (BOUNCE_ALBEDO / Math.PI) * (dl[q]! + ind[q]!)) as V3;
        }
      }
      if (k >= PROBE_AXIS_RAYS) {
        for (let q = 0; q < 3; q += 1) {
          c[q]! += L[q]! * SH_Y0;
          c[3 + q]! += L[q]! * SH_Y1 * d[1];
          c[6 + q]! += L[q]! * SH_Y1 * d[2];
          c[9 + q]! += L[q]! * SH_Y1 * d[0];
        }
      }
    }
    const w = (4 * Math.PI) / PROBE_SH_RAYS;
    const updates = state[base + 13]!;
    const a = Math.max(1 / (updates + 1), PROBE_BLEND_MIN);
    const at = s * PROBE_FLOATS;
    for (let q = 0; q < 12; q += 1) out[at + q] = state[base + q]! + (c[q]! * w - state[base + q]!) * a;
    out[at + 12] = back / PROBE_SH_RAYS;
    out[at + 13] = updates + 1;
    out.set(along, at + 16);
  }
  return out;
}
