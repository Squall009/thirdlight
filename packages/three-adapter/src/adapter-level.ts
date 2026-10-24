/**
 * The adapter's level: world streaming on a game page, rule scatter and ground
 * cover, splines, generated architecture and its rooms, clipped decals, block
 * layers and terrains with their cut-aways, and see-through round the view's
 * subjects — each made with what it needs from the rest of the adapter.
 *
 * Kept apart from the adapter so the level's views are wired in one place.
 */
import type * as THREE from 'three';
import type { BlockType, ResourceManager } from '@thirdlight/runtime';

import type { SceneAdapterOptions } from './adapter-types';
import { createAdapterArchitecture, type AdapterArchitecture } from './architecture-adapter';
import type { ArchitectureView } from './architecture-view';
import type { AutoBatcher } from './batching';
import { createBrowserMeshWorker } from './block-mesh-pool';
import type { BlockLayerView } from './block-layers';
import type { CutawayFollower } from './block-cutaway-follow';
import { CLIPPED_DECALS_KEY, ClippedDecals } from './clipped-decals';
import { materialParamsOf } from './entity-refs';
import { createLevelViews } from './level-views';
import type { LightmapSet } from './lightmaps';
import type { SceneLights } from './lights-shadows';
import type { MaterialLibrary } from './material-library';
import type { ModelsRealization } from './models';
import type { PrecompileGate } from './precompile-gate';
import type { RenderGraph } from './render-graph';
import { createScatterHost, type ScatterHost } from './scatter-host';
import { SeeThroughView, seeThroughEntitiesOf, type SeeThroughScripted } from './see-through';
import type { StaticShadowRevision } from './shadow-casters';
import { SplineView } from './spline-view';
import type { TerrainTileStore } from './terrain-tile-store';
import type { TerrainView } from './terrain-view';
import { PageWorldStream, STREAMING_KEY } from './world-stream';
import type { SceneAdapterDiagnostics } from './adapter-types';
import type { AnyRenderer } from './renderer-factory';
import { bothMemberships, type ViewCuller } from './view-cull';

type Mapping = Readonly<Record<string, string>>;

/** What the level's views reach in the rest of the adapter. */
export interface AdapterLevelDeps {
  readonly opts: SceneAdapterOptions;
  readonly scene: THREE.Scene;
  readonly resources: ResourceManager;
  readonly canvas: unknown;
  readonly graph: RenderGraph;
  readonly materialLibrary: MaterialLibrary | null;
  /** An object's mapping with the swap it wears over it. */
  effectiveMaterials(entityId: string, own: Mapping | undefined): Mapping | undefined;
  /** A realized object's components (undefined: not realized). */
  components(entityId: string): SceneAdapterOptions['snapshot']['scene']['entities'][number]['components'] | undefined;
  realization(): ModelsRealization | null;
  lightmaps(): LightmapSet | null;
  readonly staticShadows: StaticShadowRevision | null;
  readonly batcher: AutoBatcher | null;
  readonly viewCull: ViewCuller;
  /** The live renderer (null: none yet). */
  renderer(): AnyRenderer | null;
  readonly lights: SceneLights;
  precompile(): PrecompileGate;
  /** The start scenes' models have settled. */
  startModelsIn(): boolean;
}

export interface AdapterLevel {
  readonly stream: PageWorldStream | null;
  readonly scatter: ScatterHost;
  readonly splines: SplineView;
  readonly archHost: AdapterArchitecture;
  readonly architecture: ArchitectureView;
  readonly clipped: ClippedDecals | null;
  readonly blockView: BlockLayerView;
  readonly terrains: TerrainView;
  readonly ownTiles: TerrainTileStore | null;
  readonly cutaways: CutawayFollower;
  readonly seeThrough: SeeThroughView;
  /** The authored block types (the swaps a running game makes go over them). */
  readonly blockTypes: BlockType[];
  /** An asset's material mapping (its import's, else the host's row of it). */
  assetMaterials(assetId: string): Mapping | undefined;
  diagnostics(d: SceneAdapterDiagnostics): void;
}

export function createAdapterLevel(d: AdapterLevelDeps): AdapterLevel {
  const { opts, scene, graph, materialLibrary, staticShadows, batcher, lights } = d;
  const blockPrefabs = (opts.snapshot as { prefabs?: readonly { prefabId: string; entities: readonly { parentLocalId?: string; components: Record<string, unknown> }[] }[] }).prefabs ?? [];
  const assetMaterials = (assetId: string): Mapping | undefined => (opts.models?.assets.find((a) => a.assetId === assetId) ?? opts.models?.rowOf?.(assetId))?.materials;
  const template = (assetId: string, piece: string | undefined, onReady: () => void) => d.realization()?.blockInstance?.(assetId, piece, onReady) ?? null;
  const read = opts.resolveBuffer ?? opts.models?.resolveBuffer ?? null;
  const dress = (root: THREE.Object3D, assetId: string) => {
    const mapping = assetMaterials(assetId);
    return materialLibrary !== null && mapping !== undefined && Object.keys(mapping).length > 0 ? materialLibrary.apply(root, mapping, null) : null;
  };
  const place = (root: THREE.Object3D, shown: boolean): void => (shown ? graph.listStatic(root) : graph.unlistStatic(root));
  const changed = (): void => opts.onChange?.();
  // World streaming (a game page): what streamed terrains, layers and scatter hold round the camera, within the budget.
  const stream = opts.streaming !== undefined ? new PageWorldStream({ budgetBytes: opts.streaming.budgetBytes, resources: d.resources, ...(opts.streaming.onProblem !== undefined ? { onProblem: opts.streaming.onProblem } : {}) }) : null;
  if (stream !== null) scene.userData[STREAMING_KEY] = stream;
  // Rule scatter on block layers and terrains: stored copies and ground cover (scatter-host.ts).
  const scatter = createScatterHost({
    stream, template, dress, read, place,
    shapeChanged: () => staticShadows?.bump(),
    tile: (digest) => (opts.terrainTiles ?? ownTiles)?.tile(digest),
    ...(opts.meshWorkerUrl !== undefined ? { worker: () => createBrowserMeshWorker(opts.meshWorkerUrl!, 'thirdlight-cover'), scatterWorker: () => createBrowserMeshWorker(opts.meshWorkerUrl!, 'thirdlight-scatter') } : {}),
    tuning: graph.lodTuning, renderer: () => d.renderer(),
    changed,
    drawn: opts.scatter !== false,
    // The terrains' view is made below (it hands its sources to this host); cover reads its page textures.
    surface: (id: string) => terrains.coverSurface(id),
  });
  // Splines: what they make (meshes, pieces' copies), and terrain ground cover kept clear of their scatter bands.
  const splines = new SplineView({
    cover: (list) => scatter.sink?.setSplines?.(list), read, template, dress,
    materials: (root, id) => {
      const c = d.components(id) as { materials?: Record<string, string> } | undefined;
      const mapping = d.effectiveMaterials(id, c?.materials);
      return materialLibrary !== null && mapping !== undefined ? materialLibrary.apply(root, mapping, materialParamsOf(c)) : null;
    },
    place,
    shapeChanged: () => staticShadows?.bump(),
    tuning: graph.lodTuning,
    changed,
    drawn: opts.splines !== false,
  });
  // Generated architecture: made at load from its parameters on generator workers, a chunk at a time nearest the eye.
  const archHost = createAdapterArchitecture({
    components: (id) => d.components(id), effectiveMaterials: d.effectiveMaterials, materialParams: materialParamsOf, materialLibrary, assetMaterials,
    template, read,
    graph, staticShadows, arrival: stream !== null ? { left: () => stream.arrivalLeft(), spent: (ms) => stream.arrived(ms) } : null, meshWorkerUrl: opts.meshWorkerUrl,
    store: opts.architectureStore ?? null, styles: opts.architectureStyles, drawn: opts.architecture !== false, changed,
    rooms: { scene, blocks: () => blockView, regroup: (o) => batcher?.touch(o), roomLights: (on) => lights.setRoomLights(on), culling: opts.portals !== false, canvas: d.canvas as { setAttribute?(k: string, v: string): void } | null },
  });
  const architecture = archHost.view;
  // They hear what enters and leaves the scene and what moved from the render graph (none walks the scene); rooms first
  // (the room is part of a batch's key).
  graph.setMembership(bothMemberships(archHost.rooms, bothMemberships(batcher, d.viewCull)));
  // Clipped decals: cut from the surfaces the graph holds, on the generator's workers, kept with its chunks' store.
  const clipped = opts.clippedDecals !== false ? new ClippedDecals({ node: (id) => graph.nodeFor(id) ?? null, dress: (mesh, id) => materialLibrary?.apply(mesh, { '*': id }, null) ?? null, workers: architecture, store: opts.architectureStore ?? null, changed, surfacesIn: () => d.startModelsIn() && !blockView.meshing() && !architecture.making() && !splines.making() }) : null;
  graph.onSurfaces(clipped);
  // A measurement reads their diagnostics from the scene (as the projected decals').
  if (clipped !== null) scene.userData[CLIPPED_DECALS_KEY] = { diagnostics: () => clipped.diagnostics() };
  // Block layers and terrains (level-views.ts), streamed round the camera on a game page; cut-aways follow their subject.
  const { blockView, terrains, ownTiles, cutaways } = createLevelViews({
    blockInstance: template,
    prefabs: blockPrefabs, assetMaterials, materials: materialLibrary, lightmaps: d.lightmaps,
    scene, runtime: opts.runtime, position: (id, out) => graph.world.position(id, out), precompileIdle: () => d.precompile().idle(), requestPrecompile: () => d.precompile().want(),
    staticShadows, listStatic: (o) => graph.listStatic(o), unlistStatic: (o) => graph.unlistStatic(o), lodBias: () => graph.lodTuning.bias,
    scatter: scatter.sink, stream, meshWorkerUrl: opts.meshWorkerUrl, tiles: opts.terrainTiles, read, onChange: changed,
    // The key light shines along its direction: toward it is the other way.
    sun: () => (([x, y, z]) => [-x, -y, -z] as const)(lights.keyDirection() ?? [0, 0, 0]),
    horizon: opts.terrainHorizon !== false,
  });
  // See-through round the subjects (the camera's target unless a host names others); off: nothing armed, nothing built.
  const viewOf = (): { target?: string; seeThrough?: SeeThroughScripted } | null | undefined => (opts.runtime as { cameraView?: () => { target?: string; seeThrough?: SeeThroughScripted } | null }).cameraView?.();
  const st = opts.seeThrough;
  const seeThrough = new SeeThroughView({ ...seeThroughEntitiesOf(graph), components: (id) => d.components(id), cameraTarget: () => viewOf()?.target ?? null, scripted: () => viewOf()?.seeThrough ?? null, ...(st?.pinned !== undefined ? { pinned: st.pinned } : {}), ...(st?.prebuild === true ? { prebuild: true } : {}), requestPrecompile: () => d.precompile().want(), onChange: changed, regroup: (o) => batcher?.touch(o), occluderLayers: () => blockView.occluderLayers(), ...(st?.onProblem !== undefined ? { onProblem: st.onProblem } : {}) }, st?.settings);
  const blockTypes = ((opts.snapshot as { blockTypes?: readonly BlockType[] }).blockTypes ?? []) as BlockType[];
  blockView.setTypes(blockTypes);
  return {
    stream, scatter, splines, archHost, architecture, clipped, blockView, terrains, ownTiles, cutaways, seeThrough, blockTypes, assetMaterials,
    diagnostics(out) {
      if (blockView.layerIds().length > 0) out.blocks = blockView.diagnostics();
      if (terrains.ids().length > 0) out.terrain = terrains.diagnostics();
      if (stream !== null) out.streaming = stream.diagnostics();
      if (splines.ids().length > 0) out.splines = splines.diagnostics();
      if (architecture.ids().length > 0) [out.architecture, out.rooms] = [architecture.diagnostics(), archHost.rooms.diagnostics()];
    },
  };
}
