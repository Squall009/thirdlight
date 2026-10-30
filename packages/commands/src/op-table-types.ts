/**
 * The shape of the op table: every forward op's step, and the undo and redo
 * of every history entry kind it records, kept together per op family so an
 * op is added in one place (`op-table.ts` merges the families and the type
 * checker refuses a table with a gap).
 */

import type { OpInput } from './content-ops';
import type { CommandError } from './errors';
import type { OpOutcome } from './ops';
import type {
  ChangeData,
  CommandState,
  ContentDocument,
  ForwardChange,
  ForwardOp,
  HistoryEntry,
  InverseSpec,
  SceneDocument,
} from './types';
import type { ValidatedOpArgs } from './validate-request';

/** The validated args of one op (some ops share one args shape). */
export type ArgsOf<K extends ForwardOp> = ValidatedOpArgs extends infer V
  ? V extends { op: infer O; args: infer A }
    ? K extends O
      ? A
      : never
    : never
  : never;

/** The change types a forward command can record. */
export type ChangeType = ForwardChange['type'];
/** The inverse kinds a forward command can record. */
export type InverseKind = InverseSpec['kind'];

/** The recorded change of one type (some changes carry one of several types). */
export type ChangeOf<K extends ChangeType> = ForwardChange extends infer C
  ? C extends { type: infer T }
    ? K extends T
      ? C
      : never
    : never
  : never;
export type InverseOf<K extends InverseKind> = Extract<InverseSpec, { kind: K }>;

/** Result of one inverse/forward application. */
export interface AppliedState {
  scene: SceneDocument;
  content?: ContentDocument;
  change: ChangeData;
  /** A cross-scene move's second scene as it now is. */
  otherScene?: { sceneId: string; scene: SceneDocument };
}

export type ApplyResult =
  | { ok: true; applied: AppliedState }
  | { ok: false; error: CommandError };

/** One forward op: its pure step, and the change type and inverse kind pairs its history entry can carry. */
export interface OpEntry<K extends ForwardOp> {
  apply: (input: OpInput, args: ArgsOf<K>, state: CommandState<SceneDocument>) => OpOutcome;
  records: readonly (readonly [ChangeType, InverseKind])[];
}

export type OpEntries = { [K in ForwardOp]: OpEntry<K> };
/** Undo: an entry's recorded inverse applied to the state after it (LIFO). */
export type UndoTable = { [K in InverseKind]: (state: CommandState<SceneDocument>, entry: HistoryEntry, inv: InverseOf<K>) => ApplyResult };
/** Redo: an entry's recorded change re-applied with its recorded values. */
export type RedoTable = { [K in ChangeType]: (state: CommandState<SceneDocument>, entry: HistoryEntry, f: ChangeOf<K>) => ApplyResult };

/** One op family's part of the table: its ops, and the undo and redo of the entry kinds they record. */
export interface OpFamily {
  ops: Partial<OpEntries>;
  undo: Partial<UndoTable>;
  redo: Partial<RedoTable>;
}
