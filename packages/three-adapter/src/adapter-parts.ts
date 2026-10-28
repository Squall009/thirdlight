/**
 * The parts `createSceneAdapter` composes, as the frame, the diagnostics and
 * the adapter's surface reach them: each subsystem behind its own module,
 * and the little state they share (disposed, the baked lightmaps, the view's
 * camera).
 */
import type * as THREE from 'three';

import type { AdapterEffects } from './adapter-effects';
import type { AdapterClusters } from './cluster-frame';
import type { AdapterEntities } from './adapter-entities';
import type { AdapterEnvironment, EnvironmentFrameHost } from './adapter-environment';
import type { AdapterLevel } from './adapter-level';
import type { AdapterMaterials } from './adapter-materials';
import type { AdapterModels } from './adapter-models';
import type { AdapterRenderer } from './adapter-renderer';
import type { AdapterScenes } from './adapter-scenes';
import type { SceneAdapterOptions } from './adapter-types';
import type { AutoBatcher } from './batching';
import type { Precompile } from './environment-nodes';
import type { GpuTiming } from './gpu-timing';
import type { IsolationView } from './isolation-view';
import type { LightmapSet } from './lightmaps';
import type { SceneLights } from './lights-shadows';
import type { OcclusionCuller } from './occlusion';
import type { PrecompileGate } from './precompile-gate';
import type { ProbeLightingHost } from './probe-grids';
import type { QualityControl } from './quality-control';
import type { RenderControl } from './render-control';
import type { RenderGraph } from './render-graph';
import type { AdapterSurfaceLight } from './adapter-surface-light';
import type { SurfaceCacheHost } from './surface-cache-host';
import type { AnyRenderer } from './renderer-factory';
import type { ViewCuller } from './view-cull';

/** What the parts share and change. */
export interface AdapterState {
  disposed: boolean;
  /** The baked lightmaps (replaced when an editing host applies new bakes). */
  lightmaps: LightmapSet | null;
  /** The view's camera, posed every frame from the camera brain (null after dispose). */
  camera: THREE.PerspectiveCamera | null;
  /** Entities the runtime hides (`ctx.game.setVisible`, a collected collectible), with their children. */
  hiddenIds: ReadonlySet<string>;
}

export interface AdapterParts {
  readonly opts: SceneAdapterOptions;
  readonly scene: THREE.Scene;
  readonly state: AdapterState;
  readonly graph: RenderGraph;
  readonly materials: AdapterMaterials;
  readonly effects: AdapterEffects;
  readonly entities: AdapterEntities;
  readonly scenes: AdapterScenes;
  readonly models: AdapterModels;
  readonly renderer: AdapterRenderer;
  readonly environment: AdapterEnvironment;
  /** What else asks for the environment renderer and is set on it each frame. */
  readonly environmentFrame: EnvironmentFrameHost;
  readonly lights: SceneLights;
  /** The local lights' cluster lists, built and uploaded every frame for the camera drawn. */
  readonly clusters: AdapterClusters;
  readonly probes: ProbeLightingHost;
  readonly level: AdapterLevel;
  /** The surface cache (null: the host turned it off). */
  readonly surfaceCache: SurfaceCacheHost | null;
  /** The cache's live light on a WebGPU device (null: no cache). */
  readonly surfaceLight: AdapterSurfaceLight | null;
  /** Whether the light runs live where the level lets it (false: held to the saved light, as at a level without a live budget). */
  readonly liveLighting: { readonly on: boolean; set(on: boolean): void };
  readonly batcher: AutoBatcher | null;
  readonly viewCull: ViewCuller;
  readonly isolation: IsolationView;
  readonly occlusion: OcclusionCuller;
  readonly precompile: PrecompileGate;
  readonly qualityControl: QualityControl;
  readonly renderControl: RenderControl;
  readonly gpuTiming: GpuTiming;
  /** The page clock's start (material and effect time). */
  readonly clockStart: number;
  /** The key light's shadow square follows the camera (v3/v4 scenes). */
  readonly followShadow: boolean;
  /** The loaded scenes' lights picked again (the most recent scene's, the local ones within the budget). */
  selectLights(): void;
  /** An entity's look, material or flags changed outside its realization: its meshes are grouped again. */
  regroupEntity(entityId: string): void;
  /** The scene as the frame would draw it, compiled. */
  compileFrame(renderer: AnyRenderer): Precompile;
}
