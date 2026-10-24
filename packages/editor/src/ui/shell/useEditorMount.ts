/**
 * The editor's mount: the session client (backend transport) and the
 * imperative Scene view (its canvas, its assets, the gesture and handle
 * callbacks, the block and terrain tools), the asset tiles' pictures and the
 * catalog's subscription, made once and connected; all of it released on
 * unmount.
 */
import type * as THREE from 'three';
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { pageSearch, resolveRendererPreference, type MaterialLibrary, type RendererInfo } from '@thirdlight/three-adapter';
import type { readEditorConfig } from '../../config';
import { SessionClient, type ClientUiState, type PlayStartResult } from '../../session/client';
import { Gesture } from '../../session/gesture';
import { loadSnapSettings, type SnapSettings } from '../../session/snapping';
import { Viewport, type GizmoMode } from '../../viewport/viewport';
import type { ModelFiles } from '../../viewport/model-files';
import { createSceneViewAssets } from '../../viewport/scene-assets';
import { extractedImagePictures, TileThumbnails } from '../../viewport/thumbnails';
import { editorRendererChoice, setEditorRendererChoice } from '../../viewport/renderer-choice';
import type { WorkspaceAction, WorkspaceState } from '../../session/editor-window';
import type { ClientRef, ReportFailure, SetNotice, ViewportRef } from './commands';
import type { usePlaySession } from './usePlaySession';
import type { useBlockLayers } from './useBlockLayers';
import type { useTerrainTools } from './useTerrainTools';
import type { useProjectContent } from './useProjectContent';
import type { useSceneEditing } from './useSceneEditing';
import { sceneViewEntities } from './useSceneViewSync';

type PlaySession = ReturnType<typeof usePlaySession>;

export interface EditorMountDeps {
  cfg: MutableRefObject<ReturnType<typeof readEditorConfig>>;
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  /** The Scene view's canvas is put in this host. */
  viewportHostRef: MutableRefObject<HTMLDivElement | null>;
  gestureRef: MutableRefObject<Gesture | null>;
  modelFilesRef: MutableRefObject<ModelFiles | null>;
  materialLibraryRef: MutableRefObject<MaterialLibrary | null>;
  loadTextureRef: MutableRefObject<((assetId: string) => Promise<THREE.Texture | null>) | null>;
  previewTextureRef: MutableRefObject<((key: string, show: (t: THREE.Texture) => void) => THREE.Texture | null) | null>;
  workspaceRef: MutableRefObject<WorkspaceState>;
  snappingRef: MutableRefObject<boolean>;
  shiftRef: MutableRefObject<boolean>;
  enterEditModeRef: MutableRefObject<(entityId: string, kind?: string, activated?: boolean) => boolean>;
  /** The gizmo mode the Scene view's first picks select with. */
  gizmoMode: GizmoMode;
  play: Pick<PlaySession, 'setPlaying' | 'setPlayInfo' | 'bridgeRef' | 'forwardRelayRef'>;
  blocks: Pick<ReturnType<typeof useBlockLayers>, 'setBlockEditor' | 'blockHandlersRef'>;
  terrainTools: ReturnType<typeof useTerrainTools>;
  content: ReturnType<typeof useProjectContent>;
  /** The copies' edits (the scene editing hook is made after the mount). */
  editCopies: () => ReturnType<typeof useSceneEditing>['editCopiesRef']['current'];
  /** Forget the asset preview (the assets window is made after the mount). */
  forgetAssetPreview: () => void;
  refreshEntities: () => void;
  setLiveTransform: Dispatch<SetStateAction<{ id: string; position: number[]; rotation: number[]; scale: number[] } | null>>;
  setUi: Dispatch<SetStateAction<ClientUiState>>;
  setCenterTab: (key: 'scene' | 'game') => void;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  setSessionClient: Dispatch<SetStateAction<SessionClient | null>>;
  setSceneRenderer: Dispatch<SetStateAction<RendererInfo | null>>;
  setViewFailures: Dispatch<SetStateAction<{ id: string; name: string; code: string; message: string }[]>>;
  setInstanceChunks: Dispatch<SetStateAction<Record<string, number>>>;
  setSelectedId: (id: string | null) => void;
  setSelectedCopy: Dispatch<SetStateAction<number | null>>;
  setSnapSettingsState: Dispatch<SetStateAction<SnapSettings>>;
  setTileThumbnails: Dispatch<SetStateAction<TileThumbnails | null>>;
  setCatalogTick: Dispatch<SetStateAction<number>>;
  reportFailure: ReportFailure;
  setNotice: SetNotice;
}

export function useEditorMount(deps: EditorMountDeps): void {
  // The viewport and session client are made once per mount: the effect reads the first render's deps.
  useEffect(() => {
    const { cfg, clientRef, viewportRef, viewportHostRef, gestureRef, modelFilesRef, materialLibraryRef, loadTextureRef, previewTextureRef, workspaceRef, snappingRef, shiftRef, enterEditModeRef, gizmoMode, play, blocks, terrainTools, content, editCopies, forgetAssetPreview, refreshEntities, setLiveTransform, setUi, setCenterTab, workspaceDispatch, setSessionClient, setSceneRenderer, setViewFailures, setInstanceChunks, setSelectedId, setSelectedCopy, setSnapSettingsState, setTileThumbnails, setCatalogTick, reportFailure, setNotice } = deps;
    const { setPlaying, setPlayInfo, bridgeRef, forwardRelayRef } = play;
    const { setBlockEditor, blockHandlersRef } = blocks;
    if (!cfg.current.ok) return;
    const config = cfg.current.config;
    const client = new SessionClient(config, {
      onState: (s) => setUi(s),
      onSceneChanged: () => refreshEntities(),
      onPlayStarted: (r: PlayStartResult & { snapshot: unknown }) => {
        setPlaying(true);
        setCenterTab('game');
        setPlayInfo((p) => ({
          playSessionId: r.playSessionId,
          playBase: r.playBase,
          snapshot: r.snapshot,
          snapshotId: r.snapshotId,
          revision: r.revision,
          contentId: r.playContent?.contentId ?? p?.contentId ?? null,
          buildId: r.playContent?.buildId ?? p?.buildId ?? null,
          contentPath: r.playContent?.path ?? p?.contentPath ?? null,
        }));
      },
      onPlayStopRequested: (playSessionId) => {
        bridgeRef.current?.requestStop(playSessionId);
      },
      onPlayStopped: () => {
        setPlaying(false);
        // Back to the Scene from the (now empty) Game view; an editor window stays in front.
        if (workspaceRef.current.view === 'game') workspaceDispatch({ type: 'view', view: 'scene' });
        setPlayInfo(null);
        bridgeRef.current = null;
      },
      onRelayRequest: (req) => forwardRelayRef.current(req),
    });
    clientRef.current = client;
    setSessionClient(client);

    // The Viewport owns its canvas (a renderer backend change swaps it for a fresh one).
    const canvas = document.createElement('canvas');
    canvas.className = 'tl-viewport';
    viewportHostRef.current!.replaceChildren(canvas);
    const initialRenderer = resolveRendererPreference({ url: pageSearch() });
    setEditorRendererChoice(initialRenderer);
    // What the Scene view loads from assets (models, textures, project materials), in one resource manager:
    // its adapter draws the placements from it, the editor's panels read the same files through it.
    // The resolver is the editor's authenticated byte read; the renderer never receives the token.
    // A placement's file that failed and the editor's own reads that failed, together in Problems.
    let viewFailed: ReadonlyMap<string, { code: string; message: string }> = new Map();
    let filesFailed: ReadonlyMap<string, { code: string; message: string }> = new Map();
    const showFailures = (): void => setViewFailures([...new Map([...filesFailed, ...viewFailed])].map(([id, f]) => ({ id, name: client.content.getAsset(id)?.displayName ?? id, code: f.code, message: f.message })));
    const sceneAssets = createSceneViewAssets({
      client,
      changed: () => viewportRef.current?.materialsChanged(),
      // What the Scene view holds from assets now (tests read it).
      onResources: (r) => viewportHostRef.current?.setAttribute('data-resources', JSON.stringify(r.resident)),
      onSetBuilt: (entityId, chunks) => setInstanceChunks((prev) => (prev[entityId] === chunks ? prev : { ...prev, [entityId]: chunks })),
      onFailuresChanged: (failures) => {
        filesFailed = new Map(failures);
        showFailures();
      },
    });
    const viewport = new Viewport(canvas, {
      onPick: (id) => {
        setSelectedId(id);
        viewport.setSelected(id, gizmoMode);
      },
      onGestureBegin: (id) => {
        const base = client.entityTransform(id);
        gestureRef.current = base ? new Gesture(id, client.projection.revision, base) : null;
      },
      onGestureFrame: (id, t) => {
        // The viewport already moved the Object3D (local preview, no traffic);
        // mirror the live transform into the inspector readout.
        // Only the readout changes (the entity list keeps its identity, so nothing else redraws).
        setLiveTransform({ id, position: t.position, rotation: t.rotation, scale: t.scale });
      },
      onGestureEnd: async (id, transform) => {
        const g = gestureRef.current;
        gestureRef.current = null;
        // Any outcome other than an accepted commit restores the projection
        // (an accepted commit arrives as mutation.applied and refreshes it).
        const restore = (): void => {
          refreshEntities();
          viewport.syncEntities(sceneViewEntities(client));
        };
        if (!g) return restore();
        g.setLocal(transform);
        const outcome = g.decideCommit();
        if (outcome.kind !== 'commit') return restore();
        // A prop's block footprint follows it in the same command (the backend writes it).
        const res = await client.command('setTransform', { entityId: id, transform: outcome.command.args.transform }, outcome.command.expectedRevision);
        if (res.ok) return;
        if (res.response.ok === false && res.response.code === 'revision_conflict') {
          // Bounded auto-rebase (≤ 1) via the gesture; if it still conflicts,
          // the conflict is surfaced in the status bar (explained, not lost).
          const retried = g.handleResult(
            { ok: false, code: 'revision_conflict', currentRevision: res.response.currentRevision ?? 0 },
            () => client.entityTransform(id) ?? transform,
          );
          if (retried.kind === 'commit') {
            const r2 = await client.command('setTransform', { entityId: id, transform: retried.command.args.transform }, retried.command.expectedRevision);
            if (r2.ok) {
              return;
            }
          }
        }
        restore();
      },
      // A dragged handle (any descriptor handle: sizes, radii, capsules, ranges, cones,
      // directions, paths, polygon corners) — one setComponent on release, one undo step.
      onHandleEdit: (entityId, component, value) => {
        const c = clientRef.current;
        if (!c) return;
        void c.setComponent(entityId, component, value, c.projection.revision).then((r) => {
          // A drag that ends where it began changes nothing: not an error.
          if (!r.ok && (r.response as { code?: string }).code === 'no_change') return;
          reportFailure(component === 'controller' ? 'Collision capsule' : 'Handle edit', r);
        });
      },
      onHandleRefused: (message) => setNotice(`Not stored: ${message}`),
      // One copy of an instance set.
      onCopyPick: (_entityId, index) => {
        viewportRef.current?.setSelectedCopy(index);
        setSelectedCopy(index);
      },
      onCopyTransform: (entityId, index, t) => void editCopies().transform(entityId, index, t),
      onBrushStroke: (entityId, stroke) => editCopies().paint(entityId, stroke),
      onRendererChange: (info) => setSceneRenderer(info),
      onModelFailures: (failures) => {
        viewFailed = failures;
        showFailures();
      },
      onDoublePick: (entityId) => void enterEditModeRef.current(entityId, undefined, true),
    }, { assets: sceneAssets, snapping: () => snappingRef.current && !shiftRef.current, renderer: initialRenderer });
    setSceneRenderer(viewport.rendererInfo());
    viewportRef.current = viewport;
    viewport.setHidden(workspaceRef.current.view === 'game');
    // The block tools (a stroke is one editBlocks, sent on release).
    const blockEd = viewport.blockEditor({
      onCommit: async (entityId, edits) => {
        const r = await client.command('editBlocks', { entityId, edits }, client.projection.revision);
        if (!r.ok && (r.response as { code?: string }).code === 'no_change') return false;
        if (!r.ok) setNotice(`Block edit failed: ${(r.response as { message?: string }).message ?? (r.response as { code?: string }).code ?? 'unknown error'}`);
        else blockHandlersRef.current?.onCommitted(entityId, edits);
        return r.ok;
      },
      onPick: (cell) => blockHandlersRef.current?.onPick(cell),
      onSelect: (box) => blockHandlersRef.current?.onSelect(box),
      onHover: (at, cell) => blockHandlersRef.current?.onHover(at, cell),
      onPickCell: (at, cell) => blockHandlersRef.current?.onPickCell(at, cell),
      onRefused: (message) => setNotice(message),
    });
    setBlockEditor(blockEd);
    // The terrain tools (a stroke is one editTerrain, previewed on the GPU, sent on release).
    terrainTools.makeTerrainEditor(client);
    setSnapSettingsState(loadSnapSettings(typeof window !== 'undefined' ? window.localStorage : null, config.projectId));
    const { loadTexture: loadTextureAsset, materialLibrary, files } = sceneAssets;
    loadTextureRef.current = loadTextureAsset;
    previewTextureRef.current = sceneAssets.previewTexture;
    materialLibraryRef.current = materialLibrary;
    modelFilesRef.current = files;
    const thumbnails = new TileThumbnails({
      read: (digest, piece, make) => client.thumbnail(digest, piece, make),
      store: (digest, piece, png) => client.storeThumbnail(digest, piece, png),
      modelBytes: (assetId, version) => client.assetBytes(assetId, version),
      vertexColorsFor: (assetId) => client.content.getAsset(assetId)?.vertexColors ?? 'data',
      renderer: () => editorRendererChoice(),
      extractedImages: (assetId) => extractedImagePictures(client, assetId),
    });
    setTileThumbnails(thumbnails);
    // Records read by id arrived (a model the Scene view waited for) or the catalog changed: draw again.
    let loadedSeen = client.catalog.loaded;
    const unsubscribe = client.catalog.subscribe(() => {
      setCatalogTick((t) => t + 1);
      if (client.catalog.loaded !== loadedSeen) {
        loadedSeen = client.catalog.loaded;
        viewport.syncEntities(sceneViewEntities(client));
        // Conversations read by id (a tab opened, a preview's jumps).
        content.setDialogues(client.getDialogues());
      }
      // An asset's facts changed (a reimport, its vertex colours or default materials): its placements are drawn again.
      viewport.assetsChanged();
    });
    viewport.resize();
    void client.connect();
    refreshEntities();

    const onResize = (): void => viewport.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      unsubscribe();
      setSessionClient(null);
      client.dispose();
      thumbnails.dispose();
      setTileThumbnails(null);
      // The view first: its adapter lets go of what it holds in the assets' manager.
      viewport.dispose();
      sceneAssets.dispose();
      materialLibraryRef.current = null;
      modelFilesRef.current = null;
      forgetAssetPreview();
      clientRef.current = null;
      viewportRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the viewport and session client are made once per mount
  }, []);
}
