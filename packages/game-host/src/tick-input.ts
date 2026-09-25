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
import type { ActionFrame, ActionSource, ActionValue, JumpPhase } from '@thirdlight/runtime';

/** The phase a held input has on the next step when nothing new happened. */
export function continuePhase(p: JumpPhase): JumpPhase {
  return p === 'pressed' ? 'held' : p === 'released' ? 'none' : p;
}

/** The frame's continuation for a further step in the same tick (no new device events). */
export function continueFrame(f: ActionFrame): ActionFrame {
  const out: ActionFrame = { stepIndex: f.stepIndex, moveX: f.moveX, jump: continuePhase(f.jump) };
  if (f.actions !== undefined) {
    const actions: Record<string, ActionValue> = {};
    for (const name of Object.keys(f.actions)) {
      const a = f.actions[name]!;
      const p = continuePhase(a.p);
      actions[name] = p === a.p ? a : { v: a.v, ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}), p };
    }
    out.actions = actions;
  }
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
    const merged: ActionFrame = { stepIndex: frame.stepIndex, moveX: frame.moveX, jump: j.now };
    this.owedJump = j.then;
    if (frame.actions !== undefined || p.actions !== undefined) {
      const actions: Record<string, ActionValue> = {};
      const owed = new Map<string, JumpPhase>();
      for (const name of Object.keys(frame.actions ?? {})) {
        const a = frame.actions![name]!;
        const prev = p.actions?.[name];
        const m = prev !== undefined ? mergePhase(prev.p, a.p) : { now: a.p, then: null };
        actions[name] = m.now === a.p ? a : { v: a.v, ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}), p: m.now };
        if (m.then !== null) owed.set(name, m.then);
      }
      merged.actions = actions;
      this.owedActions = owed.size > 0 ? owed : null;
    }
    this.pending = merged;
  }

  sample(stepIndex: number): ActionFrame {
    const f = this.pending;
    if (f === null) return { stepIndex, moveX: 0, jump: 'none' };
    const out: ActionFrame = { stepIndex, moveX: f.moveX, jump: f.jump, ...(f.actions !== undefined ? { actions: f.actions } : {}) };
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
        if (a !== undefined) actions[name] = { v: a.v, ...(a.x !== undefined ? { x: a.x } : {}), ...(a.y !== undefined ? { y: a.y } : {}), p };
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
