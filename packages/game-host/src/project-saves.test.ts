/**
 * The project save service forgets every slot of a game on
 * `clear()` (the editor's "Clear Play save" — the level flow's own saves it
 * cleared before were deleted with the flow). Real service over the memory
 * backend: two slots saved, then cleared; the stored keys are gone, the slot
 * list is empty and the simulation is told so.
 */
import { describe, expect, it } from 'vitest';

import type { SaveEvent } from '@thirdlight/runtime';

import { createProjectSaveService, memoryProjectSaveBackend, unavailableProjectSaveBackend, type DeviceStorage, type ProjectSaveBackend } from './project-saves';

describe('project saves: clear', () => {
  it('removes every slot of the game and hands the simulation the empty list', async () => {
    const map = new Map<string, string>();
    const events: SaveEvent[] = [];
    const svc = createProjectSaveService({ schema: { version: 1, slots: 3 }, backend: memoryProjectSaveBackend(map), namespace: 'thirdlight:game-a', queue: (e) => void events.push(e), now: () => '2026-09-28T00:00:00.000Z' });
    // Another game's slot in the same storage stays.
    map.set('thirdlight:game-b:slot:1:meta', '{}');
    await svc.start();
    const meta = { title: 'A', chapter: '', location: '', playSeconds: 1, version: 1, thumbnail: false };
    svc.handle([{ op: 'save', slot: 1, meta, text: JSON.stringify({ format: 'thirdlight.save', version: 1, doc: {} }) }, { op: 'save', slot: 3, meta, text: JSON.stringify({ format: 'thirdlight.save', version: 1, doc: {} }) }]);
    await svc.idle();
    expect(svc.slots().map((s) => s.slot)).toEqual([1, 3]);
    expect([...map.keys()].filter((k) => k.startsWith('thirdlight:game-a:slot:')).length).toBeGreaterThan(0);

    events.length = 0;
    await svc.clear();
    expect(svc.slots()).toEqual([]);
    expect([...map.keys()].filter((k) => k.startsWith('thirdlight:game-a:slot:'))).toEqual([]);
    expect(map.has('thirdlight:game-b:slot:1:meta')).toBe(true);
    const last = events.filter((e) => e.kind === 'slots').at(-1) as { slots: unknown[] } | undefined;
    expect(last?.slots).toEqual([]);
  });
});

describe('project saves: a picture before the first frame', () => {
  it('holds a save with a picture (and what follows it) while the renderer is still starting, then saves it with its picture', async () => {
    const map = new Map<string, string>();
    let starting = true;
    let captures = 0;
    const svc = createProjectSaveService({
      schema: { version: 1, slots: 3 },
      backend: memoryProjectSaveBackend(map),
      namespace: 'thirdlight:game-a',
      queue: () => undefined,
      captureThumbnail: (width, height) => {
        captures += 1;
        return starting ? null : { dataUrl: 'data:image/jpeg;base64,AAAA', width, height };
      },
      pictureWaits: () => starting,
      now: () => '2026-09-28T00:00:00.000Z',
    });
    await svc.start();
    const doc = JSON.stringify({ format: 'thirdlight.save', version: 1, doc: {} });
    svc.handle([
      { op: 'save', slot: 1, meta: { title: 'A', chapter: '', location: '', playSeconds: 1, version: 1, thumbnail: true }, text: doc },
      { op: 'delete', slot: 2 },
    ]);
    svc.handle([]);
    await svc.idle();
    expect(captures).toBe(0);
    expect(svc.slots()).toEqual([]);

    starting = false;
    svc.handle([]);
    await svc.idle();
    expect(captures).toBe(1);
    expect(svc.slots().find((s) => s.slot === 1)?.thumbnail).toMatchObject({ type: 'image/jpeg', width: 256, height: 144 });
  });

  it('carries out requests without a picture at once', async () => {
    const svc = createProjectSaveService({ schema: { version: 1, slots: 3 }, backend: memoryProjectSaveBackend(new Map()), namespace: 'n', queue: () => undefined, pictureWaits: () => true, now: () => '2026-09-28T00:00:00.000Z' });
    await svc.start();
    svc.handle([{ op: 'save', slot: 1, meta: { title: 'A', chapter: '', location: '', playSeconds: 1, version: 1, thumbnail: false }, text: JSON.stringify({ format: 'thirdlight.save', version: 1, doc: {} }) }]);
    await svc.idle();
    expect(svc.slots().map((s) => s.slot)).toEqual([1]);
  });
});

/** A memory store that refuses a write the way IndexedDB does (the whole transaction, with the browser's error). */
function refusingBackend(map: Map<string, string>, refuse: () => Error | null): ProjectSaveBackend {
  const inner = memoryProjectSaveBackend(map);
  return { kind: 'indexeddb', read: inner.read, write: (puts, removes) => (refuse() !== null ? Promise.reject(refuse()!) : inner.write(puts, removes)) };
}

const quota = (): Error => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
const docOf = (n: number): string => JSON.stringify({ format: 'thirdlight.save', formatVersion: 2, version: 1, doc: { n }, world: { scenes: [], activeSpawn: null, listedScene: -1, character: null } });
const plainMeta = { title: 'A', chapter: '', location: '', playSeconds: 1, version: 1, thumbnail: false };

describe('project saves: refused writes', () => {
  it('a save refused for quota answers storage_full with the browser\'s text, and the slot still loads its earlier save', async () => {
    const map = new Map<string, string>();
    let full = false;
    const events: SaveEvent[] = [];
    const svc = createProjectSaveService({ schema: { version: 1, slots: 3 }, backend: refusingBackend(map, () => (full ? quota() : null)), namespace: 'n', queue: (e) => void events.push(e), now: () => '2026-10-03T00:00:00.000Z' });
    // The page hears the same outcomes, after the write (the slot is stored by then).
    const heard: unknown[] = [];
    svc.onSaved((a) => heard.push({ ...a, stored: map.has('n:slot:1:meta') }));
    await svc.start();
    svc.handle([{ op: 'save', slot: 1, meta: plainMeta, text: docOf(1) }]);
    await svc.idle();
    full = true;
    svc.handle([{ op: 'save', slot: 1, meta: { ...plainMeta, title: 'B' }, text: docOf(2) }]);
    await svc.idle();
    expect(events.filter((e) => e.kind === 'saved')).toEqual([
      { kind: 'saved', slot: 1, ok: true },
      { kind: 'saved', slot: 1, ok: false, reason: 'The quota has been exceeded.', code: 'storage_full' },
    ]);
    expect(heard).toEqual([
      { slot: 1, ok: true, stored: true },
      { slot: 1, ok: false, reason: 'The quota has been exceeded.', stored: true },
    ]);
    expect(svc.slots()[0]?.title).toBe('A');
    await svc.loadSlot(1);
    const loaded = events.filter((e) => e.kind === 'loaded').at(-1) as Extract<SaveEvent, { kind: 'loaded' }>;
    expect(loaded.ok).toBe(true);
    expect(loaded.save?.doc).toEqual({ n: 1 });
  });

  it('without storage every save answers storage_unavailable; a delete too', async () => {
    const events: SaveEvent[] = [];
    const svc = createProjectSaveService({ schema: { version: 1, slots: 3 }, backend: unavailableProjectSaveBackend('no IndexedDB'), namespace: 'n', queue: (e) => void events.push(e) });
    await svc.start();
    svc.handle([{ op: 'save', slot: 2, meta: plainMeta, text: docOf(1) }, { op: 'delete', slot: 2 }]);
    await svc.idle();
    expect(events.filter((e) => e.kind === 'saved' || e.kind === 'deleted')).toEqual([
      { kind: 'saved', slot: 2, ok: false, reason: 'no IndexedDB', code: 'storage_unavailable' },
      { kind: 'deleted', slot: 2, ok: false, reason: 'no IndexedDB', code: 'storage_unavailable' },
    ]);
    expect(svc.storage).toBe('unavailable');
  });

  it('a settings document localStorage refuses is reported (storage_full) and still applies for the session', async () => {
    const events: SaveEvent[] = [];
    const storage = { get: () => null, set: () => { throw Object.assign(new Error('Setting the value exceeded the quota.'), { name: 'QuotaExceededError' }); }, remove: () => undefined };
    const svc = createProjectSaveService({ schema: { version: 1, slots: 1, settings: [{ key: 'hints', type: 'bool', default: true }] }, backend: memoryProjectSaveBackend(), namespace: 'n', settingsStorage: storage, queue: (e) => void events.push(e) });
    await svc.start();
    expect(() => svc.handle([{ op: 'settings', values: { hints: false } }])).not.toThrow();
    expect(events.filter((e) => e.kind === 'settings')).toEqual([{ kind: 'settings', ok: false, reason: 'Setting the value exceeded the quota.', code: 'storage_full' }]);
    expect(svc.settings()).toEqual({ hints: false });
  });

  it('asks for persistent storage at the first save only, and reports it with usage and quota', async () => {
    const events: SaveEvent[] = [];
    let persistCalls = 0;
    let usage = 100;
    const device: DeviceStorage = { persisted: async () => persistCalls > 0, persist: async () => (persistCalls += 1) > 0, estimate: async () => ({ usage, quota: 5000 }) };
    const svc = createProjectSaveService({ schema: { version: 1, slots: 3 }, backend: memoryProjectSaveBackend(), namespace: 'n', device, queue: (e) => void events.push(e) });
    await svc.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(persistCalls).toBe(0);
    expect(svc.storageInfo()).toEqual({ persisted: false, usage: 100, quota: 5000 });
    usage = 900;
    svc.handle([{ op: 'save', slot: 1, meta: plainMeta, text: docOf(1) }]);
    svc.handle([{ op: 'save', slot: 2, meta: plainMeta, text: docOf(2) }]);
    await svc.idle();
    await new Promise((r) => setTimeout(r, 0));
    expect(persistCalls).toBe(1);
    expect(svc.persistAsked()).toBe(true);
    expect(svc.storageInfo()).toEqual({ persisted: true, usage: 900, quota: 5000 });
    expect(events.filter((e) => e.kind === 'storage').at(-1)).toEqual({ kind: 'storage', persisted: true, usage: 900, quota: 5000 });
  });
});

describe('project saves: engine-bound settings fields', () => {
  it("a field's default does not override the quality level or the project's render settings; only what the player set does, also on the next run", async () => {
    const kv = new Map<string, string>();
    const storage = { get: (k: string) => kv.get(k) ?? null, set: (k: string, v: string) => void kv.set(k, v), remove: (k: string) => void kv.delete(k) };
    const schema = {
      version: 1,
      slots: 1,
      settings: [
        { key: 'quality', type: 'enum' as const, default: 'high', values: ['low', 'medium', 'high'], engine: 'quality' as const },
        { key: 'scale', type: 'number' as const, default: 1, min: 0.5, max: 1, engine: 'renderScale' as const },
        { key: 'music', type: 'number' as const, default: 0.8, engine: 'music' as const },
      ],
    };
    const start = () => {
      const applied: [string, unknown][] = [];
      const svc = createProjectSaveService({ schema, backend: memoryProjectSaveBackend(), namespace: 'n', settingsStorage: storage, queue: () => undefined, applyEngine: (b, v) => void applied.push([b, v]) });
      return { svc, applied };
    };
    // First run, nothing stored: only the volume's default applies (it has nothing under it).
    const a = start();
    expect(a.applied).toEqual([['music', 0.8]]);
    // The game writes its whole document with the player's new scale: only that one is the player's.
    a.applied.length = 0;
    a.svc.handle([{ op: 'settings', values: { quality: 'high', scale: 0.75, music: 0.8 } }]);
    expect(a.applied).toEqual([['renderScale', 0.75], ['music', 0.8]]);
    expect(JSON.parse(kv.get('n:project-settings')!)).toEqual({ scale: 0.75 });
    expect(a.svc.settings()).toEqual({ quality: 'high', scale: 0.75, music: 0.8 });
    // The next run applies the scale the player set; the quality field's default still leaves the level alone.
    const b = start();
    expect(b.applied).toEqual([['renderScale', 0.75], ['music', 0.8]]);
    expect(b.svc.settings()).toEqual({ quality: 'high', scale: 0.75, music: 0.8 });
  });
});
