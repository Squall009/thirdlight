/**
 * What the project window does to its items besides moving them: make a new
 * one of a kind in the folder shown (Unity's Create menu, Godot's "New
 * Resource"), rename one, delete one. Each is one command through the session
 * client (the one mutation path) and one undo; each resolves to the refusal's
 * message, or null.
 *
 * A new item gets an id no item of its kind has (looked up in the project
 * index, which holds every item; the editor holds only what it has read), is
 * shown in the Inspector, and opens in its editor where it has one.
 *
 * Browser-only (React).
 */
import { useCallback, useMemo, useState, type Dispatch } from 'react';
import type { AnimatorController, MaterialDef } from '@thirdlight/project-model';
import { DIALOGUE_LIMITS, NAME_MAX, RESOURCE_KIND_TABLE, SCRIPT_LIBRARY_LIMITS, TIMELINE_LIMITS, UI_LIMITS } from '@thirdlight/project-model/limits';
import { defaultTrimSheet } from '@thirdlight/project-model/trim-sheet';
import { architectureGraphTemplate } from '@thirdlight/runtime';

import { docKey, type WorkspaceAction } from '../../session/editor-window';
import { newEffect } from '../../session/effect-edit';
import { newMaterialGraph, templateMaterial } from '../../session/material-graph';
import { documentOfItem, freeItemId, isAssetKind, type ProjectItem } from '../../session/project-items';
import { newLibraryFiles } from '../../session/script-sources';
import { newUiDocument, newUiTheme } from '../../session/ui-edit';
import { locomotionController, type ClipInfo } from '../animator/parts';
import { newTimeline } from '../timeline/TimelineDocument';
import { MODEL_KINDS } from '../catalog/RefPicker';
import { refusal, type ClientRef } from '../shell/commands';
import type { ProjectContent } from '../shell/useProjectContent';

/** One entry of the Create menu: what it makes, the name it suggests, the submenu it sits in. */
export interface CreateKind {
  readonly key: string;
  readonly label: string;
  readonly defaultName: string;
  /** The submenu (Graph material, Graph), or none. */
  readonly group?: string;
}

/** What a new graph material starts from: an empty PBR output or a shader type's built-in template (the same look). */
export const GRAPH_MATERIAL_TEMPLATES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Empty (PBR output)' },
  { value: 'standard', label: 'Standard' },
  { value: 'foliage', label: 'Foliage wind' },
  { value: 'kit', label: 'World-aligned kit' },
  { value: 'unlit', label: 'Unlit' },
  { value: 'water', label: 'Water' },
  // For a spline's water mesh: two-phase flow along it, foam at its banks and in the shallows, soft shores.
  { value: 'river', label: 'River (spline water)' },
  // Four PBR layers from texture arrays, mixed by vertex colours / painted terrain through a Height blend.
  { value: 'layers', label: 'Height-blended layers (painted terrain)' },
];

/** A name longer than its kind's model accepts is cut here (each bound is the model's own). */
function nameMaxOf(kind: string): number {
  switch (kind) {
    case 'dialogue':
      return DIALOGUE_LIMITS.nameChars;
    case 'ui':
    case 'uitheme':
      return UI_LIMITS.nameChars;
    case 'library':
      return SCRIPT_LIBRARY_LIMITS.nameChars;
    case 'timeline':
      return TIMELINE_LIMITS.nameChars;
    default:
      return NAME_MAX;
  }
}

/** Each resource kind's delete command (its id goes under the kind's id key). */
const DELETE_OP: Readonly<Record<string, string>> = {
  material: 'deleteMaterial',
  prefab: 'deletePrefab',
  behavior: 'deleteBehavior',
  animator: 'deleteAnimator',
  graph: 'deleteGraph',
  effect: 'deleteEffect',
  library: 'deleteScriptLibrary',
  ui: 'deleteUiDocument',
  uitheme: 'deleteUiTheme',
  dialogue: 'deleteDialogue',
  timeline: 'deleteTimeline',
};

export interface ItemActionsDeps {
  clientRef: ClientRef;
  content: Pick<ProjectContent, 'materials' | 'graphs' | 'graphKinds' | 'animators' | 'timelines' | 'uiDocuments' | 'uiThemes'>;
  workspaceDispatch: Dispatch<WorkspaceAction>;
  /** Show an item in the Inspector. */
  inspect: (item: ProjectItem) => void;
  /** Open a document in the editor window. */
  openDocument: (kind: string, id: string) => void;
  /** An item is gone (deleted): whatever showed it lets go. */
  onDeleted: (item: ProjectItem) => void;
  /** The model chosen in the project window (a new animator controller uses its clips), or null. */
  chosenModel: () => string | null;
  clipsOf: (assetId: string) => Promise<ClipInfo[]>;
}

export interface ItemActions {
  /** The Create menu's entries, in menu order. */
  readonly createKinds: readonly CreateKind[];
  create(key: string, name: string): Promise<string | null>;
  canRename(kind: string): boolean;
  rename(item: ProjectItem, name: string): Promise<string | null>;
  canDelete(kind: string): boolean;
  remove(item: ProjectItem): Promise<string | null>;
  /** The last refused delete (the Inspector shows it under the item). */
  readonly deleteError: { item: ProjectItem; message: string } | null;
}

export function useItemActions(deps: ItemActionsDeps): ItemActions {
  const { clientRef, content, workspaceDispatch, inspect, openDocument, onDeleted, chosenModel, clipsOf } = deps;
  const { materials, graphs, graphKinds, animators, timelines, uiDocuments, uiThemes } = content;
  const [deleteError, setDeleteError] = useState<ItemActions['deleteError']>(null);

  // Standalone graph kinds (a kind owned by another document, the animator's, is made there).
  const createKinds = useMemo<CreateKind[]>(() => {
    const graphKindIds = Object.keys(graphKinds).filter((k) => graphKinds[k]!.owner === undefined);
    return [
      { key: 'material', label: 'Material', defaultName: 'New material' },
      { key: 'trim-material', label: 'Trim sheet material', defaultName: 'New trim sheet' },
      ...GRAPH_MATERIAL_TEMPLATES.map((t) => ({ key: `graph-material:${t.value}`, label: t.label, defaultName: t.value === '' ? 'New graph material' : `New ${t.label.toLowerCase()} material`, group: 'Graph material' })),
      { key: 'animator', label: 'Animator controller', defaultName: 'New animator' },
      { key: 'animator-locomotion', label: 'Animator controller: character locomotion', defaultName: 'Character locomotion' },
      ...graphKindIds.map((k) => ({ key: `graph:${k}`, label: graphKinds[k]!.label, defaultName: `New ${graphKinds[k]!.label.toLowerCase()}`, group: 'Graph' })),
      { key: 'effect', label: 'Effect', defaultName: 'New effect' },
      { key: 'dialogue', label: 'Dialogue', defaultName: 'New conversation' },
      { key: 'timeline', label: 'Timeline', defaultName: 'New timeline' },
      { key: 'library', label: 'Script library', defaultName: 'New library' },
      { key: 'ui', label: 'UI document', defaultName: 'New UI document' },
      { key: 'uitheme', label: 'UI theme', defaultName: 'New UI theme' },
    ];
  }, [graphKinds]);

  const create = useCallback(
    async (key: string, rawName: string): Promise<string | null> => {
      const c = clientRef.current;
      if (c === null) return 'not connected';
      const [head, arg = ''] = key.includes(':') ? [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)] : [key, ''];
      const kind = head === 'graph-material' || head === 'trim-material' ? 'material' : head === 'animator-locomotion' ? 'animator' : head;
      const name = rawName.trim().slice(0, nameMaxOf(kind));
      if (name === '') return 'give it a name';
      const id = await freeItemId(name, kind, (ids) => c.catalog.taken(ids, [kind]));
      const run = async (op: string, args: Record<string, unknown>): Promise<string | null> => refusal(await c.command(op, args, c.projection.revision));
      let err: string | null;
      switch (head) {
        case 'material':
          err = await run('setMaterial', { material: { materialId: id, name, shader: 'standard', params: {}, textures: {} } satisfies MaterialDef });
          break;
        case 'trim-material':
          // One sheet in the engine's starter layout (equal rows); its textures and rows are set in the Inspector.
          err = await run('setMaterial', { material: { materialId: id, name, shader: 'trim', params: {}, textures: {}, trim: defaultTrimSheet() } satisfies MaterialDef });
          break;
        case 'graph-material':
          err = await run('setMaterial', { material: arg === '' ? ({ materialId: id, name, shader: 'standard', params: {}, textures: {}, graph: newMaterialGraph() } satisfies MaterialDef) : templateMaterial(arg, id, name) });
          break;
        case 'animator':
        case 'animator-locomotion': {
          // The model chosen in the project window, else the project's first.
          const model = chosenModel() ?? (await c.catalog.page({ kinds: MODEL_KINDS }, 0, 1)).entries[0]?.id ?? null;
          if (model === null) return 'import a model with animation clips first';
          const clips = await clipsOf(model);
          if (clips.length === 0) return 'the chosen model has no animation clips (choose one that has in the project window)';
          const made: AnimatorController | string =
            head === 'animator-locomotion'
              ? locomotionController(id, model, clips)
              : {
                  controllerId: id,
                  name,
                  parameters: [{ name: 'speed', type: 'float', default: 0 }],
                  states: [{ id: 'state-01', name: clips[0]!.name, motion: { kind: 'clip', clip: { assetId: model, clip: clips[0]!.name, duration: Math.max(0.001, clips[0]!.duration) } }, speed: 1, loop: true, position: [180, 40] }],
                  transitions: [],
                  entry: 'state-01',
                  events: [],
                };
          if (typeof made === 'string') return made;
          err = await run('setAnimator', { controller: { ...made, name } });
          break;
        }
        case 'graph':
          if (graphKinds[arg] === undefined) return `no graph kind ${arg}`;
          // An architecture style starts with its Outline and Output, a preset deriving from the starter room.
          err = await run('setGraph', { graph: { graphId: id, kind: arg, name, graph: architectureGraphTemplate(arg) } });
          break;
        case 'effect':
          err = await run('setEffect', { effect: newEffect(id, name) });
          break;
        case 'dialogue':
          err = await run('setDialogue', { dialogue: { dialogueId: id, name } });
          break;
        case 'timeline':
          err = await run('setTimeline', { timeline: newTimeline(id, name) });
          break;
        case 'library':
          err = await run('setScriptLibrary', { libraryId: id, name, files: newLibraryFiles(id) });
          break;
        case 'ui':
          err = await run('setUiDocument', { document: newUiDocument(id, name) });
          break;
        case 'uitheme':
          err = await run('setUiTheme', { theme: newUiTheme(id, name) });
          break;
        default:
          return `nothing to create for ${key}`;
      }
      if (err !== null) return err;
      const item = { kind, id };
      inspect(item);
      // A shader material is edited in the Inspector; everything else opens in its editor.
      const doc = documentOfItem(item);
      if (doc !== null && head !== 'material') openDocument(doc.kind, doc.id);
      return null;
    },
    [clientRef, graphKinds, chosenModel, clipsOf, inspect, openDocument],
  );

  const renameArgs = useCallback(
    (item: ProjectItem, name: string): [string, Record<string, unknown>] | null => {
      const { kind, id } = item;
      const one = <T>(list: readonly T[], key: keyof T): T | undefined => list.find((x) => x[key] === id);
      switch (kind) {
        case 'material': {
          const m = one(materials, 'materialId');
          return m === undefined ? null : ['setMaterial', { material: { ...m, name } }];
        }
        case 'graph': {
          const g = one(graphs, 'graphId');
          return g === undefined ? null : ['setGraph', { graph: { ...g, name } }];
        }
        case 'animator': {
          const a = one(animators, 'controllerId');
          return a === undefined ? null : ['setAnimator', { controller: { ...a, name } }];
        }
        case 'timeline': {
          const t = one(timelines, 'timelineId');
          return t === undefined ? null : ['setTimeline', { timeline: { ...t, name } }];
        }
        case 'ui': {
          const d = one(uiDocuments, 'uiDocumentId');
          return d === undefined ? null : ['setUiDocument', { document: { ...d, name } }];
        }
        case 'uitheme': {
          const t = one(uiThemes, 'uiThemeId');
          return t === undefined ? null : ['setUiTheme', { theme: { ...t, name } }];
        }
        case 'effect':
          return ['renameEffect', { effectId: id, name }];
        case 'dialogue':
          return ['setDialogue', { dialogue: { dialogueId: id, name } }];
        case 'library':
          return ['setScriptLibrary', { libraryId: id, name }];
        default:
          return null;
      }
    },
    [materials, graphs, animators, timelines, uiDocuments, uiThemes],
  );
  const canRename = useCallback((kind: string) => ['material', 'graph', 'animator', 'timeline', 'ui', 'uitheme', 'effect', 'dialogue', 'library'].includes(kind), []);
  const rename = useCallback(
    async (item: ProjectItem, rawName: string): Promise<string | null> => {
      const c = clientRef.current;
      if (c === null) return 'not connected';
      const name = rawName.trim().slice(0, nameMaxOf(item.kind));
      if (name === '') return 'give it a name';
      const sent = renameArgs(item, name);
      if (sent === null) return `${item.kind} ${item.id} cannot be renamed here`;
      return refusal(await c.command(sent[0], sent[1], c.projection.revision));
    },
    [clientRef, renameArgs],
  );

    // `asset`: an asset whose kind is not known yet (the Inspector shows one an import just brought).
  const assetItem = (kind: string): boolean => kind === 'asset' || isAssetKind(kind);
  const canDelete = useCallback((kind: string) => assetItem(kind) || DELETE_OP[kind] !== undefined, []);
  const remove = useCallback(
    async (item: ProjectItem): Promise<string | null> => {
      const c = clientRef.current;
      if (c === null) return 'not connected';
      const op = assetItem(item.kind) ? 'deleteAsset' : DELETE_OP[item.kind];
      const idKey = assetItem(item.kind) ? 'assetId' : RESOURCE_KIND_TABLE.find((k) => k.kind === item.kind)?.idKey;
      if (op === undefined || idKey === undefined) return `${item.kind} items are not deleted here`;
      // The backend refuses while anything still uses it, naming the uses; one undo brings it back.
      const err = refusal(await c.command(op, { [idKey]: item.id }, c.projection.revision));
      setDeleteError(err === null ? null : { item, message: err });
      if (err !== null) return err;
      const doc = documentOfItem(item);
      if (doc !== null) workspaceDispatch({ type: 'close', key: docKey(doc) });
      onDeleted(item);
      return null;
    },
    [clientRef, workspaceDispatch, onDeleted],
  );

  return useMemo(() => ({ createKinds, create, canRename, rename, canDelete, remove, deleteError }), [createKinds, create, canRename, rename, canDelete, remove, deleteError]);
}
