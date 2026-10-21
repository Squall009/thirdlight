/**
 * The character director — what a cutscene or a script asks of a player
 * character beyond one step's input: put it somewhere (`place`), have its
 * own controller walk it to a mark (`walkTo`), turn it, switch it off and
 * on (`setEnabled`), and hold the player's input while a cutscene owns it.
 *
 * Everything reaches the character through its intent channels, the ones a
 * script's `character_place`, `character_move`, `control_move`,
 * `control_jump` and `character_enable` fill: the director writes them once
 * per step, right after the intent phase (so it has the last word over a
 * script's input of that step) and before the placement and the controller
 * run. A walk is the controller's own move input toward the mark, so
 * acceleration, collisions, slopes, gravity and the animator's automatic
 * speed behave as with the player's input; it slows down as it nears the
 * mark (no sliding past it) and arrives within a radius. A walk that gets no
 * closer for a while is blocked: it ends there, with a log line.
 *
 * `ctx.character` and the timeline's character track both go through this
 * one path. Every value comes from the simulation (the step's transforms,
 * the controllers' tuning), so page, worker and replays agree.
 *
 * What a cutscene leaves behind when it ends is decided in `release` alone:
 * its holds end however it ends; a stop also switches each character it
 * switched off or on back to what it was before (so a stopped cutscene
 * never leaves the player parked), and stops its walks where they are; a
 * finish or a skip leaves its last keys' state. A run restart forgets
 * everything (`reset`; the controllers start switched on again), and a
 * loaded save ends every walk, placement and turn (`saveLoaded`), since it
 * puts the characters where it says.
 */
import { character3DSettingsOf, controllerTuningOf, type EntityV3 } from '@thirdlight/project-model';

import { actionAxis, type ActionFrame } from './actions';
import { CHARACTER_IMPULSE_MAX } from './character-placement';
import { quantizeIntentMove, validateIntentShape, validateIntentValue } from './intents';
import type { MutableControllerChannels } from './mutable-intents';
import type { GameplaySettings, TransformState } from './types';

/** The writer name the director's channel writes carry (what the intent view's writers show). */
export const CHARACTER_DIRECTOR_ID = 'thirdlight.runtime:character';

/** How near the mark (m, on the ground plane; on the 2D plane along x) a walk has arrived, unless it says otherwise. */
export const WALK_ARRIVE_RADIUS = 0.1;

/** A walk that gets no closer than this (m) … */
const WALK_PROGRESS_MIN = 0.01;
/** … for this long (seconds) is blocked. */
const WALK_BLOCKED_SECONDS = 1;

/** Ended walks remembered for `walkState` (the newest). */
const WALK_ENDED_KEPT = 64;

export type CharacterWalkState = 'walking' | 'arrived' | 'blocked' | 'stopped';

/** How a cutscene's hold on its characters ends: its walks carry on, land on their marks, or stop where they are. */
export type CharacterReleaseKind = 'finished' | 'skipped' | 'stopped';

/** What the director reads from and asks of the runtime. */
export interface CharacterDirectorHost {
  is3D(): boolean;
  hz(): number;
  settings(): GameplaySettings;
  /** The controller a call names (absent or empty: the first); undefined: not a player controller. */
  resolve(id: string | undefined): string | undefined;
  /** Whether a scene is loading or asked for in this step (it may bring a player character the game has not seen yet). */
  loading(): boolean;
  /** The move action a controller reads (undefined: not a controller). */
  moveAction(id: string): string | undefined;
  /** An object's transform this step. */
  transform(id: string): TransformState | undefined;
  /** A controller's document (its tuning). */
  entityDocument(id: string): EntityV3 | undefined;
  /** A controller's intent channels of this step. */
  channels(id: string): MutableControllerChannels;
  /** The facing (degrees; undefined: it keeps its way) the controller's placement of this step turns it to. */
  placeFacing(id: string, degrees: number | undefined): void;
  /** Turn a controller to a yaw (radians about +Y) without placing it. */
  turn(id: string, yaw: number): void;
  /** Whether a controller can be placed (on the 2D plane: a physics port with placements). */
  canPlace(id: string): boolean;
  addImpulse(id: string, v: readonly [number, number, number]): void;
  intentsChanged(): void;
  warn(message: string): void;
}

/** What the timeline's character track asks (owners name the play that asked). */
export interface TimelineCharacterPort {
  /** Whether an object is a player character. */
  has(id: string): boolean;
  place(id: string, position: readonly number[], facing: number | undefined): boolean;
  walk(id: string, position: readonly number[], options: { run?: boolean; facing?: number }, owner: string): boolean;
  /** Turn it (degrees about +Y): at its controller's turn speed, or at once. */
  turn(id: string, facing: number, instant: boolean): boolean;
  /** Switch its controller off or on (`owner`'s stop switches it back to what it was). */
  setEnabled(id: string, enabled: boolean, owner: string): boolean;
  /** The player's input does not move it while `owner` holds it. */
  hold(id: string, owner: string): void;
  /** `owner`'s holds end; its walks carry on (finished), land on their marks (skipped) or stop (stopped, which also switches its characters back). */
  release(owner: string, how: CharacterReleaseKind): void;
}

interface Walk {
  readonly handle: number;
  readonly target: readonly [number, number, number];
  readonly run: boolean;
  readonly radius: number;
  /** Degrees to face on arrival (null: as it walked in). */
  readonly facing: number | null;
  readonly owner: string;
  best: number;
  stale: number;
}

interface Directed {
  walk: Walk | null;
  /** A placement for this step's channels (and its facing in degrees, null: it keeps its way). */
  place: readonly [number, number, number] | null;
  placeFacing: number | null;
  /** A turn under way (radians), whether it turns at once, and (2D) where the character was when it last turned. */
  facing: { yaw: number; instant: boolean; at?: number } | null;
  enabled: boolean | null;
  readonly holds: Set<string>;
}

/** The owner name of a script's walks. */
const SCRIPT_OWNER = 'script';

const yawOf = (q: readonly number[]): number => 2 * Math.atan2(q[1] ?? 0, q[3] ?? 1);
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const radians = (degrees: number): number => (degrees * Math.PI) / 180;

export class CharacterDirector {
  private readonly directed = new Map<string, Directed>();
  private serial = 0;
  private readonly ended = new Map<number, CharacterWalkState>();
  /** Each controller's switch as last applied through its channel (absent: on, as a controller starts). */
  private readonly switchedOn = new Map<string, boolean>();
  /** Per owner (a playing cutscene), each character's switch before the owner first switched it. */
  private readonly switchedBefore = new Map<string, Map<string, boolean>>();
  /** Placements a 2D transform key could not make, already logged. */
  private readonly unplaced = new Set<string>();

  constructor(private readonly host: CharacterDirectorHost) {}

  private of(id: string): Directed {
    let d = this.directed.get(id);
    if (d === undefined) {
      d = { walk: null, place: null, placeFacing: null, facing: null, enabled: null, holds: new Set() };
      this.directed.set(id, d);
    }
    return d;
  }

  private endWalk(d: Directed, state: Exclude<CharacterWalkState, 'walking'>): void {
    if (d.walk === null) return;
    this.ended.set(d.walk.handle, state);
    if (this.ended.size > WALK_ENDED_KEPT) this.ended.delete(this.ended.keys().next().value!);
    d.walk = null;
  }

  /** A placement's or walk's point, checked as a `character_place` intent would be (null: refused). */
  private point(position: unknown, facing: unknown): { position: [number, number, number]; facing: number | undefined } | null {
    const raw = { kind: 'character_place', position, ...(facing !== undefined ? { facing } : {}) };
    const shape = validateIntentShape(raw);
    if (!shape.ok || shape.intent.kind !== 'character_place' || validateIntentValue(shape.intent) !== null) return null;
    const p = shape.intent.position;
    return { position: [p[0], p[1], p[2]], facing: shape.intent.facing };
  }

  // ---- requests ----------------------------------------------------------------------

  place(id: string, position: unknown, facing?: unknown): boolean {
    const at = this.point(position, facing);
    if (at === null || !this.host.canPlace(id)) return false;
    const d = this.of(id);
    this.endWalk(d, 'stopped');
    d.place = at.position;
    d.placeFacing = at.facing ?? null;
    d.facing = null;
    return true;
  }

  /** A walk's handle (0: refused). */
  walkTo(id: string, position: unknown, options: { run?: unknown; arrive?: unknown; facing?: unknown }, owner: string): number {
    const at = this.point(position, options.facing);
    if (at === null) return 0;
    if (options.run !== undefined && typeof options.run !== 'boolean') return 0;
    const arrive = options.arrive;
    if (arrive !== undefined && !(typeof arrive === 'number' && Number.isFinite(arrive) && arrive >= 0.01 && arrive <= 100)) return 0;
    const d = this.of(id);
    this.endWalk(d, 'stopped');
    d.facing = null;
    const handle = ++this.serial;
    d.walk = { handle, target: at.position, run: options.run === true, radius: (arrive as number | undefined) ?? WALK_ARRIVE_RADIUS, facing: at.facing ?? null, owner, best: Infinity, stale: 0 };
    return handle;
  }

  turn(id: string, facing: number, instant: boolean): boolean {
    if (!Number.isFinite(facing)) return false;
    const d = this.of(id);
    // A turn asked for with a placement of this step is that placement's facing.
    if (d.place !== null) d.placeFacing = facing;
    else d.facing = { yaw: wrap(radians(facing)), instant };
    return true;
  }

  setEnabled(id: string, enabled: boolean, owner?: string): void {
    const d = this.of(id);
    if (owner !== undefined) {
      let before = this.switchedBefore.get(owner);
      if (before === undefined) this.switchedBefore.set(owner, (before = new Map()));
      if (!before.has(id)) before.set(id, d.enabled ?? this.switchedOn.get(id) ?? true);
    }
    d.enabled = enabled;
  }

  /** A script's `character_enable` of this step (the switch a later cutscene stop goes back to). */
  noteEnabled(id: string | undefined, enabled: boolean): void {
    if (id !== undefined) this.switchedOn.set(id, enabled);
  }

  stop(id: string): boolean {
    const d = this.directed.get(id);
    if (d?.walk == null) return false;
    this.endWalk(d, 'stopped');
    return true;
  }

  walkState(handle: unknown): CharacterWalkState | null {
    if (typeof handle !== 'number') return null;
    for (const d of this.directed.values()) if (d.walk?.handle === handle) return 'walking';
    return this.ended.get(handle) ?? null;
  }

  hold(id: string, owner: string): void {
    this.of(id).holds.add(owner);
  }

  /**
   * A cutscene (`owner`) ends: the one rule for what it leaves behind. Its
   * holds end. Finished: its walks carry on to their marks. Skipped: they
   * land there, facing a turn asked after the walk began, else the walk's
   * own facing. Stopped: they stop where they are, and each character it
   * switched off or on is switched back to what it was before its first
   * switch, unless another cutscene still playing has switched it since
   * (that one's end decides).
   */
  release(owner: string, how: CharacterReleaseKind): void {
    for (const d of this.directed.values()) {
      d.holds.delete(owner);
      const w = d.walk;
      if (w === null || w.owner !== owner || how === 'finished') continue;
      if (how === 'skipped') {
        const turned = d.facing !== null ? (d.facing.yaw * 180) / Math.PI : null;
        this.endWalk(d, 'arrived');
        d.place = w.target;
        d.placeFacing = turned ?? w.facing ?? d.placeFacing;
        d.facing = null;
      } else this.endWalk(d, 'stopped');
    }
    const before = this.switchedBefore.get(owner);
    if (before === undefined) return;
    this.switchedBefore.delete(owner);
    if (how !== 'stopped') return;
    for (const [id, was] of before) {
      if (![...this.switchedBefore.values()].some((m) => m.has(id))) this.setEnabled(id, was);
    }
  }

  /** A new run: nothing is asked of any character, walk handles count from 1 again (the controllers start switched on). */
  reset(): void {
    this.directed.clear();
    this.ended.clear();
    this.switchedOn.clear();
    this.switchedBefore.clear();
    this.unplaced.clear();
    this.serial = 0;
  }

  /**
   * A save was loaded: it places the characters, so no walk, placement or
   * turn asked before carries on from where it put them. Holds, switches
   * and what a stop switches back stay with the cutscenes still playing.
   */
  saveLoaded(): void {
    for (const [id, d] of this.directed) {
      this.endWalk(d, 'stopped');
      d.place = null;
      d.placeFacing = null;
      d.facing = null;
      if (d.holds.size === 0 && d.enabled === null) this.directed.delete(id);
    }
  }

  // ---- the step ----------------------------------------------------------------------

  /** After the intent phase: each directed character's channels of this step (`held`: a game mode holds physics; `action`: the step's input). */
  afterIntentPhase(held: boolean, action: ActionFrame): void {
    if (this.directed.size === 0) return;
    let changed = false;
    for (const [id, d] of this.directed) {
      const t = this.host.transform(id);
      if (t === undefined || this.host.resolve(id) !== id) {
        this.absent(id, d);
        continue;
      }
      const c = this.host.channels(id);
      // A held step runs no controller: the switch waits for one that does.
      if (d.enabled !== null && !held) {
        c.characterEnabled = d.enabled;
        c.characterWriters.set('character_enable', CHARACTER_DIRECTOR_ID);
        this.switchedOn.set(id, d.enabled);
        d.enabled = null;
        changed = true;
      }
      if (d.place !== null) {
        c.characterPlace = { x: d.place[0], y: d.place[1], z: d.place[2] };
        c.characterWriters.set('character_place', CHARACTER_DIRECTOR_ID);
        this.host.placeFacing(id, d.placeFacing ?? undefined);
        d.place = null;
        d.placeFacing = null;
        changed = true;
      }
      if (d.walk !== null) this.walkStep(id, d, t, c, held);
      else if (d.holds.size > 0) this.input(c, 0, 0, false);
      if (d.walk !== null || d.holds.size > 0) changed = true;
      if (d.facing !== null) this.turnStep(id, d, t, c, action);
      if (d.walk === null && d.holds.size === 0 && d.facing === null && d.enabled === null) this.directed.delete(id);
    }
    if (changed) this.host.intentsChanged();
  }

  /**
   * A directed character not in the game this step. While a scene loads
   * (it may bring the character: a cutscene played in the step its scene
   * was asked for) everything asked waits for it, and so does a character
   * a cutscene holds whose scene went out (until it comes back or the
   * cutscene ends). Otherwise its walk and turn end; a switch or placement
   * asked of a player controller still waits for it to come back; an object
   * that never became a player character is dropped with a log line.
   */
  private absent(id: string, d: Directed): void {
    const controller = this.host.resolve(id) === id;
    if (this.host.loading() || (controller && d.holds.size > 0)) return;
    this.endWalk(d, 'stopped');
    d.facing = null;
    if (!controller) {
      this.directed.delete(id);
      this.host.warn(`"${id}" is not a player character (an object with a Character controller); what a cutscene asked of it is dropped`);
    } else if (d.enabled === null && d.place === null) this.directed.delete(id);
  }

  /** One step of a walk: arrived, blocked, or the controller's input toward the mark. */
  private walkStep(id: string, d: Directed, t: TransformState, c: MutableControllerChannels, held: boolean): void {
    const w = d.walk!;
    const is3D = this.host.is3D();
    const dx = w.target[0] - t.position[0];
    const dz = is3D ? w.target[2] - t.position[2] : 0;
    const dist = Math.hypot(dx, dz);
    if (dist <= w.radius) {
      this.endWalk(d, 'arrived');
      if (w.facing !== null) d.facing = { yaw: wrap(radians(w.facing)), instant: false };
      if (d.holds.size > 0) this.input(c, 0, 0, false);
      return;
    }
    // A held game mode stands everything still: that is no reason to give up.
    if (!held) {
      if (dist < w.best - WALK_PROGRESS_MIN) {
        w.best = dist;
        w.stale = 0;
      } else if (++w.stale >= Math.round(WALK_BLOCKED_SECONDS * this.host.hz())) {
        this.endWalk(d, 'blocked');
        this.host.warn(`character "${id}" was blocked ${dist.toFixed(2)} m from its mark [${w.target.map((v) => Math.round(v * 100) / 100).join(', ')}]; the walk ends there`);
        if (d.holds.size > 0) this.input(c, 0, 0, false);
        return;
      }
    }
    // Full speed until the braking distance its deceleration needs, then slower toward the mark.
    const k = this.speeds(id);
    const speed = w.run ? k.run : k.walk;
    const brake = Math.max(w.radius, (1.25 * speed * speed) / Math.max(1e-3, k.decel));
    const mag = Math.min(1, dist / brake);
    this.input(c, (dx / dist) * mag, (dz / dist) * mag, w.run);
  }

  /** The controller's input of this step: a world direction (3D) or the move axis (2D); no jump. */
  private input(c: MutableControllerChannels, x: number, z: number, run: boolean): void {
    // The climb input too: a held or walking character does not take hold of a ladder.
    c.inputHeld = true;
    if (this.host.is3D()) {
      c.characterMove = { x, z, run };
      c.characterWriters.set('character_move', CHARACTER_DIRECTOR_ID);
      c.moveY = 0;
    }
    c.move = quantizeIntentMove(x);
    c.moveWriter = CHARACTER_DIRECTOR_ID;
    c.jump = 'none';
    c.jumpWriter = CHARACTER_DIRECTOR_ID;
  }

  /**
   * A turn's step: at the controller's turn speed in 3D (at once when asked).
   * On the 2D plane its face-movement models turn at once, and again each
   * step until it stands still: they follow the way it moves, and it may
   * still be slowing down. Once nothing holds it and no walk drives it, a
   * turn ends as soon as the player (or a script's move) moves it: the
   * player's input has the last word then (an instant turn still happens).
   */
  private turnStep(id: string, d: Directed, t: TransformState, c: MutableControllerChannels, action: ActionFrame): void {
    const f = d.facing!;
    if (d.holds.size === 0 && d.walk === null && this.moved(id, c, action)) {
      if (f.instant) this.host.turn(id, f.yaw);
      d.facing = null;
      return;
    }
    if (!this.host.is3D()) {
      this.host.turn(id, f.yaw);
      if (f.at !== undefined && Math.abs(t.position[0] - f.at) < 1e-4) d.facing = null;
      else f.at = t.position[0];
      return;
    }
    const rate = this.host.is3D() && !f.instant ? this.speeds(id).turn / this.host.hz() : Infinity;
    const from = yawOf(t.rotation);
    const delta = wrap(f.yaw - from);
    const yaw = Math.abs(delta) <= rate ? f.yaw : wrap(from + Math.sign(delta) * rate);
    this.host.turn(id, yaw);
    if (yaw === f.yaw) d.facing = null;
  }

  /** Whether the step's input or a script's move intent moves a character. */
  private moved(id: string, c: MutableControllerChannels, action: ActionFrame): boolean {
    const name = this.host.moveAction(id);
    if (name !== undefined) {
      const [x, y] = actionAxis(action, name);
      if (x !== 0 || y !== 0) return true;
    }
    if (c.moveWriter !== CHARACTER_DIRECTOR_ID && ((c.move ?? 0) !== 0 || (c.moveY ?? 0) !== 0)) return true;
    const m = c.characterMove;
    return m !== null && c.characterWriters.get('character_move') !== CHARACTER_DIRECTOR_ID && (m.x !== 0 || m.z !== 0);
  }

  /** A controller's walk and run speeds, deceleration (m/s, m/s²) and turn speed (rad/s). */
  private speeds(id: string): { walk: number; run: number; decel: number; turn: number } {
    const controller = (this.host.entityDocument(id)?.components as { controller?: unknown } | undefined)?.controller;
    const settings = this.host.settings();
    const decel = controllerTuningOf(controller).deceleration;
    if (!this.host.is3D()) return { walk: settings.run_speed, run: settings.run_speed, decel, turn: Infinity };
    const s = character3DSettingsOf(controller, settings);
    return { walk: s.walkSpeed, run: s.runSpeed, decel: s.deceleration, turn: s.turnSpeed > 0 ? radians(s.turnSpeed) : Infinity };
  }

  // ---- the surfaces ------------------------------------------------------------------

  /** `ctx.character` (a call without `entityId` means the first player controller). */
  readonly control = Object.freeze({
    impulse: (v: unknown, entityId?: unknown): boolean => {
      const id = this.resolve(entityId);
      if (id === undefined) return false;
      if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= CHARACTER_IMPULSE_MAX)) return false;
      // The 2D plane has no depth: its z is dropped.
      this.host.addImpulse(id, [v[0] as number, v[1] as number, v[2] as number]);
      this.host.intentsChanged();
      return true;
    },
    place: (position: unknown, facing?: unknown, entityId?: unknown): boolean => {
      const id = this.resolve(entityId);
      return id !== undefined && this.place(id, position, facing);
    },
    walkTo: (position: unknown, options?: unknown): number => {
      const o = (typeof options === 'object' && options !== null ? options : {}) as { run?: unknown; arrive?: unknown; facing?: unknown; entityId?: unknown };
      const id = this.resolve(o.entityId);
      return id === undefined ? 0 : this.walkTo(id, position, o, SCRIPT_OWNER);
    },
    walkState: (handle: unknown): CharacterWalkState | null => this.walkState(handle),
    stop: (entityId?: unknown): boolean => {
      const id = this.resolve(entityId);
      return id !== undefined && this.stop(id);
    },
    turn: (facing: unknown, entityId?: unknown): boolean => {
      const id = this.resolve(entityId);
      return id !== undefined && typeof facing === 'number' && Math.abs(facing) <= 1e6 && this.turn(id, facing, false);
    },
    setEnabled: (enabled: unknown, entityId?: unknown): boolean => {
      const id = this.resolve(entityId);
      if (id === undefined || typeof enabled !== 'boolean') return false;
      this.setEnabled(id, enabled);
      return true;
    },
  });

  private resolve(entityId: unknown): string | undefined {
    return typeof entityId === 'string' || entityId === undefined ? this.host.resolve(entityId) : undefined;
  }

  /** The timeline's character track. */
  readonly timelinePort: TimelineCharacterPort = Object.freeze({
    // An object not in the game yet may come with a scene that is loading (the director waits for it).
    has: (id: string): boolean => id !== '' && (this.host.resolve(id) === id || (this.host.transform(id) === undefined && this.host.loading())),
    place: (id: string, position: readonly number[], facing: number | undefined): boolean => this.place(id, position, facing),
    walk: (id: string, position: readonly number[], options: { run?: boolean; facing?: number }, owner: string): boolean => this.walkTo(id, position, options, owner) > 0,
    turn: (id: string, facing: number, instant: boolean): boolean => this.turn(id, facing, instant),
    setEnabled: (id: string, enabled: boolean, owner: string): boolean => {
      this.setEnabled(id, enabled, owner);
      return true;
    },
    hold: (id: string, owner: string): void => this.hold(id, owner),
    release: (owner: string, how: CharacterReleaseKind): void => this.release(owner, how),
  });

  /**
   * A timeline's transform key on a player character: a rotation turns it
   * (its controller keeps the way the key faces); on the 2D plane a
   * position places it, as a script's `character_place` does. True when the
   * key needs nothing more (a 2D character); false: write it as usual.
   */
  timelinePose(id: string, pose: { position?: readonly number[]; rotation?: readonly number[] }): boolean {
    if (this.host.resolve(id) !== id) return false;
    if (pose.rotation !== undefined) this.turn(id, (yawOf(pose.rotation) * 180) / Math.PI, true);
    if (this.host.is3D()) return false;
    if (pose.position !== undefined && !this.place(id, [pose.position[0], pose.position[1], pose.position[2] ?? 0], undefined) && !this.unplaced.has(id)) {
      this.unplaced.add(id);
      this.host.warn(`a timeline's position key cannot place "${id}": a 2D character needs a physics world that places it`);
    }
    return true;
  }
}
