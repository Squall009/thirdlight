/**
 * Where the player character is put, and when: a respawn, a scene
 * transition's (or the scene list's) arrival at a spawn, a loaded save's
 * placement once its scenes are in, a script's `character_place`, and the
 * way the character faces as it is placed (a spawn's yaw, a placement's
 * facing, a save's facing).
 *
 * Each placement waits for its moment and is applied at one point of the
 * step, so every host (the page, the simulation worker, a replay) places the
 * character at the same step: arrivals and a save's placement at the step
 * boundary once their scenes are loaded; in 3D a respawn in the next intent
 * phase (a script placing the character that step wins), on the 2D plane at
 * the boundary. The physics port calls stay in the runtime (they fail-stop
 * the run); this module decides what is placed where.
 */
import type { EntityV3 } from '@thirdlight/project-model';

import type { SavedCharacter, WorldSave } from './project-saves';
import type { MutableControllerChannels } from './mutable-intents';
import type { TransformState } from './types-simulation';

/** The largest impulse component a script may give the character (m/s; a safety limit, far above a jump). */
export const CHARACTER_IMPULSE_MAX = 100;

type Vec3 = [number, number, number];

/** What placement reads from and asks of the runtime. */
export interface CharacterPlacementHost {
  /** A 3D project (the 3D port is present). */
  is3D(): boolean;
  /** The player character this placement moves (a controller's entity), if the game has one. */
  controllerId(): string | undefined;
  /** An object's transform this step (written in place). */
  transform(id: string): TransformState | undefined;
  /** An object's document (a spawn's yaw is read from it). */
  entityDocument(id: string): EntityV3 | undefined;
  sceneLoading(sceneId: string): boolean;
  /** The spawn respawns use from now on. */
  setActiveSpawn(spawnId: string): void;
  /** An arrival whose spawn is not there (the character stays). */
  arrivalMissed(message: string): void;
  /** Whether an object is kept loaded across scene unloads. */
  isKept(id: string): boolean;
  /** The spawn of the shell's scene list entry for a scene, if it has one. */
  listedSpawnOf(sceneId: string): string | undefined;
  /** Put the 3D character at an origin from rest (throws a port failure). */
  place3D(x: number, y: number, z: number): void;
  /** Put the 2D-plane character at an origin from rest (throws a port failure). */
  place2D(x: number, y: number, ordinal: number): void;
  /** A 2D-plane spawn's yaw for the character's controller. */
  faceSpawn2D(id: string, yaw: number): void;
  /** Fail-stop the run (a placement threw). */
  failStop(e: unknown): void;
  /** The character's intent channels of this step (a placement is its `characterPlace`). */
  intents(): MutableControllerChannels;
  /** The intent view changed. */
  intentsChanged(): void;
  /** Replace the impulse waiting for the character's next controller phase (a save's velocity). */
  setImpulse(v: Vec3): void;
  /** The character's last applied move (per step) and, in 3D, the way it faces (degrees). */
  lastMotion(): { applied?: { x: number; y: number; z?: number }; facing?: number };
  /** Steps per second. */
  hz(): number;
}

export class CharacterPlacement {
  /** A respawn (or a restart's placement) waiting for the next intent phase: where the character goes. */
  private respawn: Vec3 | null = null;
  /** The yaw (radians) the character faces on its next placement (a spawn's yaw). */
  private pendingYaw: number | null = null;
  /** This step's yaw for the controller (null: none was set). */
  private stepYaw: number | null = null;
  /** The facing (radians about +Y) a script's character_place of this step asked for. */
  private placeYaw: number | null = null;
  /** A scene transition's arrival waiting for its scene (then the character moves to the spawn). */
  private arrival: { spawnId: string; waitFor: string } | null = null;
  /** A loaded save's character placement, once the scenes it waits for are in. */
  private restore: { position: readonly [number, number, number]; velocity: readonly [number, number, number]; facing?: number; waitFor: readonly string[] } | null = null;

  constructor(private readonly host: CharacterPlacementHost) {}

  /** The yaw this step's placement turned the character to (for the controller), or null. */
  get stepFacing(): number | null {
    return this.stepYaw;
  }

  /** A respawn at a target (`ctx.lifecycle.respawn`, the respawn intent). */
  requestRespawn(target: Vec3): void {
    this.respawn = target;
  }

  /** A script's `character_place` asked for a facing (degrees; undefined: it keeps its way). */
  placeFacing(degrees: number | undefined): void {
    this.placeYaw = degrees !== undefined ? (degrees * Math.PI) / 180 : null;
  }

  /** The character arrives at a spawn once a scene is loaded. */
  arriveAt(spawnId: string, waitFor: string): void {
    this.arrival = { spawnId, waitFor };
  }

  /** A pending arrival at one of these (unloaded) objects is dropped. */
  dropArrivalAt(ids: ReadonlySet<string>): void {
    if (this.arrival !== null && ids.has(this.arrival.spawnId)) this.arrival = null;
  }

  /**
   * A kept player arrives at a listed scene's spawn (`shell.scenes[].spawn`)
   * when that scene loads, however it was loaded — unless the load already
   * names an arrival (a transition, the scene list) or a save is placing it.
   */
  arriveAtListedSpawn(sceneId: string): void {
    const player = this.host.controllerId();
    if (player === undefined || !this.host.isKept(player) || this.arrival !== null || this.restore !== null) return;
    const spawn = this.host.listedSpawnOf(sceneId);
    if (spawn !== undefined) this.arrival = { spawnId: spawn, waitFor: sceneId };
  }

  /**
   * A run restart: nothing asked of the placement in the last run outlives it
   * (a respawn or an arrival still waiting, a save's placement, a spawn's or
   * a script's facing); the runtime puts the character where it started.
   */
  restartRun(): void {
    this.respawn = null;
    this.arrival = null;
    this.restore = null;
    this.pendingYaw = null;
    this.stepYaw = null;
    this.placeYaw = null;
  }

  /** The start set is restored: arrivals, a save's placement and a spawn facing do not outlive the run. */
  startSetRestored(): void {
    this.arrival = null;
    this.restore = null;
    this.pendingYaw = null;
  }

  /** A new step: no yaw for the controller yet. */
  beginStep(): void {
    this.stepYaw = null;
  }

  /**
   * At a step boundary: a scene transition's arrival once its scene is
   * loaded, then a loaded save's placement once its scenes are. Returns
   * false after a fail-stop.
   */
  atBoundary(ordinal: number): boolean {
    if (this.arrival !== null && !this.runArrival(ordinal)) return false;
    if (this.restore !== null && !this.runRestore(ordinal)) return false;
    return true;
  }

  /** On the 2D plane a respawn places the character at the boundary, from rest. Returns false after a fail-stop. */
  respawn2DAtBoundary(ordinal: number): boolean {
    if (this.host.is3D() || this.respawn === null) return true;
    const target = this.respawn;
    this.respawn = null;
    this.pendingYaw = null;
    try {
      this.host.place2D(target[0], target[1], ordinal);
    } catch (e) {
      this.host.failStop(e);
      return false;
    }
    return true;
  }

  /** A step without an intent phase places a 3D respawn now (throws a port failure). */
  respawn3DNow(): void {
    if (!this.host.is3D() || this.respawn === null) return;
    const [x, y, z] = this.respawn;
    this.respawn = null;
    this.host.place3D(x, y, z);
    // A spawn's yaw turns the character as it is placed.
    if (this.pendingYaw !== null) this.face3D(this.pendingYaw);
    this.pendingYaw = null;
  }

  /**
   * After the intent phase, before the controller runs: a respawn places
   * the character unless a script placed it this step; a script's
   * `character_place` takes effect (turned to its facing, as a spawn's yaw);
   * on the 2D plane the placement is from rest (the controller reset). Throws
   * a port failure.
   */
  afterIntentPhase(ordinal: number): void {
    const intents = this.host.intents();
    const is3D = this.host.is3D();
    if (is3D && this.respawn !== null) {
      if (intents.characterPlace === null) {
        const [x, y, z] = this.respawn;
        intents.characterPlace = { x, y, z };
        this.host.intentsChanged();
        if (this.pendingYaw !== null) {
          this.stepYaw = this.pendingYaw;
          this.face3D(this.pendingYaw);
        }
      }
      this.respawn = null;
      this.pendingYaw = null;
    }
    if (is3D && intents.characterPlace !== null) {
      if (this.placeYaw !== null) {
        this.stepYaw = this.placeYaw;
        this.face3D(this.placeYaw);
        this.host.intentsChanged();
      }
      const place = intents.characterPlace;
      this.host.place3D(place.x, place.y, place.z);
    }
    this.placeYaw = null;
    // A respawn asked for in this step gives way to it (as in 3D).
    if (!is3D && intents.characterPlace !== null) {
      this.respawn = null;
      this.pendingYaw = null;
      this.host.place2D(intents.characterPlace.x, intents.characterPlace.y, ordinal);
    }
  }

  /** Where the character is in a save: its position, velocity (m/s) and, in 3D, the way it faces (degrees). */
  captureCharacter(): SavedCharacter | null {
    const id = this.host.controllerId();
    const t = id !== undefined ? this.host.transform(id) : undefined;
    if (t === undefined) return null;
    const is3D = this.host.is3D();
    const { applied: r, facing } = this.host.lastMotion();
    const hz = this.host.hz();
    const v = (n: number | undefined): number => {
      const x = (n ?? 0) * hz;
      return Number.isFinite(x) ? Math.max(-CHARACTER_IMPULSE_MAX, Math.min(CHARACTER_IMPULSE_MAX, x)) : 0;
    };
    return { position: [t.position[0], t.position[1], t.position[2]], velocity: [v(r?.x), v(r?.y), is3D ? v(r?.z) : 0], ...(is3D && facing !== undefined && Number.isFinite(facing) ? { facing: normalizedDegrees(facing) } : {}) };
  }

  /** A loaded save: the character goes where it was (`c`; null: it stays) once the saved scenes are in (`atBoundary`); no arrival is left waiting. */
  restoreFrom(world: WorldSave, c: SavedCharacter | null): void {
    this.arrival = null;
    this.restore = c === null || this.host.controllerId() === undefined ? null : { position: c.position, velocity: c.velocity, ...(c.facing !== undefined ? { facing: c.facing } : {}), waitFor: [...world.scenes] };
  }

  /** Whether a save's placement is waiting. */
  get restoring(): boolean {
    return this.restore !== null;
  }

  /** Turn the 3D character to a yaw (radians about +Y) — its transform now, its controller with the placement. */
  private face3D(yaw: number): void {
    const id = this.host.controllerId();
    const t = id !== undefined ? this.host.transform(id) : undefined;
    if (t === undefined) return;
    t.rotation[0] = 0;
    t.rotation[1] = Math.sin(yaw / 2);
    t.rotation[2] = 0;
    t.rotation[3] = Math.cos(yaw / 2);
  }

  /** The arrival of a scene transition, once its scene is loaded. Returns false after a fail-stop. */
  private runArrival(ordinal: number): boolean {
    const a = this.arrival;
    if (a === null || this.host.sceneLoading(a.waitFor)) return true;
    this.arrival = null;
    const t = this.host.transform(a.spawnId);
    const spawn = this.host.entityDocument(a.spawnId);
    const marker = (spawn?.components as { playerSpawn?: { yaw?: unknown } } | undefined)?.playerSpawn;
    if (t === undefined || marker === undefined) {
      this.host.arrivalMissed(`scene transition spawn "${a.spawnId}" is not loaded; the character stays`);
      return true;
    }
    // The spawn becomes the one respawns use (ctx.lifecycle).
    this.host.setActiveSpawn(a.spawnId);
    const yaw = typeof marker.yaw === 'number' && Number.isFinite(marker.yaw) ? (marker.yaw * Math.PI) / 180 : null;
    const [x, y, z] = [t.position[0], t.position[1], t.position[2]];
    if (this.host.is3D()) {
      this.respawn = [x, y, z];
      this.pendingYaw = yaw;
      return true;
    }
    try {
      this.host.place2D(x, y, ordinal);
    } catch (e) {
      this.host.failStop(e);
      return false;
    }
    const id = this.host.controllerId();
    if (yaw !== null && id !== undefined) this.host.faceSpawn2D(id, yaw);
    return true;
  }

  /** A loaded save's placement once no scene it waits for is loading. Returns false after a fail-stop. */
  private runRestore(ordinal: number): boolean {
    const r = this.restore;
    if (r === null || r.waitFor.some((sceneId) => this.host.sceneLoading(sceneId))) return true;
    this.restore = null;
    const [x, y, z] = r.position;
    const is3D = this.host.is3D();
    if (is3D) {
      this.respawn = [x, y, z];
      // A saved facing turns the character as it is placed (an older save keeps it as it is).
      this.pendingYaw = r.facing !== undefined ? (r.facing * Math.PI) / 180 : null;
    } else {
      try {
        this.host.place2D(x, y, ordinal);
      } catch (e) {
        this.host.failStop(e);
        return false;
      }
    }
    const [vx, vy, vz] = r.velocity;
    if (vx !== 0 || vy !== 0 || vz !== 0) this.host.setImpulse([vx, vy, is3D ? vz : 0]);
    return true;
  }
}

/** Degrees in [-180, 180) (a facing as a save keeps it). */
function normalizedDegrees(d: number): number {
  const x = ((((d + 180) % 360) + 360) % 360) - 180;
  return Object.is(x, -0) ? 0 : x;
}

/**
 * Every player controller's placement — one `CharacterPlacement` each, in
 * controller order (the first is index 0). A respawn or a script's placement
 * names its controller; a scene transition's arrival, a listed scene's spawn
 * (each kept controller) and a run restart place them all; a save keeps the
 * first under `character` and the others under `characters`.
 */
export class ControllerPlacements {
  private readonly list: readonly { readonly id: string; readonly placement: CharacterPlacement }[];

  constructor(ids: readonly string[], make: (id: string) => CharacterPlacement) {
    this.list = ids.map((id) => ({ id, placement: make(id) }));
  }

  /** A controller's placement (undefined: not a controller). */
  of(id: string): CharacterPlacement | undefined {
    return this.list.find((x) => x.id === id)?.placement;
  }

  /** Whether a save's placement is waiting for any controller. */
  get restoring(): boolean {
    return this.list.some((x) => x.placement.restoring);
  }

  /** At a step boundary, every controller's waiting arrival and save placement. Returns false after a fail-stop. */
  atBoundary(ordinal: number): boolean {
    return this.list.every((x) => x.placement.atBoundary(ordinal));
  }

  /** On the 2D plane every waiting respawn places its controller at the boundary. Returns false after a fail-stop. */
  respawn2DAtBoundary(ordinal: number): boolean {
    return this.list.every((x) => x.placement.respawn2DAtBoundary(ordinal));
  }

  beginStep(): void {
    for (const x of this.list) x.placement.beginStep();
  }

  /** After the intent phase: each controller's respawn or script placement (throws a port failure). */
  afterIntentPhase(ordinal: number): void {
    for (const x of this.list) x.placement.afterIntentPhase(ordinal);
  }

  /** A step without an intent phase places each waiting 3D respawn now (throws a port failure). */
  respawn3DNow(): void {
    for (const x of this.list) x.placement.respawn3DNow();
  }

  restartRun(): void {
    for (const x of this.list) x.placement.restartRun();
  }

  startSetRestored(): void {
    for (const x of this.list) x.placement.startSetRestored();
  }

  dropArrivalAt(ids: ReadonlySet<string>): void {
    for (const x of this.list) x.placement.dropArrivalAt(ids);
  }

  /** Every controller arrives at a spawn once a scene is loaded (a transition, the scene list). */
  arriveAt(spawnId: string, waitFor: string): void {
    for (const x of this.list) x.placement.arriveAt(spawnId, waitFor);
  }

  /** Every kept controller arrives at a listed scene's spawn when it loads. */
  arriveAtListedSpawn(sceneId: string): void {
    for (const x of this.list) x.placement.arriveAtListedSpawn(sceneId);
  }

  /** A loaded save: the first controller from `character`, the others from `characters` (absent: they stay). */
  restoreFrom(world: WorldSave): void {
    this.list.forEach((x, i) => x.placement.restoreFrom(world, i === 0 ? world.character : (world.characters?.[x.id] ?? null)));
  }

  /** The controllers in a save: the first as `character`, the others as `characters` (absent with one). */
  capture(): Pick<WorldSave, 'character' | 'characters'> {
    const first = this.list[0]?.placement.captureCharacter() ?? null;
    const more: Record<string, SavedCharacter> = {};
    for (let i = 1; i < this.list.length; i += 1) {
      const c = this.list[i]!.placement.captureCharacter();
      if (c !== null) more[this.list[i]!.id] = c;
    }
    return Object.keys(more).length > 0 ? { character: first, characters: more } : { character: first };
  }
}
