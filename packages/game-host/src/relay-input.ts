/**
 * The exclusive-test action source shared by the play previews (sessions.md
 * §18.1): while an input-exercise relay is active the browser binding is not
 * sampled (physical input is suppressed and cleared), the relay frames apply
 * at their `stepOffset` positions, and completion reports the applied step
 * range and re-arms the physical source.
 *
 * Phase 25.15: a frame may hold for `steps` steps (run length: its first step
 * as written, the rest its continuation), carry UI edges (handed to the page
 * on the frame's first step, where they drive menus like keys) and its
 * pointer goes through the UI hit test: over a UI element the game reads
 * `overUi` and does not see a press that went to the UI, and a left press and
 * release on one element clicks it (handed to the page). Steps no frame
 * covers are neutral. A virtual gamepad is resolved into actions and UI edges
 * on the page before the frames get here (it needs the input bindings).
 */
import { neutralFrame, type ActionFrame, type ActionSource, type PointerSample } from '@thirdlight/runtime';
import { continueFrame } from './tick-input';

/** The UI edges a relay frame may carry (the keys and pad buttons that drive menus). */
export type RelayUiEdgeName = 'up' | 'down' | 'left' | 'right' | 'submit' | 'cancel' | 'pause';

/** One relay test frame (phase 24.8: frame version 2 — named actions and the pointer, no fixed move/jump channels). */
export interface RelayTestFrame {
  stepOffset: number;
  /** Phase 25.15: the frame holds for this many steps (absent: 1). */
  steps?: number;
  actions?: ActionFrame['actions'];
  pointer?: ActionFrame['pointer'];
  /** Phase 25.15: UI edges on the frame's first step. */
  ui?: readonly RelayUiEdgeName[];
}

/** Phase 25.15: what a relay step hands to the page (it owns the UI). */
export type RelayEffect = { readonly kind: 'ui'; readonly edges: readonly RelayUiEdgeName[] } | { readonly kind: 'click'; readonly key: string };

interface Run {
  readonly start: number;
  readonly end: number;
  readonly first: ActionFrame;
  readonly rest: ActionFrame;
  readonly ui: readonly RelayUiEdgeName[] | undefined;
}

export class RelayActionSource implements ActionSource {
  private readonly browser: ActionSource & { reset?: (reason?: string) => void };
  private test: { runs: Run[]; cursor: number; base: number; end: number; first: number; last: number; next: number } | null = null;
  private onComplete: ((from: number, to: number) => void) | null = null;
  private uiHit: ((x: number, y: number) => string | null) | null = null;
  private effect: ((e: RelayEffect) => void) | null = null;
  /** The pointer buttons as the relay frames gave them (edges are derived from them). */
  private relayButtons = 0;
  /** Buttons whose press went to the UI (the game does not see them until they are released). */
  private uiHeld = 0;
  private pressKey: string | null = null;

  constructor(browser: ActionSource & { reset?: (reason?: string) => void }) {
    this.browser = browser;
  }

  /** Phase 25.15: the UI hit test (the key of the topmost UI target under x, y; null: the game view). */
  setUiHit(hit: ((x: number, y: number) => string | null) | null): void {
    this.uiHit = hit;
  }

  /** Phase 25.15: where UI edges and clicks go (the page's UI). */
  setEffectSink(sink: ((e: RelayEffect) => void) | null): void {
    this.effect = sink;
  }

  beginTest(frames: readonly RelayTestFrame[], firstStep: number, onComplete: (from: number, to: number) => void): boolean {
    if (this.test !== null) return false;
    const runs: Run[] = [];
    let end = 0;
    for (const f of frames) {
      const steps = f.steps ?? 1;
      const first: ActionFrame = { stepIndex: 0, ...(f.actions !== undefined ? { actions: f.actions } : {}), ...(f.pointer !== undefined ? { pointer: f.pointer } : {}) };
      runs.push({ start: f.stepOffset, end: f.stepOffset + steps, first, rest: continueFrame(first), ui: f.ui !== undefined && f.ui.length > 0 ? f.ui : undefined });
      if (f.stepOffset + steps > end) end = f.stepOffset + steps;
    }
    runs.sort((a, b) => a.start - b.start);
    this.browser.reset?.('exclusive-test');
    this.test = { runs, cursor: 0, base: firstStep, end, first: -1, last: -1, next: firstStep - 1 };
    this.relayButtons = 0;
    this.uiHeld = 0;
    this.pressKey = null;
    this.onComplete = onComplete;
    return true;
  }

  get testActive(): boolean {
    return this.test !== null;
  }

  sample(stepIndex: number): ActionFrame {
    const test = this.test;
    if (test === null) return this.browser.sample(stepIndex);
    test.next = stepIndex + 1;
    return this.at(test, stepIndex - test.base, stepIndex);
  }

  /**
   * Phase 25.15: a page frame in which the simulation holds (the game is
   * paused: a menu, the pause screen) while the exercise runs — it takes the
   * place of one step, so the frames' UI edges and pointer clicks still reach
   * the UI (a paused game's menu can be driven, and resumed); their actions
   * have nothing to drive and are not applied.
   */
  idle(): void {
    const test = this.test;
    if (test === null) return;
    const offset = test.next - test.base;
    test.base -= 1;
    this.at(test, offset, null);
  }

  private at(test: NonNullable<RelayActionSource['test']>, offset: number, stepIndex: number | null): ActionFrame {
    const index = stepIndex ?? 0;
    while (test.cursor < test.runs.length && test.runs[test.cursor]!.end <= offset) test.cursor += 1;
    const run = test.runs[test.cursor];
    if (run !== undefined && offset >= run.start && offset < run.end) {
      if (stepIndex !== null) {
        if (test.first < 0) test.first = stepIndex;
        test.last = stepIndex;
      }
      const isFirst = offset === run.start;
      const frame = isFirst ? run.first : run.rest;
      if (isFirst && run.ui !== undefined) this.effect?.({ kind: 'ui', edges: run.ui });
      const out: ActionFrame = { stepIndex: index, ...(frame.actions !== undefined ? { actions: frame.actions } : {}) };
      if (frame.pointer !== undefined) out.pointer = this.throughUi(frame.pointer);
      if (offset >= test.end - 1) this.finish();
      return out;
    }
    if (offset >= test.end) {
      this.finish();
      return neutralFrame(index);
    }
    // A gap: neutral (no action, no new pointer sample).
    return neutralFrame(index);
  }

  /**
   * Phase 25.15: the pointer through the UI hit test. A press over a UI
   * target goes to the UI (the game sees neither it nor its release) and a
   * left press and release on one target clicks it; the game reads `overUi`
   * while the pointer is over one.
   */
  private throughUi(p: PointerSample): PointerSample {
    const key = p.locked === true || this.uiHit === null ? null : this.uiHit(p.x, p.y);
    const buttons = p.buttons ?? 0;
    const prev = this.relayButtons;
    this.relayButtons = buttons;
    const down = (p.pressed ?? 0) | (buttons & ~prev);
    const up = (p.released ?? 0) | (prev & ~buttons);
    const taken = key !== null ? down : 0;
    if (taken !== 0) {
      this.uiHeld |= taken;
      if ((taken & 1) !== 0) this.pressKey = key;
    }
    const upUi = up & this.uiHeld;
    if ((upUi & 1) !== 0) {
      if (this.pressKey !== null && key === this.pressKey) this.effect?.({ kind: 'click', key: this.pressKey });
      this.pressKey = null;
    }
    const hidden = this.uiHeld;
    this.uiHeld &= ~upUi;
    if (key === null && hidden === 0) return p;
    const gameButtons = buttons & ~hidden;
    const pressed = (p.pressed ?? 0) & ~taken;
    const released = (p.released ?? 0) & ~upUi;
    return {
      x: p.x,
      y: p.y,
      ...(p.dx !== undefined ? { dx: p.dx } : {}),
      ...(p.dy !== undefined ? { dy: p.dy } : {}),
      ...(p.wheel !== undefined ? { wheel: p.wheel } : {}),
      ...(gameButtons !== 0 ? { buttons: gameButtons } : {}),
      ...(pressed !== 0 ? { pressed } : {}),
      ...(released !== 0 ? { released } : {}),
      ...(p.over !== undefined ? { over: p.over } : {}),
      ...(p.locked !== undefined ? { locked: p.locked } : {}),
      ...(key !== null ? { overUi: true } : {}),
    };
  }

  private finish(): void {
    const test = this.test;
    this.test = null;
    if (test === null) return;
    const from = test.first < 0 ? test.base : test.first;
    const to = test.last < 0 ? test.base : test.last;
    const cb = this.onComplete;
    this.onComplete = null;
    this.relayButtons = 0;
    this.uiHeld = 0;
    this.pressKey = null;
    this.browser.reset?.('physical-rearm');
    cb?.(from, to);
  }
}
