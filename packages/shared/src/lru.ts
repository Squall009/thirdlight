/**
 * A cache bounded by entry count that drops its least recently used entry.
 *
 * `get` and `set` make an entry the most recent; `peek` reads without doing
 * so, for a cache whose recency is meant to follow writes only. The bound is
 * the cache's, never a project's: a miss only costs the work again.
 */
export class LruCache<K, V> {
  readonly #entries = new Map<K, V>();

  constructor(readonly max: number) {}

  get size(): number {
    return this.#entries.size;
  }

  /** The value for `key`, made the most recently used. */
  get(key: K): V | undefined {
    const v = this.#entries.get(key);
    if (v !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, v);
    }
    return v;
  }

  /** The value for `key`, its recency unchanged. */
  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  /** Stores `value` as the most recently used, then drops the least recent entries beyond `max`. */
  set(key: K, value: V): this {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.max) this.#entries.delete(this.#entries.keys().next().value as K);
    return this;
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
