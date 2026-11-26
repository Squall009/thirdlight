/** What a runtime is made from (`RuntimeArgs`), its log sink, and the engine timing in steps. */
import type { VoxelWorldPorts } from './voxel-world-host';
import { type RuntimeMaterialCatalog } from './material-params';
import { type SaveSchema } from '@thirdlight/project-model';
import type { BlockType, CellField } from '@thirdlight/project-model';
import {
  ENGINE_TIMING_DEFAULTS,
  type EntityV3,
  type PrefabDefinition,
  type RuntimeUiDocumentRow,
} from '@thirdlight/project-model';
import {
  type ActionSource,
} from './actions';
import { type ModuleEntry } from './runtime-sim';
import { type LiveTagIndex } from './scene-set';
import type { BehaviorLogLevel } from './intents';
import { type AnimatorControllerLike } from './animator';
import type { ScriptStop } from './types';
import type { TimelineAsset } from '@thirdlight/project-model';
import type { PhysicsPort3D } from './ports';
import {
  type RuntimeSceneRow,
  type GameplaySettings,
  type ModelBounds,
  type SimEntityData,
  type TransformState,
} from './types';

/**
 * The M2 settle pre-roll at 120 Hz — the engine's settle time
 * (0.1 s, `ENGINE_TIMING_DEFAULTS.settleTime`) converted at the step rate.
 */
export const SETTLE_PREROLL_STEPS = 12;
/** Steps a one-way platform lets the character drop through at 120 Hz (`ENGINE_TIMING_DEFAULTS.dropThroughTime`, 0.125 s). */
export const DROP_THROUGH_STEPS = 15;

/**
 * The engine timing in whole steps at `hz` (120 Hz gives
 * `SETTLE_PREROLL_STEPS` and `DROP_THROUGH_STEPS`).
 */
export function engineTimingSteps(hz: number): { settleSteps: number; dropThroughSteps: number } {
  return {
    settleSteps: Math.max(0, Math.round(ENGINE_TIMING_DEFAULTS.settleTime * hz)),
    dropThroughSteps: Math.max(1, Math.round(ENGINE_TIMING_DEFAULTS.dropThroughTime * hz)),
  };
}

export interface BehaviorLogSink {
  handler: ((moduleId: string, level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }) => void) | null;
  stopped?: (moduleId: string, stop: ScriptStop) => void;
}

/** What the runtime is made of: `instantiateRuntime`'s validated, resolved inputs. */
export interface RuntimeArgs {
  snapshotId: string;
  revision: number;
  hz: number;
  clock: () => number;
  clockLabel: 'performance' | 'injected';
  driverKind: 'raf' | 'manual';
  onFrame?: () => void;
  modules: string[];
  entries: ModuleEntry[];
  isM2: boolean;
  /** The engine timing in steps. */
  timing: { settleSteps: number; dropThroughSteps: number };
  actions: ActionSource;
  /** The physics port (absent: a game without physics). */
  physics3d?: PhysicsPort3D;
  /** How the scenes' voxel worlds are opened (absent: they stream nothing). */
  voxels?: VoxelWorldPorts;
  settings: GameplaySettings;
  /** The player controllers' objects, in snapshot order. */
  controllerEntityIds: readonly string[];
  order: string[];
  entities: Map<string, SimEntityData>;
  /** The project's lens (its camera settings): the view's while no camera sets its own. */
  viewLens: { fovY: number; near: number; far: number };
  prev: Map<string, TransformState>;
  curr: Map<string, TransformState>;
  logSink: BehaviorLogSink;
  sceneRows: readonly RuntimeSceneRow[] | null;
  startBatches: readonly { sceneId: string; entities: EntityV3[] }[];
  liveTags: LiveTagIndex | null;
  queryTags: LiveTagIndex | null;
  /** The controllers, and the snapshot scene's entities (their `animator` components). */
  animatorControllers: readonly AnimatorControllerLike[];
  initialEntities: readonly EntityV3[];
  /** The prefab definitions scripts spawn. */
  prefabs: readonly PrefabDefinition[];
  /** Model assetId -> its recorded bounds. */
  modelBounds: Readonly<Record<string, ModelBounds>>;
  /** audio assetId -> its recorded duration (ms). */
  audioDurations: Readonly<Record<string, number>>;
  /** Model rigs (sockets are resolved on them). */
  rigs?: Readonly<Record<string, import('@thirdlight/project-model').ModelRig>>;
  /** The models' `_COL` parts (colliders `{type: 'model'}` are made of them). */
  modelColliders?: import('@thirdlight/project-model').ModelColliderTable;
  /** Generated architecture's style and preset graphs. */
  architectureStyles?: readonly import('@thirdlight/project-model').ArchitectureGraphLike[];
  /** Injected script variables (validated; ctx.save from step 0). */
  variables?: Readonly<Record<string, unknown>>;
  /** The block types and cell fields of the project's block layers. */
  blockTypes: readonly BlockType[];
  cellFields: readonly CellField[];
  /** The graph materials' parameters (ctx.materials). */
  materialCatalog?: RuntimeMaterialCatalog;
  /** Every project material the game ships (what a material swap may name). */
  materialIds?: readonly string[];
  /** The project save schema and the stored project settings document. */
  saveSchema?: SaveSchema;
  projectSettings?: Readonly<Record<string, unknown>>;
  /** The project's UI documents (id, layer, modal). */
  uiDocuments: readonly RuntimeUiDocumentRow[];
  /** The compiled conversations, speakers and dialogue settings. */
  dialogue?: import('@thirdlight/project-model').RuntimeDialogueData;
  /** The project's game modes (absent: none) and the mode runs start in. */
  modes?: import('@thirdlight/project-model').RuntimeModes;
  startMode?: string;
  /** The project's timelines. */
  timelines?: readonly TimelineAsset[];
  /** The event → cue table. */
  eventCues?: readonly import('./types').RuntimeEventCue[];
  /** The shell's ordered scene list. */
  sceneList?: readonly import('./types').ListedScene[];
  /** The environment preset ids (ctx.environment). */
  environmentPresets: readonly string[];
}
