/**
 * The priority queue jobs wait in: lane first (edit, then near, then far),
 * then distance, then arrival. An indexed binary heap, so a job can be
 * removed (cancelled) or moved (its distance changed as the focus moved)
 * in O(log n) without scanning.
 */
import { JOB_LANES, type JobLane } from './stream-job';

interface Entry<T> {
  readonly id: number;
  lane: number;
  distance: number;
  seq: number;
  readonly value: T;
}

const LANE_RANK: Readonly<Record<JobLane, number>> = Object.freeze(Object.fromEntries(JOB_LANES.map((l, i) => [l, i])) as Record<JobLane, number>);

export class JobQueue<T> {
  private readonly heap: Entry<T>[] = [];
  private readonly at = new Map<number, number>();
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  has(id: number): boolean {
    return this.at.has(id);
  }

  /** Adds a job (ids are unique while queued). */
  push(id: number, lane: JobLane, distance: number, value: T): void {
    if (this.at.has(id)) throw new RangeError(`job ${id} is already queued`);
    const e: Entry<T> = { id, lane: LANE_RANK[lane], distance, seq: this.seq++, value };
    this.heap.push(e);
    this.at.set(id, this.heap.length - 1);
    this.up(this.heap.length - 1);
  }

  /** The first job without removing it. */
  peek(): T | undefined {
    return this.heap[0]?.value;
  }

  /** Removes and returns the first job. */
  pop(): { id: number; value: T } | undefined {
    const top = this.heap[0];
    if (top === undefined) return undefined;
    this.removeAt(0);
    return { id: top.id, value: top.value };
  }

  /** Removes a job; its value, or undefined when it was not queued. */
  remove(id: number): T | undefined {
    const i = this.at.get(id);
    if (i === undefined) return undefined;
    const v = this.heap[i]!.value;
    this.removeAt(i);
    return v;
  }

  /** Moves a queued job to a new lane and distance (keeping its arrival order); false when it is not queued. */
  update(id: number, lane: JobLane, distance: number): boolean {
    const i = this.at.get(id);
    if (i === undefined) return false;
    const e = this.heap[i]!;
    e.lane = LANE_RANK[lane];
    e.distance = distance;
    this.up(i);
    this.down(this.at.get(id)!);
    return true;
  }

  /** Every queued job (in heap order, not priority order). */
  *entries(): IterableIterator<{ id: number; value: T }> {
    for (const e of this.heap) yield { id: e.id, value: e.value };
  }

  private removeAt(i: number): void {
    const last = this.heap.pop()!;
    this.at.delete(this.heap.length === i ? last.id : this.heap[i]!.id);
    if (i === this.heap.length) return;
    this.heap[i] = last;
    this.at.set(last.id, i);
    this.up(i);
    this.down(this.at.get(last.id)!);
  }

  private less(a: Entry<T>, b: Entry<T>): boolean {
    return a.lane !== b.lane ? a.lane < b.lane : a.distance !== b.distance ? a.distance < b.distance : a.seq < b.seq;
  }

  private swap(i: number, j: number): void {
    const a = this.heap[i]!;
    const b = this.heap[j]!;
    this.heap[i] = b;
    this.heap[j] = a;
    this.at.set(b.id, i);
    this.at.set(a.id, j);
  }

  private up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(this.heap[i]!, this.heap[p]!)) return;
      this.swap(i, p);
      i = p;
    }
  }

  private down(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(this.heap[l]!, this.heap[m]!)) m = l;
      if (r < n && this.less(this.heap[r]!, this.heap[m]!)) m = r;
      if (m === i) return;
      this.swap(i, m);
      i = m;
    }
  }
}
