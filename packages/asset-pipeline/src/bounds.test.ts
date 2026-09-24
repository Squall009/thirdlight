/**
 * Phase 15.3: an accepted model records its bounds in its metrics (the
 * runtime never loads a model: a pickup without a size collects over them).
 * The box comes from the POSITION accessors' `min`/`max` through the default
 * scene's node transforms; `<piece>_COL` collision nodes are left out; a file
 * without them records none.
 */
import { describe, expect, it } from 'vitest';

import { inspectGlb, type ImportJobPort } from './index';
import { fixtureBytes } from './test-fixtures';
import { mutateFixture } from './test-glb';

const job: ImportJobPort = {
  now: () => 0,
  isCancelled: () => false,
  proposalId: () => 'p-00000000000000000000000000000153',
  stageId: () => 'stage-bounds',
  expiresAt: () => '2026-09-24T00:00:00Z',
};
const inspect = (bytes: Uint8Array) => inspectGlb(bytes, { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, job });

type Json = Record<string, unknown>;
const withMinMax = (json: Json): void => {
  const acc = (json['accessors'] as Json[])[0]!;
  acc['min'] = [-1, 0, 0];
  acc['max'] = [1, 2, 0.5];
};

describe('model bounds in the import metrics (phase 15.3)', () => {
  it('a file without POSITION min/max records no bounds (the metrics are unchanged)', () => {
    const p = inspect(fixtureBytes('tiny-v1.glb'));
    expect(p.status).toBe('ok');
    expect(p.metrics).toBeDefined();
    expect(p.metrics?.bounds).toBeUndefined();
  });

  it('the accessor box goes through the node transforms (parent translation, child scale)', () => {
    const bytes = mutateFixture(fixtureBytes('tiny-v1.glb'), (json) => {
      withMinMax(json);
      const nodes = json['nodes'] as Json[];
      nodes[0]!['translation'] = [0, 1, 0];
      nodes[1]!['scale'] = [2, 1, 1];
    });
    const p = inspect(bytes);
    expect(p.status).toBe('ok');
    expect(p.metrics?.bounds).toEqual({ min: [-2, 1, 0], max: [2, 3, 0.5] });
  });

  it('a rotation turns the box (90° about Z swaps width and height)', () => {
    const s = Math.SQRT1_2;
    const bytes = mutateFixture(fixtureBytes('tiny-v1.glb'), (json) => {
      withMinMax(json);
      (json['nodes'] as Json[])[1]!['rotation'] = [0, 0, s, s];
    });
    expect(inspect(bytes).metrics?.bounds).toEqual({ min: [-2, -1, 0], max: [0, 1, 0.5] });
  });

  it('collision nodes are not part of the drawn model', () => {
    const bytes = mutateFixture(fixtureBytes('tiny-v1.glb'), (json) => {
      withMinMax(json);
      (json['nodes'] as Json[])[1]!['name'] = 'Tri_COL';
    });
    const p = inspect(bytes);
    expect(p.status).toBe('ok');
    expect(p.metrics?.bounds).toBeUndefined();
  });
});
