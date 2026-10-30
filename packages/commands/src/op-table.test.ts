/**
 * Every op the wire accepts has its forward step, and every history entry
 * kind it records has an undo and a redo, all from the one op table.
 */
import { describe, expect, it } from 'vitest';

import { MUTATION_OPS } from './mutation-ops';
import { OP_ENTRIES, REDO, UNDO } from './op-table';
import type { ForwardOp } from './types';

const forwardOps = MUTATION_OPS.filter((op): op is ForwardOp => op !== 'undo' && op !== 'redo');

describe('op table', () => {
  it.each(forwardOps)('%s has a forward step, and an undo and a redo for each entry kind it records', (op) => {
    const entry = OP_ENTRIES[op];
    expect(entry, `${op}: no op table entry`).toBeDefined();
    expect(typeof entry.apply, `${op}: no forward step`).toBe('function');
    expect(entry.records.length, `${op}: records no history entry kind`).toBeGreaterThan(0);
    for (const [change, inverse] of entry.records) {
      expect(typeof REDO[change], `${op}: no redo for a '${change}' change`).toBe('function');
      expect(typeof UNDO[inverse], `${op}: no undo for a '${inverse}' inverse`).toBe('function');
    }
  });

  it('holds only the ops the wire accepts, and no undo or redo that no op records', () => {
    expect(Object.keys(OP_ENTRIES).sort()).toEqual([...forwardOps].sort());
    const changes = new Set(forwardOps.flatMap((op) => OP_ENTRIES[op].records.map(([c]) => c)));
    const inverses = new Set(forwardOps.flatMap((op) => OP_ENTRIES[op].records.map(([, i]) => i)));
    expect(Object.keys(REDO).filter((k) => !changes.has(k as never))).toEqual([]);
    expect(Object.keys(UNDO).filter((k) => !inverses.has(k as never))).toEqual([]);
  });
});
