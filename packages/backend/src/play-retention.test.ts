/**
 * Ended plays are kept only as their `ended` answer. The
 * snapshot is released when a play stops, and at most ENDED_PLAYS_KEPT ended
 * records are kept, none older than ENDED_PLAY_RETENTION_MS.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { ENDED_PLAY_RETENTION_MS, ENDED_PLAYS_KEPT, PlayManager } from './play';

let clock = 1_000_000;
const managers: PlayManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
});

function manager(): PlayManager {
  const m = new PlayManager({
    // The owner is gone: a stop finishes at once (the unconfirmed path).
    sendToOwner: () => false,
    logPlay: () => undefined,
    ttlMs: () => 30 * 60_000,
    relayTimeoutMs: () => 10_000,
    stopAckTimeoutMs: () => 5_000,
    presentTimeoutMs: () => 15_000,
    inputRelayTimeoutMs: () => 10_000,
    nowMs: () => clock,
  });
  managers.push(m);
  return m;
}

const snapshot = (i: number) => ({ snapshotId: `p@r${i}`, projectId: 'p', revision: i, scene: { schemaVersion: 3, sceneId: 's', revision: i, entities: [{ id: `e-${i}`, components: { transform: { position: [0, 0, 0] } } }] } });

function playAndStop(m: PlayManager, i: number): string {
  const id = `play-${String(i).padStart(32, '0')}`;
  const rec = m.add(id, 'p', 'sess', snapshot(i) as never, false, `build-${i}`, clock);
  rec.snapshotBytes = new Uint8Array(1024);
  m.stop(rec, 'request');
  return id;
}

describe('phase 25.24 (D48): bounded retention of ended plays', () => {
  it('a stopped play keeps its ended answer and drops its snapshot', () => {
    const m = manager();
    const id = playAndStop(m, 1);
    const rec = m.get(id)!;
    expect(rec.state).toBe('stopped');
    expect(rec.snapshot).toBeNull();
    expect(rec.snapshotBytes).toBeUndefined();
    expect(m.describeEnd(rec)?.end).toMatchObject({ reason: 'request', presented: false });
  });

  it(`keeps at most ${ENDED_PLAYS_KEPT} ended plays, the most recent ones`, () => {
    const m = manager();
    const ids: string[] = [];
    for (let i = 0; i < ENDED_PLAYS_KEPT + 20; i += 1) {
      clock += 10;
      ids.push(playAndStop(m, i));
    }
    expect(m.counts()).toEqual({ records: ENDED_PLAYS_KEPT, ended: ENDED_PLAYS_KEPT });
    expect(m.get(ids[0]!)).toBeUndefined();
    expect(m.get(ids[19]!)).toBeUndefined();
    const recent = m.get(ids[ids.length - 1]!)!;
    expect(m.describeEnd(recent)?.end.reason).toBe('request');
    expect(m.get(ids[20]!)?.state).toBe('stopped');
  });

  it('drops ended plays older than the retention window, and never a live one', () => {
    const m = manager();
    const old = playAndStop(m, 1);
    const live = m.add(`play-${'f'.repeat(32)}`, 'q', 'sess', snapshot(2) as never, false, 'build-live', clock);
    clock += ENDED_PLAY_RETENTION_MS + 1;
    expect(m.get(old)).toBeUndefined();
    expect(m.get(live.playSessionId)?.state).toBe('active');
    expect(m.get(live.playSessionId)?.snapshot).not.toBeNull();
    expect(m.counts()).toEqual({ records: 1, ended: 0 });
  });
});
