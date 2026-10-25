/**
 * The Scene view follows the editor: the project's render settings (instance
 * chunk size, LOD tuning, ambient occlusion, occlusion culling, see-through,
 * the renderer backend), the projection (only what changed since the last
 * sync; the first non-empty scene is framed), the selection and its gizmo,
 * the instance brush, the descriptors' handles and icons, the physics
 * dimension, the project's lens and the game view's aspect.
 */
import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { lodTuningOf, renderSettingsOf } from '@thirdlight/project-model/limits';
import { pageSearch, resolveRendererPreference } from '@thirdlight/three-adapter';
import { seeThroughSettingsOfProject, viewLensOf, type SeeThroughSettings } from '@thirdlight/runtime';
import type { ProjectedEntity } from '../../session/projection';
import type { GizmoMode } from '../../viewport/viewport';
import { iconTableOf } from '../../viewport/icons';
import { setEditorRendererChoice } from '../../viewport/renderer-choice';
import type { useInstanceBrush } from '../instances/InstanceBrush';
import type { ClientRef, ViewportRef } from './commands';
import { sceneViewEntities } from './useSceneViewSync';

export interface SceneViewFollowDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  settings: Readonly<Record<string, unknown>> | null;
  seeThroughPreview: boolean;
  entities: ProjectedEntity[];
  selection: { ids: string[]; primary: string | null };
  gizmoMode: GizmoMode;
  instanceBrush: ReturnType<typeof useInstanceBrush>;
  registry: DescriptorRegistry | null;
  setLightingMode: Dispatch<SetStateAction<'editor' | 'game'>>;
  setSelectedCopy: Dispatch<SetStateAction<number | null>>;
}

export function useSceneViewFollow(deps: SceneViewFollowDeps) {
  const { clientRef, viewportRef, settings, seeThroughPreview, entities, selection, gizmoMode, instanceBrush, registry, setLightingMode, setSelectedCopy } = deps;
  const selectedId = selection.primary;
  // A changed project chunk size rebuilds the instance sets that use it.
  const instanceChunkSetting = settings?.['instance_chunk_m'];
  useEffect(() => {
    viewportRef.current?.setInstanceChunkSize(typeof instanceChunkSetting === 'number' && instanceChunkSetting > 0 ? instanceChunkSetting : undefined);
  }, [viewportRef, instanceChunkSetting]);

  // The project's LOD bias and hysteresis: the Scene view picks levels as Play does.
  const lodBiasSetting = settings?.['lod_bias'];
  const lodHysteresisSetting = settings?.['lod_hysteresis'];
  useEffect(() => {
    viewportRef.current?.setLodTuning(lodTuningOf({ lod_bias: lodBiasSetting, lod_hysteresis: lodHysteresisSetting }));
  }, [viewportRef, lodBiasSetting, lodHysteresisSetting]);

  // The project's ambient occlusion kind: the Scene view draws a look's AO as Play does (render scale and dynamic
  // resolution are Play's and the export's: the Scene view stays at full resolution).
  const aoSetting = settings?.['ambient_occlusion'];
  useEffect(() => {
    viewportRef.current?.setAmbientOcclusion(renderSettingsOf({ ambient_occlusion: aoSetting }).ambientOcclusion);
  }, [viewportRef, aoSetting]);
  // The project's occlusion culling: the Scene view culls as Play does (the View menu can turn it off there).
  const occlusionSetting = settings?.['occlusion_culling'];
  useEffect(() => {
    viewportRef.current?.setOcclusionCulling(renderSettingsOf({ occlusion_culling: occlusionSetting }).occlusionCulling);
  }, [viewportRef, occlusionSetting]);

  // The See-through preview draws with the project's see-through settings (the preview's own on/off over theirs).
  const seeThroughSettings = JSON.stringify(seeThroughSettingsOfProject(settings));
  useEffect(() => {
    viewportRef.current?.setSeeThroughPreview(seeThroughPreview, JSON.parse(seeThroughSettings) as SeeThroughSettings);
  }, [viewportRef, seeThroughPreview, seeThroughSettings]);

  // The project's render_backend setting (under the page's ?renderer= flag) picks the
  // Scene view's backend and the one previews and thumbnails create their renderer with.
  const renderBackendSetting = settings?.['render_backend'];
  useEffect(() => {
    const choice = resolveRendererPreference({ url: pageSearch(), setting: renderBackendSetting });
    setEditorRendererChoice(choice);
    viewportRef.current?.setRendererChoice(choice.preference, choice.source);
  }, [viewportRef, renderBackendSetting]);

  // A ref mirror of selectedId for the viewport callbacks (stable closure).
  const selectedIdRef = useRef<string | null>(null);
  const selectionRef = useRef<string[]>([]);
  useEffect(() => {
    selectionRef.current = selection.ids;
  }, [selection]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Push the projection into the viewport (placements must be
  // visible; the viewport renders the projection, never the reverse). The
  // first non-empty scene is framed so a large level is in view on open.
  // Animated materials (wind, water) need frames while they are in view:
  // the Scene view ticks them with its own frames and keeps drawing only while one is animated
  // (render on demand: no animation-frame loop while nothing changes).
  const framedRef = useRef(false);
  useEffect(() => {
    // Only what changed since the last sync (the projection's dirty ids; a hydrate syncs all).
    const c = clientRef.current;
    viewportRef.current?.syncEntities(c !== null ? sceneViewEntities(c, entities) : entities, c?.projection.takeDirty());
    const lit = viewportRef.current?.getLighting();
    if (lit !== undefined) setLightingMode(lit);
    if (!framedRef.current && entities.length > 0) {
      framedRef.current = true;
      viewportRef.current?.frameAll(entities);
    }
  }, [clientRef, viewportRef, setLightingMode, entities]);

  // Selection → gizmo, and to the backend (tools can inspect the selection).
  useEffect(() => {
    viewportRef.current?.setSelected(selectedId, gizmoMode);
  }, [viewportRef, selectedId, gizmoMode]);
  // Another selection drops the selected copy (and the brush's mode, in its hook).
  useEffect(() => {
    setSelectedCopy(null);
  }, [setSelectedCopy, selectedId]);
  // Paint or erase is the store's invert, which the brush follows itself: only on and off re-arm it.
  const instanceBrushOn = instanceBrush.mode !== 'off';
  useEffect(() => {
    viewportRef.current?.setInstanceBrush(instanceBrushOn ? selectedId : null, instanceBrush.store, instanceBrush.brush);
  }, [viewportRef, instanceBrushOn, instanceBrush.store, instanceBrush.brush, selectedId]);
  // The descriptors drive the Scene-view handles.
  useEffect(() => {
    viewportRef.current?.setDescriptors(registry);
  }, [viewportRef, registry]);
  // The hierarchy's row icons come from the descriptors too.
  const iconTable = useMemo(() => iconTableOf(registry), [registry]);
  // The cameras without a lens of their own use the project's (its camera settings), in the Scene view as in Play.
  const lensKey = JSON.stringify(viewLensOf(settings));
  useEffect(() => {
    viewportRef.current?.setViewLens(JSON.parse(lensKey) as { fovY: number; near: number; far: number });
  }, [viewportRef, lensKey]);
  // The cameras' frustums use the game view's aspect: the preview while it plays, else the window (an export fills it).
  useEffect(() => {
    const update = (): void => {
      const frame = document.querySelector('iframe.tl-app__preview-frame');
      const r = frame?.getBoundingClientRect();
      viewportRef.current?.setGameAspect(r !== undefined && r.width > 0 && r.height > 0 ? r.width / r.height : window.innerWidth / Math.max(1, window.innerHeight));
    };
    update();
    window.addEventListener('resize', update);
    const timer = window.setInterval(update, 1000);
    return () => {
      window.removeEventListener('resize', update);
      window.clearInterval(timer);
    };
  }, [viewportRef]);
  useEffect(() => {
    clientRef.current?.setSelection(selection.ids);
  }, [clientRef, selection]);
  return { selectedIdRef, selectionRef, iconTable };
}
