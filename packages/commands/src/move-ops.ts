/**
 * The project window's file operations (Unity's Project window, Godot's
 * FileSystem dock): `moveResources` moves assets, resources, scenes and whole
 * folders into a folder; `renameFolder` renames one folder; `createFolder`
 * makes an empty one. Each is one command and one undo however many files it
 * moves, so MCP can organize a project the way the editor does.
 *
 * Ids never change: every reference is by id, so a move changes no reference
 * and no build (paths are not part of what a build ships or its id).
 *
 * Where a resource's or a scene's file is, is the host's knowledge (the files
 * are found by id on open), not the content block's; an asset's file is on its
 * record. So the host prepares the moves from the request, as it prepares an
 * import (`CommandState.preparedMoves`: every file with where it is and where
 * it goes, every folder moved, made or removed), and this op reads only them:
 * it rewrites the asset records' paths and records the change. The host moves
 * the files after the command committed, in the change's direction, which an
 * undo reverses.
 */
import { isValidSourcePath } from '@thirdlight/project-model';

import { contentOf, type OpInput } from './content-ops';
import { fieldMissing, fieldType, fieldUnexpected, fieldValue, isPlainObject, noChangeContent, type CommandError } from './errors';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { CommandAssetRecord, ContentDocument, SceneDocument } from './types';

/** An item a move names: an asset (`asset` or its own kind), a resource kind, or `scene`. */
export interface MoveItemRef {
  kind: string;
  id: string;
}

/** `moveResources` args: the items and folders moved into `to` (a folder of the game folder; `""`: its top). */
export interface MoveResourcesArgs {
  items?: MoveItemRef[];
  folders?: string[];
  to: string;
}

/** `renameFolder` args: a folder and its new name (one path segment). */
export interface RenameFolderArgs {
  folder: string;
  name: string;
}

/** `createFolder` args: the folder to make (its parents are made too). */
export interface CreateFolderArgs {
  folder: string;
}

/** One file a change moved: `asset` (its file and sidecar), a resource kind or `scene`; paths as the index shows them. */
export interface FileMove {
  kind: string;
  id: string;
  from: string;
  to: string;
}

/** A folder moved (`from` → `to`), made (`from` null) or removed (`to` null: only an empty one). */
export interface FolderMove {
  from: string | null;
  to: string | null;
}

/** What the host prepared for one request: every file it moves and every folder it moves, makes or removes. */
export interface PreparedMoves {
  moves: FileMove[];
  folders: FolderMove[];
}

/** The change, in the direction applied (an undo swaps every move and reverses their order). */
export interface MoveResourcesChange {
  type: 'moveResources';
  moves: FileMove[];
  folders: FolderMove[];
}

export interface MoveResourcesInverse {
  kind: 'moveResources';
}

/** The ops that move files (the host prepares each). */
export const FILE_MOVE_OPS: readonly string[] = ['moveResources', 'renameFolder', 'createFolder'];

const isFolderPath = (v: unknown): v is string => typeof v === 'string' && isValidSourcePath(v);
const FOLDER_HINT = 'a folder of the game folder, relative, with forward slashes (e.g. assets/props)';

function exactKeys(args: Record<string, unknown>, allowed: readonly string[]): CommandError | null {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) return fieldUnexpected(`/args/${k}`, k, allowed.join(', '));
  return null;
}

export function validateMoveResourcesArgs(args: Record<string, unknown>): { ok: true; args: MoveResourcesArgs } | { ok: false; error: CommandError } {
  const extra = exactKeys(args, ['items', 'folders', 'to']);
  if (extra !== null) return { ok: false, error: extra };
  if (args['to'] === undefined) return { ok: false, error: fieldMissing('/args/to', 'to') };
  if (args['to'] !== '' && !isFolderPath(args['to'])) return { ok: false, error: fieldValue('/args/to', args['to'], `"" (the top of the game folder) or ${FOLDER_HINT}`, 'to names the folder the items move into') };
  const out: MoveResourcesArgs = { to: args['to'] as string };
  if (args['items'] !== undefined) {
    if (!Array.isArray(args['items'])) return { ok: false, error: fieldType('/args/items', args['items'], 'array of { kind, id }') };
    const items: MoveItemRef[] = [];
    for (let i = 0; i < args['items'].length; i++) {
      const v: unknown = args['items'][i];
      if (!isPlainObject(v)) return { ok: false, error: fieldType(`/args/items/${i}`, v, 'object { kind, id }') };
      for (const k of Object.keys(v)) if (k !== 'kind' && k !== 'id') return { ok: false, error: fieldUnexpected(`/args/items/${i}/${k}`, k, 'kind, id') };
      if (typeof v['kind'] !== 'string' || v['kind'] === '') return { ok: false, error: fieldType(`/args/items/${i}/kind`, v['kind'], 'string (asset, an asset kind, a resource kind or scene)') };
      if (typeof v['id'] !== 'string' || v['id'] === '') return { ok: false, error: fieldType(`/args/items/${i}/id`, v['id'], 'string (an id)') };
      items.push({ kind: v['kind'], id: v['id'] });
    }
    out.items = items;
  }
  if (args['folders'] !== undefined) {
    if (!Array.isArray(args['folders'])) return { ok: false, error: fieldType('/args/folders', args['folders'], 'array of folder paths') };
    for (let i = 0; i < args['folders'].length; i++) if (!isFolderPath(args['folders'][i])) return { ok: false, error: fieldValue(`/args/folders/${i}`, args['folders'][i], FOLDER_HINT, 'folders names folders moved with everything in them') };
    out.folders = [...(args['folders'] as string[])];
  }
  if ((out.items ?? []).length === 0 && (out.folders ?? []).length === 0) return { ok: false, error: fieldValue('/args', args, 'items or folders with at least one entry', 'moveResources moves items or folders') };
  return { ok: true, args: out };
}

export function validateRenameFolderArgs(args: Record<string, unknown>): { ok: true; args: RenameFolderArgs } | { ok: false; error: CommandError } {
  const extra = exactKeys(args, ['folder', 'name']);
  if (extra !== null) return { ok: false, error: extra };
  if (args['folder'] === undefined) return { ok: false, error: fieldMissing('/args/folder', 'folder') };
  if (!isFolderPath(args['folder'])) return { ok: false, error: fieldValue('/args/folder', args['folder'], FOLDER_HINT, 'folder names the folder to rename') };
  if (args['name'] === undefined) return { ok: false, error: fieldMissing('/args/name', 'name') };
  const name = args['name'];
  if (typeof name !== 'string' || name.includes('/') || name.startsWith('.') || !isValidSourcePath(name)) return { ok: false, error: fieldValue('/args/name', name, 'a folder name (no slash, not hidden)', 'name is the folder’s new name') };
  return { ok: true, args: { folder: args['folder'], name } };
}

export function validateCreateFolderArgs(args: Record<string, unknown>): { ok: true; args: CreateFolderArgs } | { ok: false; error: CommandError } {
  const extra = exactKeys(args, ['folder']);
  if (extra !== null) return { ok: false, error: extra };
  if (args['folder'] === undefined) return { ok: false, error: fieldMissing('/args/folder', 'folder') };
  if (!isFolderPath(args['folder'])) return { ok: false, error: fieldValue('/args/folder', args['folder'], FOLDER_HINT, 'folder names the folder to make') };
  return { ok: true, args: { folder: args['folder'] } };
}

type VersionPaths = { sourcePath?: string; convertedFrom?: { sourcePath?: string } };

/** The file an asset record's current version is imported from (null: stored bytes). */
function currentFile(a: CommandAssetRecord): string | null {
  const v = a.versions.find((x) => x.version === a.currentVersion) as VersionPaths | undefined;
  return v?.sourcePath ?? v?.convertedFrom?.sourcePath ?? null;
}

/** The records with every version that names a moved file naming where it went (null: an asset is not where the move says). */
function withAssetPaths(content: ContentDocument, moves: readonly FileMove[]): ContentDocument | { missing: FileMove } {
  const byId = new Map(moves.filter((m) => m.kind === 'asset').map((m) => [m.id, m]));
  if (byId.size === 0) return content;
  const seen = new Set<string>();
  const assets = (content.assets as unknown as CommandAssetRecord[]).map((a) => {
    const m = byId.get(a.assetId);
    if (m === undefined) return a;
    seen.add(a.assetId);
    if (currentFile(a) !== m.from) return a;
    const versions = a.versions.map((v) => {
      const p = v as typeof v & VersionPaths;
      if (p.sourcePath === m.from) return { ...p, sourcePath: m.to };
      if (p.convertedFrom?.sourcePath === m.from) return { ...p, convertedFrom: { ...p.convertedFrom, sourcePath: m.to } };
      return v;
    });
    return { ...a, versions } as CommandAssetRecord;
  });
  for (const m of byId.values()) {
    if (!seen.has(m.id)) return { missing: m };
    const a = assets.find((x) => x.assetId === m.id)!;
    if (currentFile(a) !== m.to) return { missing: m };
  }
  return { ...content, assets: assets as unknown as ContentDocument['assets'] };
}

export function applyMoveResources(input: OpInput, prepared: PreparedMoves | undefined): OpOutcome {
  if (prepared === undefined) return { ok: false, error: fieldValue('/args', null, 'moves the host prepared', 'nothing was prepared: the host prepares a move from the files it finds') };
  if (prepared.moves.length === 0 && prepared.folders.length === 0) return { ok: false, error: noChangeContent() };
  const catalog = contentOf(input.content);
  const next = withAssetPaths(catalog, prepared.moves);
  if ('missing' in next) return { ok: false, error: fieldValue('/args/items', next.missing.id, `an asset whose file is ${next.missing.from}`, `asset ${next.missing.id} is not at ${next.missing.from}`) };
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const change: MoveResourcesChange = { type: 'moveResources', moves: deepClone(prepared.moves), folders: deepClone(prepared.folders) };
  // Only resource, scene and folder moves: the content block is the same (their paths are the host's).
  if (next === catalog) return { ok: true, op: { scene: resultScene, change, inverse: { kind: 'moveResources' } } };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'moveResources' } } };
}

/** The change the other way: every file and folder back, the last moved first. */
export function reversedMoves(forward: MoveResourcesChange): MoveResourcesChange {
  return {
    type: 'moveResources',
    moves: forward.moves.map((m) => ({ kind: m.kind, id: m.id, from: m.to, to: m.from })).reverse(),
    folders: forward.folders.map((f) => ({ from: f.to, to: f.from })).reverse(),
  };
}

function reapply(scene: SceneDocument, content: ContentDocument, change: MoveResourcesChange): { scene: SceneDocument; content: ContentDocument; change: MoveResourcesChange } | null {
  const next = withAssetPaths(content, change.moves);
  if ('missing' in next) return null;
  return { scene: { ...scene, revision: scene.revision + 1 }, content: next, change: deepClone(change) };
}

/** The undo of a move: the assets' paths back (null: an asset is no longer where the move put it). */
export function undoMoveResources(scene: SceneDocument, content: ContentDocument, forward: MoveResourcesChange): { scene: SceneDocument; content: ContentDocument; change: MoveResourcesChange } | null {
  return reapply(scene, content, reversedMoves(forward));
}

/** The redo: the recorded moves again (null: an asset is no longer where it was). */
export function redoMoveResources(scene: SceneDocument, content: ContentDocument, forward: MoveResourcesChange): { scene: SceneDocument; content: ContentDocument; change: MoveResourcesChange } | null {
  return reapply(scene, content, forward);
}
