/**
 * The one Inspector — on the default view's right dock, or on the right of
 * the editor window while that shows (moved there, never a second copy). With a graph-like document in front
 * (an Animator controller, a visual script, a graph, a conversation, an
 * effect, a graph material) it shows that document's selection; with an
 * item chosen in the project window since the last selection, that item
 * (ui/project/ItemInspector.tsx); otherwise the selected object
 * (EntityInspector, a block layer's tools included), and the running Play's
 * script values for it.
 */
import type { JSX } from 'react';
import type { ProjectedEntity } from '../../session/projection';
import { effectiveFlagsOf } from '../../session/hierarchy';
import { addEntries } from '../../session/descriptor-fields';
import type { FieldContext } from '../DescriptorFields';
import { Inspector } from '../Inspector';
import { indexKindsOfAssetField } from '../catalog/RefPicker';
import { MaterialMappingEditor } from '../material/MaterialInspector';
import { AnimatorInspector } from '../animator/AnimatorInspector';
import { PlayDebugView } from '../PlayDebugView';
import { GraphInspector } from '../../graph/GraphInspector';
import { effectPortContext, shownSystem } from '../effect/EffectDocument';
import { functionName as scriptFunctionName } from '../../session/visual-debug';
import { behaviorPortContext } from '../../session/behavior-graph';
import { materialPortContext } from '../../session/material-graph';
import { SURFACE_PRESET_NAMES, type SurfacePresetName } from '../../session/media';
import type { GizmoMode } from '../../viewport/viewport';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { BlocksPanel } from '../BlocksPanel';
import { TerrainPanel } from '../TerrainPanel';
import { InstanceBrushPanel, type useInstanceBrush } from '../instances/InstanceBrush';
import { ItemInspector } from '../project/ItemInspector';
import type { ItemActions } from '../project/useItemActions';
import type { ProjectItem } from '../../session/project-items';
import { assetPlacementAvailable } from '../../session/placement';
import { ModelAssetOptions } from '../ModelAssetOptions';
import type { CuePreview } from './useCuePreview';
import type { AssetsWindow } from './useAssetsWindow';
import type { AssetActions } from './useAssetActions';
import type { PrefabAuthoring } from './usePrefabAuthoring';
import type { ClientRef, ReportFailure, SetNotice, ViewportRef } from './commands';
import type { ProjectContent } from './useProjectContent';
import type { ProjectSettings } from './useProjectSettings';
import type { DocumentState } from '../workspace/useDocumentState';
import type { DocumentCommands } from '../workspace/useDocumentCommands';
import type { AnimatorTools } from './useAnimatorTools';
import type { TerrainComponent } from '@thirdlight/project-model';
import type { BlockLayers } from './useBlockLayers';
import type { TerrainTools } from './useTerrainTools';
import type { PlaySession } from './usePlaySession';
import type { SceneEditing } from './useSceneEditing';
import type { EntityEditing } from './useEntityEditing';

export interface InspectorDockProps {
  width: number;
  /** Where the one Inspector stands: the default view's right dock, or the editor window's right side. */
  placement: 'dock' | 'window';
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  content: ProjectContent;
  settings: ProjectSettings;
  docState: DocumentState;
  docCmds: DocumentCommands;
  animator: AnimatorTools;
  entity: EntityEditing;
  scene: SceneEditing;
  blocks: BlockLayers;
  terrain: TerrainTools;
  play: PlaySession;
  entities: ProjectedEntity[];
  selected: ProjectedEntity | null;
  selection: { ids: string[]; primary: string | null };
  hierarchyFlags: ReturnType<typeof effectiveFlagsOf>;
  fieldContext: FieldContext;
  gizmoMode: GizmoMode;
  setGizmoMode: (mode: GizmoMode) => void;
  instanceChunks: Record<string, number>;
  selectedCopy: number | null;
  setSelectedCopy: (index: number | null) => void;
  instanceBrush: ReturnType<typeof useInstanceBrush>;
  reportFailure: ReportFailure;
  setNotice: SetNotice;
  /** An item chosen in the project window after the last selection (shown instead of the selection). */
  inspectedItem: ProjectItem | null;
  /** Show an item in the Inspector (a new material instance). */
  inspect: (item: ProjectItem) => void;
  /** Open a document in the editor window. */
  openDocument: (kind: string, id: string) => void;
  items: ItemActions;
  cue: CuePreview;
  assets: AssetsWindow;
  assetActions: AssetActions;
  prefab: PrefabAuthoring;
  tileThumbnails: TileThumbnails | null;
  /** Select one object (a block layer chosen in its tools). */
  select: (id: string) => void;
  /** The Scene view is in front (a block layer's tools are armed only then). */
  sceneInFront: boolean;
}

export function InspectorDock(props: InspectorDockProps): JSX.Element {
  const { width, selected, placement } = props;
  const { animators, behaviorViews, dialogues, effects, graphKinds, graphs, materials } = props.content;
  const { activeAnimatorId, activeDialogueId, activeEffectId, activeMaterialId, activeVisualId, activeVisualTarget, animatorSelection, animatorTargets, dialogueSelection, effectSelection, effectSystems } = props.docState;
  const { graphSelection, graphsContext, materialSelection, openGraph, setAnimatorFocus, setAnimatorSelection, setAnimatorTargets, visualSelection } = props.docState;
  const { animatorGraphEdit, clipsOf, saveAnimator } = props.animator;
  const { sendGraphEdit } = props.docCmds;
  const { observeEntity, playInfo, playing } = props.play;
  const activeVisual = activeVisualId !== null ? (behaviorViews.find((b) => b.behaviorId === activeVisualId) ?? null) : null;
  const cueOwner = props.cue.previewOwnerRef.current;
  const item = props.inspectedItem;
  return (
    <div className={placement === 'dock' ? 'tl-dock tl-dock--right' : 'tl-dock tl-editor-window__inspector'} data-tl-inspector={placement} style={{ width: width }}>
    {activeAnimatorId !== null && animators.some((a) => a.controllerId === activeAnimatorId) ? (
      <div className="tl-inspector" aria-label="animator inspector">
        <div className="tl-panel__title">Inspector</div>
        <AnimatorInspector
          controller={animators.find((a) => a.controllerId === activeAnimatorId)!}
          ownerId={animatorSelection.ownerId !== '' ? animatorSelection.ownerId : (animatorTargets[activeAnimatorId] ?? activeAnimatorId)}
          ids={animatorSelection.ids}
          kinds={graphKinds}
          clipsOf={clipsOf}
          onGraphEdit={animatorGraphEdit}
          onSave={(controller) => void saveAnimator(controller)}
          onTarget={(ownerId) => {
            setAnimatorTargets((t) => ({ ...t, [activeAnimatorId]: ownerId }));
            setAnimatorSelection({ ownerId, ids: [] });
            setAnimatorFocus(null);
          }}
          onFocus={(id) => setAnimatorFocus({ id, nonce: Date.now() })}
        />
      </div>
    ) : activeVisual?.graph !== undefined && graphKinds['behavior'] !== undefined ? (
      <div className="tl-inspector" aria-label="visual script inspector">
        <div className="tl-panel__title">Inspector</div>
        {(() => {
          // The graph in front — the event graph or one of the script's functions.
          const fn = activeVisualTarget !== '' ? activeVisual.functions?.find((f) => f.functionId === activeVisualTarget) : undefined;
          const kindDef = fn !== undefined ? graphKinds['behavior-function'] : graphKinds['behavior'];
          const g = fn !== undefined ? fn.graph : activeVisual.graph!;
          if (kindDef === undefined || (activeVisualTarget !== '' && fn === undefined)) return null;
          const owner = fn !== undefined ? `${activeVisual.behaviorId}#${fn.functionId}` : activeVisual.behaviorId;
          return (
            <GraphInspector
              key={owner}
              kind={kindDef}
              graph={g}
              ids={visualSelection}
              onEdit={(ops) => sendGraphEdit({ kind: 'behavior', id: owner }, ops)}
              portContext={behaviorPortContext(g, { functions: activeVisual.functions, graphs, kinds: graphKinds, ...(fn !== undefined ? { script: activeVisual.graph! } : {}) })}
              assetKinds={indexKindsOfAssetField}
              // Calls pick their function by name: the script's functions, or the project's shared functions.
              fieldOptions={(f, n) =>
                f.key !== 'function' ? undefined : n.type === 'fn.call' ? (activeVisual.functions ?? []).map((x) => ({ id: x.functionId, label: scriptFunctionName(x) })) : n.type === 'fn.library' ? graphs.filter((x) => x.kind === 'behavior-library').map((x) => ({ id: x.graphId, label: x.name })) : undefined
              }
            />
          );
        })()}
      </div>
    ) : openGraph !== null && graphKinds[openGraph.kind] !== undefined ? (
      <div className="tl-inspector">
        <div className="tl-panel__title">Inspector</div>
        <GraphInspector
          kind={graphKinds[openGraph.kind]!}
          graph={openGraph.graph}
          ids={graphSelection}
          onEdit={(ops) => sendGraphEdit({ kind: 'graph', id: openGraph.graphId }, ops)}
          portContext={graphsContext}
          assetKinds={indexKindsOfAssetField}
        />
      </div>
    ) : activeDialogueId !== null && graphKinds['dialogue'] !== undefined && dialogues.some((d) => d.dialogueId === activeDialogueId) ? (
      <div className="tl-inspector" aria-label="dialogue graph inspector">
        <div className="tl-panel__title">Inspector</div>
        {(() => {
          const d = dialogues.find((x) => x.dialogueId === activeDialogueId)!;
          return (
            <GraphInspector
              kind={graphKinds['dialogue']!}
              graph={d.graph}
              ids={dialogueSelection}
              onEdit={(ops) => sendGraphEdit({ kind: 'dialogue', id: d.dialogueId }, ops)}
              // A voice clip is an audio asset of any length.
              assetKinds={indexKindsOfAssetField}
              empty={<div className="tl-inspector__empty">Select a node of “{d.name}”: a line (speaker, expression, text, voice), an option (text, condition, effects), a branch, a set, a signal…</div>}
            />
          );
        })()}
      </div>
    ) : activeEffectId !== null && graphKinds['effect'] !== undefined && effects.some((e) => e.effectId === activeEffectId && e.systems.length > 0) ? (
      <div className="tl-inspector" aria-label="effect graph inspector">
        <div className="tl-panel__title">Inspector</div>
        {(() => {
          const fx = effects.find((e) => e.effectId === activeEffectId)!;
          const sys = shownSystem(fx, effectSystems[fx.effectId] ?? null)!;
          return (
            <GraphInspector
              kind={graphKinds['effect']!}
              graph={sys.graph}
              ids={effectSelection}
              onEdit={(ops) => sendGraphEdit({ kind: 'effect', id: `${fx.effectId}/${sys.systemId}` }, ops)}
              portContext={effectPortContext(fx.parameters)}
              assetKinds={indexKindsOfAssetField}
              empty={<div className="tl-inspector__empty">Select a node, wire, group or comment of “{sys.name}”.</div>}
            />
          );
        })()}
      </div>
    ) : activeMaterialId !== null && graphKinds['material'] !== undefined && materials.find((m) => m.materialId === activeMaterialId)?.graph !== undefined ? (
      <div className="tl-inspector" aria-label="material graph inspector">
        <div className="tl-panel__title">Inspector</div>
        {(() => {
          const m = materials.find((x) => x.materialId === activeMaterialId)!;
          return (
            <GraphInspector
              kind={graphKinds['material']!}
              graph={m.graph!}
              ids={materialSelection}
              onEdit={(ops) => sendGraphEdit({ kind: 'material', id: m.materialId }, ops)}
              portContext={materialPortContext(m.parameters, graphs, graphKinds)}
              assetKinds={indexKindsOfAssetField}
              empty={<div className="tl-inspector__empty">Select a node, wire, group or comment of “{m.name}”.</div>}
            />
          );
        })()}
      </div>
    ) : item !== null ? (
      <ItemInspector
        item={item}
        actions={props.items}
        open={props.assets.projectWindow.open}
        inspect={props.inspect}
        openDocument={props.openDocument}
        loading={props.assets.loadingNames}
        asset={{
          assetOptions: props.assets.assetOptions,
          preview: props.assets.assetPreview,
          place: { available: props.assetActions.placement !== null && props.assets.selectedAssetId === item.id && assetPlacementAvailable(), message: props.assetActions.placementError?.message ?? null, onPlace: () => void props.assetActions.placeAsset() },
          modelExtra:
            props.assets.selectedAssetId === item.id && props.assets.selectedAsset.summary?.kind === 'model' ? (
              <ModelAssetOptions
                asset={props.assets.selectedAsset.summary}
                materials={materials}
                sourceMaterials={props.assets.assetSourceMaterials}
                missingBones={props.animator.missingBones}
                onClipsFor={(rig) => void props.animator.setAssetClipsFor(item.id, rig)}
                onMaterials={(mapping) => void props.assets.assetOptions.setAssetMaterials(item.id, mapping)}
                onReimportExtract={(path, extract) => void props.assets.reimportWithExtract(item.id, path, extract)}
              />
            ) : undefined,
          listen: { status: cueOwner?.status() ?? { state: 'unsupported' }, diagnostics: cueOwner?.diagnostics() ?? [], onUnlock: props.cue.unlockPreview, onListen: (id) => void props.cue.previewCue(id) },
        }}
        materials={{ list: materials, save: (m, base) => void props.docCmds.saveMaterial(m, base), error: props.docCmds.materialError }}
        prefab={{
          definitions: props.content.prefabSummaries,
          targets: props.prefab.overrideTargets,
          copyError: props.prefab.copyError,
          overrideCount: Object.keys(props.prefab.overrideDrafts).length,
          onPlaceCopy: (id) => void props.prefab.placeCopy(id),
          onOverrideCommit: props.prefab.commitOverride,
        }}
      />
    ) : (
    <EntityInspector {...props} />
    )}
    {playing && playInfo !== null && selected !== null && selected.behaviorId !== undefined && (
      <PlayDebugView entityId={selected.id} observe={observeEntity} />
    )}
    </div>
  );
}

/** The Inspector of the selected object (several selected: the primary one). */
function EntityInspector(props: InspectorDockProps): JSX.Element {
  const { clientRef, viewportRef, entities, selected, selection, hierarchyFlags, fieldContext, gizmoMode, setGizmoMode, instanceChunks, selectedCopy, setSelectedCopy, instanceBrush, reportFailure, setNotice } = props;
  const { declarations, materials, prefabSummaries, registry } = props.content;
  const { settings, tags } = props.settings;
  const { addComponentTo, applyPreset, colliderFromModel, colliderFromModel3D, componentError, editComponent, editProperty, fitCapsuleToModel, propertyError, selectedSourceMaterials, setEntityMaterialParams, setEntityMaterials } = props.entity;
  const { editCopiesRef, editTransform, rename, setEntityTags, setFlag } = props.scene;
  const { writeFootprint, snapLocal, blockEditor, blockRows, blockTypes, cellFields, blockStamps, blockHandlersRef, blockRun, blockEdit, createBlockLayer } = props.blocks;
  return (
    <Inspector
      entity={selected}
      gizmoMode={gizmoMode}
      onGizmoMode={setGizmoMode}
      declarations={declarations}
      prefabDisplayName={(prefabId) => prefabSummaries.find((d) => d.prefabId === prefabId)?.displayName ?? prefabId}
      propertyError={propertyError}
      componentError={componentError}
      onEditProperty={(entityId, key, raw) => void editProperty(entityId, key, raw)}
      registry={registry}
      fieldContext={fieldContext}
      onComponentEdit={(entityId, component, patch, rebase) => void editComponent(entityId, component, patch, rebase)}
      onAddComponent={(entityId, component, value) => void addComponentTo(entityId, component, value)}
      onFitCapsule={(entityId) => void fitCapsuleToModel(entityId)}
      capsuleOwner={(() => {
        // A child of the player collides with the player's capsule.
        let parent = selected?.parentId ?? null;
        for (let depth = 0; parent !== null && depth < 64; depth++) {
          const p = entities.find((e) => e.id === parent);
          if (p === undefined) break;
          if (p.controller === true) return p.name;
          parent = p.parentId;
        }
        return null;
      })()}
      onRename={(entityId, name) => void rename(entityId, name)}
      onEditTransform={(entityId, patch, rebase) => void editTransform(entityId, patch, rebase)}
      flags={selected !== null ? (hierarchyFlags.get(selected.id) ?? null) : null}
      entityName={(id) => entities.find((e) => e.id === id)?.name ?? id}
      selectionCount={selection.ids.length}
      onSetFlag={(entityId, flag, value) => void setFlag(entityId, flag, value)}
      tags={tags}
      onSetTags={(entityId, names) => void setEntityTags(entityId, names)}
      // Descriptor-keyed custom widgets — the material mapping knows the
      // model's own material names; a surface offers the built-in presets.
      alwaysShow={selected !== null && (selected.kind === 'model' || selected.kind === 'box' || selected.instances !== undefined) ? ['materials'] : []}
      addExtras={(() => {
        // "Add collider → box / polygon from model outline" (where a collider may be added).
        if (selected === null || registry === null || selected.components['collider'] !== undefined) return [];
        const entry = addEntries(registry, new Set(Object.keys(selected.components)), { dimension: settings?.['physics_dimension'] === 3 ? 3 : 2 }).find((x) => x.component === 'collider');
        const enabled = entry?.enabled === true;
        const reason = entry?.reason ?? null;
        return [
          ...(settings?.['physics_dimension'] === 3
            ? [
                // A 3D project's colliders from the model.
                { id: 'collider-box-model', label: 'Collider: Box from model', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel3D(selected.id, 'box') },
                { id: 'collider-convex-model', label: 'Collider: Convex hull from model', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel3D(selected.id, 'convex') },
                { id: 'collider-mesh-model', label: 'Collider: Mesh from model', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel3D(selected.id, 'mesh') },
                { id: 'collider-compound-model', label: 'Collider: Compound of the _COL parts', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel3D(selected.id, 'compound') },
              ]
            : [
                { id: 'collider-box-model', label: 'Collider: Box from model', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel(selected.id, 'box') },
                { id: 'collider-polygon-model', label: 'Collider: Polygon from model outline', category: 'Physics' as const, enabled, reason, run: () => void colliderFromModel(selected.id, 'polygon') },
              ]),
        ];
      })()}
      bodies={
        selected === null
          ? {}
          : {
              materials: (
                <MaterialMappingEditor
                  label="Materials"
                  sourceNames={selected.kind === 'box' ? [] : selectedSourceMaterials}
                  mapping={selected.materials ?? null}
                  materials={materials}
                  onChange={(mapping) => void setEntityMaterials(selected.id, mapping)}
                  overrides={{
                    value: (selected.components['materialParams'] as Record<string, Record<string, number | number[] | string>> | undefined) ?? null,
                    inherited: selected.assetId !== undefined ? (clientRef.current?.content.getAsset(selected.assetId)?.materials ?? null) : null,
                    onChange: (next) => void setEntityMaterialParams(selected.id, next),
                  }}
                />
              ),
              // The overrides are edited in the Materials section above.
              materialParams: <p className="tl-inspector__hint">Edited in the Materials section (per graph material, public parameters only).</p>,
            }
      }
      extensions={
        selected === null
          ? {}
          : {
              // The selected block layer's tools: they edit it in the Scene view.
              blockLayer: (
                <BlocksPanel
                  editor={blockEditor}
                  visible={props.placement === 'dock' && props.sceneInFront}
                  layers={blockRows}
                  layerId={selected.id}
                  onLayer={(id) => id !== null && props.select(id)}
                  types={blockTypes}
                  fields={cellFields}
                  stamps={blockStamps}
                  registry={registry}
                  fieldContext={fieldContext}
                  thumbnails={props.tileThumbnails}
                  handlers={blockHandlersRef}
                  run={blockRun}
                  edit={blockEdit}
                  onCreateLayer={() => void createBlockLayer()}
                  onSetFlag={(id, flag, value) => void setFlag(id, flag, value)}
                  onNotice={setNotice}
                />
              ),
              // The selected terrain's tools: they edit it in the Scene view.
              terrain: (
                <TerrainPanel
                  editor={props.terrain.terrainEditor}
                  visible={props.placement === 'dock' && props.sceneInFront}
                  entityId={selected.id}
                  component={selected.components['terrain'] as TerrainComponent}
                  locked={hierarchyFlags.get(selected.id)?.locked === true}
                  hidden={hierarchyFlags.get(selected.id)?.active === false}
                  blockLayers={blockRows}
                  run={props.terrain.terrainRun}
                  stage={props.terrain.stageFile}
                />
              ),
              // Write the footprint's metadata into the cells beneath, or land the object on the cell tops.
              blockFootprint: (
                <div className="tl-inspector__modes">
                  <button className="tl-btn tl-btn--small" title="Write the footprint's metadata into the block cells beneath the object" onClick={() => void writeFootprint(selected.id)}>
                    Write to cells
                  </button>
                  <button
                    className="tl-btn tl-btn--small"
                    title="Move the object onto the top of the block cells under it"
                    onClick={() => {
                      const c = clientRef.current;
                      if (!c) return;
                      // Under its parent: the cells beneath its world place, as a local position.
                      const at = snapLocal(selected.id, selected.position, selected.rotation);
                      if (at === null) return setNotice('Not over a block layer.');
                      // The footprint moves with the object in the same command.
                      void c.command('setTransform', { entityId: selected.id, transform: { position: at } }, c.projection.revision).then((r) => {
                        if (!r.ok && (r.response as { code?: string }).code !== 'no_change') reportFailure('Snap to cell top', r);
                      });
                    }}
                  >
                    Snap to cell top
                  </button>
                </div>
              ),
              // One copy of an instance set, and the copy brush.
              instances: (
                <div className="tl-inspector__copies" data-copy={selectedCopy ?? ''}>
                  {instanceChunks[selected.id] !== undefined && (
                    <p className="tl-inspector__hint" data-chunks={instanceChunks[selected.id]}>
                      Drawn in {instanceChunks[selected.id]} chunk{instanceChunks[selected.id] === 1 ? '' : 's'} of at most {String((selected.components['instances'] as { chunkSize?: number } | undefined)?.chunkSize ?? settings?.['instance_chunk_m'] ?? 32)} m, each hidden out of view and given its level of detail on its own.
                    </p>
                  )}
                  {selectedCopy !== null && (
                    <>
                      <p className="tl-inspector__hint">Copy {selectedCopy + 1} selected: move, turn or scale it with the gizmo (W/E/R); Del deletes it.</p>
                      <div className="tl-inspector__modes">
                        <button className="tl-btn" onClick={() => void editCopiesRef.current.remove(selected.id, selectedCopy)}>
                          Delete copy
                        </button>
                        <button
                          className="tl-btn"
                          onClick={() => {
                            viewportRef.current?.setSelectedCopy(null);
                            setSelectedCopy(null);
                          }}
                        >
                          Whole set
                        </button>
                      </div>
                    </>
                  )}
                  <InstanceBrushPanel {...instanceBrush} />
                </div>
              ),
              // A collider from the model's outline; how to edit a polygon in the Scene view.
              collider: (
                <>
                  {settings?.['physics_dimension'] === 3 ? (
                    // A 3D project's colliders from the model (its _COL node, else its geometry).
                    <div className="tl-inspector__modes">
                      <button className="tl-btn" onClick={() => void colliderFromModel3D(selected.id, 'box')}>
                        Box from model
                      </button>
                      <button className="tl-btn" onClick={() => void colliderFromModel3D(selected.id, 'convex')}>
                        Convex hull from model
                      </button>
                      <button className="tl-btn" onClick={() => void colliderFromModel3D(selected.id, 'mesh')}>
                        Mesh from model
                      </button>
                      <button className="tl-btn" onClick={() => void colliderFromModel3D(selected.id, 'compound')}>
                        Compound of _COL parts
                      </button>
                    </div>
                  ) : (
                  <div className="tl-inspector__modes">
                    <button className="tl-btn" onClick={() => void colliderFromModel(selected.id, 'box')}>
                      Box from model
                    </button>
                    <button className="tl-btn" onClick={() => void colliderFromModel(selected.id, 'polygon')}>
                      Polygon from model outline
                    </button>
                  </div>
                  )}
                  {(selected.components['collider'] as { shape?: { type?: string } } | undefined)?.shape?.type === 'polygon' && (
                    <p className="tl-inspector__hint">Scene view: drag a corner; drag a small grey point to add a corner there; Alt+click a corner to delete it.</p>
                  )}
                </>
              ),
              mover: <p className="tl-inspector__hint">Scene view: drag a point; drag a small grey point to add one there; Alt+click a point to delete it.</p>,
              surface: (
                <label className="tl-field">
                  <span className="tl-field__label">Preset</span>
                  <select className="tl-input" aria-label="surface preset" value="" onChange={(e) => e.target.value !== '' && void applyPreset(selected.id, e.target.value as SurfacePresetName)}>
                    <option value="">apply a preset…</option>
                    {SURFACE_PRESET_NAMES.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              ),
            }
      }
    />
  );
}
