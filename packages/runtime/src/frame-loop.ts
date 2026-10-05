/**
 * The runtime's animation-frame driver: the one rAF loop a running runtime
 * owns, paced by the game's frame-rate cap (`FramePacer`), with `ctx.display`
 * over that pacer. It sits apart from the runtime so the loop's install,
 * cancel and pacing stay one small piece the runtime only starts and stops.
 */
import type { FrameRateCap } from '@thirdlight/project-model';

import { displayControlOf, FramePacer } from './frame-pacing';
import type { BehaviorDisplay } from './types-behavior-world';

export function hasRaf(): boolean {
  return typeof globalThis.requestAnimationFrame === 'function';
}

/** The page's clock in seconds (null: no `performance.now`, the host must inject one). */
export function defaultClock(): (() => number) | null {
  const p = globalThis.performance;
  if (p && typeof p.now === 'function') return () => p.now() / 1000;
  return null;
}

/** What the loop asks of the runtime it drives. */
export interface FrameLoopHost {
  /** Whether frames still run (a stop, a dispose or a fail-stop ends the loop). */
  running(): boolean;
  /** The runtime's clock (seconds): game time follows it, not the paced frames. */
  clock(): number;
  /** One frame update at `t` seconds. */
  runFrame(t: number): void;
}

export class FrameLoop {
  /** Which animation frames draw under the game's frame-rate cap. */
  readonly pacer: FramePacer;
  /** `ctx.display` over the pacer. */
  readonly display: BehaviorDisplay;
  private rafId: number | null = null;

  constructor(
    cap: FrameRateCap | null,
    private readonly host: FrameLoopHost,
  ) {
    this.pacer = new FramePacer(cap);
    this.display = displayControlOf(this.pacer);
  }

  /** Install the loop: exactly one live rAF callback while running (the wall anchor is set on its first frame). */
  start(): void {
    this.rafId = globalThis.requestAnimationFrame(this.onFrame);
  }

  /** Cancel the loop (its pending callback removed). */
  cancel(): void {
    if (this.rafId !== null) {
      const caf = globalThis.cancelAnimationFrame;
      if (typeof caf === 'function') caf(this.rafId);
      this.rafId = null;
    }
  }

  private readonly onFrame = (ts?: number): void => {
    if (!this.host.running()) return; // cancelled
    // A frame early for the frame-rate cap runs nothing: its steps run in the next drawn frame (game time is the clock's).
    const t = this.host.clock();
    if (this.pacer.frame(typeof ts === 'number' ? ts : t * 1000)) this.host.runFrame(t);
    // The loop reschedules itself, so stop/dispose cancelling it leaves no duplicate loop.
    if (this.host.running()) this.rafId = globalThis.requestAnimationFrame(this.onFrame);
  };
}
