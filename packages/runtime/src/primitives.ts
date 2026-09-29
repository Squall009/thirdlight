/**
 * The generic gameplay primitives, run by the runtime in the
 * fixed step (deterministic: entity order, sorted pairs, step counts) on the
 * 2D plane and in 3D alike:
 *
 * - `health` on any object: its current and maximum; scripts damage and heal
 *   it (`ctx.health`), and every change is an event (`damaged`, `healed`,
 *   `died` when it reaches 0). There is no rule about what 0 means: scripts
 *   decide.
 * - `collectible`: the character (the controller's object) touching its area
 *   adds `amount` to a named counter, hides it and stops it collecting, sends
 *   its `onCollect` signal and a `collected` event; it comes back after its
 *   `respawn` time (never without one) or when a script restores it.
 * - `patrol`: an object that walks by itself — along waypoints (the mover's
 *   path code), or straight ahead turning at walls and ledges (a ray ahead at
 *   the middle of its body, a ray down just past its front); a `turned` event
 *   each time it turns around.
 * - `hitbox`: an area (a box, or a sphere — a circle on the 2D plane) whose
 *   contacts with other hitboxes and with the character are `contact` and
 *   `separate` events for both sides, carrying the other object and the
 *   contact normal (a unit vector from this object toward the other: the
 *   side the contact is on, taken from the axis along which the two were
 *   still apart in the previous step when there is one). A hitbox with
 *   `damage` takes that much from the other side's health on a new contact.
 *
 * The character takes part with its capsule's bounding box. An object never
 * touches its own parents or children. Events are seen by scripts in the
 * step after they happened (like trigger events); the state is saved in a
 * project save's `components` section.
 */
import type { PhysicsPort, PhysicsPort3D } from './ports';
import type { HealthEventRecord, PrimitiveEventRecord, TransformState } from './types';

type Vec3 = [number, number, number];

// ---- the waypoint path (shared with the mover) -----------------------------------

/** A position along a waypoint path (a mover's or a waypoint patrol's). */
export interface PathState {
  points: Vec3[];
  lengths: number[];
  speed: number;
  mode: 'loop' | 'pingpong' | 'once';
  wait: number;
  /** How the position follows the distance along a stretch (was `smooth: boolean`). */
  easing: 'linear' | 'smooth' | 'gravity';
  segment: number;
  along: number;
  dir: 1 | -1;
  waiting: number;
  done: boolean;
  pos: Vec3;
}

/** The segment lengths of a path through `points` (a loop closes back to the start). */
export function pathLengths(points: readonly Vec3[], loop: boolean): number[] {
  const segs = loop ? points.length : points.length - 1;
  return Array.from({ length: segs }, (_, i) => {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  });
}

/** Advance along the path by one step of `dt` seconds (the mover rules). */
export function advancePath(m: PathState, dt: number): void {
  if (m.waiting > 0) {
    m.waiting = Math.max(0, m.waiting - dt);
    return;
  }
  let budget = m.speed * dt;
  for (let guard = 0; guard < 64 && budget > 1e-12; guard++) {
    const len = m.lengths[m.segment] ?? 0;
    const remaining = m.dir === 1 ? len - m.along : m.along;
    if (budget < remaining) {
      m.along += m.dir * budget;
      budget = 0;
      break;
    }
    budget -= remaining;
    m.along = m.dir === 1 ? len : 0;
    // At a point: wait, then pick the next segment.
    const atEnd = m.dir === 1 ? m.segment === m.lengths.length - 1 : m.segment === 0;
    if (m.mode === 'loop') {
      // A reversed loop goes round the other way.
      if (m.dir === 1) {
        m.segment = (m.segment + 1) % m.lengths.length;
        m.along = 0;
      } else {
        m.segment = (m.segment + m.lengths.length - 1) % m.lengths.length;
        m.along = m.lengths[m.segment] ?? 0;
      }
    } else if (atEnd) {
      if (m.mode === 'once') {
        m.done = true;
        break;
      }
      m.dir = m.dir === 1 ? -1 : 1;
    } else {
      m.segment += m.dir;
      m.along = m.dir === 1 ? 0 : m.lengths[m.segment] ?? 0;
    }
    if (m.wait > 0) {
      m.waiting = m.wait;
      budget = 0;
    }
  }
  m.pos = pathPosition(m);
}

/**
 * The share of a stretch's length covered at share `f` of its
 * distance along it (`along / length`), for the path's easing and direction.
 * Gravity is constant acceleration from the stretch's start point (the one it
 * left: `a` going forward, `b` going back): the distance grows with the square
 * of the time, and `along` advances at `speed` as the time does.
 */
function eased(easing: PathState['easing'], dir: 1 | -1, f: number): number {
  if (easing === 'smooth') return f * f * (3 - 2 * f);
  if (easing === 'gravity') return dir === 1 ? f * f : 1 - (1 - f) * (1 - f);
  return f;
}

/** Where a path's state puts it. */
export function pathPosition(m: PathState): Vec3 {
  const len = m.lengths[m.segment] ?? 0;
  const a = m.points[m.segment]!;
  const b = m.points[(m.segment + 1) % m.points.length]!;
  const u = eased(m.easing, m.dir, len > 0 ? m.along / len : 0);
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/**
 * Turn a path around where it is — back the way it came. A
 * finished `once` path moves again (back to its start). With gravity easing
 * the distance along the stretch is re-read for the new direction so the
 * position does not jump (the motion then carries on from that point of the
 * reversed stretch's curve).
 */
export function reversePath(m: PathState): void {
  const len = m.lengths[m.segment] ?? 0;
  if (m.easing === 'gravity' && len > 0) {
    const f = m.along / len;
    const u = eased('gravity', m.dir, f);
    // Solve eased(gravity, −dir, f') = u for f'.
    const f2 = m.dir === 1 ? 1 - Math.sqrt(Math.max(0, 1 - u)) : Math.sqrt(Math.max(0, u));
    m.along = f2 * len;
  }
  m.dir = m.dir === 1 ? -1 : 1;
  m.done = false;
}

// ---- state -----------------------------------------------------------------------

/** One object's health. */
export interface HealthRecord {
  max: number;
  start: number;
  current: number;
}

interface Collectible {
  id: string;
  counter: string;
  amount: number;
  /** Steps until it comes back (0: never). */
  respawnSteps: number;
  signal: string | null;
  half: Vec3;
  collected: boolean;
  /** Steps left until it comes back (-1: not counting). */
  timer: number;
}

interface Patrol {
  id: string;
  /** Local position where it was placed. */
  start: Vec3;
  speed: number;
  waitSteps: number;
  active: boolean;
  /** edges: the walking direction (unit), body half extents, probes; its local position; steps left of a wait. */
  edges: { dir: Vec3; startDir: Vec3; half: Vec3; wallProbe: number; ledgeProbe: number; pos: Vec3; waiting: number } | null;
  /** waypoints: the path (its `pos` is the local position). */
  path: PathState | null;
}

/** A gravity body: where it was placed (local), its body's half extents, its gravity scale and fall speed. */
interface Fall {
  id: string;
  start: Vec3;
  half: Vec3;
  scale: number;
  /** m/s along Y (negative: falling). */
  vy: number;
}

/**
 * A gravity body looks for floor from this far above its
 * underside (the patrol probes' 0.1 m): ground up to 0.1 m higher (a kerb, a
 * slope walked up) lifts it onto it instead of leaving it inside.
 */
const FALL_LIFT = 0.1;
/** The probes sit this share of the body's half width in from its sides (a body half over an edge still stands). */
const FALL_PROBE_INSET = 0.9;

interface Hitbox {
  id: string;
  /** Box half extents, or null for a sphere. */
  half: Vec3 | null;
  radius: number;
  damage: number;
  active: boolean;
}

/** A contact participant this step: its centre and shape. */
interface Body {
  id: string;
  c: Vec3;
  half: Vec3 | null;
  r: number;
  damage: number;
}

/** What the primitives need from the gameplay blocks. */
export interface PrimitivesHost {
  readonly hz: number;
  readonly dimension: 2 | 3;
  readonly curr: Map<string, TransformState>;
  readonly physics: PhysicsPort | undefined;
  readonly physics3d: PhysicsPort3D | undefined;
  /** The character (the controller's object): its id, its capsule's bounding box centre and half extents; null when there is none. */
  character(): { id: string; centre: Vec3; half: Vec3 } | null;
  worldOf(id: string): Vec3 | null;
  parentOf(id: string): string | undefined;
  setHidden(id: string, hidden: boolean): void;
  addCounter(name: string, delta: number): void;
  emit(signal: string): void;
  /** Every event as it happens (the event → cue table listens; absent: nobody). */
  note?(e: PrimitiveEventRecord): void;
  /** The project's gravity (m/s² along Y) and fall speed cap (m/s, negative) for gravity bodies (absent: −19.62, −30). */
  readonly gravityY?: number;
  readonly maxFallSpeed?: number;
}

/** The `components` save section (plain JSON). */
export interface PrimitivesSaveState {
  /** Object → its current health. */
  health?: Record<string, number>;
  /** Collected collectible → steps until it comes back (-1: never). */
  collected?: Record<string, number>;
  /** Patroller → where it is and which way it walks. */
  patrol?: Record<string, { p: number[]; d: number[]; w: number; a: boolean; s?: number; u?: number; r?: number }>;
  /** Hitboxes scripts switched off. */
  off?: string[];
  /** Gravity bodies → [local y, fall speed] (only when the scene has any). */
  fall?: Record<string, [number, number]>;
  /** The look overrides scripts set (object → its override). */
  look?: Record<string, EntityLook>;
}

/**
 * A per-object look override the simulation or a script sets
 * (`ctx.look.set`): an emissive colour and intensity, and a tint multiplied
 * into the base colour, on every mesh under the object. The renderer applies
 * it on both backends; clearing it gives the object its own look back.
 */
export interface EntityLook {
  /** '#rrggbb'. */
  readonly emissive?: string;
  /** 0–4 (absent with an emissive colour: 1). */
  readonly emissiveIntensity?: number;
  /** '#rrggbb', multiplied into the base colour. */
  readonly tint?: string;
}

/** The brightest emissive a look override may set (the surface's own limit). */
export const LOOK_MAX_EMISSIVE_INTENSITY = 4;
/** Engine limit — objects with a look override at once (a replay-safe bound on the state). */
export const MAX_LOOK_OVERRIDES = 1024;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** A valid look override from a script's value, or null (a bad field, or nothing set). */
export function entityLookOf(value: unknown): EntityLook | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (k !== 'emissive' && k !== 'emissiveIntensity' && k !== 'tint') return null;
  const out: { emissive?: string; emissiveIntensity?: number; tint?: string } = {};
  if (v['emissive'] !== undefined) {
    if (typeof v['emissive'] !== 'string' || !HEX_COLOR.test(v['emissive'])) return null;
    out.emissive = v['emissive'].toLowerCase();
  }
  if (v['emissiveIntensity'] !== undefined) {
    const n = v['emissiveIntensity'];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > LOOK_MAX_EMISSIVE_INTENSITY) return null;
    out.emissiveIntensity = n;
  }
  if (v['tint'] !== undefined) {
    if (typeof v['tint'] !== 'string' || !HEX_COLOR.test(v['tint'])) return null;
    out.tint = v['tint'].toLowerCase();
  }
  if (out.emissive === undefined && out.emissiveIntensity === undefined && out.tint === undefined) return null;
  return Object.freeze(out);
}

const NO_EVENTS: readonly PrimitiveEventRecord[] = Object.freeze([]);
const ZERO: readonly [number, number, number] = Object.freeze([0, 0, 0]) as unknown as readonly [number, number, number];
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const area = (v: unknown, d: readonly number[]): Vec3 => {
  const a = Array.isArray(v) ? (v as number[]) : d;
  const w = num(a[0], 1);
  return [w / 2, num(a[1], w) / 2, num(a[2], w) / 2];
};
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [1, 0, 0];
};
/** A frozen copy (-0 written as 0: scripts compare and print the components). */
const frozen3 = (v: readonly number[]): readonly [number, number, number] => Object.freeze([(v[0] ?? 0) + 0, (v[1] ?? 0) + 0, (v[2] ?? 0) + 0]) as unknown as readonly [number, number, number];

export class Primitives {
  private readonly healths = new Map<string, HealthRecord>();
  private readonly collectibles = new Map<string, Collectible>();
  private readonly patrols = new Map<string, Patrol>();
  private readonly falls = new Map<string, Fall>();
  private readonly hitboxes = new Map<string, Hitbox>();
  /** Objects a script switched off (they do not walk, collect or touch; a hitbox switched off separates). */
  private inactive: ReadonlySet<string> = new Set();
  /** The contacts of the last step, by pair key `a\u0000b` (a < b). */
  private contacts = new Map<string, [string, string]>();
  /** Each participant's centre in the last contact pass (the side a new contact came from). */
  private lastCentre = new Map<string, Vec3>();
  private eventsNow: PrimitiveEventRecord[] = [];
  private eventsPrev: readonly PrimitiveEventRecord[] = NO_EVENTS;
  private step = 0;
  /** Look overrides by object (insertion order is irrelevant: views are sorted). */
  private readonly looks = new Map<string, EntityLook>();
  /** Bumped on every look change (the renderer and the worker mirror compare it). */
  private looksVersion = 0;

  constructor(private readonly host: PrimitivesHost) {}

  /** Whether any primitive (besides health) runs in the step. */
  get active(): boolean {
    return this.collectibles.size > 0 || this.patrols.size > 0 || this.hitboxes.size > 0 || this.falls.size > 0;
  }

  // ---- loading -----------------------------------------------------------------

  /** An object's components (a loaded scene, a spawned copy). */
  add(id: string, c: Readonly<Record<string, Record<string, unknown> | undefined>>, position: readonly number[]): void {
    const h = c['health'];
    if (h !== undefined) {
      const max = num(h['max'], 3);
      this.healths.set(id, { max, start: Math.min(max, num(h['start'], max)), current: Math.min(max, num(h['start'], max)) });
    }
    const k = c['collectible'];
    if (k !== undefined) {
      this.collectibles.set(id, {
        id,
        counter: String(k['counter']),
        amount: num(k['amount'], 1),
        respawnSteps: Math.max(0, Math.round(num(k['respawn'], 0) * this.host.hz)),
        signal: typeof k['onCollect'] === 'string' ? (k['onCollect'] as string) : null,
        half: area(k['size'], [1, 1, 1]),
        collected: false,
        timer: -1,
      });
    }
    const p = c['patrol'];
    if (p !== undefined) {
      const start: Vec3 = [num(position[0], 0), num(position[1], 0), num(position[2], 0)];
      const waypoints = p['mode'] === 'waypoints' ? ((p['waypoints'] as number[][] | undefined) ?? []) : null;
      let path: PathState | null = null;
      let edges: Patrol['edges'] = null;
      if (waypoints !== null) {
        const points: Vec3[] = [start, ...waypoints.map((w) => [start[0] + num(w[0], 0), start[1] + num(w[1], 0), start[2] + num(w[2], 0)] as Vec3)];
        const loop = p['loop'] === true;
        path = { points, lengths: pathLengths(points, loop), speed: num(p['speed'], 1), mode: loop ? 'loop' : 'pingpong', wait: num(p['wait'], 0), easing: 'linear', segment: 0, along: 0, dir: 1, waiting: 0, done: false, pos: [...start] };
      } else {
        const d = (p['direction'] as number[] | undefined) ?? [1, 0, 0];
        // The 2D plane walks any direction in the plane (x and y; +x when it has neither — before, only
        // the sign of x counted, which a direction along x keeps exactly); 3D the direction along the ground.
        const dir: Vec3 = this.host.dimension === 2 ? unit([num(d[0], 1), num(d[1], 0), 0]) : unit([num(d[0], 0), 0, num(d[2], 0)]);
        edges = { dir: [...dir], startDir: dir, half: area(p['size'], [1, 1, 1]), wallProbe: num(p['wallProbe'], 0.05), ledgeProbe: num(p['ledgeProbe'], 0.4), pos: [...start], waiting: 0 };
      }
      this.patrols.set(id, { id, start, speed: num(p['speed'], 1), waitSteps: Math.max(0, Math.round(num(p['wait'], 0) * this.host.hz)), active: true, edges, path });
    }
    const g = c['gravity'];
    if (g !== undefined) {
      this.falls.set(id, { id, start: [num(position[0], 0), num(position[1], 0), num(position[2], 0)], half: area(g['size'], [1, 1, 1]), scale: num(g['scale'], 1), vy: 0 });
    }
    const hb = c['hitbox'];
    if (hb !== undefined) {
      const sphere = hb['shape'] === 'sphere';
      this.hitboxes.set(id, { id, half: sphere ? null : area(hb['size'], [1, 1, 1]), radius: sphere ? num(hb['radius'], 0.5) : 0, damage: num(hb['damage'], 0), active: true });
    }
  }

  /** Objects of an unloaded scene (or destroyed copies): gone without events. */
  remove(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.healths.delete(id);
      this.collectibles.delete(id);
      this.patrols.delete(id);
      this.hitboxes.delete(id);
      this.falls.delete(id);
      this.lastCentre.delete(id);
      if (this.looks.delete(id)) this.looksVersion += 1;
    }
    for (const [key, [a, b]] of this.contacts) if (ids.has(a) || ids.has(b)) this.contacts.delete(key);
  }

  /** A new run: everything as authored. */
  resetRun(): void {
    for (const h of this.healths.values()) h.current = h.start;
    for (const k of this.collectibles.values()) Object.assign(k, { collected: false, timer: -1 });
    for (const p of this.patrols.values()) this.resetPatrol(p);
    for (const b of this.hitboxes.values()) b.active = true;
    for (const f of this.falls.values()) {
      f.vy = 0;
      if (!this.patrols.has(f.id)) this.write(f.id, f.start);
    }
    this.contacts = new Map();
    this.lastCentre = new Map();
    this.eventsNow = [];
    this.eventsPrev = NO_EVENTS;
    if (this.looks.size > 0) {
      this.looks.clear();
      this.looksVersion += 1;
    }
  }

  // ---- Look overrides ---------------------------------------------------

  /** Set an object's look override (replacing any it had); false for a bad look, an object not loaded, or past the limit. */
  setLook(id: string, value: unknown): boolean {
    if (!this.host.curr.has(id)) return false;
    const look = entityLookOf(value);
    if (look === null) return false;
    if (!this.looks.has(id) && this.looks.size >= MAX_LOOK_OVERRIDES) return false;
    this.looks.set(id, look);
    this.looksVersion += 1;
    return true;
  }

  /** Give an object its own look back (false when it had no override). */
  clearLook(id: string): boolean {
    if (!this.looks.delete(id)) return false;
    this.looksVersion += 1;
    return true;
  }

  lookOf(id: string): EntityLook | null {
    return this.looks.get(id) ?? null;
  }

  /** The overrides now (the renderer's view; sorted by object id when read for a digest or a save). */
  looksView(): ReadonlyMap<string, EntityLook> {
    return this.looks;
  }

  /** Bumped on every look change. */
  get lookVersion(): number {
    return this.looksVersion;
  }

  private resetPatrol(p: Patrol): void {
    p.active = true;
    if (p.edges !== null) Object.assign(p.edges, { dir: [...p.edges.startDir], pos: [...p.start], waiting: 0 });
    if (p.path !== null) Object.assign(p.path, { segment: 0, along: 0, dir: 1, waiting: 0, done: false, pos: [...p.start] });
    this.write(p.id, p.start);
  }

  // ---- the step ------------------------------------------------------------------

  /** Start of a step: last step's events become what scripts see. */
  turnover(stepIndex: number): void {
    this.step = stepIndex;
    if (this.eventsNow.length === 0) this.eventsPrev = NO_EVENTS;
    else {
      this.eventsPrev = Object.freeze(this.eventsNow);
      this.eventsNow = [];
    }
  }

  /** The events of the previous step (in the order they happened). */
  events(): readonly PrimitiveEventRecord[] {
    return this.eventsPrev;
  }

  /** After physics: patrols walk, collectibles and contacts are tested (`playing`: the character takes part). */
  /** The objects switched off (see `GameplayBlocks.setInactive`). */
  setInactive(ids: ReadonlySet<string>): void {
    this.inactive = ids;
  }

  afterPhysics(playing: boolean): void {
    if (!this.active) return;
    const dt = 1 / this.host.hz;
    const off = this.inactive;
    for (const p of this.patrols.values()) if (off.size === 0 || !off.has(p.id)) this.walk(p, dt);
    // Gravity bodies fall (after a walker's step: it walks, then falls or lands).
    for (const f of this.falls.values()) if (off.size === 0 || !off.has(f.id)) this.fall(f, dt);
    const character = playing ? this.host.character() : null;
    for (const k of this.collectibles.values()) if (off.size === 0 || !off.has(k.id)) this.collect(k, character);
    if (this.hitboxes.size > 0) this.touch(character);
  }

  private push(e: PrimitiveEventRecord): void {
    const f = Object.freeze(e);
    this.eventsNow.push(f);
    this.host.note?.(f);
  }

  // ---- collectibles ----------------------------------------------------------------

  private collect(k: Collectible, character: { id: string; centre: Vec3; half: Vec3 } | null): void {
    if (k.collected) {
      if (k.timer > 0 && --k.timer === 0) this.restoreCollectible(k);
      return;
    }
    if (character === null) return;
    const at = this.host.worldOf(k.id);
    if (at === null) return;
    const q = this.host.curr.get(k.id)?.rotation ?? [0, 0, 0, 1];
    if (!boxesOverlap(at, k.half, q, character.centre, character.half, this.host.dimension)) return;
    k.collected = true;
    k.timer = k.respawnSteps > 0 ? k.respawnSteps : -1;
    this.host.setHidden(k.id, true);
    this.host.addCounter(k.counter, k.amount);
    if (k.signal !== null) this.host.emit(k.signal);
    this.push({ type: 'collected', entity: k.id, counter: k.counter, amount: k.amount, by: character.id, stepIndex: this.step - 1 });
  }

  private restoreCollectible(k: Collectible): void {
    k.collected = false;
    k.timer = -1;
    this.host.setHidden(k.id, false);
    this.push({ type: 'restored', entity: k.id, counter: k.counter, amount: 0, by: '', stepIndex: this.step - 1 });
  }

  // ---- patrols ---------------------------------------------------------------------

  private walk(p: Patrol, dt: number): void {
    if (!p.active) return;
    if (p.path !== null) {
      const m = p.path;
      const before = m.dir;
      advancePath(m, dt);
      this.write(p.id, m.pos);
      if (m.dir !== before) this.push({ type: 'turned', entity: p.id, reason: 'end', direction: frozen3(this.pathDirection(m)), stepIndex: this.step - 1 });
      return;
    }
    const e = p.edges!;
    if (e.waiting > 0) {
      e.waiting -= 1;
      return;
    }
    const c = this.host.worldOf(p.id);
    if (c === null) return;
    const step = p.speed * dt;
    const blocked = this.probe(c, e, step);
    if (blocked !== null) {
      e.dir = [-e.dir[0], -e.dir[1], -e.dir[2]];
      e.waiting = p.waitSteps;
      this.push({ type: 'turned', entity: p.id, reason: blocked, direction: frozen3(e.dir), stepIndex: this.step - 1 });
      return;
    }
    // A 2D walker's direction may have a y part (it moves up or down).
    e.pos = [e.pos[0] + e.dir[0] * step, e.pos[1] + e.dir[1] * step, e.pos[2] + e.dir[2] * step];
    this.write(p.id, e.pos);
  }

  /** An edge walker's probes from its world centre `c`: a wall ahead, or no floor just past its front (null: the way is clear; no physics: always clear). */
  private probe(c: Vec3, e: NonNullable<Patrol['edges']>, step: number): 'wall' | 'ledge' | null {
    const d = e.dir;
    const reach = e.half[0] + step + e.wallProbe;
    const front: Vec3 = [c[0] + d[0] * (e.half[0] + e.wallProbe), c[1] - e.half[1] + 0.1, c[2] + d[2] * (e.half[0] + e.wallProbe)];
    if (this.host.dimension === 3) {
      const port = this.host.physics3d;
      if (port?.raycast === undefined) return null;
      if (port.raycast({ x: c[0], y: c[1], z: c[2] }, { x: d[0], y: 0, z: d[2] }, reach) !== null) return 'wall';
      if (port.raycast({ x: front[0], y: front[1], z: front[2] }, { x: 0, y: -1, z: 0 }, e.ledgeProbe) === null) return 'ledge';
      return null;
    }
    const port = this.host.physics;
    if (port?.raycast === undefined) return null;
    // Along its direction in the plane, from its centre past its body's extent that way; only a walk
    // along the ground (no y part) looks for ledges — moving up or down it is not walking on a floor.
    const vertical = d[1] !== 0;
    const extent = vertical ? Math.abs(d[0]) * e.half[0] + Math.abs(d[1]) * e.half[1] : e.half[0];
    if (port.raycast({ x: c[0], y: c[1] }, { x: d[0], y: d[1] }, extent + step + e.wallProbe) !== null) return 'wall';
    if (!vertical && port.raycast({ x: front[0], y: front[1] }, { x: 0, y: -1 }, e.ledgeProbe) === null) return 'ledge';
    return null;
  }

  private pathDirection(m: PathState): Vec3 {
    const a = m.points[m.segment]!;
    const b = m.points[(m.segment + 1) % m.points.length]!;
    const v: Vec3 = [(b[0] - a[0]) * m.dir, (b[1] - a[1]) * m.dir, (b[2] - a[2]) * m.dir];
    return Math.hypot(v[0], v[1], v[2]) > 0 ? unit(v) : [0, 0, 0];
  }

  /**
   * A gravity body's step: its fall speed grows by the project's
   * gravity (times its scale, capped at the fall speed); rays down from just
   * above its underside (at its centre and near its sides; 3D: its corners
   * too) find the floor, and when this step's fall reaches it the body rests
   * on it (speed 0), else it falls. An edge walker's own height follows.
   */
  private fall(f: Fall, dt: number): void {
    const t = this.host.curr.get(f.id);
    const c = this.host.worldOf(f.id);
    if (t === undefined || c === null) return;
    const g = (this.host.gravityY ?? -19.62) * f.scale;
    f.vy = Math.max(this.host.maxFallSpeed ?? -30, f.vy + g * dt);
    const drop = Math.max(0, -f.vy * dt);
    const fromY = c[1] - f.half[1] + FALL_LIFT;
    const reach = FALL_LIFT + drop;
    const hx = f.half[0] * FALL_PROBE_INSET;
    const hz = f.half[2] * FALL_PROBE_INSET;
    let best: number | null = null;
    const ray = (x: number, z: number): void => {
      let d: number | null = null;
      if (this.host.dimension === 3) d = this.host.physics3d?.raycast?.({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }, reach)?.distance ?? null;
      else d = this.host.physics?.raycast?.({ x, y: fromY }, { x: 0, y: -1 }, reach)?.distance ?? null;
      if (d !== null && (best === null || d < best)) best = d;
    };
    ray(c[0], c[2]);
    ray(c[0] - hx, c[2]);
    ray(c[0] + hx, c[2]);
    if (this.host.dimension === 3) {
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) ray(c[0] + sx * hx, c[2] + sz * hz);
    }
    let dy: number;
    if (best !== null) {
      // Landed (or resting): the underside on the highest floor found.
      dy = FALL_LIFT - (best as number);
      f.vy = 0;
    } else dy = -drop;
    if (dy === 0) return;
    t.position[1] += dy;
    const p = this.patrols.get(f.id);
    if (p?.edges != null) p.edges.pos[1] = t.position[1];
  }

  private write(id: string, pos: readonly number[]): void {
    const t = this.host.curr.get(id);
    if (t === undefined) return;
    t.position[0] = pos[0]!;
    t.position[1] = pos[1]!;
    t.position[2] = pos[2]!;
  }

  // ---- hitbox contacts ---------------------------------------------------------------

  private touch(character: { id: string; centre: Vec3; half: Vec3 } | null): void {
    const bodies: Body[] = [];
    for (const b of this.hitboxes.values()) {
      if (!b.active || this.inactive.has(b.id)) continue;
      const c = this.host.worldOf(b.id);
      if (c !== null) bodies.push({ id: b.id, c, half: b.half, r: b.radius, damage: b.damage });
    }
    if (character !== null && !this.hitboxes.has(character.id)) bodies.push({ id: character.id, c: character.centre, half: character.half, r: 0, damage: 0 });
    const dims = this.host.dimension;
    // Sweep along x (sorted by the left edge, then id: deterministic).
    const ext = (b: Body): number => (b.half !== null ? b.half[0] : b.r);
    bodies.sort((a, b) => a.c[0] - ext(a) - (b.c[0] - ext(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const now = new Map<string, [string, string]>();
    const fresh: { key: string; a: Body; b: Body; n: Vec3 }[] = [];
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i]!;
      const right = a.c[0] + ext(a);
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j]!;
        if (b.c[0] - ext(b) >= right) break;
        if (this.related(a.id, b.id)) continue;
        const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
        const n = contactNormal(lo, hi, this.lastCentre.get(lo.id), this.lastCentre.get(hi.id), dims);
        if (n === null) continue;
        const key = `${lo.id}\u0000${hi.id}`;
        now.set(key, [lo.id, hi.id]);
        if (!this.contacts.has(key)) fresh.push({ key, a: lo, b: hi, n });
      }
    }
    const ended = [...this.contacts.keys()].filter((k) => !now.has(k)).sort();
    for (const key of ended) {
      const [a, b] = this.contacts.get(key)!;
      this.push({ type: 'separate', entity: a, other: b, normal: ZERO, stepIndex: this.step - 1 });
      this.push({ type: 'separate', entity: b, other: a, normal: ZERO, stepIndex: this.step - 1 });
    }
    fresh.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    for (const f of fresh) {
      this.push({ type: 'contact', entity: f.a.id, other: f.b.id, normal: frozen3(f.n), stepIndex: this.step - 1 });
      this.push({ type: 'contact', entity: f.b.id, other: f.a.id, normal: frozen3([-f.n[0], -f.n[1], -f.n[2]]), stepIndex: this.step - 1 });
    }
    for (const f of fresh) {
      if (f.a.damage > 0) this.damageOwner(f.b.id, f.a.damage, f.a.id);
      if (f.b.damage > 0) this.damageOwner(f.a.id, f.b.damage, f.b.id);
    }
    this.contacts = now;
    this.lastCentre = new Map(bodies.map((b) => [b.id, b.c]));
  }

  /** One is a parent (at any depth) of the other. */
  private related(a: string, b: string): boolean {
    return this.isAncestor(a, b) || this.isAncestor(b, a);
  }

  private isAncestor(anc: string, id: string): boolean {
    let p = this.host.parentOf(id);
    for (let guard = 0; p !== undefined && guard < 64; guard++) {
      if (p === anc) return true;
      p = this.host.parentOf(p);
    }
    return false;
  }

  /** Damage the object's health, or its nearest parent's that has one. */
  private damageOwner(id: string, amount: number, source: string): void {
    let cur: string | undefined = id;
    for (let guard = 0; cur !== undefined && guard < 64; guard++) {
      if (this.healths.has(cur)) {
        this.damage(cur, amount, source);
        return;
      }
      cur = this.host.parentOf(cur);
    }
  }

  // ---- the script APIs ------------------------------------------------------------------

  healthOf(id: string): { current: number; max: number } | null {
    const h = this.healths.get(id);
    return h === undefined ? null : { current: h.current, max: h.max };
  }

  /** Every object's health (id order; the HUD's bindings). */
  healthsView(): Record<string, { current: number; max: number }> {
    const out: Record<string, { current: number; max: number }> = {};
    for (const id of [...this.healths.keys()].sort()) {
      const h = this.healths.get(id)!;
      out[id] = { current: h.current, max: h.max };
    }
    return out;
  }

  /** Take `amount` from an object's health (not below 0); false without health, at 0 already, or for a bad amount. */
  damage(id: string, amount: number, source = ''): boolean {
    const h = this.healths.get(id);
    if (h === undefined || !(Number.isFinite(amount) && amount > 0) || h.current <= 0) return false;
    const before = h.current;
    h.current = Math.max(0, h.current - amount);
    this.push({ type: 'damaged', entity: id, amount: before - h.current, current: h.current, source, stepIndex: this.step - 1 });
    if (h.current === 0) this.push({ type: 'died', entity: id, amount: 0, current: 0, source, stepIndex: this.step - 1 });
    return true;
  }

  /** Give `amount` back (not above the maximum); false without health, at the maximum, or for a bad amount. */
  heal(id: string, amount: number, source = ''): boolean {
    const h = this.healths.get(id);
    if (h === undefined || !(Number.isFinite(amount) && amount > 0) || h.current >= h.max) return false;
    const before = h.current;
    h.current = Math.min(h.max, h.current + amount);
    this.push({ type: 'healed', entity: id, amount: h.current - before, current: h.current, source, stepIndex: this.step - 1 });
    return true;
  }

  healthEvents(): readonly HealthEventRecord[] {
    const all = this.eventsPrev;
    if (all.length === 0) return NO_EVENTS as readonly HealthEventRecord[];
    return Object.freeze(all.filter((e): e is HealthEventRecord => e.type === 'damaged' || e.type === 'healed' || e.type === 'died'));
  }

  patrolOf(id: string): { direction: readonly [number, number, number]; active: boolean } | null {
    const p = this.patrols.get(id);
    if (p === undefined) return null;
    return { direction: frozen3(p.edges !== null ? p.edges.dir : this.pathDirection(p.path!)), active: p.active };
  }

  setPatrolActive(id: string, active: boolean): boolean {
    const p = this.patrols.get(id);
    if (p === undefined) return false;
    p.active = active;
    return true;
  }

  /** Turn a patroller around now (a waypoint loop cannot walk backwards: false). */
  turnPatrol(id: string): boolean {
    const p = this.patrols.get(id);
    if (p === undefined) return false;
    if (p.edges !== null) p.edges.dir = [-p.edges.dir[0], -p.edges.dir[1], -p.edges.dir[2]];
    else if (p.path!.mode === 'loop') return false;
    else p.path!.dir = p.path!.dir === 1 ? -1 : 1;
    this.push({ type: 'turned', entity: id, reason: 'script', direction: frozen3(p.edges !== null ? p.edges.dir : this.pathDirection(p.path!)), stepIndex: this.step - 1 });
    return true;
  }

  setHitboxActive(id: string, active: boolean): boolean {
    const b = this.hitboxes.get(id);
    if (b === undefined) return false;
    b.active = active;
    return true;
  }

  /** The objects a hitbox (or the character) touched in the last contact pass, sorted. */
  touching(id: string): readonly string[] {
    const out: string[] = [];
    for (const [a, b] of this.contacts.values()) {
      if (a === id) out.push(b);
      else if (b === id) out.push(a);
    }
    return Object.freeze(out.sort());
  }

  isCollected(id: string): boolean {
    return this.collectibles.get(id)?.collected === true;
  }

  /** Bring a collected collectible back now (false when it is not collected or not a collectible). */
  restore(id: string): boolean {
    const k = this.collectibles.get(id);
    if (k === undefined || !k.collected) return false;
    this.restoreCollectible(k);
    return true;
  }

  // ---- saves ---------------------------------------------------------------------------

  saveState(): PrimitivesSaveState {
    const out: PrimitivesSaveState = {};
    const sorted = <T>(m: Map<string, T>): [string, T][] => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (this.healths.size > 0) out.health = Object.fromEntries(sorted(this.healths).map(([id, h]) => [id, h.current]));
    const collected = sorted(this.collectibles).filter(([, k]) => k.collected);
    if (collected.length > 0) out.collected = Object.fromEntries(collected.map(([id, k]) => [id, k.timer]));
    if (this.patrols.size > 0) {
      out.patrol = Object.fromEntries(
        sorted(this.patrols).map(([id, p]) =>
          p.edges !== null
            ? [id, { p: [...p.edges.pos], d: [...p.edges.dir], w: p.edges.waiting, a: p.active }]
            : [id, { p: [...p.path!.pos], d: [0, 0, 0], w: p.path!.waiting, a: p.active, s: p.path!.segment, u: p.path!.along, r: p.path!.dir }],
        ),
      );
    }
    const off = [...sorted(this.hitboxes).filter(([, b]) => !b.active).map(([id]) => id)];
    if (off.length > 0) out.off = off;
    if (this.looks.size > 0) out.look = Object.fromEntries(sorted(this.looks).map(([id, l]) => [id, { ...l }]));
    if (this.falls.size > 0) out.fall = Object.fromEntries(sorted(this.falls).map(([id, f]) => [id, [this.host.curr.get(id)?.position[1] ?? f.start[1], f.vy]]));
    return out;
  }

  /** Why a saved `components` section cannot be restored (null: it can). */
  checkState(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'the components section is an object';
    const v = value as Record<string, unknown>;
    const isMap = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
    for (const k of Object.keys(v)) if (!['health', 'collected', 'patrol', 'off', 'look', 'fall'].includes(k)) return `unknown key "${k.slice(0, 32)}"`;
    if (v['look'] !== undefined && (!isMap(v['look']) || !Object.values(v['look']).every((l) => entityLookOf(l) !== null))) return 'look maps objects to a look override {emissive?, emissiveIntensity?, tint?}';
    if (v['health'] !== undefined && (!isMap(v['health']) || !Object.values(v['health']).every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0))) return 'health maps objects to a health ≥ 0';
    if (v['collected'] !== undefined && (!isMap(v['collected']) || !Object.values(v['collected']).every((x) => Number.isInteger(x) && (x as number) >= -1))) return 'collected maps objects to whole steps (-1: never back)';
    if (v['fall'] !== undefined && (!isMap(v['fall']) || !Object.values(v['fall']).every((x) => Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === 'number' && Number.isFinite(n))))) return 'fall maps objects to [height, fall speed]';
    if (v['off'] !== undefined && !(Array.isArray(v['off']) && v['off'].every((x) => typeof x === 'string'))) return 'off lists object ids';
    if (v['patrol'] !== undefined) {
      if (!isMap(v['patrol'])) return 'patrol maps objects to their state';
      const vec = (x: unknown): boolean => Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n));
      for (const s of Object.values(v['patrol'])) {
        if (!isMap(s) || !vec(s['p']) || !vec(s['d']) || typeof s['w'] !== 'number' || !Number.isFinite(s['w']) || typeof s['a'] !== 'boolean') return 'a patrol state is {p, d, w, a}';
        if ((s['s'] !== undefined && !Number.isInteger(s['s'])) || (s['u'] !== undefined && typeof s['u'] !== 'number') || (s['r'] !== undefined && s['r'] !== 1 && s['r'] !== -1)) return 'a waypoint patrol state has a segment, a distance and a direction';
      }
    }
    return null;
  }

  /** Restore a checked `components` section (objects not loaded now are skipped). */
  restoreState(value: PrimitivesSaveState | undefined): void {
    const v = value ?? {};
    for (const [id, cur] of Object.entries(v.health ?? {})) {
      const h = this.healths.get(id);
      if (h !== undefined) h.current = Math.min(h.max, Math.max(0, cur));
    }
    for (const k of this.collectibles.values()) {
      const t = v.collected?.[k.id];
      k.collected = t !== undefined;
      k.timer = t !== undefined ? t : -1;
      this.host.setHidden(k.id, k.collected);
    }
    for (const [id, s] of Object.entries(v.patrol ?? {})) {
      const p = this.patrols.get(id);
      if (p === undefined) continue;
      p.active = s.a;
      const pos: Vec3 = [s.p[0]!, s.p[1]!, s.p[2]!];
      if (p.edges !== null) Object.assign(p.edges, { pos, dir: [s.d[0]!, s.d[1]!, s.d[2]!], waiting: Math.max(0, Math.round(s.w)) });
      else {
        const m = p.path!;
        const segment = Math.min(Math.max(0, s.s ?? 0), m.lengths.length - 1);
        Object.assign(m, { pos, segment, along: Math.min(Math.max(0, s.u ?? 0), m.lengths[segment] ?? 0), dir: s.r === -1 ? -1 : 1, waiting: Math.max(0, s.w), done: false });
      }
      this.write(id, pos);
    }
    const off = new Set(v.off ?? []);
    for (const b of this.hitboxes.values()) b.active = !off.has(b.id);
    for (const [id, [y, vy]] of Object.entries(v.fall ?? {})) {
      const f = this.falls.get(id);
      const t = this.host.curr.get(id);
      if (f === undefined || t === undefined) continue;
      f.vy = Math.min(0, vy);
      t.position[1] = y;
      const p = this.patrols.get(id);
      if (p?.edges != null) p.edges.pos[1] = y;
    }
    this.looks.clear();
    for (const [id, l] of Object.entries(v.look ?? {})) {
      const look = entityLookOf(l);
      if (look !== null && this.host.curr.has(id) && this.looks.size < MAX_LOOK_OVERRIDES) this.looks.set(id, look);
    }
    this.looksVersion += 1;
    this.contacts = new Map();
    this.lastCentre = new Map();
  }
}

// ---- geometry (pure) ----------------------------------------------------------------

/**
 * A box (`half` about `at`, turned by `q` in 3D) against an axis-aligned box
 * (the character's): on the 2D plane both are axis-aligned rectangles (as a
 * pickup's area); in 3D the first turns with its object (a separating-axis
 * test on its three axes and the world's).
 */
function boxesOverlap(at: Vec3, half: Vec3, q: readonly number[], c: Vec3, ch: Vec3, dims: 2 | 3): boolean {
  if (dims === 2) return Math.abs(c[0] - at[0]) < half[0] + ch[0] && Math.abs(c[1] - at[1]) < half[1] + ch[1];
  const rot = (q[0] ?? 0) !== 0 || (q[1] ?? 0) !== 0 || (q[2] ?? 0) !== 0;
  if (!rot) return Math.abs(c[0] - at[0]) < half[0] + ch[0] && Math.abs(c[1] - at[1]) < half[1] + ch[1] && Math.abs(c[2] - at[2]) < half[2] + ch[2];
  // Separating axis test: the rotated box's three axes and the world's three axes (the axis-aligned box).
  const axes: Vec3[] = [rotateVec(q, [1, 0, 0]), rotateVec(q, [0, 1, 0]), rotateVec(q, [0, 0, 1])];
  const d: Vec3 = [c[0] - at[0], c[1] - at[1], c[2] - at[2]];
  const test = (n: Vec3): boolean => {
    const ra = half[0] * Math.abs(dot(axes[0]!, n)) + half[1] * Math.abs(dot(axes[1]!, n)) + half[2] * Math.abs(dot(axes[2]!, n));
    const rb = ch[0] * Math.abs(n[0]) + ch[1] * Math.abs(n[1]) + ch[2] * Math.abs(n[2]);
    return Math.abs(dot(d, n)) < ra + rb;
  };
  return axes.every(test) && test([1, 0, 0]) && test([0, 1, 0]) && test([0, 0, 1]);
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function rotateVec(q: readonly number[], p: Vec3): Vec3 {
  const qx = q[0] ?? 0;
  const qy = q[1] ?? 0;
  const qz = q[2] ?? 0;
  const qw = q[3] ?? 1;
  const tx = 2 * (qy * p[2] - qz * p[1]);
  const ty = 2 * (qz * p[0] - qx * p[2]);
  const tz = 2 * (qx * p[1] - qy * p[0]);
  return [p[0] + qw * tx + (qy * tz - qz * ty), p[1] + qw * ty + (qz * tx - qx * tz), p[2] + qw * tz + (qx * ty - qy * tx)];
}

/**
 * The contact normal from `a` toward `b` (unit), or null when they do not
 * touch (a touch is not a contact). Boxes are axis-aligned; on the 2D plane
 * z is ignored. Two boxes, or a sphere whose centre is inside a box: the axis
 * along which they were still apart at their previous centres (the side the
 * contact came from; among several, the shallowest now), else the shallowest
 * overlap. A sphere: along the line between the closest points.
 */
export function contactNormal(a: { c: Vec3; half: Vec3 | null; r: number }, b: { c: Vec3; half: Vec3 | null; r: number }, pa: Vec3 | undefined, pb: Vec3 | undefined, dims: 2 | 3): Vec3 | null {
  if (a.half === null && b.half === null) {
    const d: Vec3 = [b.c[0] - a.c[0], b.c[1] - a.c[1], dims === 3 ? b.c[2] - a.c[2] : 0];
    const l = Math.hypot(d[0], d[1], d[2]);
    if (!(l < a.r + b.r)) return null;
    return l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : [0, 1, 0];
  }
  if (a.half !== null && b.half !== null) return boxNormal(a.c, a.half, b.c, b.half, pa, pb, dims);
  // A box and a sphere: from the box's closest point to the sphere's centre.
  const box = a.half !== null ? a : b;
  const ball = a.half !== null ? b : a;
  const h = box.half!;
  const q: Vec3 = [0, 1, 2].map((i) => (i === 2 && dims === 2 ? ball.c[2] : Math.min(box.c[i]! + h[i]!, Math.max(box.c[i]! - h[i]!, ball.c[i]!)))) as Vec3;
  const d: Vec3 = [ball.c[0] - q[0], ball.c[1] - q[1], dims === 3 ? ball.c[2] - q[2] : 0];
  const l = Math.hypot(d[0], d[1], d[2]);
  if (!(l < ball.r)) return null;
  let n: Vec3;
  if (l > 0) n = [d[0] / l, d[1] / l, d[2] / l];
  else {
    const r = ball.r;
    const nn = boxNormal(box.c, h, ball.c, [r, r, r], box === a ? pa : pb, box === a ? pb : pa, dims);
    if (nn === null) return null;
    n = nn;
  }
  // `n` points from the box toward the sphere.
  return box === a ? n : [-n[0], -n[1], -n[2]];
}

function boxNormal(ca: Vec3, ha: Vec3, cb: Vec3, hb: Vec3, pa: Vec3 | undefined, pb: Vec3 | undefined, dims: 2 | 3): Vec3 | null {
  const pen: number[] = [];
  for (let k = 0; k < dims; k++) {
    const p = ha[k]! + hb[k]! - Math.abs(cb[k]! - ca[k]!);
    if (!(p > 0)) return null;
    pen.push(p);
  }
  let axis = -1;
  if (pa !== undefined && pb !== undefined) {
    for (let k = 0; k < dims; k++) {
      const apart = ha[k]! + hb[k]! - Math.abs(pb[k]! - pa[k]!) <= 0;
      if (apart && (axis < 0 || pen[k]! < pen[axis]!)) axis = k;
    }
  }
  if (axis < 0) for (let k = 0; k < dims; k++) if (axis < 0 || pen[k]! < pen[axis]!) axis = k;
  const n: Vec3 = [0, 0, 0];
  n[axis] = cb[axis]! >= ca[axis]! ? 1 : -1;
  return n;
}
