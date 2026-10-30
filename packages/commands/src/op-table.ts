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
