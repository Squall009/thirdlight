/**
 * Phase 22.0: the simulation worker's live input.
 *
 * The main thread owns the input devices. On every frame it samples the input
 * owner ONCE (an `ActionFrame`, the same call the runtime makes per step in
 * single-thread mode) and sends it with the frame's tick. The worker runs the
 * frame's fixed steps; this source turns the one sampled frame into one frame
 * per executed step:
 *
 * - the first step of the tick gets the sampled frame (edges included);
 * - further steps of the same tick get its continuation — a `pressed` button
 *   is `held`, a `released` one is `none` (exactly what a second sample of the
 *   browser owner would return in the same frame: no new device events);
 * - a tick that runs no step (a display faster than the step rate, a paused
 *   game) keeps its frame for the next tick, merged with the next sample so
 *   no press or release is lost.
 *
 * Deterministic replays do not go through here: a recorded input (a replay,
 * the MCP input exercise) is per step and runs in the worker as recorded.
 */
import { mergeInputStatus, type ActionFrame, type ActionSource, type ActionValue, type JumpPhase, type PointerSample } from '@thirdlight/runtime';

/**
 * Phase 23.3: the pointer on a further step of the same tick — where it is
 * and what is held, without the sample's movement, wheel and edges (they
 * belong to the first step).
 */
export function continuePointer(p: PointerSample): PointerSample {
  if (p.dx === undefined && p.dy === undefined && p.wheel === undefined && p.pressed === undefined && p.released === undefined) return p;
  return { x: p.x, y: p.y, ...(p.buttons !== undefined ? { buttons: p.buttons } : {}), ...(p.over !== undefined ? { over: p.over } : {}), ...(p.locked !== undefined ? { locked: p.locked } : {}) };
}

const clamp10 = (v: number): number => (v > 10 ? 10 : v < -10 ? -10 : v);
const q4 = (v: number): number => {
  const r = Math.round(v * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};

/** Phase 23.3: two pointer samples with no step between them: the newer position and buttons, the movement and wheel added, the edges of both. */
export function mergePointer(a: PointerSample | undefined, b: PointerSample | undefined): PointerSample | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const dx = q4(clamp10((a.dx ?? 0) + (b.dx ?? 0)));
  const dy = q4(clamp10((a.dy ?? 0) + (b.dy ?? 0)));
  const wheel = q4(clamp10((a.wheel ?? 0) + (b.wheel ?? 0)));
  const pressed = (a.pressed ?? 0) | (b.pressed ?? 0);
  const released = (a.released ?? 0) | (b.released ?? 0);
  return {
    x: b.x,
    y: b.y,
    ...(dx !== 0 ? { dx } : {}),
    ...(dy !== 0 ? { dy } : {}),
    ...(wheel !== 0 ? { wheel } : {}),
    ...(b.buttons !== undefined ? { buttons: b.buttons } : {}),
    ...(pressed !== 0 ? { pressed } : {}),
    ...(released !== 0 ? { released } : {}),
    ...(b.over !== undefined ? { over: b.over } : {}),
    ...(b.locked !== undefined ? { locked: b.locked } : {}),
  };
}

/** Phase 23.3: an action value that is an amount per sample (`i`) without its amount — what a further step of the same sample sees. */
function spent(a: ActionValue, p: JumpPhase): ActionValue {
  return { v: 0, ...(a.x !== undefined ? { x: 0 } : {}), ...(a.y !== undefined ? { y: 0 } : {}), p, i: 1 };
}

/** The phase a held input has on the next step when nothing new happened. */
export function continuePhase(p: JumpPhase): JumpPhase {
  return p === 'pressed' ? 'held' : p === 'released' ? 'none' : p;
}

/** The frame's continuation for a further step in the same tick (no new device events). */
export function continueFrame(f: ActionFrame): ActionFrame {
  // Phase 23.2: a frame's second move axis (moveY) is kept as it is (absent stays absent).
  const out: ActionFrame = { stepIndex: f.stepIndex, moveX: f.moveX, ...(f.moveY !== undefined ? { moveY: f.moveY } : {}), jump: continuePhase(f.jump) };
  if (f.actions !== undefined) {
    const actions: Record<string, ActionValue> = {};
    for (const name of Object.keys(f.actions)) {
      const a = f.actions[name]!;
      const p = continuePhase(a.p);
      // Phase 23.3: a per-sample amount (pointer movement, wheel) is spent on the first step.
      if (a.i === 1) actions[name] = a.v === 0 && (a.x ?? 0) === 0 && (a.y ?? 0) === 0 && p === a.p ? a : spent(a, p);
      else actions[name] = p === a.p ? a : { v: a.v, ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}), p };
    }
    out.actions = actions;
  }
  if (f.pointer !== undefined) out.pointer = continuePointer(f.pointer);
  return out;
}

/**
 * Two phases seen in a row with no step between them, as what the next step
 * should see now and what it should see after (null: nothing pending). An
 * edge (`pressed`, `released`) is never dropped.
 */
export function mergePhase(pending: JumpPhase, next: JumpPhase): { now: JumpPhase; then: JumpPhase | null } {
  if (pending === 'pressed') return next === 'released' || next === 'none' ? { now: 'pressed', then: 'released' } : { now: 'pressed', then: null };
  if (pending === 'released') return next === 'pressed' ? { now: 'released', then: 'pressed' } : { now: 'released', then: null };
  return { now: next, then: null };
}

/**
 * The per-tick input of the worker (an `ActionSource` for the runtime).
 * `push` is called once per tick with the main thread's sample (or null:
 * no sample, e.g. input suspended); `sample` is the runtime's per-step call.
 */
export class TickInputSource implements ActionSource {
  private pending: ActionFrame | null = null;
  /** Edges still owed to the next steps after a merge (jump; per action name). */
  private owedJump: JumpPhase | null = null;
  private owedActions: Map<string, JumpPhase> | null = null;
  private consumed = true;
  private readonly onReset: ((reason?: string) => void) | undefined;

  constructor(onReset?: (reason?: string) => void) {
    this.onReset = onReset;
  }

  push(frame: ActionFrame | null): void {
    if (frame === null) return;
    if (this.consumed || this.pending === null) {
      this.pending = frame;
      this.owedJump = null;
      this.owedActions = null;
      this.consumed = false;
      return;
    }
    // The previous tick ran no step: merge, keeping its edges.
    const p = this.pending;
    const j = mergePhase(p.jump, frame.jump);
    const merged: ActionFrame = { stepIndex: frame.stepIndex, moveX: frame.moveX, ...(frame.moveY !== undefined ? { moveY: frame.moveY } : {}), jump: j.now };
    this.owedJump = j.then;
    if (frame.actions !== undefined || p.actions !== undefined) {
      const actions: Record<string, ActionValue> = {};
      const owed = new Map<string, JumpPhase>();
      for (const name of Object.keys(frame.actions ?? {})) {
        const a0 = frame.actions![name]!;
        const prev = p.actions?.[name];
        // Phase 23.3: per-sample amounts of two samples before one step add up.
        const a: ActionValue =
          a0.i === 1 && prev?.i === 1
            ? { v: q4(clamp10(a0.v + prev.v)), ...(a0.x !== undefined ? { x: q4(clamp10(a0.x + (prev.x ?? 0))) } : {}), ...(a0.y !== undefined ? { y: q4(clamp10(a0.y + (prev.y ?? 0))) } : {}), p: a0.p, i: 1 }
            : a0;
        const m = prev !== undefined ? mergePhase(prev.p, a.p) : { now: a.p, then: null };
        actions[name] = m.now === a.p ? a : { v: a.v, ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}), p: m.now, ...(a.i === 1 ? { i: 1 as const } : {}) };
        if (m.then !== null) owed.set(name, m.then);
      }
      merged.actions = actions;
      this.owedActions = owed.size > 0 ? owed : null;
    }
    const pointer = mergePointer(p.pointer, frame.pointer);
    if (pointer !== undefined) merged.pointer = pointer;
    // Phase 23.14: the host's input entries of both samples (the newer device and list, the events of both).
    const input = mergeInputStatus(p.input, frame.input);
    if (input !== undefined) merged.input = input;
    this.pending = merged;
  }

  sample(stepIndex: number): ActionFrame {
    const f = this.pending;
    if (f === null) return { stepIndex, moveX: 0, jump: 'none' };
    const out: ActionFrame = { stepIndex, moveX: f.moveX, ...(f.moveY !== undefined ? { moveY: f.moveY } : {}), jump: f.jump, ...(f.actions !== undefined ? { actions: f.actions } : {}), ...(f.pointer !== undefined ? { pointer: f.pointer } : {}), ...(f.input !== undefined ? { input: f.input } : {}) };
    // The next step of this tick sees the continuation (or the owed edge of a merge).
    const next = continueFrame(f);
    if (this.owedJump !== null) {
      next.jump = this.owedJump;
      this.owedJump = null;
    }
    if (this.owedActions !== null && next.actions !== undefined) {
      const actions = { ...next.actions };
      for (const [name, p] of this.owedActions) {
        const a = actions[name];
        if (a !== undefined) actions[name] = { v: a.v, ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}), p, ...(a.i === 1 ? { i: 1 as const } : {}) };
      }
      next.actions = actions;
      this.owedActions = null;
    }
    this.pending = next;
    this.consumed = true;
    return out;
  }

  reset(reason?: string): void {
    this.pending = null;
    this.owedJump = null;
    this.owedActions = null;
    this.consumed = true;
    this.onReset?.(reason);
  }
}
