/**
 * This editor's own commands, in the order the user made them.
 *
 * The editor used to learn the result of its own command only from the WS
 * `mutation.applied` event. When the page's main thread is busy (a heavy
 * Scene-view frame, a large redraw), the browser runs input events before
 * network tasks, so a second edit made right after the first (Enter in one
 * field, then the next field) was sent while the first one's result had not
 * been applied yet: an old `expectedRevision` (refused with
 * `revision_conflict`) and args built from the old state (a whole-document
 * setter would also undo the first edit). The fix has three parts:
 *
 * - own commands are sent one at a time, in the order they were made
 *   (`enqueue`), and the HTTP ack's change is applied before the next one is
 *   sent (the WS event for it is then a duplicate, deduped by requestId);
 * - a command whose view was behind only by this editor's own acked commands
 *   is sent against the current revision (`rebase`); a revision made by
 *   anyone else (MCP, another tool) in between still conflicts;
 * - a whole-document edit is re-applied onto the current document
 *   (`mergeDocumentEdit`): only the parts the edit changed are written.
 *
 * Pure: no I/O.
 */

/**
 * Ops whose args carry a whole document (the game block, the flow, one
 * material, …) rather than a patch. Sent against a newer revision with args
 * built from an older view they would silently undo the edits in between,
 * so they are rebased only when their args are built at send time.
 */
export const WHOLE_DOCUMENT_OPS: ReadonlySet<string> = new Set([
  'setSettings',
  'setGameConfig',
  'setTags',
  'setAssetOptions',
  'setMaterial',
  'setEnvironment',
  'setLighting',
  'setAnimator',
  'setInput',
  'setFlow',
  'setStartScenes',
  'setGraph',
  'setEffect',
]);

/** How many of our own revisions are remembered for `rebase` (a burst of edits is far smaller). */
const OWN_REVISIONS_KEPT = 256;

export class OwnCommands {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly own = new Set<number>();
  private readonly order: number[] = [];

  /** Run `send` once every earlier own command has finished (resolved or failed). */
  enqueue<T>(send: () => Promise<T>): Promise<T> {
    const run = this.tail.then(send, send);
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** A revision this editor's own command produced (acked by the backend). */
  recordOwnRevision(revision: number): void {
    if (this.own.has(revision)) return;
    this.own.add(revision);
    this.order.push(revision);
    while (this.order.length > OWN_REVISIONS_KEPT) this.own.delete(this.order.shift()!);
  }

  /**
   * The revision to send: `current` when every revision after `expected` up
   * to `current` was made by this editor (the view was behind only by its own
   * edits), otherwise `expected` unchanged (the backend decides).
   */
  rebase(expected: number, current: number): number {
    if (current <= expected || current - expected > OWN_REVISIONS_KEPT) return expected;
    for (let r = expected + 1; r <= current; r++) if (!this.own.has(r)) return expected;
    return current;
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A whole-document edit made on `base`, re-applied onto `current` (the
 * document as it is now): the top-level parts where `next` differs from
 * `base` are taken from `next`, every other part keeps `current`'s value. With
 * `current` equal to `base` the result is `next`. `null` (no document) on any
 * side leaves the edit as it is.
 */
export function mergeDocumentEdit<T extends object>(base: T | null, next: T | null, current: T | null): T | null {
  if (next === null || base === null || current === null || same(base, current)) return next;
  const b = base as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const k of new Set([...Object.keys(b), ...Object.keys(n)])) {
    if (same(b[k], n[k])) continue;
    if (n[k] === undefined) delete out[k];
    else out[k] = n[k];
  }
  return out as T;
}
