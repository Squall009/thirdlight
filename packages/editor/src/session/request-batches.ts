/**
 * Splitting a stream of new objects (a scatter stroke's decals, stored as
 * the stroke is drawn) into `createEntities` commands the backend takes: a
 * command is bounded by the request's canonical bytes (project-model
 * `MAX_REQUEST_BYTES`, the whole envelope), not by a count. A selection is
 * never split here: it goes as one command (one undo step).
 */
import { MAX_REQUEST_BYTES } from '@thirdlight/project-model/limits';

/**
 * Bytes kept free for what the envelope adds around the arguments: the op,
 * project and request ids, the revision, the origin, and a scene id the
 * client fills in. Those come to about two hundred bytes; the rest is margin
 * so an estimate a few bytes short never decides a refusal.
 */
export const REQUEST_ENVELOPE_HEADROOM = 1024;

/** UTF-8 bytes of a value's JSON (what the request carries for it). */
export function jsonBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? 'null';
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // A surrogate pair is one 4-byte character.
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/**
 * Collects items into batches that each fit one command: `add` hands back
 * the batch so far when the next item would not fit beside it (the item then
 * starts the next batch), `take` the rest. An item too large for a command
 * on its own still goes as a batch of one, so the backend's refusal names it.
 */
export class RequestBatcher<T> {
  private items: T[] = [];
  private bytes = 0;
  private readonly budget: number;

  /**
   * @param fixedBytes the arguments' bytes without the items (`jsonBytes` of the arguments with empty lists)
   * @param cost one item's bytes in the request (its separator is added here)
   */
  constructor(
    fixedBytes: number,
    private readonly cost: (item: T) => number = jsonBytes,
  ) {
    this.budget = MAX_REQUEST_BYTES - REQUEST_ENVELOPE_HEADROOM - fixedBytes;
  }

  get size(): number {
    return this.items.length;
  }

  add(item: T): T[] | null {
    const c = this.cost(item) + 1;
    const full = this.items.length > 0 && this.bytes + c > this.budget ? this.take() : null;
    this.items.push(item);
    this.bytes += c;
    return full;
  }

  take(): T[] {
    const out = this.items;
    this.items = [];
    this.bytes = 0;
    return out;
  }
}

/** `items` added to `b` and the batches they fill, the last one partly (none for none). */
function batchesOf<T>(b: RequestBatcher<T>, items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (const item of items) {
    const full = b.add(item);
    if (full !== null) out.push(full);
  }
  if (b.size > 0) out.push(b.take());
  return out;
}

/** A `createEntity` argument item without its `sceneId`: in `createEntities` the scene goes on the batch (it routes the command). */
function withoutScene(item: Record<string, unknown>): Record<string, unknown> {
  const { sceneId: _scene, ...rest } = item;
  return rest;
}

/** Collects `createEntity` argument items (of one scene, `sceneId` null: the active one) into `createEntities` batches. */
export function createEntitiesBatcher(sceneId: string | null): RequestBatcher<Record<string, unknown>> {
  return new RequestBatcher(jsonBytes({ ...(sceneId !== null ? { sceneId } : {}), entities: [] }), (item) => jsonBytes(withoutScene(item)));
}

/** The `createEntities` arguments that create `items` (`createEntity` arguments of one scene), as many as the request size takes. */
export function createEntitiesArgs(items: readonly Record<string, unknown>[]): { sceneId?: string; entities: Record<string, unknown>[] }[] {
  const scene = items[0]?.['sceneId'];
  const sceneId = typeof scene === 'string' ? scene : null;
  const batches = batchesOf(createEntitiesBatcher(sceneId), items);
  return batches.map((batch) => ({ ...(sceneId !== null ? { sceneId } : {}), entities: batch.map(withoutScene) }));
}
