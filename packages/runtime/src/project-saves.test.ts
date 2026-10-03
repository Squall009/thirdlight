import { describe, expect, it } from 'vitest';

import type { SaveSchema } from '@thirdlight/project-model';

import { RuntimeSaves, validateSaveEvents, worldSaveProblem, type SaveRequest, type SaveSectionsPort, type WorldSave } from './project-saves';
import { validateActionFrame } from './actions';

const SCHEMA: SaveSchema = {
  version: 2,
  slots: 3,
  migrations: [{ from: 1, name: 'v1to2' }],
  sections: ['storage'],
  settings: [
    { key: 'volume', type: 'number', default: 0.5, engine: 'music' },
    { key: 'hints', type: 'bool', default: true },
  ],
};

function fakePort(): SaveSectionsPort & { storage: Record<string, unknown>; world: WorldSave } {
  const port = {
    storage: { k: 1 } as Record<string, unknown>,
    capture: () => ({ ...port.storage }),
    check: (_s: string, v: unknown) => (typeof v === 'object' && v !== null ? null : 'not an object'),
    apply: (_s: string, v: unknown) => {
      port.storage = { ...((v ?? {}) as Record<string, unknown>) };
      return null;
    },
    // Where the play stands (a fixed world here; the runtime's is tested with the host).
    world: { scenes: ['scene-main'], activeSpawn: null, listedScene: -1, character: null } as WorldSave,
    captureWorld: () => port.world,
    checkWorld: (w: WorldSave) => (w.scenes.includes('scene-gone') ? 'unknown scene' : null),
    applyWorld: (w: WorldSave) => {
      port.world = w;
    },
  };
  return port;
}

/** One step: begin, the frame's entries, the scripts, end. */
function step(r: RuntimeSaves, events: Parameters<RuntimeSaves['deliver']>[0], script: () => void = () => undefined): SaveRequest[] {
  r.beginStep();
  r.deliver(events);
  script();
  r.endStep();
  return r.takeRequests();
}

describe('runtime project saves', () => {
  it('a save is assembled at the end of its step with the opted-in sections and play time', () => {
    const port = fakePort();
    const r = new RuntimeSaves(SCHEMA, 60, port, undefined, () => undefined);
    for (let i = 0; i < 59; i += 1) step(r, []);
    const reqs = step(r, [], () => {
      expect(r.api.write({ level: 'b', hp: 3 })).toBe(true);
      expect(r.api.save(2, { title: 'T', chapter: 'C', location: 'L', thumbnail: true })).toBe(true);
      expect(r.api.save(4)).toBe(false); // the game has 3 slots
      // The slot's own fields: names → texts, as many as fit the record's byte budget.
      expect(r.api.save(1, { meta: { leader: 'odessa', chapter_no: '3' } })).toBe(true);
      expect(r.api.save(1, { meta: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'v'])) })).toBe(true);
      expect(r.api.save(1, { meta: { long: 'x'.repeat(1000) } })).toBe(true);
      expect(r.api.save(1, { meta: { 'not a name': 'v' } })).toBe(false);
      expect(r.api.save(1, { meta: { n: 3 as never } })).toBe(false);
      // Over the budget in UTF-8 bytes (1,400 three-byte characters are 4,200 bytes in 1,400 UTF-16 units).
      expect(r.api.save(1, { meta: { long: '\u20ac'.repeat(1400) } })).toBe(false);
      port.storage = { k: 2 }; // later in the same step: the save sees it
    });
    expect(reqs).toHaveLength(4);
    expect((reqs[1] as Extract<SaveRequest, { op: 'save' }>).meta.meta).toEqual({ leader: 'odessa', chapter_no: '3' });
    expect(Object.keys((reqs[2] as Extract<SaveRequest, { op: 'save' }>).meta.meta ?? {})).toHaveLength(20);
    const req = reqs[0] as Extract<SaveRequest, { op: 'save' }>;
    expect(req.meta).toEqual({ title: 'T', chapter: 'C', location: 'L', thumbnail: true, playSeconds: 1, version: 2 });
    // Format version 2 — every save carries where the play stands.
    expect(JSON.parse(req.text)).toEqual({ format: 'thirdlight.save', formatVersion: 2, version: 2, playSeconds: 1, doc: { level: 'b', hp: 3 }, sections: { storage: { k: 2 } }, world: { scenes: ['scene-main'], activeSpawn: null, listedScene: -1, character: null } });
  });

  it('the world block keeps the character\'s facing (degrees); older worlds without it still load', () => {
    expect(worldSaveProblem({ scenes: [], activeSpawn: null, listedScene: -1, character: { position: [0, 0, 0], velocity: [0, 0, 0], facing: -90 } })).toBeNull();
    expect(worldSaveProblem({ scenes: [], activeSpawn: null, listedScene: -1, character: { position: [0, 0, 0], velocity: [0, 0, 0] } })).toBeNull();
    expect(worldSaveProblem({ scenes: [], activeSpawn: null, listedScene: -1, character: { position: [0, 0, 0], velocity: [0, 0, 0], facing: 'east' } })).toContain('facing');
  });

  it('a format 2 save restores its world; a format 1 save (no world) leaves it; a bad world refuses the load', () => {
    const port = fakePort();
    const r = new RuntimeSaves(SCHEMA, 60, port, undefined, () => undefined);
    const world = { scenes: ['scene-main', 'scene-far'], activeSpawn: 'spawn-0002', listedScene: 1, character: { position: [3, 1, 0], velocity: [2, 0, 0] } } as const;
    step(r, [{ kind: 'loaded', slot: 1, ok: true, save: { format: 'thirdlight.save', formatVersion: 2, version: 2, doc: {}, world } }]);
    expect(port.world).toEqual(world);
    const before = port.world;
    step(r, [{ kind: 'loaded', slot: 1, ok: true, save: { format: 'thirdlight.save', version: 2, doc: {} } }]);
    expect(port.world).toBe(before);
    step(r, [{ kind: 'loaded', slot: 1, ok: true, save: { format: 'thirdlight.save', formatVersion: 2, version: 2, doc: {}, world: { ...world, scenes: ['scene-gone'] } } }]);
    r.beginStep();
    expect(r.api.results()).toEqual([{ op: 'load', slot: 1, ok: false, reason: 'world: unknown scene' }]);
    r.endStep();
    expect(port.world).toBe(before);
    // A format 2 save without a world (a game that keeps none saved it) loads and leaves the world as it is.
    step(r, [{ kind: 'loaded', slot: 1, ok: true, save: { format: 'thirdlight.save', formatVersion: 2, version: 2, doc: {} } }]);
    r.beginStep();
    expect(r.api.results()[0]).toMatchObject({ ok: true });
    r.endStep();
    expect(port.world).toBe(before);
  });

  it('world is a section: listed, it is saved and restored; with legacyWorld false a save keeps none and a load never applies one; neither keeps it with one Problems line', () => {
    const world = { scenes: ['scene-main', 'scene-far'], activeSpawn: null, listedScene: -1, character: null } as const;
    const run = (schema: SaveSchema): { saved: Record<string, unknown>; applied: boolean; problems: string[] } => {
      const port = fakePort();
      const problems: string[] = [];
      const r = new RuntimeSaves(schema, 60, port, undefined, () => undefined, (code) => problems.push(code));
      const [req] = step(r, [], () => r.api.save(1));
      const before = port.world;
      step(r, [{ kind: 'loaded', slot: 1, ok: true, save: { format: 'thirdlight.save', formatVersion: 2, version: 1, doc: {}, world } }]);
      return { saved: JSON.parse((req as Extract<SaveRequest, { op: 'save' }>).text) as Record<string, unknown>, applied: port.world !== before, problems };
    };
    const listed = run({ version: 1, slots: 2, sections: ['world', 'storage'] });
    expect(listed.saved['world']).toEqual({ scenes: ['scene-main'], activeSpawn: null, listedScene: -1, character: null });
    expect(listed.saved['sections']).toEqual({ storage: { k: 1 } });
    expect(listed).toMatchObject({ applied: true, problems: [] });
    const off = run({ version: 1, slots: 2, sections: ['storage'], legacyWorld: false });
    expect('world' in off.saved).toBe(false);
    expect(off).toMatchObject({ applied: false, problems: [] });
    const legacy = run({ version: 1, slots: 2, sections: ['storage'] });
    expect(legacy.saved['world']).toBeDefined();
    expect(legacy.applied).toBe(true);
    // Each use is reported; the runtime keeps one line per code, the host one per Play.
    expect(legacy.problems).toEqual(['deprecated_save_world', 'deprecated_save_world']);
  });

  it('caps: a document over 1 MiB is refused; 8 requests per step', () => {
    const r = new RuntimeSaves(SCHEMA, 60, fakePort(), undefined, () => undefined);
    step(r, [], () => {
      expect(r.api.write('x'.repeat(1_048_577))).toBe(false);
      expect(r.api.write({ f: () => 1 })).toBe(true); // functions drop out like JSON.stringify does
      for (let i = 0; i < 8; i += 1) expect(r.api.load(1)).toBe(true);
      expect(r.api.load(1)).toBe(false);
    });
  });

  it('a v1 save is migrated to v2 on load by the registered function; sections and play time restored', () => {
    const port = fakePort();
    const r = new RuntimeSaves(SCHEMA, 60, port, undefined, () => undefined);
    const file = { format: 'thirdlight.save', version: 1, playSeconds: 42, doc: { items: 5 }, sections: { storage: { restored: true } } } as const;
    step(r, [{ kind: 'loaded', slot: 1, ok: true, save: file }], () => {
      r.api.migration('v1to2', (doc, from) => ({ ...(doc as object), gold: (doc as { items: number }).items * 10, migratedFrom: from }));
    });
    expect(r.api.read()).toEqual({ items: 5, gold: 50, migratedFrom: 1 });
    expect(port.storage).toEqual({ restored: true });
    step(r, []);
    expect(r.api.playSeconds()).toBeCloseTo(42 + 1 / 60, 9);
    // The outcome is visible in the step after the restore.
    r.beginStep();
    expect(r.api.results()).toEqual([]);
  });

  it('a load without the registered migration, or of a newer version, changes nothing', () => {
    const port = fakePort();
    const r = new RuntimeSaves(SCHEMA, 60, port, undefined, () => undefined);
    step(r, [], () => r.api.write({ keep: 1 }));
    step(r, [{ kind: 'loaded', slot: 1, ok: true, save: { format: 'thirdlight.save', version: 1, doc: {} } }]);
    r.beginStep();
    expect(r.api.results()).toEqual([{ op: 'load', slot: 1, ok: false, reason: 'no script registered the migration "v1to2" (ctx.saves.migration)' }]);
    r.endStep();
    step(r, [{ kind: 'loaded', slot: 2, ok: true, save: { format: 'thirdlight.save', version: 3, doc: {} } }]);
    expect(r.api.read()).toEqual({ keep: 1 });
    expect(port.storage).toEqual({ k: 1 });
  });

  it('the slot list and outcomes arrive through the frame; the settings document is checked field by field', () => {
    const r = new RuntimeSaves(SCHEMA, 60, fakePort(), { volume: 0.2, hints: 'no' }, () => undefined);
    expect(r.api.settings()).toEqual({ volume: 0.2, hints: true });
    const slot = { slot: 2, title: 'T', chapter: '', location: '', playSeconds: 1, savedAt: '2026-09-27T10:00:00.000Z', version: 2, bytes: 10, thumbnail: true, meta: { leader: 'odessa' } };
    // An entry recorded before slots had meta reads as {}.
    const { meta: _meta, ...older } = { ...slot, slot: 3 };
    const reqs = step(r, [{ kind: 'slots', slots: [slot, older as never] }, { kind: 'saved', slot: 2, ok: true }], () => {
      expect(r.api.ready()).toBe(true);
      expect(r.api.slots()).toEqual([slot, { ...older, meta: {} }]);
      expect(r.api.results()).toEqual([{ op: 'save', slot: 2, ok: true }]);
      expect(r.api.setSetting('volume', 2)).toBe(false);
      expect(r.api.setSetting('volume', 0.9)).toBe(true);
      expect(r.api.setSetting('nope', 1)).toBe(false);
    });
    expect(reqs).toEqual([{ op: 'settings', values: { volume: 0.9, hints: true } }]);
  });

  it('a refused write reaches scripts with its storage code next to the browser\'s text; the storage facts arrive as input', () => {
    const r = new RuntimeSaves(SCHEMA, 60, fakePort(), undefined, () => undefined);
    expect(r.api.storage()).toEqual({ persisted: null, usage: null, quota: null });
    const before = r.digestText();
    step(
      r,
      [
        { kind: 'saved', slot: 2, ok: false, reason: 'The quota has been exceeded.', code: 'storage_full' },
        { kind: 'settings', ok: false, reason: 'Setting the value exceeded the quota.', code: 'storage_full' },
        { kind: 'storage', persisted: true, usage: 2048, quota: 1_000_000 },
      ],
      () => {
        expect(r.api.results()).toEqual([
          { op: 'save', slot: 2, ok: false, reason: 'The quota has been exceeded.', code: 'storage_full' },
          { op: 'settings', slot: 0, ok: false, reason: 'Setting the value exceeded the quota.', code: 'storage_full' },
        ]);
        expect(r.api.storage()).toEqual({ persisted: true, usage: 2048, quota: 1_000_000 });
      },
    );
    // Scripts may branch on the facts: they are in the digest once known.
    expect(r.digestText()).not.toBe(before);
    expect(r.digestText()).toContain('"usage":2048');
    // A load storage could not read carries the code too.
    step(r, [{ kind: 'loaded', slot: 1, ok: false, reason: 'no storage', code: 'storage_unavailable' }]);
    step(r, [], () => expect(r.api.results()).toEqual([{ op: 'load', slot: 1, ok: false, reason: 'no storage', code: 'storage_unavailable' }]));
  });

  it('frame entries are validated (a recording carries them)', () => {
    expect(validateSaveEvents([{ kind: 'saved', slot: 1, ok: false, code: 'disk_on_fire' }]).ok).toBe(false);
    expect(validateSaveEvents([{ kind: 'settings', ok: false, reason: 'r' }]).ok).toBe(false);
    expect(validateSaveEvents([{ kind: 'storage', persisted: 'yes', usage: 1, quota: 2 }]).ok).toBe(false);
    expect(validateSaveEvents([{ kind: 'storage', persisted: null, usage: -1, quota: 2 }]).ok).toBe(false);
    expect(validateSaveEvents([{ kind: 'storage', persisted: false, usage: null, quota: null }]).ok).toBe(true);
    expect(validateSaveEvents([{ kind: 'loaded', slot: 1, ok: true }]).ok).toBe(false);
    expect(validateSaveEvents([{ kind: 'saved', slot: 100, ok: true }]).ok).toBe(false);
    expect(validateSaveEvents([{ kind: 'loaded', slot: 1, ok: true, save: { format: 'thirdlight.save', version: 1, doc: 'x'.repeat(1_048_577) } }]).ok).toBe(false);
    const f = validateActionFrame({ stepIndex: 3, moveX: 0, jump: 'none', saves: [{ kind: 'deleted', slot: 1, ok: false, reason: 'r' }] }, 3);
    expect(f.ok && f.frame.saves).toEqual([{ kind: 'deleted', slot: 1, ok: false, reason: 'r' }]);
    // A frame without saves carries no `saves` field.
    const g = validateActionFrame({ stepIndex: 3, moveX: 0, jump: 'none' }, 3);
    expect(g.ok && 'saves' in g.frame).toBe(false);
  });

  it('without a save schema every call answers false / empty', () => {
    const r = new RuntimeSaves(undefined, 60, fakePort(), undefined, () => undefined);
    expect(r.api.version).toBe(0);
    expect(r.api.write({})).toBe(false);
    expect(r.api.save(1)).toBe(false);
    expect(r.digestText()).toBeNull();
  });
});
