/**
 * Project resources as files (Unity's `.prefab` / `.mat`, Godot's `.tres`).
 *
 * Each prefab, material (and material instance), behavior, script library,
 * graph (material functions included), UI document and theme, dialogue,
 * timeline, effect, animator controller and environment preset is its own
 * file in the game folder, in a folder of the user's choosing
 * (`assets/<kind>/` by default):
 *
 *   <folder>/<name>.<kind>.json   { "tlresource": 1, "kind", "id", "data": <the record> }
 *
 * The file is the truth. It carries its stable id, so a file the user moves
 * or renames outside the editor is the same resource where the open finds it.
 * It holds no project state (no revision, no retry records): those stay in
 * `content.json`, which a command that writes resource files writes with
 * them, in one transaction. `content.json` keeps the project-wide settings.
 *
 * In the session the records are still one content block (the command layer
 * edits it as before); this module splits the block into files and joins the
 * files back into it.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_ASSET_FOLDER, ENV_PRESETS_LIST, isAddress, isAssetLabel, isValidSourcePath, ID_RE, parseDocumentBytes, RESOURCE_KIND_TABLE, resourceRecordsOf } from '@thirdlight/project-model';

import { layoutProjectJson } from './project-json';

/** The resource file format this build writes. */
export const RESOURCE_FORMAT = 1;

/** One kind of project resource: the content list its records live in and how its files are named. */
export interface ResourceKind {
  /** The `kind` a file states (also its name's second extension). */
  readonly kind: string;
  /** The content block's list of these records. */
  readonly list: string;
  /** The record's id field. */
  readonly idKey: string;
  /** Where a new one is written (relative to the game folder). */
  readonly folder: string;
}

/** The one resource list that is not a key of the content block: the environment's presets. */
export const ENV_PRESETS = ENV_PRESETS_LIST;

/** A kind's records in a content block (none: absent). */
export function recordsOfKind(content: unknown, k: ResourceKind): readonly Record<string, unknown>[] | undefined {
  return resourceRecordsOf(content, k);
}

/** Every kind of resource stored one file each, in the content block's key order (the model's table; new ones go in the asset folder). */
export const RESOURCE_KINDS: readonly ResourceKind[] = RESOURCE_KIND_TABLE.map((k) => ({ kind: k.kind, list: k.list, idKey: k.idKey, folder: `${DEFAULT_ASSET_FOLDER}/${k.folder}` }));

const BY_KIND = new Map(RESOURCE_KINDS.map((k) => [k.kind, k]));
const BY_LIST = new Map(RESOURCE_KINDS.map((k) => [k.list, k]));

export function resourceKindOfList(list: string): ResourceKind | undefined {
  return BY_LIST.get(list);
}

/** The content lists stored as resource files. */
export const RESOURCE_LISTS: ReadonlySet<string> = new Set(RESOURCE_KINDS.map((k) => k.list));

/** `<name>.<kind>.json`: the kind a file name says it holds (null: not a resource file name). */
export function resourceKindOfName(name: string): ResourceKind | null {
  if (!name.endsWith('.json')) return null;
  const stem = name.slice(0, -'.json'.length);
  const dot = stem.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_KIND.get(stem.slice(dot + 1)) ?? null;
}

/** Where a new resource is written: its kind's folder (or the folder the command names), named by its id. */
export function defaultResourcePath(k: ResourceKind, id: string, folder?: string): string {
  return `${folder ?? k.folder}/${id}.${k.kind}.json`;
}

/**
 * A scene outside the project folder's `scenes/`: `<folder>/<name>.scene.json`
 * in the game folder (the scene file format; its name need not be its id).
 */
export const SCENE_SUFFIX = '.scene.json';

export function isSceneFileName(name: string): boolean {
  return name.endsWith(SCENE_SUFFIX) && name.length > SCENE_SUFFIX.length;
}

/** Where a new scene is written in a folder the user chose. */
export function scenePathIn(folder: string, sceneId: string): string {
  return `${folder}/${sceneId}${SCENE_SUFFIX}`;
}

/** The name part of a resource or scene file (`crate copy.material.json` → `crate copy`). */
export function resourceStem(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (isSceneFileName(name)) return name.slice(0, -SCENE_SUFFIX.length);
  const k = resourceKindOfName(name);
  return k === null ? name.replace(/\.[^.]*$/, '') : name.slice(0, -`.${k.kind}.json`.length);
}

/** The files of the game folder are keyed apart from the project's own (`content.json`, `scenes/…`). */
export const GAME_REL_PREFIX = '@game/';

export function gameRel(path: string): string {
  return `${GAME_REL_PREFIX}${path}`;
}

/** The game-folder path of a game-folder key (null: a project file). */
export function gamePathOf(rel: string): string | null {
  return rel.startsWith(GAME_REL_PREFIX) ? rel.slice(GAME_REL_PREFIX.length) : null;
}

/** An asset's sidecar (`<file>.tlasset`): it holds the asset's record, so it is a project file too. */
export const SIDECAR_SUFFIX = '.tlasset';

/** A game-folder path a project transaction writes: relative, no hidden folder, a resource file, a scene file or a sidecar. */
export function isResourcePath(path: string): boolean {
  if (!isValidSourcePath(path)) return false;
  const segs = path.split('/');
  if (segs.some((s) => s.startsWith('.'))) return false;
  const name = segs[segs.length - 1]!;
  return resourceKindOfName(name) !== null || isSceneFileName(name) || (name.endsWith(SIDECAR_SUFFIX) && name.length > SIDECAR_SUFFIX.length);
}

/** A resource's address and labels, as its file states them beside the record (absent: none). */
export interface ResourceLoading {
  address?: string;
  labels?: string[];
}

/**
 * One resource file's bytes (the project-file layout: a diff shows one line
 * per changed item). The address and labels sit beside the record, so the
 * record is the same bytes whatever names scripts load it by.
 */
export function resourceFileBytes(k: ResourceKind, id: string, record: unknown, loading?: ResourceLoading): Uint8Array {
  return new TextEncoder().encode(
    `${layoutProjectJson({ tlresource: RESOURCE_FORMAT, kind: k.kind, id, ...(loading?.address !== undefined ? { address: loading.address } : {}), ...(loading?.labels !== undefined && loading.labels.length > 0 ? { labels: loading.labels } : {}), data: record })}\n`,
  );
}

export type ParsedResource = { ok: true; kind: ResourceKind; id: string; data: Record<string, unknown>; loading?: ResourceLoading } | { ok: false; message: string };

/** Read a resource file: its format, its kind (the one its name says), its id (the one its record has). */
export function parseResourceFile(path: string, bytes: Uint8Array): ParsedResource {
  const named = resourceKindOfName(path.slice(path.lastIndexOf('/') + 1));
  const parsed = parseDocumentBytes(bytes);
  if (!parsed.ok) return { ok: false, message: `${path} is not valid JSON (${parsed.error.message})` };
  const v = parsed.value;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, message: `${path} is not a JSON object` };
  const d = v as Record<string, unknown>;
  for (const key of Object.keys(d)) if (!['tlresource', 'kind', 'id', 'address', 'labels', 'data'].includes(key)) return { ok: false, message: `${path}: unknown key '${key}' (a resource file holds tlresource, kind, id, address, labels, data)` };
  if (d['tlresource'] !== RESOURCE_FORMAT) return { ok: false, message: `${path}: tlresource must be ${RESOURCE_FORMAT}` };
  const k = typeof d['kind'] === 'string' ? BY_KIND.get(d['kind']) : undefined;
  if (k === undefined) return { ok: false, message: `${path}: unknown resource kind ${JSON.stringify(d['kind'])}` };
  if (named !== null && named !== k) return { ok: false, message: `${path}: the file name says ${named.kind}, the file holds a ${k.kind}` };
  const id = d['id'];
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, message: `${path}: id must use the id syntax` };
  const data = d['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, message: `${path}: data must be the ${k.kind} record` };
  if ((data as Record<string, unknown>)[k.idKey] !== id) return { ok: false, message: `${path}: the record's ${k.idKey} must equal the file's id "${id}"` };
  const address = d['address'];
  if (address !== undefined && !isAddress(address)) return { ok: false, message: `${path}: address must be a letter or digit, then letters, digits, _ - . / (at most 128)` };
  const labels = d['labels'];
  if (labels !== undefined && (!Array.isArray(labels) || labels.length === 0 || !labels.every(isAssetLabel))) return { ok: false, message: `${path}: labels must be a list of labels (a letter or digit, then letters, digits, _ - . /)` };
  const loading: ResourceLoading = { ...(address !== undefined ? { address: address as string } : {}), ...(labels !== undefined ? { labels: [...new Set(labels as string[])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)) } : {}) };
  return { ok: true, kind: k, id, data: data as Record<string, unknown>, ...(loading.address !== undefined || loading.labels !== undefined ? { loading } : {}) };
}

/** Folders deep enough for any real layout; deeper is a symlink-free cycle guard. */
const MAX_DEPTH = 32;

/** Folders the resource scan never enters (package managers' trees). */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(['node_modules']);

/**
 * Every resource file, scene file and asset sidecar of the game folder (paths
 * relative to it, sorted), by name: hidden folders, `node_modules`, symlinks
 * and the `skip` folders (the project's own files) are not entered.
 */
export function scanResourceFiles(gameRoot: string, skip: (absDir: string, rel: string) => boolean): { resources: string[]; sidecars: string[]; scenes: string[] } {
  const out: string[] = [];
  const sidecars: string[] = [];
  const scenes: string[] = [];
  const walk = (rel: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(rel === '' ? gameRoot : join(gameRoot, ...rel.split('/')), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith('.')) continue;
      const path = rel === '' ? name : `${rel}/${name}`;
      if (e.isDirectory()) {
        if (depth >= MAX_DEPTH || SKIPPED_FOLDERS.has(name)) continue;
        const abs = join(gameRoot, ...path.split('/'));
        if (skip(abs, path)) continue;
        walk(path, depth + 1);
      } else if (e.isFile() && resourceKindOfName(name) !== null && isValidSourcePath(path)) {
        // A symlinked resource file is not a file here: the editor never writes through a link.
        out.push(path);
      } else if (e.isFile() && name.endsWith(SIDECAR_SUFFIX) && name.length > SIDECAR_SUFFIX.length && isValidSourcePath(path)) {
        sidecars.push(path);
      } else if (e.isFile() && isSceneFileName(name) && isValidSourcePath(path)) {
        scenes.push(path);
      }
    }
  };
  walk('', 0);
  return { resources: out.sort(), sidecars: sidecars.sort(), scenes: scenes.sort() };
}
