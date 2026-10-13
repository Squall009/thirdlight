/**
 * Engine content packs: directories under `<engineRoot>/packs/<id>` holding a
 * `pack.json` and the asset files it lists (the Basic Kit: a trim sheet,
 * presets, block types, door and window pieces, and the kit naming them).
 *
 * Adding a pack to a project makes its items ordinary project items through
 * the one mutation path: each asset file is held and inspected as an upload
 * is, then published (`publishAsset`, into the pack's folder of the game
 * folder); the pack's own commands follow (`setMaterial`, `setGraph`,
 * `setBlockType`, `setKit`), then the models' material mappings
 * (`setAssetOptions`), which name the pack's materials.
 * Every command is an ordinary one on the change feed; together they are one
 * history step (`groupHistory`), so one undo takes the whole pack out again.
 * The copies are the project's: an exported game carries their bytes like
 * any asset's, and the engine's pack itself never changes.
 *
 * A pack is added once: a project that has any of its ids is refused (named),
 * so a second add never replaces what the project changed in its copies.
 * An add is whole or nothing: checked first, and taken back when a command
 * is refused partway.
 *
 * A template's own setup is a pack too (`templates/<id>/setup/`): what a v3
 * captured project cannot hold (materials, terrain, block layers, the scene's
 * look) is made by ordinary commands when a project is created from it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ID_RE } from '@thirdlight/project-model/limits';
import type { MutationSuccess, StageInspector, WorkspaceService } from '@thirdlight/workspace';

import { importJobPort, runCommandNow } from './asset-files';

export interface PackAsset {
  assetId: string;
  kind: 'texture' | 'model';
  displayName: string;
  /** Relative to the pack's `assets/` folder. */
  file: string;
  sha256: string;
  bytes: number;
  /** A model's material mapping (source material name → material id). */
  materials?: Record<string, string>;
}

export interface Pack {
  format: 1;
  packId: string;
  name: string;
  description: string;
  /** Where its files go in the game folder. */
  folder: string;
  assets: PackAsset[];
  /**
   * Run in order. `ref` names the object a `createEntity` makes, and a later
   * argument `"$ref:<name>"` stands for its id (a template's setup sculpts
   * the terrain it made).
   */
  commands: PackCommand[];
}

export interface PackCommand {
  op: string;
  args: Record<string, unknown>;
  ref?: string;
}

const REF_PREFIX = '$ref:';

/** The names every `"$ref:<name>"` string in `value` stands for. */
function refsIn(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith(REF_PREFIX) ? [value.slice(REF_PREFIX.length)] : [];
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(refsIn);
  return [];
}

/** `args` with every `"$ref:<name>"` string replaced by the id made under that name (an unknown name is left: the command refuses it). */
function withRefs(value: unknown, refs: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return value.startsWith(REF_PREFIX) ? (refs.get(value.slice(REF_PREFIX.length)) ?? value) : value;
  if (Array.isArray(value)) return value.map((v) => withRefs(v, refs));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withRefs(v, refs)]));
  return value;
}

export interface PackInfo {
  packId: string;
  name: string;
  description: string;
}

const ROOT = 'packs';

function packDir(engineRoot: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  const dir = join(engineRoot, ROOT, id);
  return existsSync(join(dir, 'pack.json')) ? dir : null;
}

/** The packs this engine ships. */
export function listPacks(engineRoot: string): PackInfo[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(join(engineRoot, ROOT)).sort();
  } catch {
    return [];
  }
  const out: PackInfo[] = [];
  for (const id of entries) {
    const loaded = loadPack(engineRoot, id);
    if (loaded.ok) out.push({ packId: loaded.pack.packId, name: loaded.pack.name, description: loaded.pack.description });
  }
  return out;
}

export type LoadedPack = { ok: true; pack: Pack; files: ReadonlyMap<string, Uint8Array> } | { ok: false; message: string };

/** A pack and its asset files, each checked against the digest `pack.json` records. */
export function loadPack(engineRoot: string, id: string): LoadedPack {
  const dir = packDir(engineRoot, id);
  if (dir === null) return { ok: false, message: `no pack "${id}"` };
  return loadPackDir(dir, id);
}

/** A pack in folder `dir` (its `pack.json`, its files under `assets/`): an engine pack, or a template's own setup. */
export function loadPackDir(dir: string, id: string): LoadedPack {
  let pack: Pack;
  try {
    pack = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8')) as Pack;
  } catch {
    return { ok: false, message: `pack "${id}" has an unreadable pack.json` };
  }
  if (pack.format !== 1 || pack.packId !== id || !Array.isArray(pack.assets) || !Array.isArray(pack.commands)) return { ok: false, message: `pack "${id}": pack.json is not a format 1 pack` };
  const files = new Map<string, Uint8Array>();
  for (const a of pack.assets) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(dir, 'assets', a.file)));
    } catch {
      return { ok: false, message: `pack "${id}": ${a.file} is missing` };
    }
    if (createHash('sha256').update(bytes).digest('hex') !== a.sha256) return { ok: false, message: `pack "${id}": ${a.file} is not the file pack.json records` };
    files.set(a.file, bytes);
  }
  return { ok: true, pack, files };
}

/** The ids a pack adds, per content list, for the "already there" check. */
function packIds(pack: Pack): { list: string; key: string; id: string }[] {
  const out = pack.assets.map((a) => ({ list: 'assets', key: 'assetId', id: a.assetId }));
  const kinds: Record<string, [list: string, field: string, key: string]> = {
    setMaterial: ['materials', 'material', 'materialId'],
    setGraph: ['graphs', 'graph', 'graphId'],
    setBlockType: ['blockTypes', 'block', 'blockId'],
    setKit: ['kits', 'kit', 'kitId'],
  };
  for (const c of pack.commands) {
    const k = kinds[c.op];
    const id = k === undefined ? undefined : (c.args[k[1]] as Record<string, unknown> | undefined)?.[k[2]];
    if (k !== undefined && typeof id === 'string') out.push({ list: k[0], key: k[2], id });
  }
  return out;
}

export type PackAddResult =
  | { ok: true; packId: string; revision: number; added: { op: string; id: string }[] }
  | { ok: false; status: number; code: string; message: string; added?: { op: string; id: string }[] };

type Origin = { kind: 'admin' | 'browser' | 'mcp'; clientId: string };

export interface PackInstallerDeps {
  service: WorkspaceService;
  inspector: StageInspector;
  engineRoot: string | undefined;
  now: () => number;
  /** A command the add ran was applied (the change feed). */
  onApplied: (projectId: string, result: MutationSuccess, origin: { kind: 'admin' | 'browser' | 'mcp'; clientId: string }) => void;
}

export function createPackInstaller(deps: PackInstallerDeps) {
  const { service } = deps;
  /** Add pack `packId` to the project: all of it, or nothing (see `install`). */
  const add = (projectId: string, packId: string, origin: Origin): PackAddResult => {
    if (deps.engineRoot === undefined) return { ok: false, status: 503, code: 'unavailable', message: 'packs need the engine root (THIRDLIGHT_ENGINE_ROOT)' };
    const loaded = loadPack(deps.engineRoot, packId);
    if (!loaded.ok) return { ok: false, status: 404, code: 'not_found', message: loaded.message };
    return install(projectId, loaded.pack, loaded.files, origin);
  };
  /**
   * Add a loaded pack (an engine pack, a template's setup) to the project:
   * every command, as one undo step, or none. What can be known beforehand
   * is checked first (the ids it makes are free, every `$ref` names an
   * earlier command's object, every file is there and accepted by the
   * importer); a command refused partway takes back what ran before it, so
   * no half-added pack outlives the in-memory undo history (a restart).
   */
  const install = (projectId: string, pack: Pack, files: ReadonlyMap<string, Uint8Array>, origin: Origin): PackAddResult => {
    const r = addCommands(projectId, pack, files, origin);
    if (r.ok) {
      if (r.added.length > 1) service.groupHistory(projectId, r.added.length);
      return r;
    }
    const ran = r.added ?? [];
    if (ran.length === 0) return r;
    // Newest first: each undo takes back the command applied last.
    let left = ran.length;
    while (left > 0) {
      const u = runCommandNow(service, projectId, 'undo', {}, origin);
      if (!u.ok) break;
      deps.onApplied(projectId, u.result, origin);
      left -= 1;
    }
    if (left === 0) return { ...r, added: [], message: `${r.message} (nothing of ${pack.name} was added)` };
    const stay = ran.slice(0, left);
    return { ...r, added: stay, message: `${r.message}; taking back what ran before it stopped failed, so these stay: ${stay.map((a) => `${a.op} ${a.id}`).join(', ')}` };
  };
  /** Why the pack cannot be added before anything runs (null: nothing found). */
  const refusal = (content: Record<string, unknown>, pack: Pack, files: ReadonlyMap<string, Uint8Array>): PackAddResult | null => {
    const ids = packIds(pack);
    const taken = ids.filter(({ list, key, id }) => Array.isArray(content[list]) && (content[list] as Record<string, unknown>[]).some((r) => r[key] === id));
    if (taken.length > 0) {
      const named = taken.map((t) => `${t.id} (${t.list})`).join(', ');
      const message =
        taken.length === ids.length
          ? `the project already has ${pack.name} (a pack is added once; its copies are the project's to change)`
          : `${pack.name} uses ids the project's own items already have: ${named}. Rename those items (or delete them) and add ${pack.name} again; a pack is added once and never replaces an item.`;
      return { ok: false, status: 409, code: 'pack_present', message };
    }
    for (const a of pack.assets) if (!files.has(a.file)) return { ok: false, status: 400, code: 'pack_invalid', message: `pack "${pack.packId}": ${a.file} is missing` };
    const made = new Set<string>();
    for (const c of pack.commands) {
      const unknown = refsIn(c.args).find((name) => !made.has(name));
      if (unknown !== undefined) return { ok: false, status: 400, code: 'pack_invalid', message: `pack "${pack.packId}": ${c.op} names "${REF_PREFIX}${unknown}", which no earlier command makes` };
      if (c.ref !== undefined) made.add(c.ref);
    }
    return null;
  };
  const addCommands = (projectId: string, pack: Pack, files: ReadonlyMap<string, Uint8Array>, origin: Origin): PackAddResult => {
    const packId = pack.packId;
    const captured = service.readCapturedV3(projectId);
    if (!captured.ok) return { ok: false, status: 404, code: captured.error.code, message: captured.error.message ?? captured.error.code };
    const refused = refusal(captured.read.content as unknown as Record<string, unknown>, pack, files);
    if (refused !== null) return refused;
    // Every file held and inspected before the first command: a file the importer refuses stops the add with nothing run.
    const inspected: { asset: PackAsset; sourceDigest: string; sourceByteLength: number; importRecipe?: unknown; metrics?: unknown }[] = [];
    for (const a of pack.assets) {
      const bytes = files.get(a.file)!;
      const held = service.holdAssetBytes(projectId, bytes);
      if (!held.ok) return { ok: false, status: 500, code: held.error.code, message: `${a.file}: ${held.error.message ?? held.error.code}` };
      const p = deps.inspector(bytes, importJobPort(deps.now, 'pack', a.displayName), { kind: a.kind }) as unknown as { status: string; sourceDigest: string; sourceByteLength: number; importRecipe?: unknown; metrics?: unknown; diagnostics?: { message?: string }[] };
      if (p.status !== 'ok') return { ok: false, status: 400, code: 'import_rejected', message: `${a.file}: ${p.diagnostics?.[0]?.message ?? 'not accepted by the importer'}` };
      inspected.push({ asset: a, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics });
    }
    const added: { op: string; id: string }[] = [];
    let revision = captured.read.revision;
    const refs = new Map<string, string>();
    const run = (op: string, args: Record<string, unknown>, id: string, ref?: string): PackAddResult | null => {
      const r = runCommandNow(service, projectId, op, withRefs(args, refs) as Record<string, unknown>, origin);
      if (!r.ok) return { ok: false, status: 400, code: r.code, message: `${op} ${id}: ${r.message}`, added };
      deps.onApplied(projectId, r.result, origin);
      revision = r.result.revision;
      added.push({ op, id });
      const made = (r.result as { createdId?: unknown }).createdId;
      if (ref !== undefined && typeof made === 'string') refs.set(ref, made);
      return null;
    };
    for (const { asset: a, ...p } of inspected) {
      const importedAt = new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const stopped = run('publishAsset', { mode: 'create', assetId: a.assetId, kind: a.kind, displayName: a.displayName, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt, folder: pack.folder }, a.assetId);
      if (stopped !== null) return stopped;
    }
    for (const c of pack.commands) {
      const id = packIds({ ...pack, assets: [], commands: [c] })[0]?.id ?? c.ref ?? c.op;
      const stopped = run(c.op, c.args, id, c.ref);
      if (stopped !== null) return stopped;
    }
    // Material mappings last: they name the pack's materials, made just above.
    for (const a of pack.assets) {
      if (a.materials === undefined) continue;
      const stopped = run('setAssetOptions', { assetId: a.assetId, materials: a.materials }, a.assetId);
      if (stopped !== null) return stopped;
    }
    return { ok: true, packId, revision, added };
  };
  return { add, install };
}

export type PackInstaller = ReturnType<typeof createPackInstaller>;
