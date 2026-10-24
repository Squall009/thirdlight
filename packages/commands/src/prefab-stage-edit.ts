/**
 * Editing a prefab on its own: its stage.
 *
 * A prefab opens for editing as a copy no scene holds (its root's id is
 * project-model `prefabStageId`, its parts' ids derived from it as any
 * copy's). A command that names the stage's objects is an ordinary command:
 * it runs on the stage copy through the one pipeline (a linked copy's part
 * edit, `prefab-copy-edit.ts`), and what it made the copy differ in is then
 * applied to the prefab (`applyPrefabOverrides` with `all`). The stored
 * change is the prefab replaced and no scene object, so it is one undo step,
 * every copy follows it as it follows any prefab edit, and a copy nested in
 * the prefab is edited as a copy (its overrides land on the nested copy).
 */
import { assembleSceneEntities, prefabPartId, prefabStageId, prefabStageRootOf, type AssemblyEntity, type EntityV3 } from '@thirdlight/project-model';

import { contentOf } from './content-ops';
import { prefabOverrideUnsupported, type CommandError } from './errors';
import { deepClone, gateResultState, type OpSuccess } from './ops';
import { catalogAssembler, namedIds, routeCopyEdit } from './prefab-copy-edit';
import type { PrefabLinkEditChange } from './prefab-link-types';
import type { ApplyOutcome, CommandState, ContentDocument, SceneDocument } from './types';

type Obj = Record<string, unknown>;

/** The stored root of a prefab's stage copy: the prefab's own root placement, no overrides. */
function stageRoot(prefabId: string, transform: unknown): EntityV3 {
  return { id: prefabStageId(prefabId), components: { transform: deepClone(transform), prefab: { prefabId } } } as unknown as EntityV3;
}

/** The prefab whose stage an id names (null: none; undefined: not a stage id at all). */
function stagePrefabOf(content: ContentDocument | undefined, id: string): { prefabId: string; transform: unknown } | null | undefined {
  const root = prefabStageRootOf(id);
  if (root === null) return undefined;
  for (const d of contentOf(content).prefabs) if (prefabStageId(d.prefabId) === root) return { prefabId: d.prefabId, transform: d.entities[0]?.components.transform };
  return null;
}

/** A prefab's stage as the editor shows it: the copy's objects, assembled (null: no such prefab). */
export function prefabStage(content: ContentDocument | undefined, prefabId: string): { rootId: string; entities: AssemblyEntity[] } | null {
  const d = contentOf(content).prefabs.find((p) => p.prefabId === prefabId);
  if (d === undefined) return null;
  const root = stageRoot(prefabId, d.entities[0]?.components.transform);
  const made = assembleSceneEntities([root as unknown as AssemblyEntity], catalogAssembler(content));
  return { rootId: root.id, entities: made.entities };
}

/**
 * Run a command that names a prefab stage's objects on the stage and store
 * it as the prefab changed. Null when it names no stage.
 */
export function routeStageEdit(
  state: CommandState<SceneDocument>,
  request: unknown,
  op: string,
  args: Obj,
  run: (state: CommandState<SceneDocument>, request: unknown) => ApplyOutcome<SceneDocument>,
): { ok: true; op: OpSuccess } | { ok: false; error: CommandError } | null {
  if (op === 'undo' || op === 'redo' || state.scene.schemaVersion !== 4) return null;
  const { targets, places } = namedIds(args);
  const ids = [...targets, ...places];
  const staged = ids.map((id) => ({ id, stage: stagePrefabOf(state.content, id) }));
  const first = staged.find((s) => s.stage !== undefined);
  if (first === undefined) return null;
  // Inside the stage's own run its copy is stored: the command runs as a copy's part edit.
  const rootId = prefabStageRootOf(first.id);
  if (state.scene.entities.some((e) => e.id === rootId)) return null;
  const found = first.stage;
  if (found === null || found === undefined) return { ok: false, error: prefabOverrideUnsupported(first.id, `"${first.id}" names the stage of a prefab that is gone`) };
  const { prefabId, transform } = found;
  const other = staged.find((s) => s.stage === undefined || s.stage === null || s.stage.prefabId !== prefabId);
  if (other !== undefined) return { ok: false, error: prefabOverrideUnsupported(other.id, `an edit in a prefab's stage names only that prefab's objects ("${other.id}" is not one)`) };
  if (state.otherScene !== undefined) return { ok: false, error: prefabOverrideUnsupported(first.id, "a prefab's objects stay in the prefab") };
  const root = stageRoot(prefabId, transform);
  const bare = JSON.stringify(root);
  const stage = { ...state.scene, entities: [root] } as SceneDocument;
  const fresh = { entries: [], cursor: 0, seq: 1 };
  const edited = run({ ...state, scene: stage, history: fresh }, request);
  if (!edited.ok) return { ok: false, error: edited.result.error };
  // The root's own placement, name and tags are each copy's, never the prefab's: an edit of them is refused, not lost.
  const own = (e: unknown): string => {
    const { components, ...rest } = (e ?? {}) as { components?: Obj };
    const { prefab: _p, ...comps } = components ?? {};
    void _p;
    return JSON.stringify({ ...rest, components: comps });
  };
  const editedRoot = edited.state.scene.entities.find((e) => e.id === root.id);
  if (own(editedRoot) !== own(root)) {
    return { ok: false, error: prefabOverrideUnsupported(root.id, `${op} changes what each copy of the prefab keeps as its own (the root's place, name or tags), not the prefab: edit them on a copy`) };
  }
  const env = request as Obj;
  const applied = run(
    { ...edited.state, history: fresh },
    { op: 'applyPrefabOverrides', projectId: env['projectId'], expectedRevision: edited.state.scene.revision, ...(env['requestId'] !== undefined ? { requestId: env['requestId'] } : {}), ...(env['origin'] !== undefined ? { origin: env['origin'] } : {}), args: { entityId: root.id, all: true } },
  );
  if (!applied.ok) return { ok: false, error: applied.result.error };
  const left = applied.state.scene.entities;
  // Objects the edit added became parts; the stage keeps no ids of its own (`partIds`): its parts' ids are derived.
  const leftRoot = left[0] as unknown as { components: { prefab?: { partIds?: Record<string, string> } } } | undefined;
  const kept = leftRoot?.components.prefab?.partIds ?? {};
  if (leftRoot?.components.prefab !== undefined) {
    const { partIds: _k, ...link } = leftRoot.components.prefab;
    void _k;
    leftRoot.components.prefab = link;
  }
  if (left.length !== 1 || JSON.stringify(left[0]) !== bare) {
    return { ok: false, error: prefabOverrideUnsupported(root.id, `${op} changes the root's place, name or tags, which each copy keeps as its own: edit them on a copy`) };
  }
  const prefabs = (applied.result.change as PrefabLinkEditChange).prefabs ?? [];
  const gate = gateResultState({ scene: state.scene, content: state.content, manifest: state.manifest }, { ...state.scene, revision: state.scene.revision + 1 }, applied.state.content);
  if (!gate.ok) return gate;
  // An object made in the stage is named by the id it has there now that it is a part.
  const made = edited.result.createdId;
  const madeKey = made === undefined ? undefined : Object.entries(kept).find(([, id]) => id === made)?.[0];
  const createdId = madeKey !== undefined ? prefabPartId(root.id, madeKey) : made;
  const change: PrefabLinkEditChange = { type: 'prefabLinkEdit', copyIds: [], previous: [], next: [], removedIds: [], ...(prefabs.length > 0 ? { prefabs } : {}) };
  return { ok: true, op: { scene: gate.scene, ...(gate.content !== undefined ? { content: gate.content } : {}), change, inverse: { kind: 'prefabLinkEdit' }, ...(createdId !== undefined ? { createdId } : {}) } };
}

/** A command that names a prefab stage's objects (the prefab changes) or a linked copy's parts (overrides); null: neither. */
export function routeLinkedEdit(
  state: CommandState<SceneDocument>,
  request: unknown,
  op: string,
  args: Obj,
  run: (state: CommandState<SceneDocument>, request: unknown) => ApplyOutcome<SceneDocument>,
): ReturnType<typeof routeStageEdit> {
  return routeStageEdit(state, request, op, args, run) ?? routeCopyEdit(state, request, op, args, run);
}
