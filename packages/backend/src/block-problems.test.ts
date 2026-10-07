/**
 * The backend's block-layer checks: a layer's problems are logged once when
 * they appear, not again while they stay the same, again when they change;
 * an unchanged layer is not re-checked (its result kept by what it reads);
 * only block-relevant changes schedule a check.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BlockLayerComponent, BlockLayerData, BlockType } from '@thirdlight/project-model';

import { createBlockProblemChecker } from './block-problems';

const COMP: BlockLayerComponent = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 8, 8] } };
const TYPES: BlockType[] = [{ blockId: 'stone', name: 'Stone', variants: [{ color: '#808080' }], shape: 'full' }];

/** An 8 × 8 stone floor (row 0) and stone cells over it at [x, y, z] (a chunk's columns: lx, lz, then y, count, palette index runs). */
function data(over: readonly (readonly [number, number, number])[]): BlockLayerData {
  const columns: number[][] = [];
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) columns.push([x, z, 0, 1, 0, ...over.filter((c) => c[0] === x && c[2] === z).flatMap((c) => [c[1], 1, 0])]);
  return { entityId: 'ground', chunks: [{ cx: 0, cz: 0, palette: [{ block: 'stone' }], columns }] } as BlockLayerData;
}

describe('block problems on the backend', () => {
  it('logs a layer\'s problems when they appear or change, keeps unchanged layers\' results, and schedules only on block changes', () => {
    vi.useFakeTimers();
    try {
      let blocks: BlockLayerData | null = data([[3, 4, 3]]);
      const content = { blockTypes: TYPES, cellFields: [], settings: {} };
      let reads = 0;
      const service = {
        readCapturedV3: () => {
          reads += 1;
          return { ok: true, read: { content, scenes: [{ sceneId: 'main', entities: [{ id: 'ground', components: { blockLayer: COMP } }], blocks: blocks === null ? [] : [blocks] }] } };
        },
      };
      const lines: string[] = [];
      const checker = createBlockProblemChecker({ service: service as never, recordProblem: (_p, code, message) => lines.push(`${code}: ${message}`), logStartup: () => undefined, closed: () => false });
      const rows = checker.check('p')!;
      expect(rows).toHaveLength(1);
      expect(lines).toEqual([expect.stringMatching(/^block_floating: block layer "ground": 1 block in 1 group floats .* at \[3, 4, 3\] \(scene "main"\)$/)]);
      // The same layer again: no new line, the result kept.
      const kept = checker.check('p')!;
      expect(kept[0]!.checks).toBe(rows[0]!.checks);
      expect(lines).toHaveLength(1);
      // Another block floats: the line changes and is logged again.
      blocks = data([[3, 4, 3], [5, 5, 5]]);
      checker.check('p');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('2 blocks in 2 groups');
      // A transform change schedules nothing; a block edit checks once its edits settle.
      const before = reads;
      checker.changed('p', { type: 'setTransform' });
      checker.changed('p', { type: 'editBlocks' });
      checker.changed('p', { type: 'editBlocks' });
      expect(reads).toBe(before);
      vi.advanceTimersByTime(1000);
      expect(reads).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
