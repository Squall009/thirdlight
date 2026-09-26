/**
 * Phase 23.7: `ctx.random` — seeded, replay-safe random numbers for scripts.
 *
 * Every script instance owns a main stream and up to `MAX_RANDOM_STREAMS`
 * named sub-streams. A stream's seed is a 128-bit hash (cyrb128) of the
 * project's `random_seed` setting, the behavior id, the entity id and the
 * stream name; its generator is sfc32 (32-bit integer arithmetic only, so
 * every JavaScript engine — the page, the simulation worker, Node — draws
 * the same numbers). A stream advances only when drawn from, so one draw
 * more in one stream never shifts another. The behavior host reseeds every
 * stream of an instance at each new run (start, replay), exactly when it
 * instantiates the script's state again.
 *
 * Pure: no DOM, no clock, no `Math.random`.
 */
import type { BehaviorRandom, BehaviorRandomStream } from './types';

/** The seed a project uses until it sets `random_seed` (any fixed value works; 0 is the neutral one). */
export const DEFAULT_RANDOM_SEED = 0;
/** An engine limit protecting the runtime: named streams per script instance. */
export const MAX_RANDOM_STREAMS = 64;
const STREAM_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TWO_POW_32 = 4294967296;

/** A bad `ctx.random` call (the behavior host turns it into a script error). */
export class RandomCallError extends Error {
  readonly reason: 'behavior_random_invalid' | 'behavior_random_limit';
  constructor(reason: RandomCallError['reason'], message: string) {
    super(message);
    this.name = 'RandomCallError';
    this.reason = reason;
  }
}

/**
 * The run seed of a resolved settings object: its `random_seed` (a uint32)
 * when set, else `DEFAULT_RANDOM_SEED`.
 */
export function randomSeedOf(settings: unknown): number {
  const v = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['random_seed'] : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < TWO_POW_32 ? v : DEFAULT_RANDOM_SEED;
}

/** cyrb128: four 32-bit words from a string (a well-mixed seed for sfc32). */
export function hashSeed(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i++) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** The seed text of one stream (parts joined by NUL, which no id or stream name contains). */
function seedText(seed: number, behaviorId: string, entityId: string, stream: string | null): string {
  return `tl-random-v1\u0000${seed}\u0000${behaviorId}\u0000${entityId}\u0000${stream === null ? 'main' : `s:${stream}`}`;
}

function finite(name: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RandomCallError('behavior_random_invalid', `ctx.random.${name} needs finite numbers`);
  return v;
}

/** One sfc32 stream. */
class Stream {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  readonly api: BehaviorRandomStream;

  constructor(private readonly seedWords: readonly [number, number, number, number]) {
    this.reseed();
    this.api = {
      next: (): number => this.u32() / TWO_POW_32,
      range: (min: number, max: number): number => {
        const lo = finite('range', min);
        const hi = finite('range', max);
        return lo + (hi - lo) * (this.u32() / TWO_POW_32);
      },
      int: (min: number, max: number): number => {
        const a = finite('int', min);
        const b = finite('int', max);
        const lo = Math.ceil(Math.min(a, b));
        const hi = Math.floor(Math.max(a, b));
        if (hi < lo) return lo;
        return lo + Math.floor((this.u32() / TWO_POW_32) * (hi - lo + 1));
      },
      chance: (p: number): boolean => {
        const q = finite('chance', p);
        return this.u32() / TWO_POW_32 < q;
      },
      pick: <T>(list: readonly T[]): T | undefined => {
        if (!Array.isArray(list)) throw new RandomCallError('behavior_random_invalid', 'ctx.random.pick needs a list');
        if (list.length === 0) return undefined;
        return list[Math.floor((this.u32() / TWO_POW_32) * list.length)];
      },
    };
  }

  /** Back to the stream's first number. */
  reseed(): void {
    this.a = this.seedWords[0];
    this.b = this.seedWords[1];
    this.c = this.seedWords[2];
    this.d = this.seedWords[3];
    // The usual sfc32 warm-up: the first outputs of a fresh state are less mixed.
    for (let i = 0; i < 12; i++) this.u32();
  }

  /** The next 32-bit output (sfc32). */
  u32(): number {
    const t0 = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const t = (t0 + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }
}

/** `ctx.random` of one script instance (made on first use; streams made on first use). */
export class InstanceRandom {
  private main: Stream | null = null;
  private readonly streams = new Map<string, Stream>();
  readonly api: BehaviorRandom;

  constructor(
    private readonly seed: number,
    private readonly behaviorId: string,
    private readonly entityId: string,
  ) {
    const main = (): BehaviorRandomStream => this.mainStream().api;
    this.api = Object.freeze({
      next: (): number => main().next(),
      range: (min: number, max: number): number => main().range(min, max),
      int: (min: number, max: number): number => main().int(min, max),
      chance: (p: number): boolean => main().chance(p),
      pick: <T>(list: readonly T[]): T | undefined => main().pick(list),
      stream: (name: string): BehaviorRandomStream => this.stream(name),
    });
  }

  private mainStream(): Stream {
    if (this.main === null) this.main = new Stream(hashSeed(seedText(this.seed, this.behaviorId, this.entityId, null)));
    return this.main;
  }

  private stream(name: string): BehaviorRandomStream {
    if (typeof name !== 'string' || !STREAM_NAME_RE.test(name)) {
      throw new RandomCallError('behavior_random_invalid', `ctx.random.stream name must be 1-64 characters of letters, digits, "_", ".", ":" or "-" (got ${JSON.stringify(String(name)).slice(0, 80)})`);
    }
    let s = this.streams.get(name);
    if (s === undefined) {
      if (this.streams.size >= MAX_RANDOM_STREAMS) throw new RandomCallError('behavior_random_limit', `ctx.random: at most ${MAX_RANDOM_STREAMS} named streams per object`);
      s = new Stream(hashSeed(seedText(this.seed, this.behaviorId, this.entityId, name)));
      Object.freeze(s.api);
      this.streams.set(name, s);
    }
    return s.api;
  }

  /** A new run: every stream starts over (handles a script kept stay valid). */
  reset(): void {
    this.main?.reseed();
    this.streams.forEach((s) => s.reseed());
  }
}
