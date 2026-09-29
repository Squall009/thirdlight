/**
 * Runtime types of the snapshot and its scenes: the frozen snapshot a play
 * starts from, scene rows, loading and transitions, and what scripts see of
 * the world and its random streams.
 */

import type {
  AnimatorController,
  EntityV3,
  GameplaySettings as ModelGameplaySettings,
  PrefabDefinition,
  ResolvedSceneV3,
  TagDefinition,
} from '@thirdlight/project-model';

/** One entity of any supported normalized scene version. */
export type RuntimeSnapshotEntity = ResolvedSceneV3['entities'][number];

/**
 * A complete normalized scene document (project-model §23: `schemaVersion`
 * 3, or 4 for the merged start scenes).
 */
export interface RuntimeScene {
  schemaVersion: 3 | 4;
  sceneId: string;
  revision: number;
  entities: RuntimeSnapshotEntity[];
}

/**
 * The runtime snapshot (runtime.md §2) — the ONLY input of a runtime
 * instance. `scene` is a complete normalized scene document. Phase 24.8: no
 * `game` wrapper field (the deleted game block).
 */
export interface RuntimeSnapshot {
  /** Exactly `<projectId>@r<revision>` (project-model §6). */
  snapshotId: string;
  projectId: string;
  /** Integer, 0 ≤ v ≤ 2^53−1; must equal `scene.revision`. */
  revision: number;
  scene: RuntimeScene;
  /**
   * Phase 12 (b), v3 only, optional: the project tag registry (`content.tags`).
   * The entities carry their effective masks once the scene is resolved.
   */
  tags?: readonly TagDefinition[];
  /**
   * Phase 12 (c), v4 only, optional: every scene of the project. `start`
   * scenes are merged into `scene` (their members listed in `entityIds`); the
   * others load on demand (`ctx.scenes.load`, an exit zone). Absent: the
   * whole snapshot scene is one fixed scene and the scene API is unavailable.
   */
  scenes?: readonly RuntimeSceneRow[];
  /** Phase 9.7, v4 only, optional: the project's animator controllers (`content.animators`). */
  animators?: readonly AnimatorController[];
  /** Phase 14.1, v4 only, optional: the project's prefab definitions (`ctx.spawn`). */
  prefabs?: readonly PrefabDefinition[];
  /**
   * Phase 15.3, v4 only, optional: model assetId -> its recorded bounds (the
   * asset's import metrics; the runtime never loads a model). A pickup
   * without a size collects over its model's bounds.
   */
  modelBounds?: Readonly<Record<string, ModelBounds>>;
  /**
   * Phase 23.13, v4 only, optional: audio/music assetId -> its recorded
   * duration in ms (the asset's import metrics). A script sound's `finished`
   * event is computed from it in the simulation.
   */
  audioDurations?: Readonly<Record<string, number>>;
  /**
   * Phase 23.11, v4 only, optional: model assetId -> its rig (nodes and node
   * animation channels, read from the GLB by the play/export closure) — the
   * data sockets are resolved on (the runtime never loads a model).
   */
  rigs?: Readonly<Record<string, import('@thirdlight/project-model').ModelRig>>;
  /** Phase 23.5, v4 only, optional: the block types block layers use (`content.blockTypes`). */
  blockTypes?: readonly import('@thirdlight/project-model').BlockType[];
  /** Phase 23.5, v4 only, optional: the cell metadata schema (`content.cellFields`). */
  cellFields?: readonly import('@thirdlight/project-model').CellField[];
  /**
   * Phase 23.12, optional: the graph materials' parameters, the model assets'
   * default mappings and the closure's textures (`ctx.materials` checks script
   * values against them; built from the manifest by `materialCatalogOf`).
   */
  materialCatalog?: import('./material-params').RuntimeMaterialCatalog;
  /** Phase 23.19, optional: the project save schema (`content.saveSchema`; `ctx.saves`). */
  saveSchema?: import('@thirdlight/project-model').SaveSchema;
  /** Phase 23.18, optional: the ids of the environment presets (`environment.presets`; `ctx.environment`). */
  environmentPresets?: readonly string[];
  /**
   * Phase 23.9a, v4 only, optional: the project's UI documents as the
   * simulation knows them (id, layer, modal) — `ctx.ui.show/hide` and a
   * frame's show/hide entries name them. The host draws the documents.
   */
  uiDocuments?: readonly import('@thirdlight/project-model').RuntimeUiDocumentRow[];
  /**
   * Phase 23.16, v4 only, optional: the compiled conversations, the speaker
   * registry and the dialogue settings (`ctx.dialogue`; built from the
   * manifest's `dialogue`).
   */
  dialogue?: import('@thirdlight/project-model').RuntimeDialogueData;
  /**
   * Phase 23.10, v4 only, optional: the project's game modes (the first is
   * the start mode) and each input action's map (the masking of inactive
   * maps). Absent: no modes — nothing of them runs or enters the digest.
   */
  modes?: import('@thirdlight/project-model').RuntimeModes;
  /** Phase 23.17, v4 only, optional: the project's timelines (`content.timelines`; `ctx.timeline`). */
  timelines?: readonly import('@thirdlight/project-model').TimelineAsset[];
  /** Phase 24.4i, v4 only, optional: the event → cue table (`content.eventCues`); absent: no event sounds. */
  eventCues?: readonly RuntimeEventCue[];
  /** Phase 24.4j, optional: the shell's ordered scene list (`content.shell.scenes`) the `scene` UI event walks. */
  sceneList?: readonly ListedScene[];
}

/** Phase 24.4i: one row of the event → cue table (project-model `EventCue`). */
export type RuntimeEventCue = import('@thirdlight/project-model').EventCue;

/** Phase 15.3: a model's axis-aligned bounds in its own space (metres). */
export interface ModelBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** Phase 12 (c): one scene of the project as the runtime knows it. */
export interface RuntimeSceneRow {
  sceneId: string;
  start: boolean;
  /** Start scenes: the ids of their (resolved) entities in the snapshot scene. */
  entityIds?: readonly string[];
}

/** Phase 24.4j: one entry of the shell's scene list (phase 25.24e: with the fade of a move to it). */
export interface ListedScene {
  readonly scene: string;
  readonly spawn?: string;
  readonly fade?: number;
  readonly fadeColor?: string;
}

/** Phase 12 (c): where a scene is in its load cycle. */
export type SceneStatus = 'unloaded' | 'loading' | 'loaded';

/**
 * Phase 12 (c): options of one scene load. `at` offsets the scene's root
 * entities (world units). Loads are keyed by scene id today; the batch shape
 * leaves room for keyed, repeated (instanced) loads of one scene later.
 */
export interface SceneLoadOptions {
  at?: readonly [number, number, number];
  /**
   * Phase 25.24e: scenes unloaded when this one is in (a transition). They
   * stay drawn until the loaded scene replaces them in the same step, so the
   * view never shows an empty world.
   */
  unload?: readonly string[];
  /** Phase 25.24e: seconds the view fades out before the swap and back in after it (0–5; absent: 0, no fade). */
  fade?: number;
  /** Phase 25.24e: the fade's colour ("#rrggbb"; absent: black). */
  fadeColor?: string;
}

/**
 * Phase 25.24e: a scene transition in progress (a trigger's scene
 * transition, a move along the shell's scene list, a load with `unload` or
 * `fade`): the scene it waits for, and where it is — `out` while the view
 * fades out, `loading` while the scene is read and prepared.
 */
export interface SceneTransitionView {
  readonly scene: string;
  readonly phase: 'out' | 'loading';
  /** How far the view has faded out (0–1; 1 for a transition without a fade). */
  readonly fade: number;
  /** The fade's length (seconds; 0: none) and colour. */
  readonly seconds: number;
  readonly color: string;
  /** The scenes it unloads once its scene is in. */
  readonly unload: readonly string[];
}

/**
 * Phase 25.24e: scene loading as the page reads it (a loading screen, the
 * fade): the scenes being loaded, the transition waiting (null: none) and
 * the last swap a transition made (the page fades back in once it has drawn
 * that scene set revision).
 */
export interface SceneLoadingView {
  readonly loading: readonly string[];
  readonly transition: SceneTransitionView | null;
  readonly swap: { readonly scene: string; readonly revision: number; readonly seconds: number; readonly color: string } | null;
}

/** Phase 12 (c): the scene API a behavior script reaches as `ctx.scenes`. */
export interface BehaviorSceneControl {
  /**
   * Request a load; it completes at a later step boundary. Loading or loaded ⇒ no-op.
   * @graphNode Load scene
   */
  load(sceneId: string, options?: SceneLoadOptions): void;
  /**
   * Request an unload at the next step boundary. Unloaded ⇒ no-op.
   * @graphNode Unload scene
   */
  unload(sceneId: string): void;
  /**
   * Where a scene is in its load cycle.
   * @graphPure
   * @graphNode Scene status
   */
  status(sceneId: string): SceneStatus;
  /**
   * The loaded scene ids, in load order.
   * @graphPure
   * @graphNode Loaded scenes
   */
  loaded(): readonly string[];
  /**
   * Phase 25.24e: the scenes being loaded (asked for, not yet in), in request order.
   * @graphPure
   * @graphNode Loading scenes
   */
  loading(): readonly string[];
  /**
   * Phase 25.24e: the scene transition in progress (its scene, `out` while the view fades out, `loading` while the scene loads), or null.
   * @graphPure
   * @graphNode Scene transition
   */
  transition(): SceneTransitionView | null;
}

/** Phase 12 (c): a read-only view of entity transforms (`ctx.world`). */
export interface BehaviorWorldView {
  /**
   * The entity's current transform (this step so far), or `undefined` when it is not loaded.
   * @graphPure
   * @graphNode Transform of
   */
  transform(entityId: string): Readonly<{ position: readonly [number, number, number]; rotation: readonly [number, number, number, number]; scale: readonly [number, number, number] }> | undefined;
  /**
   * Phase 23.7: the first loaded entity whose name is exactly `name` (case-sensitive), or `undefined`.
   * Entities are searched in load order: the start scene in document order, then later scenes and spawned copies as they arrived.
   * @graphPure
   * @graphNode Find object by name
   */
  find(name: string): string | undefined;
  /**
   * Phase 23.7: every loaded entity whose name is exactly `name` (case-sensitive), in load order (spawned copies included).
   * @graphPure
   * @graphNode Find objects by name
   */
  findAll(name: string): readonly string[];
  /**
   * Phase 23.7: every loaded entity carrying a component of this kind (as stored on the entity, e.g. `'collider'`, `'light'`, `'behavior'`), in load order (spawned copies included).
   * @graphPure
   * @graphNode Find objects with component
   */
  withComponent(kind: string): readonly string[];
}

/**
 * Phase 23.7: one seeded random number stream (`ctx.random`, `ctx.random.stream(name)`).
 * Replay-safe: the numbers come from the project's `random_seed` setting mixed with the
 * script id, the object's id and the stream name, and advance only when drawn — a replay,
 * the simulation worker and the page all draw the same numbers. Each new run starts over.
 */
export interface BehaviorRandomStream {
  /**
   * A number in [0, 1) (a multiple of 2^-32).
   * @graphNode Seeded random
   */
  next(): number;
  /**
   * A number in [min, max).
   * @graphNode Seeded random range
   * @graphDefault max 1
   */
  range(min: number, max: number): number;
  /**
   * A whole number from `min` to `max`, both included (the bounds are rounded inward).
   * @graphNode Seeded random integer
   * @graphDefault max 6
   */
  int(min: number, max: number): number;
  /**
   * True with probability `p` (0: never, 1: always).
   * @graphNode Seeded chance
   * @graphDefault p 0.5
   */
  chance(p: number): boolean;
  /**
   * One item of `list` chosen evenly, or `undefined` when it is empty.
   * @graphNode skip a list's random item is Seeded random integer with the list's Get item
   */
  pick<T>(list: readonly T[]): T | undefined;
}

/**
 * Phase 23.7: `ctx.random` — the instance's main seeded stream, plus named sub-streams.
 */
export interface BehaviorRandom extends BehaviorRandomStream {
  /**
   * An independent named stream of this object (the same name gives the same stream):
   * draws from one never shift the numbers of another, so adding a draw for loot does
   * not change the numbers used for movement. Names: 1–64 characters of letters, digits,
   * `_ . : -`; at most 64 streams per object.
   * @graphLabel name stream
   */
  stream(name: string): BehaviorRandomStream;
}

/** Phase 12 (c): one loaded scene as the runtime holds it (renderer/host view). */
export interface LoadedSceneBatch {
  readonly sceneId: string;
  readonly start: boolean;
  /** The scene's resolved entities (offset already applied), frozen. */
  readonly entities: readonly EntityV3[];
}

/** Phase 12 (c): the scene set the renderer syncs to (`revision` bumps on every change). */
export interface SceneSetView {
  readonly revision: number;
  readonly batches: readonly LoadedSceneBatch[];
  readonly status: Readonly<Record<string, SceneStatus>>;
  /**
   * Phase 14.1: the live spawned entities (`ctx.spawn`), in spawn order
   * (parents before children), frozen. An id may come back in a later run
   * as a new object: renderers compare the objects, not only the ids.
   */
  readonly spawned: readonly EntityV3[];
}

/** Phase 12 (c): a load the host must fetch (`takeSceneRequests`). */
export interface SceneLoadRequest {
  readonly sceneId: string;
  readonly at?: readonly [number, number, number];
}

/** The resolved gameplay settings (runtime.md §12.2; project-model §14). */
export type GameplaySettings = ModelGameplaySettings;