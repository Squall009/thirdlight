/**
 * Phase 9.9: the gameplay building blocks, run by the runtime every fixed
 * step (deterministic; a replay plays the same):
 *
 * - movers (and doors: movers that start on a signal) follow their waypoints;
 *   a mover with a collider is a kinematic platform, and the player standing
 *   on it moves with it;
 * - triggers and switches emit signals (seen by movers and scripts in the
 *   next step);
 * - pickups add to counters (coins, gems, keys, lives, custom) or heal, and
 *   disappear; `respawn: "death"` ones come back when the player respawns;
 * - enemies walk (between two offsets, or until a ledge or a wall), hurt the
 *   player on contact, and are stomped from above (the player bounces);
 * - the player's `health` takes damage from enemies and damaging hazards,
 *   with a short invulnerability; at 0 (or without a health component) the
 *   player dies as before.
 *
 * Boxes (triggers, switches, pickups) are centred on their entity; an enemy's
 * box stands on its entity's position (its feet).
 */
import type { ActionFrame } from './actions';
import type { PhysicsPort, Vec2 } from './ports';
import type { EntityV3 } from '@thirdlight/project-model';
import type { PlayerCapsule, TransformState } from './types';
import { capsuleHalfTotal } from './scene-set';

const STOMP_BOUNCE = 9;
const HIT_BOUNCE = 5;
const DEFAULT_INVULNERABLE = 1;
/** A knockback pushes for this long, easing out. */
const KNOCKBACK_SECONDS = 0.25;
/** A defeated enemy squashes (feet anchored) for this long, then disappears. */
const DEFEAT_SECONDS = 0.3;
/** A chasing enemy notices a player within this height of its feet. */
const CHASE_HEIGHT = 2;

type Vec3 = [number, number, number];

interface Mover {
  id: string;
  points: Vec3[];
  lengths: number[];
  speed: number;
  mode: 'loop' | 'pingpong' | 'once';
  wait: number;
  smooth: boolean;
  startOn: string | null;
  // state
  started: boolean;
  segment: number;
  along: number;
  dir: 1 | -1;
  waiting: number;
  done: boolean;
  pos: Vec3;
  /** The box collider's half extents (a mover without one never pushes). */
  half: Vec2 | null;
}

interface Box {
  id: string;
  half: Vec2;
}

interface Trigger extends Box {
  signal: string;
  exitSignal: string | null;
  once: boolean;
  inside: boolean;
  spent: boolean;
}

interface Switch extends Box {
  signal: string;
  mode: 'interact' | 'stand';
  once: boolean;
  inside: boolean;
  spent: boolean;
}

interface Pickup extends Box {
  kind: string;
  value: number;
  counter: string | null;
  respawnOnDeath: boolean;
  cue: string | null;
  taken: boolean;
}

interface Enemy {
  id: string;
  start: Vec3;
  x: number;
  dir: 1 | -1;
  patrol: 'points' | 'edges';
  range: [number, number];
  speed: number;
  half: Vec2;
  contactDamage: number;
  stompable: boolean;
  maxHealth: number;
  health: number;
  defeated: boolean;
  chase: number;
  /** Steps left of the defeat squash (0: none running). */
  squash: number;
  /** The authored Y scale (the squash scales it). */
  scaleY: number;
}

export interface BlocksHost {
  readonly hz: number;
  readonly physics: PhysicsPort | undefined;
  readonly curr: Map<string, TransformState>;
  readonly playerId: string;
  /**
   * Phase 14.0: the player's capsule. The blocks test its bounding box: half
   * width `radius`, half height `halfHeight + radius`, centred at the
   * player's position plus `offset`.
   */
  readonly playerCapsule: PlayerCapsule;
  /** The player's committed position (the entity origin), or null. */
  player(): Vec2 | null;
  /** The player's motion in the last step (m per step). */
  playerDelta(): Vec2;
  /** The collider entity the player stands on, or null. */
  groundEntityId(): string | null;
  /** Kill the player (the session's respawn), only while playing. */
  kill(): void;
  /** Play an audio asset through the sfx bus (after the step). */
  playCue?(assetId: string): void;
  /** The animator of an entity (or of one of its children), for parameters. */
  animator(entityId: string): { set(name: string, v: number | boolean): boolean; trigger(name: string): boolean } | null;
}

/** A box collider's half extents, or null for another shape. */
function boxHalf(col: Record<string, unknown> | undefined): Vec2 | null {
  const shape = col?.['shape'] as { type?: string; hx?: number; hy?: number } | undefined;
  return shape?.type === 'box' && typeof shape.hx === 'number' && typeof shape.hy === 'number' ? { x: shape.hx, y: shape.hy } : null;
}

/** The gap kept between a pushing mover and the player (the controller's skin plus a margin). */
const PUSH_SKIN = 0.011;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class GameplayBlocks {
  private readonly movers = new Map<string, Mover>();
  private readonly triggers = new Map<string, Trigger>();
  private readonly switches = new Map<string, Switch>();
  private readonly pickups = new Map<string, Pickup>();
  private readonly enemies = new Map<string, Enemy>();
  private readonly oneWay = new Set<string>();
  private readonly hazardDamage = new Map<string, number>();
  private readonly parents = new Map<string, string>();
  private readonly hidden = new Set<string>();
  /** Phase 9.13: models that face where their parent goes (yaw about +Y, radians). */
  private readonly facers = new Map<string, { right: number; left: number; rate: number; yaw: number; lastX: number | null }>();
  private readonly counters = new Map<string, number>();
  private health: { max: number; start: number; current: number; invulnerable: number; invulnerableUntil: number; knockback: number } | null = null;
  /** A hit's push: m/s along X, steps left. */
  private knock = { v: 0, steps: 0, total: 0 };
  private signalsNow = new Set<string>();
  private signalsPrev = new Set<string>();
  private pendingBounce: number | null = null;
  private carry: Vec2 = { x: 0, y: 0 };
  private step = 0;
  /** Phase 14.0: the player capsule's box — centre offset from the player's position, half width, half height. */
  private readonly pc: { ox: number; oy: number; hw: number; hh: number };

  constructor(
    private readonly host: BlocksHost,
    entities: readonly EntityV3[],
  ) {
    const c = host.playerCapsule;
    this.pc = { ox: c.offset.x, oy: c.offset.y, hw: c.radius, hh: capsuleHalfTotal(c) };
    this.add(entities);
  }

  /** Entities of a loaded scene. */
  add(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      if (e.parentId !== undefined) this.parents.set(e.id, e.parentId);
      const c = e.components as unknown as Record<string, Record<string, unknown> | undefined>;
      const p = e.components.transform.position;
      const zone = c['gameZone'];
      if (zone !== undefined && zone['role'] === 'hazard' && typeof zone['damage'] === 'number') this.hazardDamage.set(e.id, zone['damage'] as number);
      const col = c['collider'];
      if (col !== undefined && col['oneWay'] === true) this.oneWay.add(e.id);
      const face = c['faceMovement'];
      if (face !== undefined && e.parentId !== undefined) {
        const right = (num(face['yawRight'], 90) * Math.PI) / 180;
        const left = (num(face['yawLeft'], -90) * Math.PI) / 180;
        const turn = num(face['turnSeconds'], 0.12);
        const q = e.components.transform.rotation;
        this.facers.set(e.id, { right, left, rate: turn > 0 ? Math.abs(right - left) / turn : Infinity, yaw: 2 * Math.atan2(q[1] ?? 0, q[3] ?? 1), lastX: null });
      }
      const m = c['mover'];
      if (m !== undefined) {
        const base: Vec3 = [p[0], p[1], p[2]];
        const points: Vec3[] = [base, ...(m['waypoints'] as number[][]).map((w) => [base[0] + (w[0] ?? 0), base[1] + (w[1] ?? 0), base[2] + (w[2] ?? 0)] as Vec3)];
        const mode = m['mode'] as Mover['mode'];
        const segs = mode === 'loop' ? points.length : points.length - 1;
        const lengths = Array.from({ length: segs }, (_, i) => {
          const a = points[i]!;
          const b = points[(i + 1) % points.length]!;
          return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        });
        this.movers.set(e.id, {
          id: e.id,
          points,
          lengths,
          speed: num(m['speed'], 1),
          mode,
          wait: num(m['wait'], 0),
          smooth: m['easing'] === 'smooth',
          startOn: typeof m['startOn'] === 'string' ? (m['startOn'] as string) : null,
          started: typeof m['startOn'] !== 'string',
          segment: 0,
          along: 0,
          dir: 1,
          waiting: 0,
          done: false,
          pos: [...base],
          half: boxHalf(col),
        });
      }
      const t = c['trigger'];
      if (t !== undefined) {
        const size = t['size'] as number[];
        this.triggers.set(e.id, { id: e.id, half: { x: size[0]! / 2, y: size[1]! / 2 }, signal: String(t['signal']), exitSignal: typeof t['exitSignal'] === 'string' ? (t['exitSignal'] as string) : null, once: t['once'] === true, inside: false, spent: false });
      }
      const s = c['switch'];
      if (s !== undefined) {
        const size = s['size'] as number[];
        this.switches.set(e.id, { id: e.id, half: { x: size[0]! / 2, y: size[1]! / 2 }, signal: String(s['signal']), mode: s['mode'] as Switch['mode'], once: s['once'] === true, inside: false, spent: false });
      }
      const pk = c['pickup'];
      if (pk !== undefined) {
        const size = (pk['size'] as number[] | undefined) ?? [0.8, 0.8];
        this.pickups.set(e.id, {
          id: e.id,
          half: { x: size[0]! / 2, y: size[1]! / 2 },
          kind: String(pk['kind']),
          value: num(pk['value'], 1),
          counter: typeof pk['counter'] === 'string' ? (pk['counter'] as string) : null,
          respawnOnDeath: pk['respawn'] === 'death',
          cue: typeof pk['cue'] === 'string' ? (pk['cue'] as string) : null,
          taken: false,
        });
      }
      const en = c['enemy'];
      if (en !== undefined) {
        const size = en['size'] as number[];
        const range = (en['range'] as number[] | undefined) ?? [0, 0];
        const health = num(en['health'], 1);
        this.enemies.set(e.id, {
          id: e.id,
          start: [p[0], p[1], p[2]],
          x: p[0],
          dir: 1,
          patrol: en['patrol'] as Enemy['patrol'],
          range: [p[0] + range[0]!, p[0] + range[1]!],
          speed: num(en['speed'], 1),
          half: { x: size[0]! / 2, y: size[1]! / 2 },
          contactDamage: num(en['contactDamage'], 1),
          stompable: en['stompable'] === true,
          maxHealth: health,
          health,
          defeated: false,
          chase: num(en['chase'], 0),
          squash: 0,
          scaleY: e.components.transform.scale[1] ?? 1,
        });
      }
      const h = c['health'];
      if (h !== undefined && e.id === this.host.playerId) {
        const max = num(h['max'], 3);
        const start = Math.min(max, num(h['start'], max));
        this.health = { max, start, current: start, invulnerable: num(h['invulnerableSeconds'], DEFAULT_INVULNERABLE), invulnerableUntil: -1, knockback: num(h['knockback'], 0) };
      }
    }
  }

  /** Entities of an unloaded scene. */
  remove(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.movers.delete(id);
      this.triggers.delete(id);
      this.switches.delete(id);
      this.pickups.delete(id);
      this.enemies.delete(id);
      this.oneWay.delete(id);
      this.hazardDamage.delete(id);
      this.hidden.delete(id);
      this.parents.delete(id);
      this.facers.delete(id);
    }
  }

  /** A new run (start/replay): everything back as authored. */
  resetRun(): void {
    for (const m of this.movers.values()) {
      Object.assign(m, { started: m.startOn === null, segment: 0, along: 0, dir: 1, waiting: 0, done: false, pos: [...m.points[0]!] });
      this.writeTransform(m.id, m.pos);
    }
    for (const t of this.triggers.values()) Object.assign(t, { inside: false, spent: false });
    for (const s of this.switches.values()) Object.assign(s, { inside: false, spent: false });
    for (const p of this.pickups.values()) p.taken = false;
    for (const e of this.enemies.values()) {
      this.writeSquash(e.id, e.scaleY);
      Object.assign(e, { x: e.start[0], dir: 1, health: e.maxHealth, defeated: false, squash: 0 });
      this.writeTransform(e.id, e.start);
    }
    this.hidden.clear();
    this.counters.clear();
    if (this.health !== null) Object.assign(this.health, { current: this.health.start, invulnerableUntil: -1 });
    this.knock = { v: 0, steps: 0, total: 0 };
    this.signalsNow.clear();
    this.signalsPrev.clear();
    this.pendingBounce = null;
    this.carry = { x: 0, y: 0 };
  }

  /** The player respawned after a death: health back to full, some pickups back. */
  onRespawn(): void {
    if (this.health !== null) Object.assign(this.health, { current: this.health.start, invulnerableUntil: -1 });
    this.knock = { v: 0, steps: 0, total: 0 };
    for (const p of this.pickups.values()) {
      if (p.taken && p.respawnOnDeath) {
        p.taken = false;
        this.hidden.delete(p.id);
      }
    }
    this.pendingBounce = null;
  }

  // ---- queries ------------------------------------------------------------------

  /** A script shows or hides an entity (a new run shows everything again). */
  setVisible(entityId: string, visible: boolean): void {
    if (visible) this.hidden.delete(entityId);
    else this.hidden.add(entityId);
  }

  hiddenEntities(): ReadonlySet<string> {
    return this.hidden;
  }

  countersView(): Record<string, number> {
    return Object.fromEntries([...this.counters].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  addCounter(name: string, delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  /** Phase 9.11: what a save keeps of the run (collected pickups, defeated enemies, counters, health). */
  snapshotRun(): { counters: Record<string, number>; collected: string[]; defeated: string[]; health: number | null } {
    return {
      counters: this.countersView(),
      collected: [...this.pickups.values()].filter((p) => p.taken).map((p) => p.id).sort(),
      defeated: [...this.enemies.values()].filter((e) => e.defeated).map((e) => e.id).sort(),
      health: this.health?.current ?? null,
    };
  }

  /** Phase 9.11: a loaded save's run (after the fresh run began): pickups stay collected, enemies defeated. */
  restoreRun(run: { counters?: Record<string, number>; collected?: readonly string[]; defeated?: readonly string[]; health?: number | null }): void {
    for (const [k, v] of Object.entries(run.counters ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k) && Number.isFinite(v)) this.counters.set(k, v);
    for (const id of run.collected ?? []) {
      const p = this.pickups.get(id);
      if (p === undefined) continue;
      p.taken = true;
      this.hidden.add(id);
    }
    for (const id of run.defeated ?? []) {
      const e = this.enemies.get(id);
      if (e === undefined) continue;
      e.defeated = true;
      this.hidden.add(id);
    }
    if (this.health !== null && typeof run.health === 'number' && run.health >= 1) this.health.current = Math.min(this.health.max, Math.round(run.health));
  }

  healthView(): { current: number; max: number } | null {
    return this.health === null ? null : { current: this.health.current, max: this.health.max };
  }

  /** A signal emitted in the previous step (what consumers see this step). */
  signaled(name: string): boolean {
    return this.signalsPrev.has(name);
  }

  emit(name: string): void {
    this.signalsNow.add(name);
  }

  /** The upward speed to give the player this step (a stomp or a hit), once. */
  takeBounce(): number | null {
    const b = this.pendingBounce;
    this.pendingBounce = null;
    return b;
  }

  /** The carried platform's motion this step (added to the player's staged move). */
  carryDelta(): Vec2 {
    return this.carry;
  }

  isOneWay(entityId: string | null): boolean {
    return entityId !== null && this.oneWay.has(entityId);
  }

  // ---- the step --------------------------------------------------------------------

  /** Start of a step: signals turn over, movers advance (their colliders are posed for physics). */
  beforeStep(stepIndex: number): void {
    this.step = stepIndex;
    this.signalsPrev = this.signalsNow;
    this.signalsNow = new Set();
    const dt = 1 / this.host.hz;
    const ground = this.host.groundEntityId();
    this.carry = { x: 0, y: 0 };
    const poses: { entityId: string; position: Vec2; rotationZ: number }[] = [];
    // A mover that moves into the player (one it is not carrying) pushes the
    // player out along the shallower axis this step — a rising lift scoops up
    // a player at its edge, a sliding block shoves — so the character never
    // ends up inside a kinematic body (the controller would then have to
    // correct beyond its contracted bound).
    const player = this.host.player();
    const pushed = { x: 0, y: 0 };
    // Phase 14.7: a mover moving mostly upward pushes a player beside or
    // under it (the capsule's centre below the mover's top) out sideways, away
    // from the mover, never up — a rising gate or pillar does not lift a
    // player pressing against it; only a player above it is scooped up.
    const push = (m: Mover, before: Vec3): void => {
      if (player === null || m.half === null) return;
      const px = player.x + this.pc.ox + pushed.x;
      const py = player.y + this.pc.oy + pushed.y;
      const ox = m.half.x + this.pc.hw + PUSH_SKIN - Math.abs(px - m.pos[0]);
      const oy = m.half.y + this.pc.hh + PUSH_SKIN - Math.abs(py - m.pos[1]);
      if (ox <= 0 || oy <= 0) return;
      const dx = m.pos[0] - before[0];
      const dy = m.pos[1] - before[1];
      const sideways = dy > 0 && dy >= Math.abs(dx) && py < m.pos[1] + m.half.y;
      if (oy <= ox && !sideways) pushed.y += Math.min(0.5, oy) * (py >= m.pos[1] ? 1 : -1);
      else pushed.x += Math.min(0.5, ox) * (px >= m.pos[0] ? 1 : -1);
    };
    for (const m of this.movers.values()) {
      const before: Vec3 = [...m.pos];
      if (!m.started && m.startOn !== null && this.signalsPrev.has(m.startOn)) m.started = true;
      if (m.started && !m.done) this.advance(m, dt);
      this.writeTransform(m.id, m.pos);
      poses.push({ entityId: m.id, position: { x: m.pos[0], y: m.pos[1] }, rotationZ: 0 });
      if (ground === m.id) this.carry = { x: m.pos[0] - before[0], y: m.pos[1] - before[1] };
      else if (m.pos[0] !== before[0] || m.pos[1] !== before[1]) push(m, before);
    }
    // A hit's knockback: a horizontal push that eases out over KNOCKBACK_SECONDS.
    if (this.knock.steps > 0) {
      pushed.x += (this.knock.v * dt * this.knock.steps) / this.knock.total;
      this.knock.steps -= 1;
    }
    this.carry = { x: this.carry.x + pushed.x, y: this.carry.y + pushed.y };
    if (poses.length > 0) this.host.physics?.setKinematicPositions?.(poses);
  }

  private advance(m: Mover, dt: number): void {
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
        m.segment = (m.segment + 1) % m.lengths.length;
        m.along = 0;
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
    const len = m.lengths[m.segment] ?? 0;
    const a = m.points[m.segment]!;
    const b = m.points[(m.segment + 1) % m.points.length]!;
    let u = len > 0 ? m.along / len : 0;
    if (m.smooth) u = u * u * (3 - 2 * u);
    m.pos = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }

  /** After physics: overlaps with the player, enemies, pickups, switches, damage. */
  afterPhysics(frame: ActionFrame, playing: boolean): void {
    const dt = 1 / this.host.hz;
    this.moveEnemies(dt);
    this.turnFacers(dt);
    const player = this.host.player();
    if (player === null || !playing) return;
    const overlaps = (id: string, half: Vec2, feetAnchored = false): boolean => {
      const at = this.worldOf(id);
      if (at === null) return false;
      const cy = feetAnchored ? at[1] + half.y : at[1];
      return Math.abs(player.x + this.pc.ox - at[0]) < half.x + this.pc.hw && Math.abs(player.y + this.pc.oy - cy) < half.y + this.pc.hh;
    };
    for (const t of this.triggers.values()) {
      const inside = overlaps(t.id, t.half);
      if (inside && !t.inside && !t.spent) {
        this.emit(t.signal);
        if (t.once) t.spent = true;
      }
      if (!inside && t.inside && t.exitSignal !== null) this.emit(t.exitSignal);
      t.inside = inside;
    }
    const interact = frame.actions?.['interact']?.p === 'pressed';
    for (const s of this.switches.values()) {
      const inside = overlaps(s.id, s.half);
      const fire = s.mode === 'stand' ? inside && !s.inside : inside && interact;
      if (fire && !s.spent) {
        this.emit(s.signal);
        if (s.once) s.spent = true;
      }
      s.inside = inside;
    }
    for (const p of this.pickups.values()) {
      if (p.taken || !overlaps(p.id, p.half)) continue;
      p.taken = true;
      this.hidden.add(p.id);
      if (p.cue !== null) this.host.playCue?.(p.cue);
      if (p.kind === 'heart') {
        if (this.health !== null) this.health.current = Math.min(this.health.max, this.health.current + p.value);
      } else {
        const name = p.kind === 'custom' ? (p.counter ?? 'custom') : p.kind === 'life' ? 'lives' : `${p.kind}s`;
        this.addCounter(name, p.value);
      }
    }
    const delta = this.host.playerDelta();
    for (const e of this.enemies.values()) {
      if (e.defeated || !overlaps(e.id, e.half, true)) continue;
      const at = this.worldOf(e.id)!;
      const top = at[1] + 2 * e.half.y;
      const feetBefore = player.y + this.pc.oy - delta.y - this.pc.hh;
      if (e.stompable && delta.y < 0 && feetBefore >= top - 0.2) {
        e.health -= 1;
        this.pendingBounce = STOMP_BOUNCE;
        const anim = this.host.animator(e.id);
        anim?.trigger('hurt');
        if (e.health <= 0) {
          e.defeated = true;
          e.squash = Math.max(1, Math.round(DEFEAT_SECONDS * this.host.hz));
          anim?.set('defeated', true);
          this.host.animator(e.id)?.set('attacking', false);
          this.addCounter('defeated', 1);
        }
      } else if (e.contactDamage > 0) {
        this.damage(e.contactDamage, at[0]);
      }
    }
  }

  private moveEnemies(dt: number): void {
    const player = this.host.player();
    for (const e of this.enemies.values()) {
      if (e.defeated) {
        // The defeat: squash toward the feet, then gone.
        if (e.squash > 0) {
          e.squash -= 1;
          const total = Math.max(1, Math.round(DEFEAT_SECONDS * this.host.hz));
          this.writeSquash(e.id, e.scaleY * (0.15 + (0.85 * e.squash) / total));
          if (e.squash === 0) this.hidden.add(e.id);
        }
        continue;
      }
      // Chase: turn toward a player in range (the patrol limits below still hold).
      let chasing = false;
      if (e.chase > 0 && player !== null) {
        const dx = player.x + this.pc.ox - e.x;
        const feet = player.y + this.pc.oy - this.pc.hh;
        if (Math.abs(dx) <= e.chase && Math.abs(feet - e.start[1]) <= CHASE_HEIGHT && Math.abs(dx) > 0.05) {
          e.dir = dx > 0 ? 1 : -1;
          chasing = true;
        }
      }
      this.host.animator(e.id)?.set('attacking', chasing);
      const step = e.speed * dt * e.dir;
      let next = e.x + step;
      if (e.patrol === 'points') {
        if (next > e.range[1]) {
          next = e.range[1];
          e.dir = -1;
        } else if (next < e.range[0]) {
          next = e.range[0];
          e.dir = 1;
        }
      } else if (this.host.physics?.raycast !== undefined) {
        const y = e.start[1];
        const front = e.x + e.dir * e.half.x;
        const wall = this.host.physics.raycast({ x: e.x, y: y + e.half.y }, { x: e.dir, y: 0 }, e.half.x + Math.abs(step) + 0.05);
        const floor = this.host.physics.raycast({ x: front + e.dir * 0.05, y: y + 0.1 }, { x: 0, y: -1 }, 0.4);
        if (wall !== null || floor === null) {
          e.dir = e.dir === 1 ? -1 : 1;
          next = e.x;
        }
      }
      e.x = next;
      this.writeTransform(e.id, [e.x, e.start[1], e.start[2]]);
      this.host.animator(e.id)?.set('speed', e.speed);
    }
  }

  /** Damage the player (from `fromX`: a knockback pushes away from it); without a health component any damage kills. */
  damage(amount: number, fromX?: number): 'alive' | 'dead' {
    if (amount <= 0) return 'alive';
    if (this.health === null) {
      this.host.kill();
      return 'dead';
    }
    if (this.step < this.health.invulnerableUntil) return 'alive';
    this.health.current = Math.max(0, this.health.current - amount);
    this.health.invulnerableUntil = this.step + Math.round(this.health.invulnerable * this.host.hz);
    this.host.animator(this.host.playerId)?.trigger('hurt');
    if (this.health.current === 0) {
      this.host.kill();
      return 'dead';
    }
    this.pendingBounce = HIT_BOUNCE;
    const player = this.host.player();
    if (this.health.knockback > 0 && fromX !== undefined && player !== null) {
      const total = Math.max(1, Math.round(KNOCKBACK_SECONDS * this.host.hz));
      // Twice the speed at the start, easing to zero: the mean is `knockback`.
      this.knock = { v: 2 * this.health.knockback * (player.x >= fromX ? 1 : -1), steps: total, total };
    }
    return 'alive';
  }

  /**
   * A hazard zone touched: with `damage` (and a player health) it hurts —
   * 'handled' (the player may still die of it); else 'kill' (the session's
   * plain respawn, with the zone).
   */
  hazard(zoneId: string | undefined): 'handled' | 'kill' {
    const damage = zoneId !== undefined ? this.hazardDamage.get(zoneId) : undefined;
    if (damage === undefined || damage <= 0 || this.health === null) return 'kill';
    this.damage(damage);
    return 'handled';
  }

  private writeSquash(id: string, sy: number): void {
    const t = this.host.curr.get(id);
    if (t === undefined) return;
    t.scale[1] = sy;
  }

  private writeTransform(id: string, pos: readonly number[]): void {
    const t = this.host.curr.get(id);
    if (t === undefined) return;
    t.position[0] = pos[0]!;
    t.position[1] = pos[1]!;
    t.position[2] = pos[2]!;
  }

  /** World position by summing the parent chain (the runtime's hierarchy has no rotation here). */
  /** Phase 9.13: each facing model turns toward its parent's horizontal motion (it keeps its yaw while the parent stands). */
  private turnFacers(dt: number): void {
    for (const [id, f] of this.facers) {
      const parent = this.parents.get(id);
      const at = parent !== undefined ? this.worldOf(parent) : null;
      if (at === null) continue;
      const dx = f.lastX === null ? 0 : at[0] - f.lastX;
      f.lastX = at[0];
      const target = dx > 1e-4 ? f.right : dx < -1e-4 ? f.left : null;
      if (target !== null && target !== f.yaw) {
        const step = f.rate * dt;
        f.yaw = Math.abs(target - f.yaw) <= step ? target : f.yaw + Math.sign(target - f.yaw) * step;
      }
      const t = this.host.curr.get(id);
      if (t !== undefined) {
        t.rotation[0] = 0;
        t.rotation[1] = Math.sin(f.yaw / 2);
        t.rotation[2] = 0;
        t.rotation[3] = Math.cos(f.yaw / 2);
      }
    }
  }

  private worldOf(id: string): Vec3 | null {
    const t = this.host.curr.get(id);
    if (t === undefined) return null;
    const out: Vec3 = [t.position[0], t.position[1], t.position[2]];
    let parent = this.parents.get(id);
    for (let guard = 0; parent !== undefined && guard < 64; guard++) {
      const pt = this.host.curr.get(parent);
      if (pt === undefined) break;
      out[0] += pt.position[0];
      out[1] += pt.position[1];
      out[2] += pt.position[2];
      parent = this.parents.get(parent);
    }
    return out;
  }
}
