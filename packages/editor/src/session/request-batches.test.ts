import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES } from '@thirdlight/project-model/limits';

import { DECAL_SCATTER_DEFAULTS, scatterPlacement, selectionEdit } from './decal-editor';
import { DECAL_TOOL_DEFAULTS, decalPlaceCommand } from './decal-place';
import { makeEnvelope } from './envelope';
import { createEntitiesArgs, jsonBytes } from './request-batches';

/** The bytes the backend measures: the whole envelope the client posts, at its largest ids and revision. */
function envelopeBytes(op: string, args: unknown): number {
  const id64 = 'p'.repeat(64);
  const env = makeEnvelope(op, id64, `req-${'f'.repeat(32)}`, Number.MAX_SAFE_INTEGER, args, { kind: 'browser', clientId: id64 });
  return new TextEncoder().encode(JSON.stringify(env)).length;
}

const SCENE = 's'.repeat(64);

describe('request batches', () => {
  it('splits a 2000-decal scatter stroke into createEntities requests that each fit the request bytes', () => {
    const tool = { ...DECAL_TOOL_DEFAULTS, size: [1.25, 0.75, 0.5] as [number, number, number] };
    const items = Array.from({ length: 2000 }, (_, i) => {
      const p = scatterPlacement(tool, DECAL_SCATTER_DEFAULTS, 'mat-puddle-with-a-long-name', [i * 0.37, 0.1 * (i % 7), -i * 0.11], [0, 1, 0], i);
      return decalPlaceCommand(SCENE, 'Decal', p).args;
    });
    const args = createEntitiesArgs(items);
    expect(args.length).toBeGreaterThan(1);
    expect(args.flatMap((a) => a.entities)).toHaveLength(2000);
    for (const a of args) {
      expect(a.sceneId).toBe(SCENE);
      expect(a.entities.every((e) => e['sceneId'] === undefined)).toBe(true);
      expect(envelopeBytes('createEntities', a)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    }
    // Batches are full, not timid: each but the last fills nine tenths of the request or more.
    for (const a of args.slice(0, -1)) expect(envelopeBytes('createEntities', a)).toBeGreaterThan(MAX_REQUEST_BYTES * 0.9);
  });

  it('edits a whole selection in one command: one id list and a value per decal only where they differ', () => {
    const decal = { material: 'mat-puddle', size: [1, 1, 0.5] as [number, number, number] };
    const same = Array.from({ length: 1500 }, (_, i) => ({ id: `decal-${i}`, decal }));
    const one = selectionEdit(same, { field: 'size', axis: 0, value: 2 });
    expect(one).toHaveLength(1);
    expect(one[0]!.entityIds).toHaveLength(1499);
    expect(one[0]!.values).toBeUndefined();
    expect(envelopeBytes('setComponent', one[0])).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    const differing = same.slice(0, 300).map((e, i) => ({ id: e.id, decal: { ...decal, size: [1, 1 + i / 1000, 0.5] as [number, number, number] } }));
    const each = selectionEdit(differing, { field: 'size', axis: 0, value: 2 });
    expect(each).toHaveLength(1);
    expect(each[0]!.values).toHaveLength(299);
    expect(selectionEdit([], { field: 'size', axis: 0, value: 2 })).toEqual([]);
  });

  it('keeps an item too large for any request as a batch of its own', () => {
    const big = { kind: 'group', name: 'x'.repeat(MAX_REQUEST_BYTES) };
    expect(createEntitiesArgs([{ kind: 'group', name: 'a' }, big, { kind: 'group', name: 'b' }]).map((a) => a.entities.map((e) => String(e['name']).slice(0, 1)))).toEqual([['a'], ['x'], ['b']]);
    expect(jsonBytes('é😀')).toBe(new TextEncoder().encode(JSON.stringify('é😀')).length);
  });
});
