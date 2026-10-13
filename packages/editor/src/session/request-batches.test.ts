import { describe, expect, it } from 'vitest';
import { CREATE_ENTITIES_MAX, DELETE_ENTITIES_MAX, MAX_REQUEST_BYTES, SET_COMPONENT_ENTITIES_MAX } from '@thirdlight/project-model/limits';

import { DECAL_SCATTER_DEFAULTS, scatterPlacement, selectionEdit } from './decal-editor';
import { DECAL_TOOL_DEFAULTS, decalPlaceCommand } from './decal-place';
import { deleteEntitiesArgs } from './delete-entities';
import { makeEnvelope } from './envelope';
import { createEntitiesArgs, jsonBytes, requestBatches } from './request-batches';

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
    // The count alone would allow two requests; the bytes need more.
    expect(args.length).toBeGreaterThan(Math.ceil(items.length / CREATE_ENTITIES_MAX));
    expect(args.flatMap((a) => a.entities)).toHaveLength(2000);
    for (const a of args) {
      expect(a.sceneId).toBe(SCENE);
      expect(a.entities.length).toBeLessThanOrEqual(CREATE_ENTITIES_MAX);
      expect(a.entities.every((e) => e['sceneId'] === undefined)).toBe(true);
      expect(envelopeBytes('createEntities', a)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    }
    // Batches are full, not timid: each but the last fills nine tenths of the request or more.
    for (const a of args.slice(0, -1)) expect(envelopeBytes('createEntities', a)).toBeGreaterThan(MAX_REQUEST_BYTES * 0.9);
  });

  it('splits a selection edit with a value per decal by the request bytes', () => {
    const decal = { material: 'mat-puddle-with-a-long-name', size: [1, 1, 0.5] as [number, number, number] };
    const entries = Array.from({ length: 3000 }, (_, i) => ({ id: `decal-${'x'.repeat(50)}-${i}`, decal: { ...decal, size: [1, 1 + i / 1000, 0.5] as [number, number, number] } }));
    const args = selectionEdit(entries, { field: 'size', axis: 0, value: 2 });
    expect(args.reduce((n, a) => n + 1 + (a.entityIds?.length ?? 0), 0)).toBe(3000);
    for (const a of args) {
      expect(a.entityIds!.length).toBeLessThanOrEqual(SET_COMPONENT_ENTITIES_MAX);
      expect(a.values).toHaveLength(a.entityIds!.length);
      expect(envelopeBytes('setComponent', a)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    }
  });

  it('splits a delete of long ids by the request bytes before the id count', () => {
    const ids = Array.from({ length: DELETE_ENTITIES_MAX + 1 }, (_, i) => `${'e'.repeat(58)}-${String(i).padStart(5, '0')}`);
    const args = deleteEntitiesArgs(ids);
    expect(args.length).toBe(2);
    expect(args.flatMap((a) => [a.entityId, ...(a.entityIds ?? [])])).toEqual(ids);
    for (const a of args) expect(envelopeBytes('deleteEntity', a)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  });

  it('keeps an item too large for any request as a batch of its own', () => {
    const big = 'x'.repeat(MAX_REQUEST_BYTES);
    expect(requestBatches(['a', big, 'b'], 10, 0)).toEqual([['a'], [big], ['b']]);
    expect(jsonBytes('é😀')).toBe(new TextEncoder().encode(JSON.stringify('é😀')).length);
  });
});
