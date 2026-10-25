/**
 * The editor's refresh after every applied change: the entity list, the
 * scene headers, the content and settings slices (each keeps its previous
 * object while its content is the same, so panels keyed on them do not
 * redraw), and what the Scene view draws besides the entities — the
 * materials (with the decal pages they draw from), generated architecture's
 * graphs, the shown environment and the scenes' bakes, each handed over only
 * when it changed.
 */
import type * as THREE from 'three';
import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DecalPageRef, MaterialDef } from '@thirdlight/project-model';
import type { EnvironmentLike, LightingBakeLike, MaterialDefLike, MaterialFunctionLike, MaterialLibrary, WindLike } from '@thirdlight/three-adapter';
import { architectureGraphsOf, architectureStylesOf, type ArchitectureStyles } from '@thirdlight/runtime';
import type { SessionClient, ClientUiState } from '../../session/client';
import type { ProjectedEntity } from '../../session/projection';
import { withDecalPageRefs } from '../../session/decal-atlas';
import { withSlotTextureKeys } from '../../session/texture-slots';
import { withSceneViewInteriors, withSceneViewLights } from '../../session/building-interiors';
import type { SceneHeaderView } from '../Hierarchy';
import type { ClientRef, ViewportRef } from './commands';
import type { useProjectContent } from './useProjectContent';
import type { useProjectSettings } from './useProjectSettings';
import type { useBlockLayers } from './useBlockLayers';

/** The architecture graphs' table of the Scene view, made again only when the project's graphs change. */
let sceneTable: { graphs: readonly unknown[]; table: ArchitectureStyles } | null = null;

/** What the Scene view draws: the open scenes' objects, the interiors buildings make into them and their furnishing lights. */
export function sceneViewEntities(c: SessionClient, visible: readonly ProjectedEntity[] = c.visibleEntities()): ProjectedEntity[] {
  const graphs = c.getGraphs();
  if (sceneTable?.graphs !== graphs) sceneTable = { graphs, table: architectureStylesOf(architectureGraphsOf(graphs)) };
  return withSceneViewLights(withSceneViewInteriors(visible, c.projection.listEntities(), new Set(c.getSceneView().open)), sceneTable.table) as ProjectedEntity[];
}

export interface SceneViewSyncDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  setEntities: Dispatch<SetStateAction<ProjectedEntity[]>>;
  setLiveTransform: (t: null) => void;
  setSceneHeaders: Dispatch<SetStateAction<SceneHeaderView[] | null>>;
  setClosedScenes: Dispatch<SetStateAction<{ sceneId: string; name: string }[]>>;
  setUi: Dispatch<SetStateAction<ClientUiState>>;
  receiveContent: ReturnType<typeof useProjectContent>['receive'];
  receiveSettings: ReturnType<typeof useProjectSettings>['receive'];
  receiveBlocks: ReturnType<typeof useBlockLayers>['receive'];
}

export function useSceneViewSync(deps: SceneViewSyncDeps) {
  const { clientRef, viewportRef, setEntities, setLiveTransform, setSceneHeaders, setClosedScenes, setUi, receiveContent, receiveSettings, receiveBlocks } = deps;
  const materialLibraryRef = useRef<MaterialLibrary | null>(null);
  const materialsKeyRef = useRef('');
  /** The materials last received, and the composed decal pages the Scene view draws them with (null: their own textures). */
  const lastMaterialsRef = useRef<{ mats: MaterialDef[]; libFunctions: unknown[] } | null>(null);
  const decalPagesRef = useRef<{ signature: string; refs: Readonly<Record<string, DecalPageRef>>; preview?: true } | null>(null);
  /** The Scene view's materials, handed over again only when they or the decal pages drawn changed. */
  const sendMaterials = useCallback(() => {
    const last = lastMaterialsRef.current;
    if (last === null) return;
    const pages = decalPagesRef.current;
    // A preview and the pages that replace it share their signature, not their arrays.
    const matsKey = JSON.stringify([last.mats, last.libFunctions, pages?.signature ?? null, pages?.preview === true]);
    if (matsKey === materialsKeyRef.current) return;
    materialsKeyRef.current = matsKey;
    // A material's per-layer texture slots draw as the array the backend assembles from them; a decal material
    // draws from the composed decal pages (as in Play) while the decal atlas has current ones.
    materialLibraryRef.current?.setMaterials(withDecalPageRefs(withSlotTextureKeys(last.mats), pages?.refs ?? null) as unknown as MaterialDefLike[], last.libFunctions as unknown as MaterialFunctionLike[]);
    // A material that animates (wind, water) keeps the Scene view drawing from this frame on.
    viewportRef.current?.requestRender();
  }, [viewportRef]);
  const environmentKeyRef = useRef('');
  const lightingKeyRef = useRef('');
  const architectureKeyRef = useRef('');
  const planesKeyRef = useRef('');
  const loadTextureRef = useRef<((assetId: string) => Promise<THREE.Texture | null>) | null>(null);
  const previewTextureRef = useRef<((key: string, show: (t: THREE.Texture) => void) => THREE.Texture | null) | null>(null);

  /** The environment the Scene view shows: the active scene's look with the project's quality and presets. */
  const applyEnvironmentView = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    const shown = c.getShownEnvironment() as unknown as (EnvironmentLike & { wind?: unknown }) | null;
    materialLibraryRef.current?.setWind(((shown as { wind?: WindLike } | null)?.wind ?? null) as WindLike | null);
    materialLibraryRef.current?.setWetness((shown as { wetness?: number } | null)?.wetness ?? 0);
    const envKey = JSON.stringify(shown);
    if (envKey !== environmentKeyRef.current && loadTextureRef.current !== null) {
      environmentKeyRef.current = envKey;
      viewportRef.current?.setEnvironment(shown === null ? null : (shown as EnvironmentLike));
    }
  }, [clientRef, viewportRef]);

  // A refresh after every applied change must not hand React new
  // objects for what did not change — every panel keyed on them would redraw
  // (and effects such as the asset thumbnails and the Scene view sync would
  // rerun). A slice keeps its previous object while its content is the same.
  const stableRef = useRef(new Map<string, { key: string; value: unknown }>());
  const stable = useCallback(<T,>(slot: string, value: T, key: string = JSON.stringify(value instanceof Map ? [...value] : value) ?? 'undefined'): T => {
    const prev = stableRef.current.get(slot);
    if (prev !== undefined && prev.key === key) return prev.value as T;
    stableRef.current.set(slot, { key, value });
    return value;
  }, []);
  const refreshEntities = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    // The projection hands out the same array until an entity changes.
    setEntities(c.visibleEntities());
    setLiveTransform(null);
    // The scene headers (open scenes) and the closed scenes.
    const scenes = c.projection.scenes;
    if (scenes.length === 0) {
      setSceneHeaders(null);
      setClosedScenes(stable('closedScenes', []));
    } else {
      const view = c.getSceneView();
      const counts = new Map<string, number>();
      for (const e of c.projection.listEntities()) if (e.sceneId !== undefined) counts.set(e.sceneId, (counts.get(e.sceneId) ?? 0) + 1);
      const start = new Set(c.projection.startScenes);
      setSceneHeaders(stable('sceneHeaders', scenes.filter((r) => view.open.includes(r.sceneId)).map((r) => ({ sceneId: r.sceneId, name: r.name, start: start.has(r.sceneId), active: r.sceneId === view.active, entityCount: counts.get(r.sceneId) ?? 0 }))));
      setClosedScenes(stable('closedScenes', scenes.filter((r) => !view.open.includes(r.sceneId)).map((r) => ({ sceneId: r.sceneId, name: r.name }))));
    }
    const { materials: mats, lighting, lightingKey } = receiveContent(c, stable);
    receiveSettings(c, stable);
    // Graph materials compile to TSL in the Scene view too (the library recompiles only when a
    // graph's compile input changes — moving a node does not), with the material functions they call.
    const libFunctions = c.getGraphs().filter((g) => g.kind === 'material-function');
    lastMaterialsRef.current = { mats: mats as unknown as MaterialDef[], libFunctions };
    sendMaterials();
    // Generated architecture's styles, presets, room programs and furnishing sets: outlines are made again where their elements changed.
    const archGraphs = architectureGraphsOf(c.getGraphs());
    const archKey = JSON.stringify(archGraphs);
    if (archKey !== architectureKeyRef.current) {
      architectureKeyRef.current = archKey;
      viewportRef.current?.setArchitectureStyles(archGraphs);
    }
    // The scenes' default planes: the colliders' outlines and the gizmo's plane lock.
    const planes = c.getScenePlanes();
    const planesKey = JSON.stringify([...planes]);
    if (planesKey !== planesKeyRef.current && viewportRef.current !== null) {
      planesKeyRef.current = planesKey;
      viewportRef.current.setScenePlanes(new Map(planes));
    }
    // The project environment (wind included).
    applyEnvironmentView();
    // The scenes' bakes (lightmaps in the Scene view with game lighting).
    if (lightingKey !== lightingKeyRef.current && loadTextureRef.current !== null) {
      lightingKeyRef.current = lightingKey;
      viewportRef.current?.setLightmaps(lighting as unknown as Record<string, LightingBakeLike>);
    }
    receiveBlocks(c, stable);
    setUi((s) => (s.revision === c.projection.revision ? s : { ...s, revision: c.projection.revision }));
  }, [clientRef, viewportRef, setEntities, setLiveTransform, setSceneHeaders, setClosedScenes, setUi, applyEnvironmentView, stable, receiveContent, receiveSettings, receiveBlocks, sendMaterials]);

  return { refreshEntities, sendMaterials, materialLibraryRef, decalPagesRef, loadTextureRef, previewTextureRef };
}
