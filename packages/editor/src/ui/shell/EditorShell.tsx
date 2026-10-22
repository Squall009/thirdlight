/**
 * The editor's shell as it is drawn: menus, toolbar, the hierarchy, the
 * centre (Scene and Game views, the stage that takes asset and material
 * drops), the bottom dock, the one Inspector (on the right dock or beside the
 * editor window), edit modes, tool windows, Project Settings, the status bar
 * and the dialogs; and the hosts the kit editor and the edit modes read.
 * Plain render functions over the editor's model (no hooks of their own), so
 * the page's element tree is the editor app's own.
 *
 * Browser-only.
 */
import type { JSX } from 'react';
import type { SessionClient } from '../../session/client';
import { ASSET_DRAG_TYPE, parseAssetDrag } from '../../session/placement';
import { publishBakeTexture } from '../../viewport/bake-run';
import { MenuBar } from '../MenuBar';
import { Hierarchy, type SceneAction } from '../Hierarchy';
import { Toolbar } from '../Toolbar';
import { StatusBar } from '../StatusBar';
import { CatalogProvider } from '../catalog/catalog-context';
import { ItemOpenerProvider } from '../catalog/item-opener';
import { MATERIAL_DRAG_TYPE } from '../material/MaterialInspector';
import { CentreTabs, EditorWindow } from '../workspace/EditorWindow';
import { ProjectSettingsWindow } from '../settings/ProjectSettingsWindow';
import { ProjectFilePicker } from '../ProjectFilePicker';
import { workspaceHostOf } from '../workspace/workspace-host';
import { presetSlidersHost } from '../architecture/PresetSliders';
import { EditModeShell } from '../editmode/EditModeShell';
import { editModeFor, editModeVia, isSceneMode, type EditModeHost } from '../editmode/modes';
import type { BlockModeHost } from '../blocks/block-host';
import type { KitDocumentHost } from '../kit/KitDocument';
import { SceneToolWindows } from '../tools/SceneToolWindows';
import { EditorDialogs } from './EditorDialogs';
import { editorMenus, hierarchyContextMenu } from './menus';
import { BottomDock } from './BottomDock';
import { InspectorDock } from './InspectorDock';
import type { BottomTab } from './dock-tabs';
import type { EditorModel } from './useEditorModel';

/** The kit editor's host (its tab and the Inspector beside it share its state). */
function makeKitHost(m: EditorModel): KitDocumentHost {
  const { kitEditor, content, materials, blocks, tileThumbnails, openDocument, clientRef } = m;
  return {
    editor: kitEditor,
    kits: content.kits,
    materials,
    graphs: content.graphs,
    blockTypes: blocks.blockTypes,
    thumbnails: tileThumbnails,
    onOpen: (kind, id) => openDocument(kind, id),
    docs: async (topic) => clientRef.current?.docsText(topic) ?? { ok: false, error: { message: 'not connected' } },
  };
}

/**
 * The block editor's host; with `via` (a grouped action's scope) its commands and model publishes are that
 * action's own, so the action's steps are grouped and nothing else sent meanwhile joins them.
 */
function makeBlockModeHost(m: EditorModel, via?: SessionClient): BlockModeHost {
  const { blocks, content, materials, docCmds, viewportRef, prefabSummaries, sceneEditing, setNotice, blockHandlersRef, clientRef, openDocument, reportFailure } = m;
  return {
    editor: blocks.blockEditor,
    rows: blocks.blockRows,
    types: blocks.blockTypes,
    fields: blocks.cellFields,
    stamps: blocks.blockStamps,
    kits: content.kits,
    graphs: content.graphs,
    presets: presetSlidersHost(content.graphs, materials, (graphId, ops) => docCmds.sendGraphEdit({ kind: 'graph', id: graphId }, ops), (p) => void viewportRef.current?.previewArchitecture(p)),
    prefabs: prefabSummaries,
    setLayer: blocks.setEditedLayer,
    run: (what, op, args) => blocks.blockRun(what, op, args, via),
    // A scope's own `grouped` joins its action.
    grouped: (action) => {
      const c = via ?? clientRef.current;
      return c !== null ? c.grouped((g) => action(makeBlockModeHost(m, g))) : action(makeBlockModeHost(m));
    },
    edit: (what, entityId, edits) => blocks.blockEdit(what, entityId, edits, via),
    changeLayer: (what, entityId, change) => blocks.changeLayer(what, entityId, change, via),
    setFlag: (id, flag, value) => void sceneEditing.setFlag(id, flag, value),
    notice: setNotice,
    handlers: blockHandlersRef,
    importModel: async (file) => {
      const c = via ?? clientRef.current;
      if (c === null) return null;
      if (!/\.glb$/i.test(file.name)) {
        setNotice(`${file.name}: a block look is a GLB file (export glTF binary from the modelling tool).`);
        return null;
      }
      const id = await publishBakeTexture(c, new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.[^.]+$/, ''), undefined, file.name, 'model');
      if (typeof id === 'string') return id;
      setNotice(id.message);
      return null;
    },
    openKit: (kitId) => openDocument('kit', kitId),
    clientRef: via === undefined ? clientRef : { current: via },
    viewportRef,
    reportFailure,
  };
}

/** What the edit modes read from the app. */
function makeEditModeHost(m: EditorModel): EditModeHost {
  const { terrainTools, vertexPaint, decalTools, decalAtlas, entities, activeScene, hierarchyFlags, blocks, tileThumbnails, materials, newMaterialId, openDocument, clientRef } = m;
  return {
    terrain: terrainTools,
    paint: vertexPaint,
    decals: decalTools,
    decalAtlas,
    blocks: makeBlockModeHost(m),
    entities,
    scene: activeScene === null ? null : { sceneId: activeScene.sceneId, name: activeScene.name },
    flags: (id) => hierarchyFlags.get(id),
    blockLayers: blocks.blockRows,
    palette: {
      thumbnails: tileThumbnails,
      materials,
      run: terrainTools.terrainRun,
      newMaterialId,
      openMaterial: (id) => openDocument('material', id),
      heightInAlpha: (ids) => clientRef.current?.heightInAlpha(ids) ?? Promise.resolve(null),
    },
  };
}

/** The centre's stage: the Scene view's host, asset and material drops on it, the notices and the Game view's preview. */
function renderSceneStage(m: EditorModel): JSX.Element {
  const { assetDropActive, setAssetDropActive, stageRef, centerTab, viewportRef, clientRef, entityEditing, setSelectedId, setNotice, dropAsset, viewportHostRef, playing, ui, notice, playInfo, playRenderer, playIframeRef, previewSrc } = m;
  return (
    <div
      className={assetDropActive ? 'tl-app__stage is-asset-drop' : 'tl-app__stage'}
      ref={stageRef}
      onDragOver={(ev) => {
        if (centerTab === 'scene' && ev.dataTransfer.types.includes(MATERIAL_DRAG_TYPE)) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = 'copy';
          return;
        }
        if (centerTab !== 'scene' || !ev.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        if (!assetDropActive) setAssetDropActive(true);
      }}
      onDragLeave={(ev) => {
        if (ev.currentTarget === ev.target || !ev.currentTarget.contains(ev.relatedTarget as Node | null)) setAssetDropActive(false);
      }}
      onDrop={(ev) => {
        setAssetDropActive(false);
        if (centerTab === 'scene' && ev.dataTransfer.types.includes(MATERIAL_DRAG_TYPE)) {
          // A material dropped on an object: it uses it for all of its materials.
          ev.preventDefault();
          const materialId = ev.dataTransfer.getData(MATERIAL_DRAG_TYPE);
          const id = viewportRef.current?.pickAt(ev.clientX, ev.clientY) ?? null;
          const target = id !== null ? clientRef.current?.projection.getEntity(id) : undefined;
          if (target !== undefined && (target.kind === 'model' || target.kind === 'box' || target.instances !== undefined)) {
            void entityEditing.setEntityMaterials(target.id, { ...(target.materials ?? {}), '*': materialId });
            setSelectedId(target.id);
          } else setNotice('Drop a material on a model or a box.');
          return;
        }
        if (centerTab !== 'scene' || !ev.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
        ev.preventDefault();
        const payload = parseAssetDrag(ev.dataTransfer.getData(ASSET_DRAG_TYPE));
        const at = viewportRef.current?.dropPoint(ev.clientX, ev.clientY);
        if (payload !== null && at !== undefined) void dropAsset(payload, at, null);
      }}
    >
      <div ref={viewportHostRef} className="tl-viewport-host" />
      {centerTab === 'game' && !playing && (
        <div className="tl-app__game-empty">Press ▶ play to run the game here.</div>
      )}
      {ui.external !== null && (
        <div className="tl-notice tl-notice--external" role="alert">
          <span>
            The project files changed on disk. Editing is paused.
            {ui.external.valid === false ? ` The disk version is invalid (${ui.external.errorCount ?? '?'} problems) and cannot be loaded.` : ''}
          </span>
          <button
            className="tl-btn tl-btn--small"
            disabled={ui.external.valid === false}
            onClick={() => void clientRef.current?.resolveExternal('accept').then((r) => { if (!r.ok) setNotice(`Load failed: ${r.error.message}`); })}
          >
            load disk version
          </button>
          <button
            className="tl-btn tl-btn--small"
            onClick={() => void clientRef.current?.resolveExternal('discard').then((r) => { if (!r.ok) setNotice(`Discard failed: ${r.error.message}`); })}
          >
            keep editor version
          </button>
        </div>
      )}
      {notice !== null && (
        <div className="tl-notice" role="alert">
          <span>{notice}</span>
          <button className="tl-btn tl-btn--small" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}
      {playing && previewSrc && (
        <div className={`tl-app__preview${centerTab === 'game' ? '' : ' tl-app__preview--hidden'}`}>
          <div className="tl-app__preview-label">
            <span>
              play {playInfo?.snapshotId ?? ''} @ r{playInfo?.revision ?? 0}
            </span>
            {playRenderer !== null && (
              <span className="tl-app__preview-renderer" data-render-backend={String(playRenderer['backend'] ?? 'pending')} title={String(playRenderer['reason'] ?? '')}>
                renderer {String(playRenderer['backend'] ?? 'pending')} ({String(playRenderer['state'] ?? '')}) — {String(playRenderer['reason'] ?? '')}
              </span>
            )}
          </div>
          <iframe
            ref={playIframeRef}
            className="tl-app__preview-frame"
            src={previewSrc}
            title="Thirdlight play preview"
            allow="gamepad; cross-origin-isolated"
          />
        </div>
      )}
    </div>
  );
}

/** The editor's shell for a project (`projectId`: the page's project). */
export function renderEditorShell(m: EditorModel, projectId: string): JSX.Element {
  const { animatorTools, assetActions, assetSummary, assets, bake, blocks, bottomTab, centerTab, cfg, clientRef, closeSettings, closedScenes, content, cue, dialogs, docCmds, docState, dropAsset, editMode, effectPreview, entities, entityEditing, fieldContext, fileCheck, filePicker, gizmoMode, gizmos, groupUsage, hierarchyFlags, iconTable, inspect, inspectedItem, instanceBrush, instanceChunks, items, kitEditor, layerUsage, lightingMode, loadTextureRef, modelFilesRef, modes, move, notice, occlusionView, openDocument, play, playMode, playSession, playing, prefab, previewTextureRef, problems, projectSearch, projectSettings, registry, rename, reportFailure, resync, saveSchema, sceneAction, sceneEditing, sceneHeaders, sceneRenderer, sceneView, scripting, seeThroughPreview, selectedCopy, selectedEntity, selectedId, selection, sessionClient, setBottomTab, setCenterTab, setEffectPreview, setFilePicker, setGizmoMode, setGizmos, setLightingMode, setNotice, setOcclusionView, setProjectSearch, setSeeThroughPreview, setSelectedCopy, setSelectedId, setSelection, setSnapSettingsState, setSnapping, settings, settingsWindow, showToolWindow, sizes, snapSettings, snapping, splitter, stop, structureKey, tagUsage, terrainTools, tileThumbnails, toolWindows, ui, uiPreviewAssets, viewFailures, viewportRef, windowOpen, workareaRef, workspace, workspaceDispatch } = m;
  const selected = selectedEntity;
  /** The components the selection carries (the Component menu's add/remove state). */
  const selectedComponents = new Set<string>(selected === null ? [] : Object.keys(selected.components));
  /** The selection's edit mode (the Inspector's Edit button). */
  const selectedEditMode = editModeFor(selected);
  const selectedVia = editModeVia(selected, entities);
  // The game block's pickers name objects in any scene.
  const { sceneId: _selectedScene, ...gameFieldContext } = fieldContext;
  const kitHost = makeKitHost(m);
  const workspaceHost = workspaceHostOf({
    clientRef,
    modelFilesRef,
    loadTextureRef,
    previewTextureRef,
    projectId: projectId,
    content,
    settings: projectSettings,
    docState,
    docCmds,
    scripting,
    animator: animatorTools,
    debugPlay: playSession.debugPlay,
    entities,
    selectedId,
    gameFieldContext,
    uiPreviewAssets,
    openDocument,
    workspaceDispatch,
    sceneView,
    items,
    kit: kitHost,
  });

  const menus = editorMenus({
    registry,
    settings,
    sceneHeaders,
    closedScenes,
    entities,
    selected,
    selectedId,
    selectedComponents,
    ui,
    snapping,
    setSnapping,
    snapSettings,
    gizmos,
    setGizmos,
    effectPreview,
    setEffectPreview,
    occlusionView,
    setOcclusionView,
    workspace,
    workspaceDispatch,
    setCenterTab,
    // A tool window shows in the default view, so the settings window closes for it.
    setBottomTab: (tab: BottomTab) => {
      closeSettings();
      setBottomTab(tab);
    },
    showProject: (text: string) => {
      closeSettings();
      workspaceDispatch({ type: 'show', on: false });
      setBottomTab('assets');
      setProjectSearch((cur) => ({ text, n: (cur?.n ?? 0) + 1 }));
    },
    openProjectSettings: () => settingsWindow.show(),
    showToolWindow,
    openDecals: () => void editMode.open('decals'),
    createPrefabFromSelection: () => void prefab.createPrefabFromSelection(),
    createBlockLayer: () => void blocks.createBlockLayer(),
    createTerrain: () => void terrainTools.createTerrain(),
    resync,
    scene: sceneEditing,
    entity: entityEditing,
    dialogs,
  });

  /** The one Inspector, on the right dock or on the editor window's right side. */
  const inspector = (placement: 'dock' | 'window'): JSX.Element => (
    <InspectorDock
      placement={placement}
      width={placement === 'dock' ? sizes.right : sizes.window}
      clientRef={clientRef}
      viewportRef={viewportRef}
      content={content}
      settings={projectSettings}
      docState={docState}
      docCmds={docCmds}
      animator={animatorTools}
      entity={entityEditing}
      scene={sceneEditing}
      blocks={blocks}
      play={playSession}
      entities={entities}
      selected={selected}
      selection={selection}
      hierarchyFlags={hierarchyFlags}
      fieldContext={fieldContext}
      gizmoMode={gizmoMode}
      setGizmoMode={setGizmoMode}
      instanceChunks={instanceChunks}
      selectedCopy={selectedCopy}
      setSelectedCopy={setSelectedCopy}
      instanceBrush={instanceBrush}
      reportFailure={reportFailure}
      setNotice={setNotice}
      inspectedItem={inspectedItem}
      inspect={inspect}
      openDocument={openDocument}
      items={items}
      cue={cue}
      assets={assets}
      assetActions={assetActions}
      prefab={prefab}
      tileThumbnails={tileThumbnails}
      kit={kitEditor}
      select={setSelectedId}
      sceneInFront={centerTab === 'scene'}
      editMode={(() => {
        if (selected === null) return null;
        const own = selectedEditMode === undefined ? null : { label: selectedEditMode.action, enter: () => void editMode.enter(selected.id), ...(!isSceneMode(selectedEditMode) && selectedEditMode.inspectorSkips !== undefined ? { skips: selectedEditMode.inspectorSkips } : {}) };
        if (selectedVia === undefined) return own;
        // The editor of the object it belongs to first (the rooms' block editor); its own (vertex paint) beside it.
        const via = { label: selectedVia.label, enter: () => void editMode.enter(selectedVia.entityId, undefined, false, selectedVia.mode), ...(selectedVia.skips !== undefined ? { skips: selectedVia.skips } : {}) };
        return own === null ? via : { ...via, also: { label: own.label, enter: own.enter } };
      })()}
    />
  );

  /** What the edit modes read from the app. */
  const editModeHost = makeEditModeHost(m);

  return (
    <CatalogProvider catalog={sessionClient?.catalog ?? null} asset={assetSummary}>
    <ItemOpenerProvider opener={assets.itemOpener}>
    <div className="tl-app">
      <MenuBar menus={menus} />
      <Toolbar
        projectId={projectId}
        onProjects={() => { window.location.search = ''; }}
        gizmoMode={gizmoMode}
        onGizmoMode={setGizmoMode}
        editing={editMode.shown}
        playing={playing}
        snapping={snapping}
        onToggleSnapping={() => setSnapping((v) => !v)}
        decalTool={editMode.shown && editMode.state?.kind === 'decals'}
        onToggleDecalTool={() => (editMode.state?.kind === 'decals' ? editMode.leave() : void editMode.open('decals'))}
        lighting={lightingMode}
        onToggleLighting={() => {
          const next = lightingMode === 'game' ? 'editor' : 'game';
          viewportRef.current?.setLighting(next);
          setLightingMode(next);
        }}
        seeThrough={seeThroughPreview}
        onToggleSeeThrough={() => setSeeThroughPreview((v) => !v)}
        onPlay={() => void play()}
        onPlayFrom={() => {
          dialogs.setPlayFromForm((f) => ({ ...f, busy: false, error: null }));
          dialogs.setDialog('playFrom');
        }}
        onStop={() => void stop()}
        {...(playMode !== null ? { playMode } : {})}
      />
      <div className="tl-app__workarea" ref={workareaRef}>
      {/* Under the editor window the default view keeps its state but takes no input. */}
      <div className={`tl-app__body${workspace.maximized ? ' is-maximized' : ''}`} inert={windowOpen || settingsWindow.open || editMode.shown}>
        <div className="tl-app__main">
          <div className="tl-app__row">
            <div className="tl-dock tl-dock--left" style={{ width: sizes.left }}>
            <Hierarchy
          entities={entities}
          structureKey={structureKey}
          flags={hierarchyFlags}
          projectId={projectId}
          selectedIds={selection.ids}
          primaryId={selection.primary}
          onSelect={(ids, primary) => setSelection({ ids, primary })}
          onActivate={(id) => editMode.enter(id, undefined, true)}
          onRename={(id, name) => void rename(id, name)}
          onMove={(ids, parentId, beforeId, sceneId) => void move(ids, parentId, beforeId, sceneId)}
          icons={iconTable}
          onAssetDrop={(asset, parentId, sceneId) => {
            if (sceneId !== null) clientRef.current?.setActiveScene(sceneId);
            const focus = viewportRef.current?.focusPoint() ?? [0, 0, 0];
            void dropAsset(asset, [Math.round(focus[0] * 4) / 4, Math.round(focus[1] * 4) / 4, Math.round(focus[2] * 4) / 4], parentId);
          }}
          {...(sceneHeaders !== null ? { scenes: sceneHeaders, closedScenes, onSceneAction: (a: SceneAction) => void sceneAction(a) } : {})}
          contextMenu={() => hierarchyContextMenu(sceneEditing, () => void prefab.createPrefabFromSelection())}
        />
            </div>
            <div className="tl-splitter tl-splitter--v" onPointerDown={splitter('left')} role="separator" aria-orientation="vertical" aria-label="Resize the hierarchy" />
            <div className="tl-app__center">
              <CentreTabs state={workspace} dispatch={workspaceDispatch} />
        {renderSceneStage(m)}
            </div>
          </div>
          <div className="tl-splitter tl-splitter--h" onPointerDown={splitter('bottom')} role="separator" aria-orientation="horizontal" aria-label="Resize the bottom panel" />
          <BottomDock
            tab={bottomTab}
            onTab={setBottomTab}
            height={sizes.bottom}
            clientRef={clientRef}
            docState={docState}
            docCmds={docCmds}
            scripting={scripting}
            play={playSession}
            problems={problems}
            problemLog={ui.problems}
            viewFailures={viewFailures}
            fileCheck={fileCheck}
            reimportIssue={assets.reimportIssue}
            assetsTab={{
              clientRef,
              assets,
              actions: assetActions,
              folderImport: fileCheck.checkable,
              tileThumbnails,
              inspect,
              items,
              search: projectSearch,
            }}
            workspaceDispatch={workspaceDispatch}
            openDocument={openDocument}
          />
        </div>
        <div className="tl-splitter tl-splitter--v" onPointerDown={splitter('right')} role="separator" aria-orientation="vertical" aria-label="Resize the inspector" />
        {windowOpen ? <div className="tl-dock" style={{ width: sizes.right }} /> : inspector('dock')}
      </div>
      {/* Scene settings float over the Scene view while it is in front (the editor window, Project Settings and the Game view set them aside). */}
      {/* An object's edit mode over the work area, the Scene view lent to it. */}
      {editMode.shown && (
        <EditModeShell
          mode={editMode}
          host={editModeHost}
          sceneView={sceneView}
          viewportRef={viewportRef}
          icons={iconTable}
          canUndo={ui.undoDepth > 0}
          canRedo={ui.redoDepth > 0}
          onUndo={() => void sceneEditing.undo()}
          onRedo={() => void sceneEditing.redo()}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
        />
      )}
      {centerTab === 'scene' && !windowOpen && !settingsWindow.open && !editMode.shown && (
        <SceneToolWindows
          tools={toolWindows}
          area={workareaRef}
          clientRef={clientRef}
          viewportRef={viewportRef}
          content={content}
          docCmds={docCmds}
          bake={bake}
          entities={entities}
          sceneHeaders={sceneHeaders}
          activateScene={(sceneId) => void sceneAction({ kind: 'activate', sceneId })}
        />
      )}
      {/* The settings window covers the editor window too; what is under it takes no input. */}
      <div className="tl-app__layer" inert={settingsWindow.open}>
        <EditorWindow state={workspace} dispatch={workspaceDispatch} host={workspaceHost} inspector={windowOpen ? inspector('window') : null} onSplitter={splitter('window')} />
      </div>
      <ProjectSettingsWindow
        state={settingsWindow}
        settings={projectSettings}
        content={content}
        docCmds={docCmds}
        scripting={scripting}
        play={playSession}
        entities={entities}
        setSelection={setSelection}
        fieldContext={fieldContext}
        gameFieldContext={gameFieldContext}
        tagUsage={tagUsage}
        layerUsage={layerUsage}
        groupUsage={groupUsage}
      />
      </div>
      <StatusBar state={ui} onResync={resync} renderer={sceneRenderer} />
      {filePicker !== null && (
        <ProjectFilePicker
          title={filePicker === 'create' ? 'Import from project folder' : 'Reimport from project folder'}
          startDir="assets"
          load={assets.loadProjectFiles}
          onClose={() => setFilePicker(null)}
          onPick={(entry) => {
            const mode = filePicker;
            setFilePicker(null);
            void assets.importFromFolder(entry.path, mode, mode === 'reimport' ? assets.selectedAssetIdRef.current : null);
          }}
        />
      )}
      <EditorDialogs
        dialogs={dialogs}
        cfg={cfg}
        revision={ui.revision}
        sceneHeaders={sceneHeaders}
        closedScenes={closedScenes}
        saveSchema={saveSchema}
        modes={modes}
        playing={playing}
        setSnapSettingsState={setSnapSettingsState}
      />
    </div>
    </ItemOpenerProvider>
    </CatalogProvider>
  );
}
