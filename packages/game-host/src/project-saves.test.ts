/**
 * The project save service forgets every slot of a game on
 * `clear()` (the editor's "Clear Play save" — the level flow's own saves it
 * cleared before were deleted with the flow). Real service over the memory
 * backend: two slots saved, then cleared; the stored keys are gone, the slot
 * list is empty and the simulation is told so.
 */
import { describe, expect, it } from 'vitest';

import type { SaveEvent } from '@thirdlight/runtime';

import { createProjectSaveService, memoryProjectSaveBackend } from './project-saves';

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
