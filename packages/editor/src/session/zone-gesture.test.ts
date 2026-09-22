/**
 * M3 zone gesture tests (packet 56) — the imperative viewport gesture
 * decides; the backend commands are the only observable result.
 *
 * Observable surface (the packet's failure modes):
 *  - zero commands are decided during a gesture (the preview is local only);
 *  - a committed release decides exactly ONE command at the gesture's
 *    expected revision (the pre-gesture read);
 *  - a cancelled gesture decides zero and reverts the preview;
 *  - a `revision_conflict` is rebased at most ONCE (bounded retry, move only);
 *  - a create with a negligible drag (a click) places the default-size zone
 *    at the anchor; a checkpoint without a safe spawn is unplannable →
 *    zero commands (the UI preflights before arming).
 */
import { describe, it, expect } from 'vitest';
import {
  ZoneGesture,
  ZoneGestureRunner,
  type ZoneCommit,
  type ZoneGestureOptions,
  type ZonePose,
} from './zone-gesture';
import { MIN_ZONE_SPAN_UI } from './gameplay';

const POSE: ZonePose = { position: [0, 0, 0], size: [2, 1] };

function decisions(g: ZoneGesture): number {
  return g.commandDecisions;
}

describe('ZoneGesture — move', () => {
  it('decides no commands during the drag; one setTransform on the committed release', () => {
    const g = new ZoneGesture('move', 5, POSE, { entityId: 'zone-0001' });
    expect(decisions(g)).toBe(0);
    g.preview({ dx: 1.5, dy: -0.5 });
    expect(g.localPreview).toEqual({ position: [1.5, -0.5, 0], size: [2, 1] });
    expect(decisions(g)).toBe(0); // the preview is local only
    const out = g.decideCommit();
    expect(out.kind).toBe('commit');
    if (out.kind !== 'commit') return;
    expect(out.command).toEqual({
      op: 'setTransform',
      entityId: 'zone-0001',
      args: {
        entityId: 'zone-0001',
        transform: { position: [1.5, -0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    });
    expect(decisions(g)).toBe(1);
    expect(g.expectedRevision).toBe(5); // the pre-gesture read
  });

  it('a release without movement is a noop with zero commands', () => {
    const g = new ZoneGesture('move', 5, POSE, { entityId: 'zone-0001' });
    g.preview({ dx: 0, dy: 0 });
    expect(g.decideCommit().kind).toBe('noop');
    expect(decisions(g)).toBe(0);
  });

  it('cancel reverts the preview and decides nothing', () => {
    const g = new ZoneGesture('move', 5, POSE, { entityId: 'zone-0001' });
    g.preview({ dx: 3, dy: 0 });
    expect(g.localPreview.position).toEqual([3, 0, 0]);
    g.cancel();
    expect(g.localPreview).toEqual(POSE);
    expect(g.decideCommit().kind).toBe('noop');
    expect(decisions(g)).toBe(0);
  });

  it('rebases a revision_conflict once (re-applying the delta to the new base) and surfaces a second conflict', () => {
    const g = new ZoneGesture('move', 5, POSE, { entityId: 'zone-0001' });
    g.preview({ dx: 2, dy: 0 });
    const initial = g.decideCommit(); // the original decision (issues nothing itself)
    expect(initial.kind).toBe('commit');
    const first = g.handleResult(
      { ok: false, code: 'revision_conflict', currentRevision: 9 },
      () => ({ position: [4, 1, 0], size: [2, 1] }), // the projection says the entity is now at (4,1)
    );
    expect(first.kind).toBe('commit');
    if (first.kind !== 'commit') return;
    // The commit re-applies the delta (2,0) to the rebased base (4,1) at revision 9.
    expect(first.command).toMatchObject({
      op: 'setTransform',
      args: { transform: { position: [6, 1, 0] } },
    });
    expect(g.expectedRevision).toBe(9);
    expect(decisions(g)).toBe(2); // the original decision + the bounded rebase
    const second = g.handleResult(
      { ok: false, code: 'revision_conflict', currentRevision: 11 },
      () => ({ position: [4, 1, 0], size: [2, 1] }),
    );
    expect(second.kind).toBe('conflict');
    if (second.kind !== 'conflict') return;
    expect(second.conflict).toEqual({ currentRevision: 11, expectedRevision: 9 });
  });

  it('a revision_conflict on an UNMOVED gesture degrades to a noop (there is nothing to rebase)', () => {
    const g = new ZoneGesture('move', 5, POSE, { entityId: 'zone-0001' });
    const out = g.handleResult(
      { ok: false, code: 'revision_conflict', currentRevision: 9 },
      () => ({ ...POSE, position: [0, 0, 0] }),
    );
    expect(out.kind).toBe('noop');
  });
});

describe('ZoneGesture — resize', () => {
  it('one setComponent(gameZone, { size }) per gesture', () => {
    const g = new ZoneGesture('resize', 3, { position: [0, 0, 0], size: [2, 1] }, { entityId: 'zone-0001' });
    g.preview({ dx: 0.5, dy: 0.25 });
    const out = g.decideCommit();
    expect(out.kind).toBe('commit');
    if (out.kind !== 'commit') return;
    expect(out.command).toEqual({
      op: 'setComponent',
      entityId: 'zone-0001',
      args: { entityId: 'zone-0001', component: 'gameZone', value: { size: [2.5, 1.25] } },
    });
  });

  it('a size drag below the UI floor commits the clamped size (never an invalid zone)', () => {
    const g = new ZoneGesture('resize', 3, { position: [0, 0, 0], size: [0.10001, 5] }, { entityId: 'zone-0001' });
    g.preview({ dx: -100, dy: 0 });
    expect(g.localPreview.size).toEqual([MIN_ZONE_SPAN_UI, 5]);
    const out = g.decideCommit();
    expect(out.kind).toBe('commit');
    if (out.kind !== 'commit') return;
    expect((out.command as Extract<ZoneCommit, { op: 'setComponent' }>).args.value).toEqual({ size: [MIN_ZONE_SPAN_UI, 5] });
  });

  it('an unchanged size is a noop', () => {
    const g = new ZoneGesture('resize', 3, { position: [0, 0, 0], size: [2, 1] }, { entityId: 'zone-0001' });
    g.preview({ dx: 0, dy: 0 });
    expect(g.decideCommit().kind).toBe('noop');
    expect(decisions(g)).toBe(0);
  });
});

describe('ZoneGesture — create', () => {
  const OPTS: ZoneGestureOptions = { role: 'hazard' };

  it('a dragged create decides one createEntity with the extent as size', () => {
    const g = new ZoneGesture('create', 7, { position: [1, 2, 0], size: [1, 1] }, OPTS);
    g.preview({ dx: 2, dy: -1 });
    const out = g.decideCommit();
    expect(out.kind).toBe('commit');
    if (out.kind !== 'commit') return;
    expect(out.command.op).toBe('createEntity');
    const args = out.command.op === 'createEntity' ? out.command.args : null;
    expect(args?.kind).toBe('group');
    expect(args?.components.gameZone).toEqual({ role: 'hazard', size: [2, 1] });
    // The preview centers the extent on the anchor (right/up drag: +w/2, -h/2).
    expect(args?.transform.position).toEqual([2, 1.5, 0]);
    expect(decisions(g)).toBe(1);
  });

  it('a negligible drag (a click) places the default-size zone at the anchor', () => {
    const g = new ZoneGesture('create', 7, { position: [1, 2, 0], size: [1, 1] }, OPTS);
    g.preview({ dx: 0, dy: 0 });
    const out = g.decideCommit();
    expect(out.kind).toBe('commit');
    if (out.kind !== 'commit') return;
    const args = out.command.op === 'createEntity' ? out.command.args : null;
    expect(args?.transform.position).toEqual([1, 2, 0]);
    expect(args?.components.gameZone).toEqual({ role: 'hazard', size: [1.5, 0.5] }); // the hazard default
  });

  it('an unplannable create (a checkpoint without a safe spawn) decides zero commands', () => {
    const g = new ZoneGesture('create', 7, { position: [0, 0, 0], size: [1, 1] }, { role: 'checkpoint' });
    g.preview({ dx: 2, dy: 2 });
    const out = g.decideCommit();
    expect(out.kind).toBe('noop');
    expect(decisions(g)).toBe(0);
  });

  it('a checkpoint create with a safe spawn carries the reference + default activation', () => {
    const g = new ZoneGesture('create', 7, { position: [0, 0, 0], size: [1, 1] }, { role: 'checkpoint', safeSpawnId: 'spawn-0001' });
    g.preview({ dx: 1.5, dy: 1.5 });
    const out = g.decideCommit();
    expect(out.kind).toBe('commit');
    if (out.kind !== 'commit') return;
    const args = out.command.op === 'createEntity' ? out.command.args : null;
    expect(args?.components.gameZone).toMatchObject({ role: 'checkpoint', safeSpawnId: 'spawn-0001', activation: { cueAssetId: null } });
  });
});

describe('ZoneGestureRunner — the command sink contract', () => {
  it('issues exactly one command on a committed release and zero on cancel', () => {
    const issued: ZoneCommit[] = [];
    const sink = { issue: (c: ZoneCommit) => { issued.push(c); } };

    // Committed move.
    const r1 = new ZoneGestureRunner('move', 5, { position: [0, 0, 0], size: [2, 1] }, sink, { entityId: 'zone-0001' });
    r1.preview({ dx: 1, dy: 1 });
    expect(issued).toHaveLength(0); // nothing during the drag
    const committed = r1.release();
    expect(committed.kind).toBe('commit');
    expect(issued).toHaveLength(1);
    expect(issued[0]?.op).toBe('setTransform');

    // Cancelled move: nothing issued.
    const r2 = new ZoneGestureRunner('move', 6, { position: [0, 0, 0], size: [2, 1] }, sink, { entityId: 'zone-0001' });
    r2.preview({ dx: 4, dy: 0 });
    r2.cancel();
    expect(issued).toHaveLength(1);

    // A no-op release: nothing issued.
    const r3 = new ZoneGestureRunner('move', 6, { position: [0, 0, 0], size: [2, 1] }, sink, { entityId: 'zone-0001' });
    const noop = r3.release();
    expect(noop.kind).toBe('noop');
    expect(issued).toHaveLength(1);
  });
});