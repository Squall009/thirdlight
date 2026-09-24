/**
 * The exclusive-test action source shared by the play previews (sessions.md
 * §18.1): while an input-exercise relay is active the browser binding is not
 * sampled (physical input is suppressed and cleared), the relay frames apply
 * at their `stepOffset` positions, and completion reports the applied step
 * range and re-arms the physical source.
 */
import { neutralFrame, type ActionFrame, type ActionSource } from '@thirdlight/runtime';

export class RelayActionSource implements ActionSource {
  private readonly browser: ActionSource & { reset?: (reason?: string) => void };
  private test: { frames: Map<number, ActionFrame>; base: number; lastOffset: number; first: number; last: number } | null = null;
  private onComplete: ((from: number, to: number) => void) | null = null;

  constructor(browser: ActionSource & { reset?: (reason?: string) => void }) {
    this.browser = browser;
  }

  beginTest(frames: readonly { stepOffset: number; moveX: number; jump: string; actions?: ActionFrame['actions'] }[], firstStep: number, onComplete: (from: number, to: number) => void): boolean {
    if (this.test !== null) return false;
    const map = new Map<number, ActionFrame>();
    let lastOffset = -1;
    for (const f of frames) {
      const jump = f.jump as ActionFrame['jump'];
      map.set(f.stepOffset, { stepIndex: firstStep + f.stepOffset, moveX: f.moveX, jump, ...(f.actions !== undefined ? { actions: f.actions } : {}) });
      if (f.stepOffset > lastOffset) lastOffset = f.stepOffset;
    }
    this.browser.reset?.('exclusive-test');
    this.test = { frames: map, base: firstStep, lastOffset, first: -1, last: -1 };
    this.onComplete = onComplete;
    return true;
  }

  get testActive(): boolean {
    return this.test !== null;
  }

  sample(stepIndex: number): ActionFrame {
    const test = this.test;
    if (test === null) return this.browser.sample(stepIndex);
    const offset = stepIndex - test.base;
    const frame = test.frames.get(offset);
    if (frame !== undefined) {
      if (test.first < 0) test.first = stepIndex;
      test.last = stepIndex;
      const done = offset >= test.lastOffset;
      const out: ActionFrame = { stepIndex, moveX: frame.moveX, jump: frame.jump, ...(frame.actions !== undefined ? { actions: frame.actions } : {}) };
      if (done) this.finish();
      return out;
    }
    if (offset > test.lastOffset) {
      const from = test.first < 0 ? test.base : test.first;
      const to = test.last < 0 ? test.base : test.last;
      this.finish();
      this.onComplete?.(from, to);
      return neutralFrame(stepIndex);
    }
    return neutralFrame(stepIndex);
  }

  private finish(): void {
    const test = this.test;
    this.test = null;
    if (test === null) return;
    const from = test.first < 0 ? test.base : test.first;
    const to = test.last < 0 ? test.base : test.last;
    const cb = this.onComplete;
    this.onComplete = null;
    this.browser.reset?.('physical-rearm');
    cb?.(from, to);
  }
}

