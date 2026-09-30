/**
 * `importResources`: resource and scene files the file check found in the
 * game folder come into the project in one command (one revision, one undo):
 * a file added or copied outside the editor, a resource file changed there
 * (its record is replaced by the file's), one removed there (its record goes).
 *
 * The request carries nothing. What the files hold was prepared by the host
 * from the files themselves (each record with its content list and id, each
 * scene with its index name and document), as `importAssets` reads a folder:
 * the op reads only `CommandState.preparedResourceImport`, never a
 * caller-supplied record, so no unchecked write path exists. The result is
 * validated like any edit.
 */
import type { SceneIndexEntry } from '@thirdlight/project-model';

import { contentOf, type OpInput } from './content-ops';
import { fieldUnexpected, fieldValue, noChangeContent, type CommandError } from './errors';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import { withListRecord } from './record-lists';
import type { ContentDocument, SceneDocument } from './types';

/** `importResources` takes no args: the host prepared what the files hold. */
export type ImportResourcesArgs = Record<string, never>;

/** One record the files set (`record`) or removed (`null`), in its content list (`environment.presets`: a list inside a block). */
export interface PreparedResourceRecord {
  list: string;
  idKey: string;
  id: string;
  record: Record<string, unknown> | null;
}

/** One scene file adopted: its index entry and its document (the host placed it in the scene set). */
export interface AdoptedScene {
  sceneId: string;
  name: string;
  scene: unknown;
}

/** What the host prepared for one `importResources` request. */
export interface PreparedResourceImport {
  records: PreparedResourceRecord[];
  scenes: AdoptedScene[];
}

/** `importResources` change data, in the direction applied (an undo swaps each record and removes the scenes it added). */
export interface ImportResourcesChange {
  type: 'importResources';
  records: { list: string; idKey: string; id: string; previous: Record<string, unknown> | null; next: Record<string, unknown> | null }[];
  scenesAdded: AdoptedScene[];
  scenesRemoved: string[];
}

export interface ImportResourcesInverse {
  kind: 'importResources';
}

export function validateImportResourcesArgs(args: Record<string, unknown>): { ok: true; args: ImportResourcesArgs } | { ok: false; error: CommandError } {
  for (const k of Object.keys(args)) return { ok: false, error: fieldUnexpected(`/args/${k}`, k, 'none (the file check prepares what the files hold)') };
  return { ok: true, args: {} };
}

type Rec = Record<string, unknown>;

function listAt(content: ContentDocument, list: string): readonly Rec[] {
  const c = content as unknown as Rec;
  const v = list.includes('.') ? (c[list.split('.')[0]!] as Rec | undefined)?.[list.split('.')[1]!] : c[list];
  return Array.isArray(v) ? (v as Rec[]) : [];
}

/** The content with one record of a list set or removed (a nested list keeps its order: its records are the author's order). */
function withRecord(content: ContentDocument, r: { list: string; idKey: string; id: string }, record: Rec | null): ContentDocument {
  const c = content as unknown as Rec;
  const idOf = (x: Rec): string => String(x[r.idKey]);
  if (!r.list.includes('.')) return { ...c, [r.list]: withListRecord(listAt(content, r.list), idOf, r.id, record) } as unknown as ContentDocument;
  const [block, key] = r.list.split('.') as [string, string];
  const list = [...listAt(content, r.list)];
  const at = list.findIndex((x) => idOf(x) === r.id);
  if (record === null) {
    if (at >= 0) list.splice(at, 1);
  } else if (at >= 0) list[at] = record;
  else list.push(record);
  return { ...c, [block]: { ...((c[block] as Rec | undefined) ?? {}), [key]: list } } as unknown as ContentDocument;
}

function sceneIndexOf(content: ContentDocument): { scenes: SceneIndexEntry[]; startScenes: string[] } | null {
  const c = content as { scenes?: SceneIndexEntry[]; startScenes?: string[] };
  return Array.isArray(c.scenes) && Array.isArray(c.startScenes) ? { scenes: c.scenes, startScenes: c.startScenes } : null;
}

/** Apply records and scene entries; null when the history no longer fits (an undo or redo). */
function applyTo(content: ContentDocument, records: ImportResourcesChange['records'], add: readonly AdoptedScene[], remove: readonly string[]): ContentDocument | { error: CommandError } {
  let next = content;
  for (const r of records) next = withRecord(next, r, r.next === null ? null : deepClone(r.next));
  if (add.length === 0 && remove.length === 0) return next;
  const index = sceneIndexOf(next);
  if (index === null) return { error: fieldValue('/prepared/scenes', add.length, 'a v4 project', 'scenes come in only in a v4 project (one file per scene)') };
  const gone = new Set(remove);
  const scenes = index.scenes.filter((e) => !gone.has(e.sceneId));
  for (const s of add) {
    if (scenes.some((e) => e.sceneId === s.sceneId)) return { error: fieldValue('/prepared/scenes', s.sceneId, 'an unused scene id', 'a scene with this id already exists') };
    scenes.push({ sceneId: s.sceneId, name: s.name });
  }
  const startScenes = index.startScenes.filter((id) => !gone.has(id));
  if (startScenes.length === 0) return { error: fieldValue('/prepared/scenes', remove, 'a start scene left', 'the game needs at least one start scene') };
  return { ...(next as unknown as Rec), scenes, startScenes } as unknown as ContentDocument;
}

export function applyImportResources(input: OpInput, prepared: PreparedResourceImport | undefined): OpOutcome {
  if (prepared === undefined) return { ok: false, error: fieldValue('/args', null, 'files the host prepared', 'nothing was prepared: the file check sends this command after it read the files') };
  if (prepared.records.length === 0 && prepared.scenes.length === 0) return { ok: false, error: noChangeContent() };
  const catalog = contentOf(input.content);
  const records: ImportResourcesChange['records'] = prepared.records.map((r) => {
    const found = listAt(catalog, r.list).find((x) => String(x[r.idKey]) === r.id);
    return { list: r.list, idKey: r.idKey, id: r.id, previous: found === undefined ? null : deepClone(found), next: r.record };
  });
  const next = applyTo(catalog, records, prepared.scenes, []);
  if ('error' in next) return { ok: false, error: next.error };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  // The change carries each record as stored (canonical).
  const stored = gate.content ?? next;
  for (const r of records) if (r.next !== null) r.next = deepClone(listAt(stored, r.list).find((x) => String(x[r.idKey]) === r.id) ?? r.next);
  const change: ImportResourcesChange = { type: 'importResources', records, scenesAdded: deepClone(prepared.scenes), scenesRemoved: [] };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'importResources' } } };
}

/** The records are where the change left them (else the history does not apply). */
function fits(content: ContentDocument, records: ImportResourcesChange['records'], side: 'previous' | 'next'): boolean {
  return records.every((r) => listAt(content, r.list).some((x) => String(x[r.idKey]) === r.id) === (r[side] !== null));
}

/** The undo of an `importResources`: each record back as it was, the adopted scenes out of the index (null: the history does not apply). */
export function undoImportResources(scene: SceneDocument, content: ContentDocument, forward: ImportResourcesChange): { scene: SceneDocument; content: ContentDocument; change: ImportResourcesChange } | null {
  if (!fits(content, forward.records, 'next')) return null;
  const records = forward.records.map((r) => ({ ...r, previous: r.next, next: r.previous })).reverse();
  const removed = forward.scenesAdded.map((s) => s.sceneId);
  const next = applyTo(content, records, [], removed);
  if ('error' in next) return null;
  return { scene: { ...scene, revision: scene.revision + 1 }, content: next, change: { type: 'importResources', records: deepClone(records), scenesAdded: [], scenesRemoved: removed } };
}

/** The redo: the recorded records and scenes again (null: the history does not apply). */
export function redoImportResources(scene: SceneDocument, content: ContentDocument, forward: ImportResourcesChange): { scene: SceneDocument; content: ContentDocument; change: ImportResourcesChange } | null {
  if (!fits(content, forward.records, 'previous')) return null;
  const next = applyTo(content, forward.records, forward.scenesAdded, []);
  if ('error' in next) return null;
  return { scene: { ...scene, revision: scene.revision + 1 }, content: next, change: deepClone(forward) };
}
