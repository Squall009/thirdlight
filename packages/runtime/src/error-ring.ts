/**
 * The runtime's play log: the last errors and script log lines, for
 * diagnostics (a display ring, not a record; `errorCount` counts them all).
 *
 * Copies of one row (the same error from every copy of an object, the same
 * line logged every step) are folded into one row with a count, so the ring
 * keeps distinct problems rather than copies of one. Errors are what a run
 * needs read first: when the ring is full, a log line goes before an error
 * unless log lines hold half the ring or less, so a script logging every
 * step cannot push the errors out and a run with many errors still shows
 * its newest log lines.
 */
import { isErrorRow, mergeRepeatedRow, repeatedRowKey } from '@thirdlight/project-model';
import type { DiagnosticErrorEntry } from './types';

/** The ring's size. */
export const MAX_ERROR_ENTRIES = 32;

export class ErrorRing {
  private readonly rows: DiagnosticErrorEntry[] = [];
  private readonly keys: string[] = [];

  push(entry: DiagnosticErrorEntry): void {
    const key = repeatedRowKey(entry) ?? '';
    const at = this.keys.indexOf(key);
    let row = entry;
    if (at >= 0) {
      // A folded row moves to the newest end (the ring stays in the order rows last happened).
      row = mergeRepeatedRow(this.rows[at]!, entry);
      this.rows.splice(at, 1);
      this.keys.splice(at, 1);
    }
    this.rows.push(row);
    this.keys.push(key);
    if (this.rows.length > MAX_ERROR_ENTRIES) this.evict();
  }

  /** The rows, oldest first (a copy: a folded row is a new object, so a returned row never changes). */
  entries(): DiagnosticErrorEntry[] {
    return [...this.rows];
  }

  private evict(): void {
    const logs = this.rows.reduce((n, r) => n + (isErrorRow(r) ? 0 : 1), 0);
    const dropLog = logs > MAX_ERROR_ENTRIES / 2;
    const i = this.rows.findIndex((r) => isErrorRow(r) !== dropLog);
    const at = i < 0 ? 0 : i;
    this.rows.splice(at, 1);
    this.keys.splice(at, 1);
  }
}
