/**
 * `importAssets`: every supported file of a game-folder folder comes in as an
 * asset, in one command (one revision, one undo), with labels applied to all
 * of them.
 *
 * The request names only the folder and the labels. The files' facts (each
 * one's digest, import recipe and metrics, the id and name chosen for it) are
 * prepared by the host from the files themselves, as behavior sources are:
 * the op reads only `CommandState.preparedAssetImport`, never a
 * caller-supplied record, so a request stays small however many files the
 * folder holds, and no unchecked write path exists.
 */
import { canonicalLabels, isAssetLabel } from '@thirdlight/project-model';

import { contentOf, createdAssetRecord, type OpInput } from './content-ops';
import { assetIdDuplicate, fieldMissing, fieldType, fieldUnexpected, fieldValue, noChangeContent, type CommandError } from './errors';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import { validatePublishAssetArgs } from './validate-content-args';
import type { CommandAssetRecord, ContentDocument, PublishAssetArgs, SceneDocument } from './types';

/** `importAssets` args. */
export interface ImportAssetsArgs {
  /** The folder, relative to the game folder (forward slashes). */
  folder: string;
  /** Labels every imported asset gets (besides those its own sidecar names). */
  labels?: string[];
  /** How PNG/JPEG textures in the folder are imported: encoded to KTX2 with this encoding (absent: as they are). */
  ktx2?: 'color' | 'normal' | 'data';
  /** Whether new models' images are extracted into texture assets (absent: yes; read by the host that prepares the files). */
  extractTextures?: boolean;
  /** Whether new GLB models without authored levels get generated ones (absent: no; read by the host that prepares the files). */
  generateLods?: boolean;
}

/** One file's prepared facts: a `publishAsset` create's, plus its labels. */
export type PreparedAssetImportItem = Omit<PublishAssetArgs, 'mode' | 'animation'> & { labels?: string[] };

/** What the host prepared for one `importAssets` request. */
export interface PreparedAssetImport {
  folder: string;
  items: PreparedAssetImportItem[];
}

/** `importAssets` change data: the records in the direction applied (an undo removes what the import added). */
export interface ImportAssetsChange {
  type: 'importAssets';
  folder: string;
  added: CommandAssetRecord[];
  removed: CommandAssetRecord[];
}

/** Undo of an `importAssets`: forget the records it added (the files stay, as the user's). */
export interface ImportAssetsInverse {
  kind: 'importAssets';
  assetIds: string[];
}

const KNOWN = 'folder, labels (optional), ktx2 (optional), extractTextures (optional), generateLods (optional)';

export function validateImportAssetsArgs(args: Record<string, unknown>): { ok: true; args: ImportAssetsArgs } | { ok: false; error: CommandError } {
  for (const k of Object.keys(args)) if (k !== 'folder' && k !== 'labels' && k !== 'ktx2' && k !== 'extractTextures' && k !== 'generateLods') return { ok: false, error: fieldUnexpected(`/args/${k}`, k, KNOWN) };
  if (args['folder'] === undefined) return { ok: false, error: fieldMissing('/args/folder', 'folder') };
  if (typeof args['folder'] !== 'string') return { ok: false, error: fieldType('/args/folder', args['folder'], 'string (a folder of the game folder)') };
  const out: ImportAssetsArgs = { folder: args['folder'] };
  if (args['labels'] !== undefined) {
    const l = args['labels'];
    if (!Array.isArray(l)) return { ok: false, error: fieldType('/args/labels', l, 'array of labels') };
    for (let i = 0; i < l.length; i++) {
      if (!isAssetLabel(l[i])) return { ok: false, error: fieldValue(`/args/labels/${i}`, l[i], 'a letter or digit, then letters, digits, _ - . / (at most 64)', 'a label has no spaces or other punctuation') };
    }
    out.labels = canonicalLabels(l as string[]);
  }
  if (args['ktx2'] !== undefined) {
    const k = args['ktx2'];
    if (k !== 'color' && k !== 'normal' && k !== 'data') return { ok: false, error: fieldValue('/args/ktx2', k, '"color", "normal" or "data"', 'ktx2 names the KTX2 encoding of the PNG/JPEG textures') };
    out.ktx2 = k;
  }
  if (args['extractTextures'] !== undefined) {
    if (typeof args['extractTextures'] !== 'boolean') return { ok: false, error: fieldType('/args/extractTextures', args['extractTextures'], 'boolean') };
    out.extractTextures = args['extractTextures'];
  }
  if (args['generateLods'] !== undefined) {
    if (typeof args['generateLods'] !== 'boolean') return { ok: false, error: fieldType('/args/generateLods', args['generateLods'], 'boolean') };
    out.generateLods = args['generateLods'];
  }
  return { ok: true, args: out };
}

function atItem(error: CommandError, i: number): CommandError {
  const path = (error as { path?: string }).path;
  return typeof path === 'string' && path.startsWith('/args') ? ({ ...error, path: `/prepared/items/${i}${path.slice('/args'.length)}` } as CommandError) : error;
}

export function applyImportAssets(input: OpInput, args: ImportAssetsArgs, prepared: PreparedAssetImport | undefined): OpOutcome {
  if (prepared === undefined || prepared.folder !== args.folder) {
    return {
      ok: false,
      error: fieldValue('/args/folder', args.folder, 'a folder the host prepared', 'the folder was not prepared for import (the backend reads its files when it receives the command)'),
    };
  }
  if (prepared.items.length === 0) return { ok: false, error: noChangeContent() };
  const catalog = contentOf(input.content);
  const ids = new Set(catalog.assets.map((a) => a.assetId));
  const added: CommandAssetRecord[] = [];
  for (let i = 0; i < prepared.items.length; i++) {
    const { labels, ...facts } = prepared.items[i]!;
    const v = validatePublishAssetArgs({ ...facts, mode: 'create' } as unknown as Record<string, unknown>);
    if (!v.ok) return { ok: false, error: atItem(v.error, i) };
    if (v.args.kind === undefined) return { ok: false, error: fieldMissing(`/prepared/items/${i}/kind`, 'kind') };
    if (ids.has(v.args.assetId)) return { ok: false, error: assetIdDuplicate(v.args.assetId) };
    ids.add(v.args.assetId);
    const all = [...(args.labels ?? []), ...(labels ?? [])];
    if (!all.every(isAssetLabel)) return { ok: false, error: fieldValue(`/prepared/items/${i}/labels`, labels, 'labels', 'a sidecar names a label that is not one') };
    const record = createdAssetRecord(v.args, input.revision);
    added.push(all.length > 0 ? { ...record, labels: canonicalLabels(all) } : record);
  }
  const nextContent = withAssets(catalog, added, new Set());
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog, manifest: input.manifest }, resultScene, nextContent);
  if (!gate.ok) return gate;
  const addedIds = new Set(added.map((a) => a.assetId));
  const next = deepClone(((gate.content ?? nextContent).assets as unknown as CommandAssetRecord[]).filter((a) => addedIds.has(a.assetId)));
  const change: ImportAssetsChange = { type: 'importAssets', folder: args.folder, added: next, removed: [] };
  const inverse: ImportAssetsInverse = { kind: 'importAssets', assetIds: next.map((a) => a.assetId) };
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse } };
}

/** The catalog with `add` records added and `remove` ids removed (sorted by id, as the catalog keeps them). */
function withAssets(catalog: ContentDocument, add: readonly CommandAssetRecord[], remove: ReadonlySet<string>): ContentDocument {
  const addIds = new Set(add.map((a) => a.assetId));
  const assets = [...(catalog.assets as unknown as CommandAssetRecord[]).filter((a) => !remove.has(a.assetId) && !addIds.has(a.assetId)), ...deepClone(add)].sort((a, b) =>
    a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0,
  );
  return { ...catalog, assets: assets as unknown as ContentDocument['assets'] };
}

/** The undo of an import: its records go (null: one is no longer there, so the history does not apply). */
export function undoImportAssets(scene: SceneDocument, content: ContentDocument, inverse: ImportAssetsInverse, forward: ImportAssetsChange): { scene: SceneDocument; content: ContentDocument; change: ImportAssetsChange } | null {
  const byId = new Map((content.assets as unknown as CommandAssetRecord[]).map((a) => [a.assetId, a]));
  const removed: CommandAssetRecord[] = [];
  for (const id of inverse.assetIds) {
    const r = byId.get(id);
    if (r === undefined) return null;
    removed.push(deepClone(r));
  }
  return {
    scene: { ...scene, revision: scene.revision + 1 },
    content: withAssets(content, [], new Set(inverse.assetIds)),
    change: { type: 'importAssets', folder: forward.folder, added: [], removed },
  };
}

/** The redo of an import: its recorded records come back (null: an id is taken again). */
export function redoImportAssets(scene: SceneDocument, content: ContentDocument, forward: ImportAssetsChange): { scene: SceneDocument; content: ContentDocument; change: ImportAssetsChange } | null {
  const ids = new Set(content.assets.map((a) => a.assetId));
  if (forward.added.some((a) => ids.has(a.assetId))) return null;
  return {
    scene: { ...scene, revision: scene.revision + 1 },
    content: withAssets(content, forward.added, new Set()),
    change: { type: 'importAssets', folder: forward.folder, added: deepClone(forward.added), removed: [] },
  };
}
