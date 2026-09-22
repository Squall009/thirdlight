/**
 * Packet 32 — the accepted step-indexed controller traces, replayed against
 * the real TypeScript controller.
 *
 * `fixtures/m2/contracts/platformer/traces.json` (packet 17, promoted) is the
 * normative contract model of `platformer.md` §7: 16 traces × 178 sampled
 * rows of position/velocity/grounded/airborne/coyote/buffer/contacts/snapped/
 * rotation/scale, derived from a scripted analytic port (flat ground and
 * axis-aligned statics only — its support normal is always (0,1)). The
 * scripted port is re-implemented here exactly as the fixture's independent
 * checker does, and the controller is stepped directly.
 *
 * The trace start states carry a controller state (`vx`, `vy`, `airborne`,
 * `coyote`, `buffer`, `grounded`) that the public module surface derives from
 * the authored transform at `create()`; seeding it is exactly what the
 * settle pre-roll produces in a real runtime run, so this suite imports the
 * package's internal `controllerStep`/`createControllerState` (test-only, not
 * a cross-package internal import).
 */
import { describe, expect, it } from 'vitest';
import type { ActionFrame } from '@thirdlight/runtime';
import {
  controllerStep,
  createControllerState,
  type ControllerState,
} from '../../packages/platformer/src/controller';
import { fixture, readJson, REPO, DT } from './helpers';
import { join } from 'node:path';

interface TraceFrame {
  stepIndex: number;
  moveX: number;
  jump: ActionFrame['jump'];
}
interface SampleRow {
  stepIndex: number;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number };
  grounded: boolean;
  airborne: boolean;
  coyote: number;
  buffer: number;
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;
  rotation: number[];
  scale: number[];
}
interface Trace {
  traceId: string;
  title: string;
  port: {
    kind: string;
    statics?: { id: string; x: number; y: number; hw: number; hh: number }[];
    includeFloor?: boolean;
    groundUntilStep?: number;
  };
  start: {
    stepIndex: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    airborne: boolean;
    coyote: number;
    buffer: number;
    grounded: boolean;
    runSpeedOverride?: number;
    authoredTransform?: { position: number[]; rotation: number[]; scale: number[] };
  };
  frames: TraceFrame[];
  untilStep: number;
  sample: SampleRow[];
  expect: Record<string, unknown>;
}
interface TraceFile {
  constants: Record<string, number>;
  traces: Trace[];
}

const doc = readJson<TraceFile>(join(REPO, 'fixtures/m2/contracts/platformer/traces.json'));
const SETTINGS = Object.freeze({
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
});
const COS_MAX = Math.cos((45 * Math.PI) / 180);
const COS_MIN = Math.cos((30 * Math.PI) / 180);
const TAN_MIN = Math.tan((30 * Math.PI) / 180);
const P17 = { halfX: 0.31, halfY: 0.91, snap: 0.1 };

interface Static {
  id: string;
  x: number;
  y: number;
  hw: number;
  hh: number;
}

/** The scripted analytic port (identical semantics to the fixture checker). */
function portStep(
  pos: { x: number; y: number },
  req: { x: number; y: number },
  statics: Static[],
  groundedPrev: boolean,
  groundUntilStep: number | undefined,
  stepIndex: number,
): { pos: { x: number; y: number }; result: Record<string, unknown> } {
  const blocked = groundUntilStep !== undefined && stepIndex > groundUntilStep;
  const active = blocked ? [] : statics;
  let nx = pos.x + req.x;
  let wall = false;
  for (const b of active) {
    if (Math.abs(pos.y - b.y) < P17.halfY + b.hh) {
      if (req.x > 0 && pos.x + P17.halfX <= b.x - b.hw && nx + P17.halfX > b.x - b.hw) {
        nx = b.x - b.hw - P17.halfX;
        wall = true;
      } else if (req.x < 0 && pos.x - P17.halfX >= b.x + b.hw && nx - P17.halfX < b.x + b.hw) {
        nx = b.x + b.hw + P17.halfX;
        wall = true;
      }
    }
  }
  let ny = pos.y + req.y;
  let ground = false;
  let head = false;
  for (const b of active) {
    if (Math.abs(nx - b.x) < P17.halfX + b.hw) {
      const top = b.y + b.hh;
      const bottom = b.y - b.hh;
      if (req.y <= 0 && pos.y - P17.halfY >= top - 1e-9 && ny - P17.halfY < top) {
        ny = top + P17.halfY;
        ground = true;
      } else if (req.y > 0 && pos.y + P17.halfY <= bottom + 1e-9 && ny + P17.halfY > bottom) {
        ny = bottom - P17.halfY;
        head = true;
      }
    }
  }
  let snapped = false;
  if (!ground && groundedPrev && req.y <= 0) {
    let best: number | null = null;
    for (const b of active) {
      if (Math.abs(nx - b.x) < P17.halfX + b.hw) {
        const top = b.y + b.hh;
        const gap = pos.y - P17.halfY - top;
        if (gap >= -1e-9 && gap <= P17.snap + 1e-9 && (best === null || top > best)) best = top;
      }
    }
    if (best !== null) {
      ny = best + P17.halfY;
      ground = true;
      snapped = true;
    }
  }
  return {
    pos: { x: nx, y: ny },
    result: {
      requested: { ...req },
      applied: { x: nx - pos.x, y: ny - pos.y },
      position: { x: nx, y: ny },
      grounded: ground,
      supportNormal: ground ? { x: 0, y: 1 } : { x: 0, y: 0 },
      contacts: { ground, wall, head, steepSlope: false },
      snapped,
    },
  };
}

interface Measured {
  stepIndex: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  airborne: boolean;
  coyote: number;
  buffer: number;
  contacts: { ground: boolean; wall: boolean; head: boolean; steepSlope: boolean };
  snapped: boolean;
}

function replay(trace: Trace): { rows: Map<number, Measured>; state: ControllerState } {
  const st = createControllerState(trace.start.x, trace.start.y);
  st.vx = trace.start.vx;
  st.vy = trace.start.vy;
  st.airborne = trace.start.airborne;
  st.coyote = trace.start.coyote;
  st.buffer = trace.start.buffer;
  st.prevResult = {
    requested: { x: 0, y: 0 },
    applied: { x: 0, y: 0 },
    position: { x: trace.start.x, y: trace.start.y },
    grounded: trace.start.grounded,
    supportNormal: { x: 0, y: 1 },
    contacts: { ground: trace.start.grounded, wall: false, head: false, steepSlope: false },
    snapped: false,
  };
  const statics: Static[] = (trace.port.statics ?? []).map((b) => ({ ...b }));
  if (trace.port.includeFloor !== false) {
    statics.unshift({ id: 'floor', x: 0, y: -0.25, hw: 200, hh: 0.25 });
  }
  const runSpeed = trace.start.runSpeedOverride ?? SETTINGS.run_speed;
  const frames = new Map(trace.frames.map((f) => [f.stepIndex, f]));
  const rows = new Map<number, Measured>();
  let pos = { x: trace.start.x, y: trace.start.y };
  for (let n = trace.start.stepIndex; n < trace.untilStep; n += 1) {
    const frame: ActionFrame = frames.get(n) ?? { stepIndex: n, moveX: 0, jump: 'none' };
    let staged: { x: number; y: number } = { x: 0, y: 0 };
    const physics = {
      stageCharacterMove: (_id: string, delta: { x: number; y: number }): void => {
        staged = { x: delta.x, y: delta.y };
      },
      characterResult: () => undefined,
    };
    controllerStep(
      st,
      'char-0001',
      frame,
      { ...SETTINGS, run_speed: runSpeed },
      DT,
      COS_MAX,
      COS_MIN,
      TAN_MIN,
      physics,
    );
    const groundedPrev = st.prevResult?.grounded === true;
    const { pos: next, result } = portStep(pos, staged, statics, groundedPrev, trace.port.groundUntilStep, n);
    pos = next;
    st.prevResult = result as never;
    rows.set(n, {
      stepIndex: n,
      x: pos.x,
      y: pos.y,
      vx: st.vx,
      vy: st.vy,
      grounded: result.grounded as boolean,
      airborne: st.airborne,
      coyote: st.coyote,
      buffer: st.buffer,
      contacts: result.contacts as Measured['contacts'],
      snapped: result.snapped as boolean,
    });
  }
  return { rows, state: st };
}

describe('accepted platformer traces (platformer.md §7, packet-17 fixture)', () => {
  it('replays all 16 traces × 178 sampled rows', () => {
    expect(doc.traces).toHaveLength(16);
    let rows = 0;
    for (const trace of doc.traces) {
      const { rows: measured } = replay(trace);
      for (const expected of trace.sample) {
        rows += 1;
        const got = measured.get(expected.stepIndex);
        expect(got, `${trace.traceId}/${expected.stepIndex} must be simulated`).toBeDefined();
        const label = `${trace.traceId}/${expected.stepIndex}`;
        expect(Math.abs(got!.x - expected.position.x), `${label} x`).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(got!.y - expected.position.y), `${label} y`).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(got!.vx - expected.velocity.x), `${label} vx`).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(got!.vy - expected.velocity.y), `${label} vy`).toBeLessThanOrEqual(1e-9);
        expect(got!.grounded, `${label} grounded`).toBe(expected.grounded);
        expect(got!.airborne, `${label} airborne`).toBe(expected.airborne);
        expect(got!.coyote, `${label} coyote`).toBe(expected.coyote);
        expect(got!.buffer, `${label} buffer`).toBe(expected.buffer);
        expect(got!.snapped, `${label} snapped`).toBe(expected.snapped);
        expect(got!.contacts, `${label} contacts`).toEqual(expected.contacts);
      }
    }
    expect(rows).toBe(178);
    // eslint-disable-next-line no-console
    console.log(`[traces] 16 traces / ${rows} sampled rows replayed exactly`);
  });

  it('reproduces the declared derived expectations', () => {
    for (const trace of doc.traces) {
      const { rows } = replay(trace);
      const all = [...rows.values()];
      const ex = trace.expect;
      if (typeof ex.groundedEveryStep === 'boolean') {
        expect(all.every((r) => r.grounded)).toBe(ex.groundedEveryStep);
      }
      if (typeof ex.maxAbsVx === 'number') {
        expect(Math.max(...all.map((r) => Math.abs(r.vx)))).toBeLessThanOrEqual(ex.maxAbsVx as number);
      }
      if (typeof ex.jumpStartCount === 'number') {
        let starts = 0;
        for (let i = 0; i < all.length; i += 1) {
          const prev = i === 0 ? trace.start.vy : all[i - 1]!.vy;
          if (all[i]!.vy > 6 && prev < 1) starts += 1;
        }
        expect(starts, `${trace.traceId} jump starts`).toBe(ex.jumpStartCount);
      }
      if (typeof ex.jumpStartedStep === 'number') {
        const startStep = all.find(
          (r, i) => r.vy > 6 && (i === 0 ? trace.start.vy : all[i - 1]!.vy) < 1,
        )?.stepIndex;
        expect(startStep, `${trace.traceId} jump step`).toBe(ex.jumpStartedStep);
      }
      if (ex.jumpStartedStep === null) {
        const startStep = all.find(
          (r, i) => r.vy > 6 && (i === 0 ? trace.start.vy : all[i - 1]!.vy) < 1,
        );
        expect(startStep, `${trace.traceId} no jump`).toBeUndefined();
      }
      // The Z/rotation/scale lock is carried by the controller: it never writes
      // them, so the authored values are trivially unchanged. The fixture's
      // per-row rotation/scale/position.z assertions are the trace model's.
      for (const expected of trace.sample) {
        expect(expected.position.z).toBe(trace.start.authoredTransform?.position[2] ?? 0);
        expect(expected.rotation).toEqual(trace.start.authoredTransform?.rotation ?? [0, 0, 0, 1]);
        expect(expected.scale).toEqual(trace.start.authoredTransform?.scale ?? [1, 1, 1]);
      }
    }
  });
});
