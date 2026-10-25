/**
 * The loaded scene set: which scenes are loaded (in load order) and what each
 * brought, the loads the host is fetching and the runtime is preparing, the
 * unloads and reloads waiting for a step boundary, scene transitions and their
 * fades, and the run's place in the shell's scene list.
 *
 * Requests (`ctx.scenes`, the host, triggers, UI events, a save) are checked
 * and queued here and applied at a step boundary (`applyOps`), in the same
 * order whatever the frame rate, so a replay loads and unloads alike. The
 * scenes' objects come and go through the runtime's entity set (`SceneHost`).
 */
import { MAX_TRANSITION_FADE, type EntityV3 } from '@thirdlight/project-model';

import { arrivalProblem } from './arriving-players';
import type { SceneTransitionRequest } from './blocks';
import type { ControllerPlacements } from './character-placement';
import type { ColliderSystem } from './collider-system';
import type { EnvironmentDirector } from './environment-director';
import { clipMessage } from './errors';
import type { RuntimeGrid } from './grid';
import type { KeptObjects } from './kept';
import type { PlayerControllers } from './player-controllers';
import type { WorldSave } from './project-saves';
import type { RuntimeFaults } from './runtime-faults';
import { messageOf, type RuntimeSim } from './runtime-sim';
import { createSceneControl, FADE_COLOR_RE, sceneRequestProblem, type SceneOp, type SceneRequestHost, type TransitionSpec } from './scene-control';
import { offsetEntities } from './scene-set';
import { deepFreeze } from './snapshot';
import type { BehaviorSceneControl, ListedScene, RuntimeSceneRow, SceneLoadOptions, SceneLoadRequest, SceneLoadingView, SceneSetView, SceneStatus, SceneTransitionView } from './types';

/**
 * The time a step boundary spends preparing loaded scenes'
 * entities (copying and freezing them) before it attaches them; a large
 * scene is prepared over several steps and attached in one.
 */
const SCENE_PREP_BUDGET_MS = 4;
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** One loaded scene inside the runtime. */
interface SceneBatchState {
  sceneId: string;
  start: boolean;
  entities: readonly EntityV3[];
  ids: ReadonlySet<string>;
  /** Its objects that put a collider in the physics world (the player's excluded). */
  colliderIds: readonly string[];
}

/** The objects of a list that put a collider in the physics world (the player's excluded). */
function colliderIdsOf(entities: readonly EntityV3[]): string[] {
  return entities.filter((e) => (e.components as unknown as Record<string, unknown>)['collider'] !== undefined && (e.components as unknown as Record<string, unknown>)['controller'] === undefined).map((e) => e.id);
}

/** What the scene set works with: the runtime's parts a scene's objects reach, and its entity set. */
export interface SceneHost {
  readonly kept: KeptObjects;
  readonly colliders: ColliderSystem;
  readonly grid: RuntimeGrid;
  readonly controllers: PlayerControllers;
  readonly placement: ControllerPlacements;
  readonly environment: EnvironmentDirector;
  /** A scene's sounds stop (the scene went). */
  sceneSoundsGone(sceneId: string): void;
  /** The live spawned copies, in spawn order. */
  spawned(): ReadonlyMap<string, EntityV3>;
  /** Put resolved, frozen entities into the simulation. */
  attach(frozen: readonly EntityV3[]): void;
  /** Take entities out of the simulation (`what` names them in diagnostics). */
  detach(ids: ReadonlySet<string>, colliderIds: readonly string[], what: string, how?: 'unload' | 'reload'): void;
  /** The player controllers among arrived entities; false after a fail-stop. */
  playersArrive(frozen: readonly EntityV3[], placeReturning: boolean): boolean;
  /** Tell the phased modules about arrived entities; false after a fail-stop. */
  notifyLoaded(frozen: readonly EntityV3[]): boolean;
  /** Remove spawned copies (and what belongs to them). */
  removeSpawned(ids: ReadonlySet<string>): void;
  /** The spawned copies a scene's objects made (a reload removes them). */
  copiesOf(sceneId: string): ReadonlySet<string>;
}

export class RuntimeScenes {
  /** Every scene of the project (null: one fixed scene, no scene API). */
  readonly rows: readonly RuntimeSceneRow[] | null;
  private readonly startBatchSource: ReadonlyMap<string, readonly EntityV3[]>;
  /** Loaded scenes, in load order. */
  private readonly batches = new Map<string, SceneBatchState>();
  private readonly status = new Map<string, SceneStatus>();
  /** Loads requested and not yet handed to the host. */
  private readonly requestedLoads = new Map<string, { at?: readonly [number, number, number] }>();
  /** Loads the host is fetching. */
  private readonly fetchingLoads = new Map<string, { at?: readonly [number, number, number] }>();
  /** Fetched scenes waiting for the next step boundary. */
  private readonly readyLoads = new Map<string, readonly EntityV3[]>();
  /** Fetched scenes being prepared (copied and frozen, a budget per step boundary) before they attach. */
  private readonly preparedLoads = new Map<string, { readonly out: EntityV3[]; next: number }>();
  private readonly pendingUnloads = new Set<string>();
  /** Loaded scenes whose objects return as authored at the next boundary (`ctx.scenes.reload`). */
  private readonly pendingReloads = new Set<string>();
  /**
   * Transitions waiting for their scene (keyed by it): the
   * scenes they unload stay loaded (and drawn) until it is in, then both
   * happen at one step boundary. `outLeft`: steps of fade-out still to go.
   */
  private readonly transitions = new Map<string, TransitionSpec & { readonly fadeSteps: number; outLeft: number }>();
  /** The last swap a transition made (the page fades back in once it drew that revision). */
  private lastSwap: { readonly scene: string; readonly revision: number; readonly seconds: number; readonly color: string } | null = null;
  private loadingViewCache: { key: string; view: SceneLoadingView } | null = null;
  /** Scene ops issued during the running step (committed with it). */
  private stepOps: SceneOp[] = [];
  private revision = 0;
  private setCache: SceneSetView | null = null;
  /** The shell's ordered scene list, the entry the run is at (-1: none; null: not worked out yet this run) and a move asked for by a `scene` UI event. */
  readonly list: readonly ListedScene[];
  private listed: number | null = null;
  private pendingListed: number | null = null;
  private readonly requestHost: SceneRequestHost;
  /** `ctx.scenes`. */
  readonly control: BehaviorSceneControl;

  constructor(
    private readonly sim: RuntimeSim,
    private readonly faults: RuntimeFaults,
    private readonly host: SceneHost,
    rows: readonly RuntimeSceneRow[] | null,
    startBatches: readonly { sceneId: string; entities: EntityV3[] }[],
    list: readonly ListedScene[],
  ) {
    this.rows = rows;
    this.list = list;
    this.startBatchSource = new Map(startBatches.map((b) => [b.sceneId, b.entities]));
    if (rows !== null) {
      for (const row of rows) this.status.set(row.sceneId, 'unloaded');
      for (const b of startBatches) {
        this.batches.set(b.sceneId, { sceneId: b.sceneId, start: true, entities: Object.freeze(b.entities), ids: new Set(b.entities.map((e) => e.id)), colliderIds: colliderIdsOf(b.entities) });
        this.status.set(b.sceneId, 'loaded');
      }
    }
    this.requestHost = {
      hasCatalog: () => this.rows !== null,
      status: (sceneId) => this.status.get(sceneId),
      loaded: () => [...this.batches.keys()],
      loadingView: () => this.loadingView(),
      activeScene: () => this.host.environment.activeScene(),
      push: (op) => void this.stepOps.push(op),
    };
    this.control = createSceneControl(this.requestHost);
  }

  // ---- Reads -----------------------------------------------------------

  view(): SceneSetView {
    if (this.setCache === null) {
      this.setCache = Object.freeze({
        revision: this.revision,
        batches: Object.freeze([...this.batches.values()].map((b) => Object.freeze({ sceneId: b.sceneId, start: b.start, entities: b.entities }))),
        status: Object.freeze(Object.fromEntries(this.status)),
        // Kept objects whose scene went are scene-less, as spawned copies are.
        spawned: Object.freeze([...this.host.spawned().values(), ...this.host.kept.orphanList()]),
      });
    }
    return this.setCache;
  }

  /** The scene set changed outside a load or unload (spawned copies came or went). */
  changed(): void {
    this.revision += 1;
    this.setCache = null;
  }

  known(sceneId: string): boolean {
    return this.status.has(sceneId);
  }

  isLoaded(sceneId: string): boolean {
    return this.batches.has(sceneId);
  }

  isLoading(sceneId: string): boolean {
    return this.status.get(sceneId) === 'loading';
  }

  /** A scene is being loaded, or a load or reload was asked for in this step. */
  anyLoading(): boolean {
    return [...this.status.values()].includes('loading') || this.stepOps.some((op) => op.op === 'load' || op.op === 'reload');
  }

  /** The default plane of the loaded scene holding an object (null: none, or no such scene). */
  planeOf(entityId: string): NonNullable<RuntimeSceneRow['plane']> | null {
    const sceneId = this.sceneOf(entityId);
    if (sceneId === undefined || this.rows === null) return null;
    return this.rows.find((r) => r.sceneId === sceneId)?.plane ?? null;
  }

  /** The loaded scene holding an object (undefined: none — a spawned copy). */
  sceneOf(entityId: string): string | undefined {
    for (const b of this.batches.values()) if (b.ids.has(entityId)) return b.sceneId;
    return undefined;
  }

  /** A loaded entity's document (its components), or undefined. */
  entityDocument(id: string): EntityV3 | undefined {
    for (const b of this.batches.values()) {
      if (!b.ids.has(id)) continue;
      return b.entities.find((e) => e.id === id);
    }
    return this.host.spawned().get(id) ?? this.host.kept.orphan(id);
  }

  /** The scenes being loaded, the transition waiting and the last swap (unchanged views are the same object). */
  loadingView(): SceneLoadingView {
    const loading: string[] = [];
    for (const [id, st] of this.status) if (st === 'loading') loading.push(id);
    let transition: SceneTransitionView | null = null;
    for (const [scene, t] of this.transitions) {
      if (this.status.get(scene) !== 'loading') continue;
      const fade = t.fadeSteps === 0 ? 1 : Math.round((1 - t.outLeft / t.fadeSteps) * 1000) / 1000;
      transition = { scene, phase: t.outLeft > 0 ? 'out' : 'loading', fade, seconds: t.fade, color: t.color, unload: t.unload };
      break;
    }
    const key = `${loading.join(',')}|${transition === null ? '' : `${transition.scene}:${transition.phase}:${transition.fade}`}|${this.lastSwap?.revision ?? -1}`;
    if (this.loadingViewCache !== null && this.loadingViewCache.key === key) return this.loadingViewCache.view;
    const view = deepFreeze({ loading, transition, swap: this.lastSwap === null ? null : { ...this.lastSwap } });
    this.loadingViewCache = { key, view };
    return view;
  }

  /** The shell's scene list entry the run is at (-1: none). */
  listedIndex(): number {
    return this.listed ?? this.list.findIndex((x) => this.startBatchSource.has(x.scene));
  }

  /** The listed spawn of a scene's first scene-list entry with one. */
  listedSpawnOf(sceneId: string): string | undefined {
    return this.list.find((x) => x.scene === sceneId && x.spawn !== undefined)?.spawn;
  }

  // ---- The host's requests ------------------------------------------------

  takeRequests(): SceneLoadRequest[] {
    const out: SceneLoadRequest[] = [];
    for (const [sceneId, req] of this.requestedLoads) {
      this.fetchingLoads.set(sceneId, req);
      out.push(Object.freeze({ sceneId, ...(req.at !== undefined ? { at: req.at } : {}) }));
    }
    this.requestedLoads.clear();
    return out;
  }

  /** A fetched scene (or why it could not be read); it attaches at a step boundary. */
  provide(sceneId: string, result: { ok: true; entities: readonly EntityV3[] } | { ok: false; message: string }): void {
    // A load cancelled while it was fetched (an unload, a replay) is dropped.
    if (!this.fetchingLoads.has(sceneId)) return;
    if (!result.ok) {
      this.fetchingLoads.delete(sceneId);
      // A transition to a scene that could not be read keeps the world it has.
      this.transitions.delete(sceneId);
      this.setStatus(sceneId, 'unloaded');
      this.faults.record({ code: 'scene_load_failed', message: clipMessage(`scene "${sceneId}" could not be loaded: ${result.message}`), stepIndex: this.sim.stepIndex, reason: 'fetch' });
      return;
    }
    this.readyLoads.set(sceneId, result.entities);
  }

  /** Why a scene op cannot be requested now (null: it can). */
  opProblem(op: 'load' | 'unload' | 'reload', sceneId: unknown, options?: SceneLoadOptions): string | null {
    return sceneRequestProblem(this.requestHost, op, sceneId, options);
  }

  /** Queue a validated op: loads go to the host, unloads and reloads wait for the next boundary; an activation applies now. */
  enqueue(op: SceneOp): void {
    const status = this.status.get(op.sceneId);
    if (op.op === 'reload') {
      // A scene being loaded arrives as authored anyway; one not loaded loads; the last of unload and reload in a step wins.
      if (status === 'loaded') {
        this.pendingUnloads.delete(op.sceneId);
        this.pendingReloads.add(op.sceneId);
      } else if (status === 'unloaded') this.enqueue({ op: 'load', sceneId: op.sceneId });
      return;
    }
    if (op.op === 'activate') {
      // Still loaded when the step commits (an unload earlier in the step wins).
      if (status === 'loaded' && !this.pendingUnloads.has(op.sceneId)) this.host.environment.activate(op.sceneId, op.blend, op.easing);
      return;
    }
    if (op.op === 'load') {
      if (status === 'loaded') {
        this.pendingUnloads.delete(op.sceneId); // load after unload in one step: stays loaded
        // A transition to a scene that is in: its unloads go now (nothing to wait for).
        for (const u of op.transition?.unload ?? []) if (u !== op.sceneId && this.opProblem('unload', u) === null) this.enqueue({ op: 'unload', sceneId: u });
        return;
      }
      // A transition waits for its scene (a later one for the same scene replaces it).
      if (op.transition !== undefined) {
        const fadeSteps = Math.round(op.transition.fade * this.sim.hz);
        this.transitions.set(op.sceneId, { ...op.transition, fadeSteps, outLeft: fadeSteps });
        this.loadingViewCache = null;
      }
      if (status === 'loading') return;
      this.requestedLoads.set(op.sceneId, op.at !== undefined ? { at: op.at } : {});
      this.setStatus(op.sceneId, 'loading');
      return;
    }
    if (status === 'loaded') {
      this.pendingUnloads.add(op.sceneId);
      this.pendingReloads.delete(op.sceneId);
      return;
    }
    if (status === 'loading') {
      this.requestedLoads.delete(op.sceneId);
      this.fetchingLoads.delete(op.sceneId);
      this.readyLoads.delete(op.sceneId);
      this.preparedLoads.delete(op.sceneId);
      this.transitions.delete(op.sceneId);
      this.setStatus(op.sceneId, 'unloaded');
    }
  }

  /** The scene engine actions (reloadScene without a scene: the active one), checked like `ctx.scenes`, at the next boundary; a refusal is logged. */
  opFromUi(op: 'load' | 'unload' | 'reload', value: unknown): void {
    const id = op === 'reload' && (value === undefined || value === '') ? this.host.environment.activeScene() : value;
    const problem = id === null ? 'no scene is active' : this.opProblem(op, id);
    if (problem !== null) return void this.faults.record({ code: 'scene_invalid', message: clipMessage(`${op}Scene: ${problem}`), stepIndex: this.sim.stepIndex, reason: op });
    this.enqueue({ op, sceneId: id as string });
  }

  // ---- The step ---------------------------------------------------------

  /** A new step: the last step's requests were committed (or dropped with it). */
  beginStep(): void {
    if (this.stepOps.length > 0) this.stepOps = [];
  }

  /** The step's scene requests commit with it. */
  commitStep(): void {
    if (this.stepOps.length > 0) {
      for (const op of this.stepOps) this.enqueue(op);
      this.stepOps = [];
    }
  }

  /**
   * The step boundary for scenes: pending unloads, then fetched loads.
   * Returns `false` after a fail-stop (a module refused a loaded scene).
   */
  applyOps(stepped = true): boolean {
    if (this.rows === null) return true;
    if (this.pendingUnloads.size > 0) {
      for (const sceneId of this.pendingUnloads) this.removeBatch(sceneId);
      this.pendingUnloads.clear();
      // The active scene unloaded on its own: the first scene still loaded (in load order) is active, at once.
      this.reactivateIfGone();
    }
    if (this.pendingReloads.size > 0) {
      const reloads = [...this.pendingReloads];
      this.pendingReloads.clear();
      for (const sceneId of reloads) if (!this.reloadBatch(sceneId)) return false;
    }
    // Fade-outs advance one step per step (a paused game draws no fade: it is done at once).
    for (const t of this.transitions.values()) {
      if (t.outLeft === 0) continue;
      t.outLeft = stepped ? t.outLeft - 1 : 0;
      this.loadingViewCache = null;
    }
    if (this.readyLoads.size === 0) return true;
    const deadline = nowMs() + SCENE_PREP_BUDGET_MS;
    for (const [sceneId, entities] of [...this.readyLoads]) {
      // Copy and freeze its entities within the step's budget (a large scene over several steps).
      let prep = this.preparedLoads.get(sceneId);
      if (prep === undefined) this.preparedLoads.set(sceneId, (prep = { out: [], next: 0 }));
      while (prep.next < entities.length) {
        prep.out.push(deepFreeze(structuredClone(entities[prep.next]!)));
        prep.next += 1;
        if ((prep.next & 63) === 0 && nowMs() > deadline) break;
      }
      if (prep.next < entities.length) continue;
      const t = this.transitions.get(sceneId);
      if (t !== undefined && t.outLeft > 0) continue; // the view fades out first
      this.readyLoads.delete(sceneId);
      this.preparedLoads.delete(sceneId);
      const at = this.fetchingLoads.get(sceneId)?.at;
      this.fetchingLoads.delete(sceneId);
      // A transition's unloads leave in the step its scene arrives (never an empty world between).
      let takesActive = false;
      if (t !== undefined) {
        this.transitions.delete(sceneId);
        for (const u of t.unload) {
          if (u === sceneId || !this.batches.has(u) || this.opProblem('unload', u) !== null) continue;
          if (u === this.host.environment.activeScene()) takesActive = true;
          this.removeBatch(u);
        }
      }
      if (!this.addBatch(sceneId, offsetEntities(prep.out, at), false, at === undefined)) return false;
      // The scene loaded in place of the active one is active: its look blends in over the transition's fade.
      if (takesActive) {
        if (this.batches.has(sceneId)) this.host.environment.activate(sceneId, t!.fade);
        else this.reactivateIfGone();
      }
      if (t !== undefined) {
        this.lastSwap = { scene: sceneId, revision: this.revision, seconds: t.fade, color: t.color };
        this.loadingViewCache = null;
      }
    }
    return true;
  }

  // ---- Transitions and the scene list ------------------------------------

  /**
   * A trigger's scene transition (the character entered it): its unloads and
   * its load are queued like `ctx.scenes` calls, and the character moves to
   * the spawn once the scene is loaded, at the next step boundary after the
   * load (the character placement's arrival).
   */
  beginTransition(triggerId: string, t: SceneTransitionRequest): void {
    // The unloads wait for the scene (they leave in the step it arrives), so the view is never empty.
    const unload: string[] = [];
    for (const sceneId of t.unload) {
      const problem = sceneId === t.scene ? `it unloads the scene it loads (${JSON.stringify(sceneId)})` : this.opProblem('unload', sceneId);
      if (problem !== null) {
        this.faults.record({ code: 'scene_invalid', message: clipMessage(`scene transition "${triggerId}": ${problem}`), stepIndex: this.sim.stepIndex, reason: 'unload' });
        continue;
      }
      unload.push(sceneId);
    }
    const problem = this.opProblem('load', t.scene);
    if (problem !== null) {
      this.faults.record({ code: 'scene_invalid', message: clipMessage(`scene transition "${triggerId}": ${problem}`), stepIndex: this.sim.stepIndex, reason: 'load' });
      // Nothing to wait for: the unloads go as before.
      for (const sceneId of unload) this.enqueue({ op: 'unload', sceneId });
      return;
    }
    const fade = t.fade !== undefined && Number.isFinite(t.fade) ? Math.max(0, Math.min(MAX_TRANSITION_FADE, t.fade)) : 0;
    const color = t.fadeColor !== undefined && FADE_COLOR_RE.test(t.fadeColor) ? t.fadeColor : '#000000';
    this.enqueue({ op: 'load', sceneId: t.scene, transition: Object.freeze({ unload: Object.freeze(unload), fade, color }) });
    if (t.spawn === null) return;
    this.host.placement.arriveAt(t.spawn, t.scene);
  }

  /** A move along the shell's scene list, at the next step boundary. */
  requestListed(index: number): void {
    this.pendingListed = index;
  }

  /**
   * Move to the entry of the shell's scene list asked for (a `scene` UI
   * event, at a step boundary): the previous listed scene is unloaded unless
   * it is a start scene or the same scene; the entry's scene is loaded when
   * it is not; the character moves to the entry's spawn once it is (as a
   * trigger's scene transition). At a new run the run is at the first entry
   * whose scene is a start scene (else none).
   */
  goToListed(): void {
    if (this.pendingListed === null) return;
    const index = this.pendingListed;
    this.pendingListed = null;
    const entry = Number.isInteger(index) ? this.list[index] : undefined;
    if (entry === undefined) {
      this.faults.record({ code: 'scene_invalid', message: clipMessage(`the scene list has no entry ${String(index)}`), stepIndex: this.sim.stepIndex, reason: 'load' });
      return;
    }
    if (this.listed === null) this.listed = this.list.findIndex((x) => this.startBatchSource.has(x.scene));
    const prev = this.listed >= 0 ? this.list[this.listed] : undefined;
    this.listed = index;
    const unload = prev !== undefined && prev.scene !== entry.scene && !this.startBatchSource.has(prev.scene) && this.batches.has(prev.scene) ? [prev.scene] : [];
    if (!this.batches.has(entry.scene) && this.status.get(entry.scene) !== 'loading') {
      this.beginTransition(`scene list ${index}`, { scene: entry.scene, spawn: entry.spawn ?? null, unload, ...(entry.fade !== undefined ? { fade: entry.fade } : {}), ...(entry.fadeColor !== undefined ? { fadeColor: entry.fadeColor } : {}) });
      return;
    }
    for (const sceneId of unload) {
      const problem = this.opProblem('unload', sceneId);
      if (problem === null) this.enqueue({ op: 'unload', sceneId });
    }
    if (entry.spawn !== undefined) this.host.placement.arriveAt(entry.spawn, entry.scene);
  }

  // ---- A save's scenes ----------------------------------------------------

  /** The loaded scenes and the scene list entry, for a save. */
  capture(): Pick<WorldSave, 'scenes' | 'listedScene'> {
    return { scenes: [...this.batches.keys()], listedScene: this.listedIndex() };
  }

  /** Why a saved world's scenes cannot be restored in this game (null: they can). */
  worldProblem(world: WorldSave): string | null {
    if (this.rows === null) return null;
    for (const sceneId of world.scenes) if (!this.status.has(sceneId)) return `the save names scene "${sceneId}", which this game does not have`;
    if (world.listedScene >= this.list.length) return `the save is at scene list entry ${world.listedScene}; the list has ${this.list.length}`;
    return null;
  }

  /** Scenes not in the save are unloaded (the start set's pinned ones stay), the saved ones loaded; the scene list entry is the saved one. */
  restore(world: WorldSave): void {
    if (this.rows !== null) {
      const want = new Set(world.scenes);
      for (const sceneId of [...this.batches.keys()]) {
        if (want.has(sceneId) || this.opProblem('unload', sceneId) !== null) continue;
        this.enqueue({ op: 'unload', sceneId });
      }
      for (const sceneId of world.scenes) if (!this.batches.has(sceneId) && this.opProblem('load', sceneId) === null) this.enqueue({ op: 'load', sceneId });
    }
    this.listed = world.listedScene >= 0 ? world.listedScene : null;
  }

  // ---- A new run ----------------------------------------------------------

  /** A new run is at the scene list entry of its start scenes again. */
  newRun(): void {
    this.listed = null;
  }

  /** A replay starts from the start scenes again: others unloaded, unloaded start scenes restored. Returns false after a fail-stop. */
  restoreStartSet(): boolean {
    if (this.rows === null) return true;
    for (const b of [...this.batches.values()]) if (!b.start) this.removeBatch(b.sceneId);
    // The kept objects whose scene went go too: their start scenes bring them back.
    const orphans = this.host.kept.takeOrphans();
    if (orphans.size > 0) {
      const colliders = [...orphans].filter((id) => this.host.colliders.has(id) || this.sim.entities.get(id)?.hasCollider === true);
      this.host.detach(orphans, colliders, 'kept objects');
      this.changed();
    }
    for (const sceneId of [...this.requestedLoads.keys(), ...this.fetchingLoads.keys(), ...this.readyLoads.keys()]) {
      if (!this.startBatchSource.has(sceneId)) this.setStatus(sceneId, 'unloaded');
    }
    this.requestedLoads.clear();
    this.fetchingLoads.clear();
    this.readyLoads.clear();
    this.preparedLoads.clear();
    this.pendingUnloads.clear();
    this.pendingReloads.clear();
    // Transitions and their fades do not outlive the run.
    this.transitions.clear();
    this.lastSwap = null;
    this.loadingViewCache = null;
    // A scene transition's arrival, a spawn facing and scripts' impulses do not outlive the run.
    this.host.placement.startSetRestored();
    this.host.controllers.clearImpulses();
    for (const [sceneId, entities] of this.startBatchSource) {
      if (this.batches.has(sceneId)) continue;
      if (!this.addBatch(sceneId, entities, true)) return false;
    }
    return true;
  }

  // ---- Loading and unloading ------------------------------------------------

  private setStatus(sceneId: string, status: SceneStatus): void {
    this.status.set(sceneId, status);
    this.setCache = null;
  }

  /**
   * Add one scene. A scene that does not fit (duplicate ids, a start-only
   * entity, colliders without a capable port) is refused: logged, left
   * unloaded, the run continues. Returns `false` only after a fail-stop.
   */
  private addBatch(sceneId: string, all: readonly EntityV3[], start: boolean, prepared = false, placeReturning = !start): boolean {
    const host = this.host;
    const refuse = (why: string): boolean => {
      this.setStatus(sceneId, 'unloaded');
      this.faults.record({ code: 'scene_load_failed', message: clipMessage(`scene "${sceneId}" was not loaded: ${why}`), stepIndex: this.sim.stepIndex, reason: 'refused' });
      return true;
    };
    // A kept object of this scene that is still alive (the scene loaded again) is not brought a second time.
    const { entities, skipped } = host.kept.arriving(all, (id) => this.sim.entities.has(id));
    for (const e of entities) {
      if (this.sim.entities.has(e.id)) return refuse(`entity "${e.id}" is already loaded`);
    }
    const players = arrivalProblem(entities, host.controllers, this.sim.physics3d);
    if (players !== null) return refuse(players);
    // A loaded scene's entities arrive copied and frozen (prepared over the steps before).
    const frozen = prepared ? Object.freeze([...entities]) : deepFreeze(entities.map((e) => structuredClone(e)));
    const added = host.colliders.add(frozen, `scene "${sceneId}"`);
    if (!added.ok && 'refused' in added) return refuse(added.refused);
    if (!added.ok && 'failed' in added) {
      this.faults.failStop('physics_port_error', 'scene_colliders', added.failed, this.sim.stepIndex);
      return false;
    }
    const ids = new Set(frozen.map((e) => e.id));
    host.kept.add(frozen);
    host.attach(frozen);
    // The scene's block layers and their colliders (at this step boundary).
    if (host.grid.addLayers(frozen).length > 0) {
      try {
        host.grid.flushCollision(this.sim.physics3d);
      } catch (e) {
        this.faults.failStop('physics_port_error', 'scene_colliders', `adding the block colliders of scene "${sceneId}" failed: ${messageOf(e)}`, this.sim.stepIndex);
        return false;
      }
    }
    // Its kept objects that waited scene-less belong to it again (a restart keeping the scene keeps them).
    const adopted = skipped.length > 0 ? host.kept.adopt(skipped) : [];
    for (const e of adopted) ids.add(e.id);
    this.batches.set(sceneId, { sceneId, start, entities: adopted.length > 0 ? Object.freeze([...frozen, ...adopted]) : frozen, ids, colliderIds: colliderIdsOf(frozen) });
    this.setStatus(sceneId, 'loaded');
    this.revision += 1;
    if (!start) host.placement.arriveAtListedSpawn(sceneId);
    return host.playersArrive(frozen, placeReturning) && host.notifyLoaded(frozen);
  }

  /** The active scene is no longer loaded: the first scene still loaded (in load order) becomes active at once; none loaded keeps the look. */
  private reactivateIfGone(): void {
    const environment = this.host.environment;
    const active = environment.activeScene();
    if (active === null || this.batches.has(active)) return;
    const next = this.batches.keys().next();
    if (next.done !== true) environment.activate(next.value);
  }

  /** Remove one scene and release what belongs to it. */
  private removeBatch(sceneId: string, reloading = false): void {
    const batch = this.batches.get(sceneId);
    if (batch === undefined) return;
    const host = this.host;
    // Its kept objects stay (scene-less); the rest goes.
    const ids = host.kept.leave(batch.entities);
    host.detach(ids, batch.colliderIds.filter((id) => ids.has(id)), `scene "${sceneId}"`, reloading ? 'reload' : 'unload');
    // What a kept object named in the scene now reads as empty: said once (a reload brings it straight back).
    const refs = reloading ? [] : host.kept.referencesTo(ids, (id) => this.entityDocument(id));
    if (refs.length > 0) {
      const list = refs.slice(0, 4).map((r) => `"${r.from}" → "${r.to}"`).join(', ');
      const message = `kept objects name objects of the unloaded scene "${sceneId}" (${list}${refs.length > 4 ? ', …' : ''}): those references read as empty until something with the id is loaded again`;
      this.faults.log('thirdlight.runtime:scenes', 'warn', message);
      this.faults.problem('kept_reference_unloaded', message);
    }
    host.sceneSoundsGone(sceneId);
    // A pending arrival at a spawn of the unloaded scene is dropped.
    host.placement.dropArrivalAt(ids);
    this.batches.delete(sceneId);
    this.setStatus(sceneId, 'unloaded');
    this.revision += 1;
  }

  /**
   * `ctx.scenes.reload` at the boundary: the scene's objects leave and come
   * back as authored (where it was loaded), their scripts start over from
   * their reset hook (disposed and made again, no leave callbacks), the
   * copies its objects spawned go and its sounds stop. Kept objects, other
   * scenes, `ctx.save` and the counters are left as they are; a kept player
   * arrives at the scene's listed spawn as on a load. Returns false after a
   * fail-stop.
   */
  private reloadBatch(sceneId: string): boolean {
    const batch = this.batches.get(sceneId);
    if (batch === undefined) return true;
    const problem = this.opProblem('reload', sceneId);
    if (problem !== null) {
      this.faults.record({ code: 'scene_invalid', message: clipMessage(`scene "${sceneId}" was not reloaded: ${problem}`), stepIndex: this.sim.stepIndex, reason: 'reload' });
      return true;
    }
    this.host.removeSpawned(this.host.copiesOf(sceneId));
    this.removeBatch(sceneId, true);
    // Its players come back where it puts them.
    if (!this.addBatch(sceneId, batch.entities, batch.start, true, true)) return false;
    if (batch.start) this.host.placement.arriveAtListedSpawn(sceneId);
    return true;
  }
}
