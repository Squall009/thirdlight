import { describe, it, expect } from 'vitest';
import {
  Gesture,
  GestureRunner,
  applyRawGesture,
  transformsEqual,
  type CommitCommand,
  type GestureCommandSink,
  type Transform,
} from './gesture';

const base: Transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

/** A counting sink that also maintains a one-step undo history. */
class TestSink implements GestureCommandSink {
  readonly issued: CommitCommand[] = [];
  readonly undoStack: Transform[] = [];
  current: Transform = clone(base);
  issue(command: CommitCommand): void {
    this.undoStack.push(clone(this.current));
    this.current = clone(command.args.transform);
    this.issued.push(command);
  }
  undo(): Transform | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.current = previous;
    return previous;
  }
}

function clone(t: Transform): Transform {
  return { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
}

describe('packet 27 — command discipline (zero during drag, one on release, none on cancel)', () => {
  it('per-frame previews issue no command at all; release issues exactly one', () => {
    const sink = new TestSink();
    const runner = new GestureRunner('e1', 5, base, sink, { snapping: true });
    for (let i = 0; i < 50; i += 1) {
      runner.preview({ kind: 'translate', delta: [i * 0.01, 0, 0] });
    }
    expect(sink.issued.length).toBe(0);
    expect(runner.gesture.commandDecisions).toBe(0);
    const outcome = runner.release();
    expect(outcome.kind).toBe('commit');
    expect(sink.issued.length).toBe(1);
    expect(runner.gesture.commandDecisions).toBe(1);
    // The single commit carries the base revision (the revision at drag start).
    expect(sink.issued[0]?.expectedRevision).toBe(5);
  });

  it('cancel issues no command and reverts the preview', () => {
    const sink = new TestSink();
    const runner = new GestureRunner('e1', 5, base, sink, { snapping: true });
    runner.preview({ kind: 'translate', delta: [3, 0, 0] });
    runner.preview({ kind: 'translate', delta: [5, 0, 0] });
    runner.cancel();
    expect(runner.gesture.isCancelled).toBe(true);
    expect(transformsEqual(runner.gesture.localPreview, base)).toBe(true);
    const outcome = runner.release();
    expect(outcome.kind).toBe('noop');
    expect(sink.issued.length).toBe(0);
    expect(runner.gesture.commandDecisions).toBe(0);
  });

  it('a drag that returns to its origin issues nothing', () => {
    const sink = new TestSink();
    const runner = new GestureRunner('e1', 5, base, sink);
    runner.preview({ kind: 'translate', delta: [4, 0, 0] });
    runner.preview({ kind: 'translate', delta: [0, 0, 0] });
    expect(runner.release().kind).toBe('noop');
    expect(sink.issued.length).toBe(0);
  });

  it('one undo restores the pre-gesture transform', () => {
    const sink = new TestSink();
    const preGesture: Transform = { position: [1, 1, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    sink.current = clone(preGesture);
    const runner = new GestureRunner('e1', 5, preGesture, sink);
    runner.preview({ kind: 'translate', delta: [2, 0, 0] });
    runner.release();
    expect(sink.current.position).toEqual([3, 1, 1]);
    expect(sink.undoStack.length).toBe(1);
    const restored = sink.undo();
    expect(restored?.position).toEqual([1, 1, 1]);
    expect(sink.undoStack.length).toBe(0);
  });
});

describe('packet 27 — snapping in the local gesture path', () => {
  it('translate preview snaps the world-axis delta to 0.25 m (snapping on)', () => {
    const runner = new GestureRunner('e1', 5, base, new TestSink(), { snapping: true });
    const t = runner.preview({ kind: 'translate', delta: [0.6, 0.6, -0.6] });
    expect(t.position).toEqual([0.5, 0.5, -0.5]);
  });

  it('holding Shift disables snapping for that preview (raw delta kept)', () => {
    const runner = new GestureRunner('e1', 5, base, new TestSink(), { snapping: true });
    const t = runner.preview({ kind: 'translate', delta: [0.6, 0, 0] }, true);
    expect(t.position[0]).toBeCloseTo(0.6, 12);
  });

  it('snapping can be disabled locally (no persistent setting)', () => {
    const runner = new GestureRunner('e1', 5, base, new TestSink());
    runner.gesture.setSnapping(false);
    const t = runner.preview({ kind: 'translate', delta: [0.6, 0, 0] });
    expect(t.position[0]).toBeCloseTo(0.6, 12);
    runner.gesture.setSnapping(true);
    expect(runner.preview({ kind: 'translate', delta: [0.6, 0, 0] }).position[0]).toBe(0.5);
  });

  it('rotate snaps the accumulated angle to 15° and rebuilds a unit quaternion', () => {
    const runner = new GestureRunner('e1', 5, base, new TestSink(), { snapping: true });
    const tiny = runner.preview({ kind: 'rotate', axis: [0, 1, 0], angleRad: 0.05 });
    expect(tiny.rotation).toEqual([0, 0, 0, 1]);
    const t = runner.preview({ kind: 'rotate', axis: [0, 1, 0], angleRad: 0.2 });
    expect(Math.hypot(...t.rotation)).toBeCloseTo(1, 12);
    expect(t.rotation[1]).toBeCloseTo(Math.sin(0.2618 / 2), 12);
  });

  it('scale snaps the uniform factor to 0.25 and clamps the result', () => {
    const runner = new GestureRunner('e1', 5, base, new TestSink(), { snapping: true });
    expect(runner.preview({ kind: 'scale', factor: 0.6 }).scale).toEqual([0.5, 0.5, 0.5]);
    expect(runner.preview({ kind: 'scale', factor: 0.001 }).scale).toEqual([0.01, 0.01, 0.01]);
    expect(runner.preview({ kind: 'scale', factor: 1000 }).scale).toEqual([100, 100, 100]);
  });

  it('the committed transform is the snapped, quantized preview', () => {
    const sink = new TestSink();
    const runner = new GestureRunner('e1', 5, base, sink, { snapping: true });
    runner.preview({ kind: 'translate', delta: [1.13, 0, 0] });
    runner.release();
    expect(sink.issued[0]?.args.transform.position).toEqual([1.25, 0, 0]);
  });

  it('applyRawGesture is exact per kind and coordinate space (no parent-space math)', () => {
    expect(applyRawGesture(base, { kind: 'translate', delta: [1, 2, 3] }, true)).toEqual({
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    const scaled = applyRawGesture(base, { kind: 'scale', factor: 2 }, true);
    expect(scaled.scale).toEqual([2, 2, 2]);
    // Unsnapped path keeps the raw value (Shift/cancel-friendly).
    expect(applyRawGesture(base, { kind: 'translate', delta: [0.6, 0, 0] }, false).position[0]).toBeCloseTo(0.6, 12);
  });
});

describe('packet 27 — remote edit during the drag (conflict handling)', () => {
  it('the drag keeps the base revision; a remote edit causes one bounded rebase, then surfaces the conflict', () => {
    const sink = new TestSink();
    const runner = new GestureRunner('e1', 5, base, sink, { snapping: true });
    runner.preview({ kind: 'translate', delta: [3, 0, 0] });

    // A remote client advanced the revision to 6 and moved the entity to
    // [1, 0, 0] while the drag was still active. The projection may show that,
    // but the gesture's commit still EXPECTS the revision it started from.
    const first = runner.release();
    expect(first.kind).toBe('commit');
    if (first.kind !== 'commit') return;
    expect(first.command.expectedRevision).toBe(5);
    expect(sink.issued[0]?.args.transform.position).toEqual([3, 0, 0]);

    // The backend rejects it; the gesture auto-rebases exactly once.
    const second = runner.handleResult({ ok: false, code: 'revision_conflict', currentRevision: 6 }, () => ({
      position: [1, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }));
    expect(second.kind).toBe('commit');
    if (second.kind !== 'commit') return;
    expect(second.command.expectedRevision).toBe(6);
    // The user's target is preserved — never silently re-snapped or dropped.
    expect(second.command.args.transform.position).toEqual([3, 0, 0]);

    // A second conflict is surfaced (explained, not lost).
    const third = runner.handleResult({ ok: false, code: 'revision_conflict', currentRevision: 9 }, () => clone(base));
    expect(third.kind).toBe('conflict');
    if (third.kind !== 'conflict') return;
    expect(third.conflict.currentRevision).toBe(9);
    expect(sink.issued.length).toBe(2); // exactly one retry, never more
  });

  it('a cancelled gesture is not resurrected by a conflict result', () => {
    const sink = new TestSink();
    const runner = new GestureRunner('e1', 5, base, sink);
    runner.preview({ kind: 'translate', delta: [2, 0, 0] });
    runner.cancel();
    const outcome = runner.handleResult({ ok: false, code: 'revision_conflict', currentRevision: 6 }, () => clone(base));
    expect(outcome.kind).toBe('conflict');
    expect(sink.issued.length).toBe(0);
  });
});
