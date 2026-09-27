import { describe, expect, it } from 'vitest';

import type { SaveSchema } from '@thirdlight/project-model';

import { RuntimeSaves, validateSaveEvents, type SaveRequest, type SaveSectionsPort } from './project-saves';
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

function fakePort(): SaveSectionsPort & { storage: Record<string, unknown> } {
  const port = {
    storage: { k: 1 } as Record<string, unknown>,
    capture: () => ({ ...port.storage }),
    check: (_s: string, v: unknown) => (typeof v === 'object' && v !== null ? null : 'not an object'),
    apply: (_s: string, v: unknown) => {
      port.storage = { ...((v ?? {}) as Record<string, unknown>) };
      return null;
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

describe('phase 23.19: runtime project saves', () => {
  it('a save is assembled at the end of its step with the opted-in sections and play time', () => {
    const port = fakePort();
    const r = new RuntimeSaves(SCHEMA, 60, port, undefined, () => undefined);
    for (let i = 0; i < 59; i += 1) step(r, []);
    const reqs = step(r, [], () => {
      expect(r.api.write({ level: 'b', hp: 3 })).toBe(true);
      expect(r.api.save(2, { title: 'T', chapter: 'C', location: 'L', thumbnail: true })).toBe(true);
      expect(r.api.save(4)).toBe(false); // the game has 3 slots
      port.storage = { k: 2 }; // later in the same step: the save sees it
    });
    expect(reqs).toHaveLength(1);
    const req = reqs[0] as Extract<SaveRequest, { op: 'save' }>;
    expect(req.meta).toEqual({ title: 'T', chapter: 'C', location: 'L', thumbnail: true, playSeconds: 1, version: 2 });
    expect(JSON.parse(req.text)).toEqual({ format: 'thirdlight.save', formatVersion: 1, version: 2, playSeconds: 1, doc: { level: 'b', hp: 3 }, sections: { storage: { k: 2 } } });
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
    const file = { format: 'thirdlight.save', version: 1, playSeconds: 42, doc: { coins: 5 }, sections: { storage: { restored: true } } } as const;
    step(r, [{ kind: 'loaded', slot: 1, ok: true, save: file }], () => {
      r.api.migration('v1to2', (doc, from) => ({ ...(doc as object), gold: (doc as { coins: number }).coins * 10, migratedFrom: from }));
    });
    expect(r.api.read()).toEqual({ coins: 5, gold: 50, migratedFrom: 1 });
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
    const slot = { slot: 2, title: 'T', chapter: '', location: '', playSeconds: 1, savedAt: '2026-09-27T10:00:00.000Z', version: 2, bytes: 10, thumbnail: true };
    const reqs = step(r, [{ kind: 'slots', slots: [slot] }, { kind: 'saved', slot: 2, ok: true }], () => {
      expect(r.api.ready()).toBe(true);
      expect(r.api.slots()).toEqual([slot]);
      expect(r.api.results()).toEqual([{ op: 'save', slot: 2, ok: true }]);
      expect(r.api.setSetting('volume', 2)).toBe(false);
      expect(r.api.setSetting('volume', 0.9)).toBe(true);
      expect(r.api.setSetting('nope', 1)).toBe(false);
    });
    expect(reqs).toEqual([{ op: 'settings', values: { volume: 0.9, hints: true } }]);
  });

  it('frame entries are validated (a recording carries them)', () => {
    expect(validateSaveEvents([{ kind: 'loaded', slot: 1, ok: true }]).ok).toBe(false);
    expect(validateSaveEvents([{ kind: 'saved', slot: 100, ok: true }]).ok).toBe(false);
    expect(validateSaveEvents([{ kind: 'loaded', slot: 1, ok: true, save: { format: 'thirdlight.save', version: 1, doc: 'x'.repeat(1_048_577) } }]).ok).toBe(false);
    const f = validateActionFrame({ stepIndex: 3, moveX: 0, jump: 'none', saves: [{ kind: 'deleted', slot: 1, ok: false, reason: 'r' }] }, 3);
    expect(f.ok && f.frame.saves).toEqual([{ kind: 'deleted', slot: 1, ok: false, reason: 'r' }]);
    // A frame without saves keeps its old shape.
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
