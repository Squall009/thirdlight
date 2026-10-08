/**
 * World streaming on the page: which streamed terrain tiles, block chunks
 * and scatter groups are resident, by distance from the drawn camera's eye
 * (project-model `world-streaming.ts`), within the project's streaming
 * budget.
 *
 * Each view (terrain, block layers, scatter) asks which of an object's
 * cells to hold (`residency`) when the eye has moved or the object's cells
 * changed: those in the ring, then those still within its hysteresis,
 * nearest first, while the total stays within the budget — a kept cell the
 * budget has no room for is let go (`evicted`). Cells in a ring are never cut: when the rings alone need more
 * than the budget, it is reported (diagnostics, and once as a problem) and
 * they stay.
 *
 * What is held goes through the page's resource manager (kinds
 * `terrain-tile`, `block-chunk`, `scatter-group`, holder
 * {@link WORLD_STREAM_HOLDER}): a cell let go is freed at the manager's
 * settle after the frame (the view drops its drawing then), and one taken
 * again before it — a camera turning back — is kept, as a scene's model is
 * across a transition. Play diagnostics show them with every other resource.
 */
import { inStreamRing, type ResourceManager, type StreamRing } from '@thirdlight/runtime';

/** How far (m) the eye moves before a view asks again which of an object's cells to hold (sooner when its cells changed). */
export const STREAM_RECHECK_EYE_METRES = 1;

/**
 * How far (m) the eye moves before a view asks again about a ring: a quarter
 * of its hysteresis (at least {@link STREAM_RECHECK_EYE_METRES}), so a camera
 * crossing a large world asks a few times a second, not every frame.
 */
export function recheckMetres(ring: StreamRing): number {
  return Math.max(STREAM_RECHECK_EYE_METRES, ring.hysteresis / 4);
}

/**
 * The ring a view asks with: reaching as far further as the eye may move
 * before it asks again, so nothing comes into the ring between two asks
 * without having been asked for.
 */
export function askingRing(ring: StreamRing): StreamRing {
  return { radius: ring.radius + recheckMetres(ring), hysteresis: ring.hysteresis };
}

/** Where a view last asked from (x, z), and whether the eye has moved `metres` since (null: never asked). */
export function eyeMoved(at: readonly number[] | null, eye: ArrayLike<number>, metres: number): boolean {
  return at === null || Math.hypot(eye[0]! - at[0]!, eye[2]! - at[1]!) >= metres;
}

/** Frames the deciding time's mean and most cover (10 s at 60 Hz). */
const STREAM_MS_FRAMES = 600;

/** `scene.userData[STREAMING_KEY]`: the page's world streaming (a measurement reads its diagnostics). */
export const STREAMING_KEY = 'tlStreaming';

/** The holder of streamed cells in the resource manager. */
export const WORLD_STREAM_HOLDER = 'world-stream';

/** What streams on the page. */
export type StreamKind = 'terrain-tile' | 'block-chunk' | 'scatter-group';
const KINDS: readonly StreamKind[] = ['terrain-tile', 'block-chunk', 'scatter-group'];

/** One cell a view asks about: its key (unique within the kind), distance from the eye (m), bytes resident and whether it is resident now. */
export interface StreamCell {
  readonly key: string;
  readonly d: number;
  readonly bytes: number;
  readonly resident: boolean;
}

/** Per kind: resident cells and bytes, the cells in the rings and kept past them (each object's last answer), and those let go for the budget since the page began. */
export interface StreamKindDiagnostics {
  resident: number;
  bytes: number;
  inRing: number;
  kept: number;
  evicted: number;
}

export interface PageStreamDiagnostics {
  budgetBytes: number;
  /** Bytes the resident cells take, and what the rings alone hold (each object's last answer); the most resident so far. */
  residentBytes: number;
  ringBytes: number;
  peakResidentBytes: number;
  /** Main-thread milliseconds a frame the views spent deciding what to hold (the last frames': mean and most). */
  ms: { mean: number; max: number };
  /** The rings alone need more than the budget (reported once as a problem each time it starts). */
  overBudget: boolean;
  kinds: Partial<Record<StreamKind, StreamKindDiagnostics>>;
}

export interface PageWorldStreamOptions {
  readonly budgetBytes: number;
  /** The page's resource manager (null: cells are let go at once, no accounting there). */
  readonly resources: ResourceManager | null;
  /** The rings outgrew the budget (a problem for the author). */
  readonly onProblem?: (code: string, message: string) => void;
}

interface Held {
  bytes: number;
  free: () => void;
  /** Let go and waiting for the manager's settle. */
  leaving: boolean;
}

/**
 * Main-thread time (ms) a frame's streamed arrivals share: chunk meshes
 * swapped in and scatter sets made. Each view has its own slice as well; on
 * a game page they draw from this one, so arrivals of every kind landing on
 * the same frame do not add up past what a 60 Hz frame spares (each still
 * makes at least one piece a frame, so none waits on another for ever).
 */
export const STREAM_ARRIVAL_MS = 4;

const mib = (b: number): string => `${Math.round(b / (1024 * 1024))} MiB`;

export class PageWorldStream {
  private readonly held = new Map<StreamKind, Map<string, Held>>(KINDS.map((k) => [k, new Map()]));
  /** Each object's last answer: what it holds (bytes), what its rings alone hold, and its counts. */
  private readonly objects = new Map<string, { kind: StreamKind; used: number; ring: number; inRing: number; kept: number }>();
  private readonly evicted = new Map<StreamKind, number>();
  private used = 0;
  private ringBytes = 0;
  private over = false;
  private peakResident = 0;
  /** This frame's deciding time, and the last frames' (a ring). */
  private frameMs = 0;
  /** This frame's arrivals' time (see {@link STREAM_ARRIVAL_MS}). */
  private arrivalMs = 0;
  private readonly msRing = new Float32Array(STREAM_MS_FRAMES);
  private msAt = 0;
  private msFrames = 0;
  /** The drawn camera's eye (the last frame's), or null before the first. */
  eye: readonly number[] | null = null;

  constructor(private readonly o: PageWorldStreamOptions) {}

  get budgetBytes(): number {
    return this.o.budgetBytes;
  }

  /** A new frame (the eye its views stream around); the rings' last answers against the budget. */
  beginFrame(eye: ArrayLike<number>): void {
    this.eye = [eye[0]!, eye[1]!, eye[2]!];
    this.msRing[this.msAt] = this.frameMs;
    this.msAt = (this.msAt + 1) % STREAM_MS_FRAMES;
    this.msFrames = Math.min(STREAM_MS_FRAMES, this.msFrames + 1);
    this.frameMs = 0;
    this.arrivalMs = 0;
    const over = this.ringBytes > this.o.budgetBytes;
    if (over && !this.over) {
      const msg = `world streaming: the rings around the camera need ${mib(this.ringBytes)}, over the streaming budget of ${mib(this.o.budgetBytes)} (streaming_budget_mb); nothing in a ring is let go, so memory grows past it — make the rings smaller or the budget larger`;
      console.warn(msg);
      this.o.onProblem?.('world_streaming_over_budget', msg);
    }
    this.over = over;
  }

  /**
   * The cells of one object (`object`, unique across kinds) to hold: every
   * cell in `ring`, then those resident within its hysteresis while the
   * total — this object's and every other's last answer — stays within the
   * budget (the farthest let go first). An object asks again when what it
   * streams around moved or its cells changed; its last answer counts until
   * then.
   */
  residency(kind: StreamKind, object: string, cells: readonly StreamCell[], ring: StreamRing): Set<string> {
    const was = this.objects.get(object);
    let used = this.used - (was?.used ?? 0);
    let ringBytes = 0;
    const hold = new Set<string>();
    const kept: StreamCell[] = [];
    let inRing = 0;
    for (const c of cells) {
      if (c.d <= ring.radius) {
        hold.add(c.key);
        used += c.bytes;
        ringBytes += c.bytes;
        inRing += 1;
      } else if (c.resident && inStreamRing(c.d, ring, true)) kept.push(c);
    }
    kept.sort((a, b) => a.d - b.d || (a.key < b.key ? -1 : 1));
    let k = 0;
    for (const c of kept) {
      if (used + c.bytes > this.o.budgetBytes) {
        this.evicted.set(kind, (this.evicted.get(kind) ?? 0) + 1);
        continue;
      }
      hold.add(c.key);
      used += c.bytes;
      k += 1;
    }
    const mine = used - (this.used - (was?.used ?? 0));
    this.used += mine - (was?.used ?? 0);
    this.ringBytes += ringBytes - (was?.ring ?? 0);
    this.objects.set(object, { kind, used: mine, ring: ringBytes, inRing, kept: k });
    return hold;
  }

  /** What is left this frame of the arrivals' shared time (ms; 0: none, a view makes its one piece). */
  arrivalLeft(): number {
    return Math.max(0, STREAM_ARRIVAL_MS - this.arrivalMs);
  }

  /** Main-thread time a view spent on arrivals (counted into this frame's shared time). */
  arrived(ms: number): void {
    this.arrivalMs += ms;
  }

  /** Main-thread time a view spent deciding (counted into this frame's). */
  spent(ms: number): void {
    this.frameMs += ms;
  }

  /** An object that streams no more (it went): its last answer stops counting. */
  forgetObject(object: string): void {
    const was = this.objects.get(object);
    if (was === undefined) return;
    this.used -= was.used;
    this.ringBytes -= was.ring;
    this.objects.delete(object);
  }

  /** Whether a cell is resident (held, or let go and not yet freed). */
  has(kind: StreamKind, key: string): boolean {
    return this.held.get(kind)!.has(key);
  }

  /** Whether a cell is held (not let go). */
  holds(kind: StreamKind, key: string): boolean {
    const h = this.held.get(kind)!.get(key);
    return h !== undefined && !h.leaving;
  }

  /** Hold a cell (taken again if it was let go and not yet freed); `free` drops it when it goes. */
  hold(kind: StreamKind, key: string, bytes: number, free: () => void): void {
    const map = this.held.get(kind)!;
    const h = map.get(key);
    if (h !== undefined) {
      h.leaving = false;
      h.free = free;
      this.resize(kind, key, bytes);
      if (this.o.resources !== null) this.o.resources.hold(kind, key, WORLD_STREAM_HOLDER);
      return;
    }
    map.set(key, { bytes, free, leaving: false });
    const r = this.o.resources;
    if (r === null) return;
    const freed = (): void => {
      const now = map.get(key);
      if (now === undefined || !now.leaving) return;
      map.delete(key);
      now.free();
    };
    void r.acquire(kind, key, WORLD_STREAM_HOLDER, () => Promise.resolve({ value: key, bytes, free: freed })).catch(() => undefined);
  }

  /** A held cell's size changed (its tile re-read, its chunk meshed again). */
  resize(kind: StreamKind, key: string, bytes: number): void {
    const h = this.held.get(kind)!.get(key);
    if (h === undefined) return;
    h.bytes = bytes;
    this.o.resources?.resize(kind, key, key, bytes);
  }

  /** Let a cell go: freed at the manager's settle (at once without one) unless held again first. */
  release(kind: StreamKind, key: string): void {
    const map = this.held.get(kind)!;
    const h = map.get(key);
    if (h === undefined || h.leaving) return;
    h.leaving = true;
    if (this.o.resources === null) {
      map.delete(key);
      h.free();
      return;
    }
    this.o.resources.release(kind, key, WORLD_STREAM_HOLDER);
  }

  /** Forget a cell without freeing it (its object went: the view dropped it already). */
  forget(kind: StreamKind, key: string): void {
    const map = this.held.get(kind)!;
    const h = map.get(key);
    if (h === undefined) return;
    h.leaving = true;
    h.free = () => undefined;
    if (this.o.resources === null) map.delete(key);
    else this.o.resources.release(kind, key, WORLD_STREAM_HOLDER);
  }

  diagnostics(): PageStreamDiagnostics {
    const kinds: Partial<Record<StreamKind, StreamKindDiagnostics>> = {};
    let residentBytes = 0;
    for (const kind of KINDS) {
      const map = this.held.get(kind)!;
      let inRing = 0;
      let kept = 0;
      let any = map.size > 0;
      for (const o of this.objects.values()) {
        if (o.kind !== kind) continue;
        any = true;
        inRing += o.inRing;
        kept += o.kept;
      }
      if (!any) continue;
      let bytes = 0;
      for (const h of map.values()) bytes += h.bytes;
      residentBytes += bytes;
      kinds[kind] = { resident: map.size, bytes, inRing, kept, evicted: this.evicted.get(kind) ?? 0 };
    }
    this.peakResident = Math.max(this.peakResident, residentBytes);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < this.msFrames; i++) {
      sum += this.msRing[i]!;
      max = Math.max(max, this.msRing[i]!);
    }
    const r3 = (v: number): number => Math.round(v * 1000) / 1000;
    return { budgetBytes: this.o.budgetBytes, residentBytes, ringBytes: this.ringBytes, peakResidentBytes: this.peakResident, ms: { mean: r3(this.msFrames > 0 ? sum / this.msFrames : 0), max: r3(max) }, overBudget: this.over, kinds };
  }
}
