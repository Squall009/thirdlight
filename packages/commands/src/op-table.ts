/**
 * The op table: every forward op's step, and the undo and redo of every
 * history entry kind, merged from the op families. `apply.ts` and
 * `history.ts` dispatch through it only. The `satisfies` clauses make a gap a
 * type error, and `op-table.test.ts` checks each op's recorded kinds against
 * the undo and redo it needs.
 */

import { blockTerrainFamily } from './family-blocks-terrain';
import { contentFamily } from './family-content';
import { documentFamily } from './family-documents';
import { entityFamily } from './family-entities';
import { fileFamily } from './family-files';
import { prefabFamily } from './family-prefabs';
import { projectFamily } from './family-project';
import type { ForwardOp } from './mutation-ops';
import type { OpSuccess } from './ops';
import type { OpEntries, RedoTable, UndoTable } from './op-table-types';

export const OP_ENTRIES = {
  ...entityFamily.ops,
  ...contentFamily.ops,
  ...prefabFamily.ops,
  ...projectFamily.ops,
  ...documentFamily.ops,
  ...fileFamily.ops,
  ...blockTerrainFamily.ops,
} satisfies OpEntries as OpEntries;

export const UNDO = {
  ...entityFamily.undo,
  ...contentFamily.undo,
  ...prefabFamily.undo,
  ...projectFamily.undo,
  ...documentFamily.undo,
  ...fileFamily.undo,
  ...blockTerrainFamily.undo,
} satisfies UndoTable as UndoTable;

export const REDO = {
  ...entityFamily.redo,
  ...contentFamily.redo,
  ...prefabFamily.redo,
  ...projectFamily.redo,
  ...documentFamily.redo,
  ...fileFamily.redo,
  ...blockTerrainFamily.redo,
} satisfies RedoTable as RedoTable;

/**
 * Whether each applied op is held to its declared records. Off in a game or
 * the service; on where the host's environment asks for it (the test suites
 * and the e2e backend set THIRDLIGHT_CHECK_OP_RECORDS=1), so every command
 * a suite runs checks the table's declarations against what the op really
 * recorded, not only the declarations against each other. Read from the host
 * once; this package has no I/O and no environment of its own.
 */
const CHECK_RECORDS = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['THIRDLIGHT_CHECK_OP_RECORDS'] === '1';

/** Throws (checks on) when an op recorded a change and inverse pair its entry does not declare. */
export function assertRecorded(op: ForwardOp, applied: Pick<OpSuccess, 'change' | 'inverse'>): void {
  if (!CHECK_RECORDS) return;
  const records = OP_ENTRIES[op].records;
  if (!records.some(([change, inverse]) => change === applied.change.type && inverse === applied.inverse.kind)) {
    throw new Error(`op table: ${op} recorded [${applied.change.type}, ${applied.inverse.kind}], which its entry does not declare (${JSON.stringify(records)})`);
  }
}
