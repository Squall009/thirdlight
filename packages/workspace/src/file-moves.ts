/**
 * The project window's file operations on disk: `moveResources` (items and
 * whole folders into a folder), `renameFolder` and `createFolder`.
 *
 * Before the command: the request is turned into the moves it makes (every
 * asset, resource and scene file with where it is and where it goes, every
 * folder moved or made), refused when a target is taken or a folder would
 * move into itself. The command layer reads only these (an asset's path is on
 * its record); the transaction writes each moved resource and scene file and
 * each asset's sidecar at its new path and removes the old ones.
 *
 * After it committed: the asset files follow their sidecars, a moved folder's
 * other files (anything the project does not track) and empty subfolders
 * follow it, and a folder left empty by a moved folder goes. Undo and redo
 * run the same steps from their change (the moves the other way).
 */
import { mkdirSync, readdirSync, rmdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandError, FileMove, FolderMove, MoveResourcesChange, PreparedMoves } from '@thirdlight/commands';
import { validateCreateFolderArgs, validateMoveResourcesArgs, validateRenameFolderArgs } from '@thirdlight/commands';

import { assetRoot, checkGamePath, fileOfRecord, gamePathTaken, isGameFolder, moveGameFile, type RecordLike } from './asset-files';
import type { ContentContext } from './content-store';
import { pathRejected } from './errors';
import type { ProjectIndex } from './project-index';
import { gamePathOf, gameRel, RESOURCE_KINDS, SCENE_SUFFIX } from './resource-files';
import { formerKey, sceneRel, type V4State } from './store-v4';

const ASSET_KINDS_OF_ITEMS = new Set(['asset', 'model', 'texture', 'audio', 'font']);
const RESOURCE_BY_KIND = new Map(RESOURCE_KINDS.map((k) => [k.kind, k]));

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join2 = (folder: string, name: string): string => (folder === '' ? name : `${folder}/${name}`);
const within = (path: string, folder: string): boolean => folder === '' || path.startsWith(`${folder}/`);

/** A scene's file key from the path the index shows (`scenes/<id>.json` in the project folder, else a game-folder path). */
export function sceneRelOfPath(sceneId: string, path: string): string {
  return path === sceneRel(sceneId) ? path : gameRel(path);
}

/** The path a scene's file key shows (the index's). */
function scenePathOfRel(rel: string): string {
  return gamePathOf(rel) ?? rel;
}

function refused(path: string, message: string): { ok: false; error: CommandError } {
  return { ok: false, error: pathRejected(path, message) };
}

type Prepared = { ok: true; prepared: PreparedMoves } | { ok: false; error: CommandError };

/**
 * The moves a request makes, or why it cannot (null: the request is not
 * well-formed; the command layer refuses it with the field at fault).
 */
export function prepareFileMoves(ctx: ContentContext, state: V4State, index: ProjectIndex | undefined, op: string, args: Record<string, unknown>): Prepared | null {
  if (op === 'createFolder') {
    const v = validateCreateFolderArgs(args);
    if (!v.ok) return null;
    const folder = v.args.folder;
    const ok = checkGamePath(ctx, `${folder}/-`);
    if (!ok.ok) return ok;
    if (gamePathTaken(ctx, folder)) return refused(folder, `${folder} already exists`);
    return { ok: true, prepared: { moves: [], folders: [{ from: null, to: folder }] } };
  }
  if (op === 'renameFolder') {
    const v = validateRenameFolderArgs(args);
    if (!v.ok) return null;
    return moveFolders(ctx, state, index, [{ from: v.args.folder, to: join2(parentOf(v.args.folder), v.args.name) }], []);
  }
  const v = validateMoveResourcesArgs(args);
  if (!v.ok) return null;
  const to = v.args.to;
  const folders: FolderMove[] = [];
  for (const f of v.args.folders ?? []) {
    if (f === to || within(to, f)) return refused(f, `${f} cannot move into itself`);
    // Already there: nothing to do for it.
    if (parentOf(f) === to) continue;
    folders.push({ from: f, to: join2(to, lastSegment(f)) });
  }
  const items: { kind: string; id: string; from: string }[] = [];
  const assets = (v.args.items ?? []).some((i) => ASSET_KINDS_OF_ITEMS.has(i.kind)) ? new Map((state.content.assets as unknown as RecordLike[]).map((a) => [a.assetId, a])) : null;
  for (const [i, item] of (v.args.items ?? []).entries()) {
    const at = `/args/items/${i}`;
    if (ASSET_KINDS_OF_ITEMS.has(item.kind)) {
      const a = assets!.get(item.id);
      if (a === undefined) return refused(at, `no asset "${item.id}" in this project`);
      const file = fileOfRecord(a);
      if (file === null) return refused(at, `asset ${item.id} has no file in the game folder (its bytes are stored in the project); reimport it from a file to place it`);
      items.push({ kind: 'asset', id: item.id, from: file });
      continue;
    }
    if (item.kind === 'scene') {
      if (!state.scenes.has(item.id)) return refused(at, `no scene "${item.id}" in this project`);
      items.push({ kind: 'scene', id: item.id, from: scenePathOfRel(state.scenePaths.get(item.id) ?? sceneRel(item.id)) });
      continue;
    }
    const k = RESOURCE_BY_KIND.get(item.kind);
    if (k === undefined) return refused(`${at}/kind`, `${item.kind} is not asset, an asset kind (model, texture, audio, font), a resource kind (${RESOURCE_KINDS.map((x) => x.kind).join(', ')}) or scene`);
    const path = state.resourcePaths.get(k.list)?.get(item.id);
    if (path === undefined) return refused(at, `no ${item.kind} "${item.id}" in this project`);
    items.push({ kind: item.kind, id: item.id, from: path });
  }
  return moveFolders(ctx, state, index, folders, items, to);
}

/** Every file of the moved folders, and the named items, to where they go. */
function moveFolders(ctx: ContentContext, state: V4State, index: ProjectIndex | undefined, folders: FolderMove[], items: { kind: string; id: string; from: string }[], to?: string): Prepared {
  for (const f of folders) {
    const from = f.from!;
    const dest = f.to!;
    if (!isGameFolder(ctx, from)) return refused(from, `${from} is not a folder of the game folder`);
    if (dest === from) return refused(dest, `${from} is already called ${lastSegment(dest)}`);
    if (within(dest, from)) return refused(dest, `${from} cannot move into itself`);
    const ok = checkGamePath(ctx, `${dest}/-`);
    if (!ok.ok) return ok;
    if (gamePathTaken(ctx, dest)) return refused(dest, `${dest} already exists`);
  }
  const moves: FileMove[] = [];
  const seen = new Set<string>();
  const targets = new Set<string>();
  const add = (kind: string, id: string, from: string, dest: string): CommandError | null => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    if (dest === from) return null;
    const lower = dest.toLowerCase();
    if (targets.has(lower)) return pathRejected(dest, `two moved files would both be ${dest}`);
    targets.add(lower);
    moves.push({ kind, id, from, to: dest });
    return null;
  };
  // Everything the project tracks under a moved folder moves with it.
  if (folders.length > 0) {
    const entries = index?.entries.values() ?? [];
    for (const e of entries) {
      if (e.path === null) continue;
      const f = folders.find((x) => within(e.path!, x.from!));
      if (f === undefined) continue;
      // A scene in the project folder's own scenes/ is not in the game folder.
      if (e.kind === 'scene' && !(state.scenePaths.get(e.id) ?? '').startsWith('@game/')) continue;
      const kind = RESOURCE_BY_KIND.has(e.kind) || e.kind === 'scene' ? e.kind : 'asset';
      const err = add(kind, e.id, e.path, `${f.to!}${e.path.slice(f.from!.length)}`);
      if (err !== null) return { ok: false, error: err };
    }
  }
  for (const it of items) {
    if (folders.some((f) => within(it.from, f.from!))) continue;
    // A scene from the project folder's scenes/ becomes a scene file of the game folder.
    const name = it.kind === 'scene' && it.from === sceneRel(it.id) ? `${it.id}${SCENE_SUFFIX}` : lastSegment(it.from);
    const err = add(it.kind, it.id, it.from, join2(to ?? '', name));
    if (err !== null) return { ok: false, error: err };
  }
  const moving = new Set(moves.map((m) => m.from.toLowerCase()));
  for (const m of moves) {
    if (folders.some((f) => within(m.to, f.to!))) continue;
    const ok = checkGamePath(ctx, m.to);
    if (!ok.ok) return ok;
    // A target that is taken, unless the file there moves away in the same command.
    if (gamePathTaken(ctx, m.to) && !moving.has(m.to.toLowerCase())) return refused(m.to, `${m.to} already exists`);
    if (m.kind === 'asset' && gamePathTaken(ctx, `${m.to}.tlasset`) && !moving.has(m.to.toLowerCase())) return refused(m.to, `${m.to}.tlasset already exists`);
  }
  return { ok: true, prepared: { moves, folders } };
}

/**
 * Before an undo or redo moves files back: every target free (a file made
 * there since would be overwritten), every folder it moves still there.
 */
export function checkReplayedMoves(ctx: ContentContext, change: MoveResourcesChange): CommandError | null {
  const moving = new Set(change.moves.map((m) => m.from.toLowerCase()));
  for (const m of change.moves) {
    if (gamePathTaken(ctx, m.to) && !moving.has(m.to.toLowerCase())) return pathRejected(m.to, `${m.to} is taken now; move that file away first`);
  }
  for (const f of change.folders) {
    if (f.from !== null && f.to !== null && gamePathTaken(ctx, f.to) && !isGameFolder(ctx, f.to)) return pathRejected(f.to, `${f.to} is taken now by a file`);
  }
  return null;
}

/** The resource and scene files a change moves, by `formerKey` (the transaction writes them at their new paths). */
export function movedFileKeys(change: MoveResourcesChange): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of change.moves) {
    if (m.kind === 'asset') continue;
    if (m.kind === 'scene') out.set(formerKey('scene', m.id), sceneRelOfPath(m.id, m.to));
    else {
      const k = RESOURCE_BY_KIND.get(m.kind);
      if (k !== undefined) out.set(formerKey(k.list, m.id), m.to);
    }
  }
  return out;
}

/** Move everything left in a folder (files the project does not track, empty folders) to another; then remove the emptied folders. */
function moveRest(ctx: ContentContext, from: string, to: string, problems: string[]): void {
  const root = assetRoot(ctx);
  const walk = (rel: string, depth: number): void => {
    if (depth > 32) return;
    let names: string[];
    try {
      names = readdirSync(join(root, ...rel.split('/')));
    } catch {
      return;
    }
    const dest = `${to}${rel.slice(from.length)}`;
    try {
      mkdirSync(join(root, ...dest.split('/')), { recursive: true, mode: 0o755 });
    } catch {
      problems.push(`${dest} could not be made`);
      return;
    }
    for (const name of names) {
      const child = `${rel}/${name}`;
      let st;
      try {
        st = lstatSync(join(root, ...child.split('/')));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(child, depth + 1);
      else if (!moveGameFile(ctx, child, `${to}${child.slice(from.length)}`)) problems.push(`${child} could not be moved to ${to}${child.slice(from.length)}`);
    }
  };
  walk(from, 0);
  removeEmpty(ctx, from);
}

/** Remove a folder when it and its subfolders hold no file (returns whether it went). */
function removeEmpty(ctx: Pick<ContentContext, 'gameFolder' | 'dir'>, rel: string): boolean {
  const abs = join(assetRoot(ctx), ...rel.split('/'));
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return false;
  }
  let empty = true;
  for (const name of names) {
    let st;
    try {
      st = lstatSync(join(abs, name));
    } catch {
      empty = false;
      continue;
    }
    if (!st.isDirectory() || !removeEmpty(ctx, `${rel}/${name}`)) empty = false;
  }
  if (!empty) return false;
  try {
    rmdirSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * After a committed move (or its undo or redo): the folders it makes, the
 * asset files (their sidecars were written by the transaction), the rest of
 * each moved folder, and a made folder removed again by an undo. Returns the
 * problems found (never fatal: the command is committed; the file check
 * finds files by their sidecars).
 */
export function applyFileMoves(ctx: ContentContext, change: MoveResourcesChange): string[] {
  const problems: string[] = [];
  const root = assetRoot(ctx);
  for (const f of change.folders) {
    if (f.from !== null || f.to === null) continue;
    try {
      mkdirSync(join(root, ...f.to.split('/')), { recursive: true, mode: 0o755 });
    } catch {
      problems.push(`${f.to} could not be made`);
    }
  }
  for (const m of change.moves) {
    if (m.kind !== 'asset') continue;
    if (!gamePathTaken(ctx, m.from)) continue;
    if (!moveGameFile(ctx, m.from, m.to)) problems.push(`${m.from} could not be moved to ${m.to}`);
  }
  for (const f of change.folders) {
    if (f.from === null) continue;
    if (f.to === null) {
      if (!removeEmpty(ctx, f.from)) problems.push(`${f.from} was kept: it is not empty`);
      continue;
    }
    if (isGameFolder(ctx, f.from)) moveRest(ctx, f.from, f.to, problems);
    else {
      try {
        mkdirSync(join(root, ...f.to.split('/')), { recursive: true, mode: 0o755 });
      } catch {
        problems.push(`${f.to} could not be made`);
      }
    }
  }
  return problems;
}
