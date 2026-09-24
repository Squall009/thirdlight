/**
 * Phase 14.2: `ctx.timers` — named timers of one script instance.
 *
 * Deterministic: a timer is a number of fixed steps (`seconds × fixedStepHz`,
 * rounded, at least one step), never wall-clock time, so a replay fires every
 * timer in the same step. The behavior host keeps one `InstanceTimers` per
 * instance, turns it over at the instance's first stepping in each step
 * (`begin`) and clears it at every new run (start, replay, a level switch).
 *
 * Pure: no DOM, no clock.
 */
import type { BehaviorTimers } from './types';

/** An engine limit protecting the runtime: running timers per script instance. */
export const MAX_TIMERS_PER_INSTANCE = 64;
/** The longest timer (s): an hour covers any in-game delay and keeps step counts small. */
export const MAX_TIMER_SECONDS = 3600;
const TIMER_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A bad `ctx.timers` call (the behavior host turns it into a script error). */
export class TimerCallError extends Error {
  readonly reason: 'behavior_timer_invalid' | 'behavior_timer_limit';
  constructor(reason: TimerCallError['reason'], message: string) {
    super(message);
    this.name = 'TimerCallError';
    this.reason = reason;
  }
}

interface Timer {
  /** The step it fires in next. */
  due: number;
  /** Its length in steps. */
  steps: number;
  repeat: boolean;
}

export class InstanceTimers {
  private readonly timers = new Map<string, Timer>();
  private firedNow = new Set<string>();
  /** The step the instance is in (-1: none yet). */
  private step = -1;
  readonly api: BehaviorTimers;

  constructor(private readonly hz: number) {
    this.api = Object.freeze({
      after: (name: string, seconds: number): boolean => this.start(name, seconds, false),
      every: (name: string, seconds: number): boolean => this.start(name, seconds, true),
      fired: (name: string): boolean => this.firedNow.has(String(name)),
      cancel: (name: string): boolean => this.timers.delete(String(name)),
    });
  }

  /** The instance's first stepping in `stepIndex`: the timers due now fire (once each, a repeating one moves on). */
  begin(stepIndex: number): void {
    if (stepIndex === this.step) return;
    this.step = stepIndex;
    if (this.firedNow.size > 0) this.firedNow = new Set();
    for (const [name, t] of this.timers) {
      if (t.due > stepIndex) continue;
      this.firedNow.add(name);
      if (!t.repeat) {
        this.timers.delete(name);
        continue;
      }
      // A repeating timer fires once per step even if steps were skipped.
      while (t.due <= stepIndex) t.due += t.steps;
    }
  }

  /** A new run: no timer runs, none has fired. */
  clear(): void {
    this.timers.clear();
    this.firedNow = new Set();
  }

  /** Running timers (diagnostics and tests). */
  get size(): number {
    return this.timers.size;
  }

  private start(rawName: unknown, seconds: unknown, repeat: boolean): boolean {
    const call = repeat ? 'every' : 'after';
    if (typeof rawName !== 'string' || !TIMER_NAME_RE.test(rawName)) {
      throw new TimerCallError('behavior_timer_invalid', `ctx.timers.${call}: the name is 1–64 letters, digits or _ . : - (got ${JSON.stringify(String(rawName)).slice(0, 80)})`);
    }
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > MAX_TIMER_SECONDS) {
      throw new TimerCallError('behavior_timer_invalid', `ctx.timers.${call}("${rawName}"): seconds is 0–${MAX_TIMER_SECONDS}`);
    }
    const steps = Math.max(1, Math.round(seconds * this.hz));
    const running = this.timers.get(rawName);
    if (running !== undefined && running.repeat === repeat && running.steps === steps) return false;
    if (running === undefined && this.timers.size >= MAX_TIMERS_PER_INSTANCE) {
      throw new TimerCallError('behavior_timer_limit', `ctx.timers.${call}("${rawName}"): at most ${MAX_TIMERS_PER_INSTANCE} timers run per script instance`);
    }
    // Before the first stepping (never in practice: the API is reached only from step) count from step 0.
    const now = Math.max(0, this.step);
    this.timers.set(rawName, { due: now + steps, steps, repeat });
    return true;
  }
}
