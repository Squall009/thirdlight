/**
 * The bottom dock: its tab strip and each tab's panel, wired to the editor's
 * state and commands (the Assets tab in AssetsTab.tsx).
 */
import type { JSX, Dispatch } from 'react';
import type { ClientUiState } from '../../session/client';
import type { ProjectedEntity } from '../../session/projection';
import type { FieldContext } from '../DescriptorFields';
import { TileThumbnails } from '../../viewport/thumbnails';
import type { SceneHeaderView } from '../Hierarchy';
import { MaterialsPanel } from '../MaterialsPanel';
import { EnvironmentPanel } from '../EnvironmentPanel';
import { LightingPanel } from '../LightingPanel';
import { AnimatorPanel } from '../AnimatorPanel';
import { bakeIsStale } from '../../viewport/bake-run';
import { PrefabPanel } from '../PrefabPanel';
import { activeDoc, docKey, type WorkspaceAction, type WorkspaceState } from '../../session/editor-window';
import { BlocksPanel } from '../BlocksPanel';
import { MediaPanel } from '../MediaPanel';
import { ProblemsPanel } from '../ProblemsPanel';
import { EffectsPanel } from '../effect/EffectsPanel';
import { DialoguePanel, freeDialogueId } from '../dialogue/DialoguePanel';
import { TimelinesPanel } from '../timeline/TimelinesPanel';
import { newTimeline } from '../timeline/TimelineDocument';
import { LibrariesPanel } from '../script/LibrariesPanel';
import { ConsolePanel } from '../ConsolePanel';
import { UiPanel } from '../uidoc/UiPanel';
import { newUiTheme, uniqueDocId } from '../../session/ui-edit';
import { newLibraryFiles } from '../../session/script-sources';
import { newEffect, uniqueId } from '../../session/effect-edit';
import { GraphsPanel } from '../../graph/GraphsPanel';
import type { SourceIssue } from '../../session/asset-sources';
import { useAssetFileCheck } from '../useAssetFileCheck';
import type { ClientRef, SetNotice, ViewportRef } from './commands';
import type { ProjectContent } from './useProjectContent';
import type { ProjectSettings } from './useProjectSettings';
import type { DocumentState } from '../workspace/useDocumentState';
import type { DocumentCommands } from '../workspace/useDocumentCommands';
import type { Scripting } from './useScripting';
import type { AnimatorTools } from './useAnimatorTools';
import type { LightingBakeState } from './useLightingBake';
import type { BlockLayers } from './useBlockLayers';
import type { PrefabAuthoring } from './usePrefabAuthoring';
import type { CuePreview } from './useCuePreview';
import type { PlaySession } from './usePlaySession';
import type { SceneEditing } from './useSceneEditing';
import type { EditorProblems } from './useEditorProblems';
import { BOTTOM_TABS, type BottomTab } from './dock-tabs';
import { AssetsTab, type AssetsTabProps } from './AssetsTab';

export interface BottomDockProps {
  tab: BottomTab;
  onTab: (tab: BottomTab) => void;
  height: number;
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  content: ProjectContent;
  settings: ProjectSettings;
  docState: DocumentState;
  docCmds: DocumentCommands;
  scripting: Scripting;
  animator: AnimatorTools;
  bake: LightingBakeState;
  blocks: BlockLayers;
  prefab: PrefabAuthoring;
  cue: CuePreview;
  play: PlaySession;
  scene: SceneEditing;
  problems: EditorProblems;
  /** The client's problem log (the Problems tab). */
  problemLog: ClientUiState['problems'];
  viewFailures: { id: string; name: string; code: string; message: string }[];
  fileCheck: ReturnType<typeof useAssetFileCheck>;
  reimportIssue: (issue: SourceIssue) => Promise<void>;
  assetsTab: AssetsTabProps;
  workspace: WorkspaceState;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  openDocument: (kind: string, id: string) => void;
  entities: ProjectedEntity[];
  selected: ProjectedEntity | null;
  selectedId: string | null;
  refreshEntities: () => void;
  setNotice: SetNotice;
  activeScene: SceneHeaderView | null;
  fieldContext: FieldContext;
  gameFieldContext: Omit<FieldContext, 'sceneId'>;
  tileThumbnails: TileThumbnails | null;
}

export function BottomDock(props: BottomDockProps): JSX.Element {
  const { tab: bottomTab, onTab: setBottomTab, height, clientRef, viewportRef, problemLog, viewFailures, fileCheck, reimportIssue, workspace, workspaceDispatch, openDocument } = props;
  const { entities, selected, selectedId, refreshEntities, setNotice, activeScene, gameFieldContext, tileThumbnails } = props;
  const { fieldContext: fieldContextMemo } = props;
  const { dialogues, dialogueSettings, effects, environment, sceneLook, graphKinds, graphs, lighting, materials, prefabSummaries, projectUiDocs, projectUiThemes, registry, scriptLibraries, speakers, timelines, uiDocuments, uiThemes } = props.content;
  const { eventCues, eventCuesError, saveEventCues } = props.settings;
  const { activeDialogueId, activeEffectId, activeGraphId, setMaterialFocus, setVisualFocus } = props.docState;
  const { createUiDocument, deleteMaterial, dialogueCommand, dialogueError, graphDocCommand, graphsError, effectCommand, effectError, materialError, saveEnvironment, saveSceneEnvironment, saveMaterial } = props.docCmds;
  const { selectedMaterialId, setSelectedMaterialId, setDialogueError, setUiError, showGraph, timelineCommand, timelineError, uiCommand, uiError } = props.docCmds;
  const { dirtyLibraries, libraryCommand, libraryDependents, libraryError, openSource, saveAllLibraries, saveAllOutcome } = props.scripting;
  const { animatorProps } = props.animator;
  const { bakeAbortRef, bakeBusy, bakeFinal, bakeHost, bakeMessage, bakePreview, bakeSettings, clearBake, setBakeSettings } = props.bake;
  const { blockEdit, blockEditor, blockHandlersRef, blockLayerId, blockLayerIdRef, blockRows, blockRun, blockStamps, blockTypes, cellFields, createBlockLayer, setBlockLayerId } = props.blocks;
  const { captureError, captureIdRef, captureName, capturePrefab, commitOverride, copyError, deletePrefab, overrideDrafts, overrideTargets, placeCopy } = props.prefab;
  const { prefabDeleteError, selectedPrefabId, setCaptureName, setCopyError, setOverrideDrafts, setSelectedPrefabId } = props.prefab;
  const { previewCue, previewOwnerRef, unlockPreview } = props.cue;
  const { playInfo, playing } = props.play;
  const { setFlag } = props.scene;
  const { graphIssues, scriptIssues, materialIssues } = props.problems;
  return (
    <div className="tl-dock tl-dock--bottom" style={{ height: height }}>
      <div className="tl-tabs" role="tablist">
        {BOTTOM_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={bottomTab === t.id} className={`tl-tab${bottomTab === t.id ? ' is-active' : ''}`} onClick={() => setBottomTab(t.id)}>
            {t.label}
            {t.id === 'problems' && problemLog.length + fileCheck.count + viewFailures.length + graphIssues.length + scriptIssues.length + materialIssues.length > 0 ? <span className="tl-tab__count">{problemLog.length + fileCheck.count + viewFailures.length + graphIssues.length + scriptIssues.length + materialIssues.length}</span> : null}
          </button>
        ))}
      </div>
    {bottomTab === 'graphs' && (
      <GraphsPanel
        graphs={graphs}
        kinds={graphKinds}
        openId={activeGraphId}
        error={graphsError}
        onOpen={(id) => showGraph(id)}
        onCreate={(kind, name) => {
          const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'graph';
          let graphId = base;
          for (let i = 2; graphs.some((g) => g.graphId === graphId); i++) graphId = `${base}-${i}`;
          void graphDocCommand('setGraph', { graph: { graphId, kind, name, graph: { nodes: [], edges: [] } } }).then((ok) => ok && showGraph(graphId));
        }}
        onRename={(graphId, name) => {
          const g = graphs.find((x) => x.graphId === graphId);
          if (g !== undefined) void graphDocCommand('setGraph', { graph: { ...g, name } });
        }}
        onDelete={(graphId) => {
          void graphDocCommand('deleteGraph', { graphId }).then((ok) => {
            if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'graph', id: graphId }) });
          });
        }}
      />
    )}
    {bottomTab === 'dialogue' && (
      <DialoguePanel
        dialogues={dialogues}
        speakers={speakers}
        settings={dialogueSettings}
        uiDocuments={projectUiDocs}
        uiThemes={projectUiThemes}
        openId={activeDialogueId}
        error={dialogueError}
        onOpen={(id) => openDocument('dialogue', id)}
        onCreate={(name) => {
          const c = clientRef.current;
          if (c === null) return;
          void freeDialogueId(name, async (ids) => new Set([...(await c.catalog.taken(ids, ['dialogue'])), ...dialogues.map((d) => d.dialogueId)])).then(
            async (dialogueId) => (await dialogueCommand('setDialogue', { dialogue: { dialogueId, name } })) && openDocument('dialogue', dialogueId),
            (e: unknown) => setDialogueError(`the new conversation's id could not be checked: ${e instanceof Error ? e.message : String(e)}`),
          );
        }}
        onRename={(dialogueId, name) => void dialogueCommand('setDialogue', { dialogue: { dialogueId, name } })}
        onDelete={(dialogueId) => {
          void dialogueCommand('deleteDialogue', { dialogueId }).then((ok) => {
            if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'dialogue', id: dialogueId }) });
          });
        }}
        onSaveSpeaker={(speaker) => void dialogueCommand('setSpeaker', { speaker })}
        onDeleteSpeaker={(speakerId) => void dialogueCommand('deleteSpeaker', { speakerId })}
        onSaveSettings={(settings) => void dialogueCommand('setDialogueSettings', { settings })}
      />
    )}
    {bottomTab === 'effects' && (
      <EffectsPanel
        effects={effects}
        openId={activeEffectId}
        error={effectError}
        onOpen={(id) => openDocument('effect', id)}
        onCreate={(name) => {
          const effectId = uniqueId(name, effects.map((e) => e.effectId), 'effect');
          void effectCommand('setEffect', { effect: newEffect(effectId, name) }).then((ok) => ok && openDocument('effect', effectId));
        }}
        onRename={(effectId, name) => void effectCommand('renameEffect', { effectId, name })}
        onDelete={(effectId) => {
          void effectCommand('deleteEffect', { effectId }).then((ok) => {
            if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'effect', id: effectId }) });
          });
        }}
      />
    )}
    {bottomTab === 'timelines' && (
      <TimelinesPanel
        timelines={timelines}
        openId={(() => {
          const d = activeDoc(workspace);
          return d !== null && d.kind === 'timeline' ? d.id : null;
        })()}
        error={timelineError}
        onOpen={(id) => openDocument('timeline', id)}
        onCreate={(name) => {
          const timelineId = uniqueId(name, timelines.map((t) => t.timelineId), 'timeline');
          void timelineCommand('setTimeline', { timeline: newTimeline(timelineId, name) }).then((ok) => ok && openDocument('timeline', timelineId));
        }}
        onDelete={(timelineId) => {
          void timelineCommand('deleteTimeline', { timelineId }).then((ok) => {
            if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'timeline', id: timelineId }) });
          });
        }}
      />
    )}
    {bottomTab === 'console' && (
      <ConsolePanel
        playSessionId={playing && playInfo !== null ? playInfo.playSessionId : null}
        fetchDiagnostics={async (psid) => clientRef.current?.playDiagnostics(psid) ?? { ok: false, message: 'not connected' }}
        onOpenSource={openSource}
      />
    )}
    {bottomTab === 'libraries' && (
      <LibrariesPanel
        libraries={scriptLibraries}
        dependents={libraryDependents}
        openId={(() => {
          const d = activeDoc(workspace);
          return d !== null && d.kind === 'script-library' ? d.id : null;
        })()}
        error={libraryError}
        dirty={dirtyLibraries}
        saveAll={saveAllOutcome}
        onSaveAll={(acknowledge) => void saveAllLibraries(acknowledge)}
        onOpen={(id) => openDocument('script-library', id)}
        onCreate={(name) => {
          const libraryId = uniqueId(name, scriptLibraries.map((l) => l.libraryId), 'library');
          void libraryCommand('setScriptLibrary', { libraryId, name: name.slice(0, 64), files: newLibraryFiles(libraryId) }).then((ok) => ok && openDocument('script-library', libraryId));
        }}
        onRename={(libraryId, name) => void libraryCommand('setScriptLibrary', { libraryId, name })}
        onDelete={(libraryId) => {
          void libraryCommand('deleteScriptLibrary', { libraryId }).then((ok) => {
            if (ok) workspaceDispatch({ type: 'close', key: docKey({ kind: 'script-library', id: libraryId }) });
          });
        }}
      />
    )}
    {bottomTab === 'blocks' && (
      <BlocksPanel
        editor={blockEditor}
        visible={bottomTab === 'blocks' && activeDoc(workspace) === null}
        layers={blockRows}
        layerId={blockLayerId}
        onLayer={(id) => {
          setBlockLayerId(id);
          blockLayerIdRef.current = id;
          refreshEntities();
        }}
        types={blockTypes}
        fields={cellFields}
        stamps={blockStamps}
        registry={registry}
        fieldContext={gameFieldContext}
        thumbnails={tileThumbnails}
        handlers={blockHandlersRef}
        run={blockRun}
        edit={blockEdit}
        onCreateLayer={() => void createBlockLayer()}
        onSetFlag={(id, flag, value) => void setFlag(id, flag, value)}
        onNotice={setNotice}
      />
    )}
    {bottomTab === 'problems' && (
      <ProblemsPanel
        graphIssues={[...graphIssues, ...scriptIssues, ...materialIssues]}
        onGraphIssue={(i) => {
          if (i.materialId !== undefined) {
            // A graph material's problem opens its Material tab at the node.
            if (i.nodeId !== undefined) setMaterialFocus({ id: i.nodeId, nonce: Date.now(), materialId: i.materialId });
            openDocument('material', i.materialId);
          } else if (i.behaviorId !== undefined) {
            // A visual script's problem opens its Graph tab at the node (its function's tab inside a function).
            workspaceDispatch({ type: 'open', doc: { kind: 'visual-script', id: i.behaviorId } });
            if (i.nodeId !== undefined) setVisualFocus({ behaviorId: i.behaviorId, id: i.nodeId, nonce: Date.now() });
          } else showGraph(i.graphId, i.nodeId);
        }}
        problems={problemLog}
        viewFailures={viewFailures}
        fileCheck={fileCheck.checkable ? fileCheck : null}
        onReimport={(i) => void reimportIssue(i)}
      />
    )}
    {bottomTab === 'ui' && (
      <UiPanel
        documents={uiDocuments}
        themes={uiThemes}
        error={uiError}
        onOpenDocument={(id) => openDocument('ui-document', id)}
        onOpenTheme={(id) => openDocument('ui-theme', id)}
        onCreateDocument={(name) => void createUiDocument(name)}
        onCreateTheme={(name) => {
          const uiThemeId = uniqueDocId(name, uiThemes.map((t) => t.uiThemeId), 'theme');
          void uiCommand('setUiTheme', { theme: newUiTheme(uiThemeId, name) }).then((err) => {
            setUiError(err);
            if (err === null) openDocument('ui-theme', uiThemeId);
          });
        }}
        onRenameDocument={(id, name) => {
          const d = uiDocuments.find((x) => x.uiDocumentId === id);
          if (d !== undefined) void uiCommand('setUiDocument', { document: { ...d, name } }).then(setUiError);
        }}
        onRenameTheme={(id, name) => {
          const t = uiThemes.find((x) => x.uiThemeId === id);
          if (t !== undefined) void uiCommand('setUiTheme', { theme: { ...t, name } }).then(setUiError);
        }}
        onDeleteDocument={(id) =>
          void uiCommand('deleteUiDocument', { uiDocumentId: id }).then((err) => {
            setUiError(err);
            if (err === null) workspaceDispatch({ type: 'close', key: docKey({ kind: 'ui-document', id }) });
          })
        }
        onDeleteTheme={(id) =>
          void uiCommand('deleteUiTheme', { uiThemeId: id }).then((err) => {
            setUiError(err);
            if (err === null) workspaceDispatch({ type: 'close', key: docKey({ kind: 'ui-theme', id }) });
          })
        }
      />
    )}
    {bottomTab === 'assets' && <AssetsTab {...props.assetsTab} />}
    {bottomTab === 'prefabs' && (
      <PrefabPanel
        selection={selected}
        definitions={prefabSummaries}
        selectedPrefabId={selectedPrefabId}
        targets={overrideTargets}
        captureDraft={captureIdRef.current && selectedId ? { prefabId: captureIdRef.current, displayName: captureName } : null}
        captureError={captureError}
        copyError={copyError}
        overrideCount={Object.keys(overrideDrafts).length}
        onCaptureName={setCaptureName}
        onCapture={() => void capturePrefab()}
        onSelect={(id) => {
          setSelectedPrefabId(id);
          setOverrideDrafts({});
          setCopyError(null);
        }}
        onPlaceCopy={(id) => void placeCopy(id)}
        onDelete={(id) => void deletePrefab(id)}
        deleteError={prefabDeleteError}
        onOverrideCommit={commitOverride}
      />
    )}
    {bottomTab === 'materials' && (
      <MaterialsPanel
        materials={materials}
        selectedId={selectedMaterialId}
        onSelect={setSelectedMaterialId}
        onSave={(m) => void saveMaterial(m, materials.find((x) => x.materialId === m.materialId) ?? null)}
        onDelete={(id) => void deleteMaterial(id)}
        error={materialError}
        onOpen={(id) => openDocument('material', id)}
      />
    )}
    {bottomTab === 'environment' && (
      <EnvironmentPanel
        environment={environment}
        onSave={(env) => void saveEnvironment(env, environment)}
        scene={activeScene === null ? null : { sceneId: activeScene.sceneId, name: activeScene.name }}
        look={sceneLook}
        onSaveLook={(look) => activeScene !== null && void saveSceneEnvironment(activeScene.sceneId, look, sceneLook)}
        error={materialError}
        presets={{
          lights: entities.filter((e) => e.light !== undefined).map((e) => ({ id: e.id, type: e.light!.type, color: e.light!.color, intensity: e.light!.intensity, ...(e.light!.direction !== undefined ? { direction: e.light!.direction } : {}), ...(e.light!.groundColor !== undefined ? { groundColor: e.light!.groundColor } : {}) })),
          onPreview: (weights) => viewportRef.current?.previewEnvironmentBlend(weights === null ? null : { weights }, new Map((clientRef.current?.getTags() ?? []).map((t) => [t.name, t.bit]))),
        }}
      />
    )}
    {bottomTab === 'animator' && <AnimatorPanel {...animatorProps} />}
    {bottomTab === 'lighting' && (
      activeScene === null ? (
        <p className="tl-hint">Lighting bakes need a project with scenes (storage v4).</p>
      ) : (
        <LightingPanel
          sceneName={activeScene.name}
          bake={lighting[activeScene.sceneId] ?? null}
          stale={lighting[activeScene.sceneId] !== undefined && bakeIsStale(lighting[activeScene.sceneId]!, (clientRef.current?.projection.listEntities() ?? []).filter((e) => e.sceneId === activeScene.sceneId), (id) => clientRef.current?.getBlockLayers().get(id)?.chunks)}
          settings={bakeSettings}
          onSettings={setBakeSettings}
          busy={bakeBusy}
          finalUnavailable={bakeHost}
          message={bakeMessage}
          onBakePreview={() => void bakePreview()}
          onBakeFinal={() => void bakeFinal()}
          onCancel={() => bakeAbortRef.current?.abort()}
          onClear={() => void clearBake()}
        />
      )
    )}
    {bottomTab === 'media' && (
      <MediaPanel
        previewStatus={previewOwnerRef.current?.status() ?? { state: 'unsupported' }}
        previewDiagnostics={previewOwnerRef.current?.diagnostics() ?? []}
        onUnlockPreview={unlockPreview}
        onPreviewCue={(id) => void previewCue(id)}
        registry={registry}
        eventCues={eventCues}
        fieldContext={fieldContextMemo}
        eventCuesError={eventCuesError}
        onSetEventCues={(next, base) => void saveEventCues(next, base)}
      />
    )}
    </div>
  );
}
