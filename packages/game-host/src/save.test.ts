/**
 * Phase 9.11: the save store — slots round-trip, a changed byte (checksum),
 * another version or junk read as damaged, an oversized save is refused,
 * settings are cleaned on read, clear() empties the namespace only.
 */
import { describe, expect, it } from 'vitest';

import { createSaveStore, saveChecksum, SAVE_MAX_BYTES, type SaveDocument, type SaveStorage } from './save';

const mapStorage = (): SaveStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => void map.set(k, v), remove: (k) => void map.delete(k) };
};

const DOC: SaveDocument = {
  version: 1,
  savedAt: '2026-09-24T08:00:00.000Z',
  levelId: 'meadow-1',
  levelIndex: 0,
  levelName: 'Meadow 1',
  lives: 2,
  run: { checkpointId: 'cp-1', counters: { coins: 3 }, collected: ['coin-1', 'coin-2', 'coin-3'], defeated: [], health: 2, values: { door: 'open' } },
  levels: {},
};

describe('save store', () => {
  it('round-trips a slot, reports damaged slots and refuses oversized saves', () => {
    const st = mapStorage();
    const save = createSaveStore(st, 'thirdlight:demo');
    expect(save.read('1')).toEqual({ state: 'empty' });
    expect(save.write('1', DOC)).toEqual({ ok: true });
    expect(save.read('1')).toEqual({ state: 'ok', doc: DOC });
    // One changed character: the checksum no longer matches.
    const raw = st.map.get('thirdlight:demo:1')!;
    st.map.set('thirdlight:demo:1', raw.replace('coin-3', 'coin-9'));
    expect(save.read('1')).toMatchObject({ state: 'damaged', reason: 'checksum mismatch' });
    st.map.set('thirdlight:demo:2', 'not json');
    expect(save.read('2')).toMatchObject({ state: 'damaged' });
    const body = JSON.stringify({ ...DOC, version: 2 });
    st.map.set('thirdlight:demo:3', JSON.stringify({ sum: saveChecksum(body), body }));
    expect(save.read('3')).toMatchObject({ state: 'damaged', reason: 'unknown version' });
    const huge = { ...DOC, run: { ...DOC.run, values: { big: 'x'.repeat(SAVE_MAX_BYTES) } } };
    expect(save.write('auto', huge).ok).toBe(false);
    expect(save.read('auto')).toEqual({ state: 'empty' });
  });

  it('keeps settings (cleaned on read) and clears only its own namespace', () => {
    const st = mapStorage();
    const save = createSaveStore(st, 'thirdlight:demo');
    save.writeSettings({ music: 0.4, sfx: 1, quality: 'medium', keys: { jump: 'KeyK' } });
    st.map.set('thirdlight:other:1', 'kept');
    expect(save.readSettings()).toEqual({ music: 0.4, sfx: 1, quality: 'medium', keys: { jump: 'KeyK' } });
    st.map.set('thirdlight:demo:settings', JSON.stringify({ music: 7, quality: 'ultra', keys: { jump: 'Key K!' } }));
    expect(save.readSettings()).toEqual({ music: 0.8, sfx: 1, quality: 'high', keys: {} });
    save.write('auto', DOC);
    save.clear();
    expect([...st.map.keys()]).toEqual(['thirdlight:other:1']);
  });
});
