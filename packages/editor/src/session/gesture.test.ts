import { describe, it, expect } from 'vitest';
import { Gesture, transformsEqual, type Transform } from './gesture';

const t = (position: number[]): Transform => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

describe('Gesture — local preview, no commit for a no-op drag', () => {
  it('a drag that ends where it began ⇒ no command', () => {
    const g = new Gesture('e1', 5, t([0, 0, 0]));
    g.setLocal(t([2, 0, 0]));
    g.setLocal(t([0, 0, 0])); // released back at the origin
    const out = g.decideCommit();
    expect(out.kind).toBe('noop');
  });
});

describe('Gesture — one commit command with the base revision', () => {
  it('a real drag ⇒ exactly one setTransform expecting the base revision', () => {
    const g = new Gesture('e1', 5, t([0, 0, 0]));
    g.setLocal(t([0.1, 0, 0])); // per-frame preview (no traffic)
    g.setLocal(t([3, 0, 0]));
    const out = g.decideCommit();
    expect(out.kind).toBe('commit');
    if (out.kind !== 'commit') return;
    expect(out.command.op).toBe('setTransform');
    expect(out.command.entityId).toBe('e1');
    expect(out.command.expectedRevision).toBe(5);
    expect(out.command.args.transform.position).toEqual([3, 0, 0]);
  });
});

describe('Gesture — conflict recovery (≤ 1 auto-retry, never silently lost)', () => {
  it('a stale base ⇒ auto-rebase ONCE to currentRevision and commit again', () => {
    const g = new Gesture('e1', 5, t([0, 0, 0]));
    g.setLocal(t([3, 0, 0]));
    const first = g.decideCommit();
    expect(first.kind).toBe('commit');

    // The backend advanced to 7 while we dragged; our commit conflicts.
    // rebase() returns the entity's CURRENT transform at that revision.
    const second = g.handleResult(
      { ok: false, code: 'revision_conflict', currentRevision: 7 },
      () => t([1, 0, 0]), // the entity moved to [1,0,0] under us
    );
    expect(second.kind).toBe('commit'); // auto-retried once
    if (second.kind !== 'commit') return;
    expect(second.command.expectedRevision).toBe(7); // rebased
    expect(second.command.args.transform.position).toEqual([3, 0, 0]); // user's target preserved
  });

  it('a second conflict after the retry ⇒ surfaced (explained), not lost', () => {
    const g = new Gesture('e1', 5, t([0, 0, 0]));
    g.setLocal(t([3, 0, 0]));
    g.decideCommit();
    g.handleResult({ ok: false, code: 'revision_conflict', currentRevision: 7 }, () => t([1, 0, 0]));
    const third = g.handleResult({ ok: false, code: 'revision_conflict', currentRevision: 9 }, () => t([2, 0, 0]));
    expect(third.kind).toBe('conflict');
    if (third.kind !== 'conflict') return;
    expect(third.conflict.currentRevision).toBe(9);
  });

  it('a success after the retry ⇒ done (noop)', () => {
    const g = new Gesture('e1', 5, t([0, 0, 0]));
    g.setLocal(t([3, 0, 0]));
    g.decideCommit();
    g.handleResult({ ok: false, code: 'revision_conflict', currentRevision: 7 }, () => t([1, 0, 0]));
    const done = g.handleResult({ ok: true }, () => t([1, 0, 0]));
    expect(done.kind).toBe('noop');
  });

  it('the user target equal to the changed base after rebase ⇒ noop (nothing left)', () => {
    const g = new Gesture('e1', 5, t([0, 0, 0]));
    g.setLocal(t([1, 0, 0]));
    g.decideCommit();
    const out = g.handleResult({ ok: false, code: 'revision_conflict', currentRevision: 7 }, () => t([1, 0, 0]));
    expect(out.kind).toBe('noop');
  });
});

describe('transformsEqual', () => {
  it('compares all three fields element-wise', () => {
    expect(transformsEqual(t([1, 2, 3]), t([1, 2, 3]))).toBe(true);
    expect(transformsEqual(t([1, 2, 3]), t([1, 2, 4]))).toBe(false);
  });
});