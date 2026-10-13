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
 * Every command is an ordinary one on the change feed, undone on its own.
 * The copies are the project's: an exported game carries their bytes like
 * any asset's, and the engine's pack itself never changes.
 *
 * A pack is added once: a project that has any of its ids is refused (named),
 * so a second add never replaces what the project changed in its copies.
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
  commands: { op: string; args: Record<string, unknown> }[];
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

/** A pack and its asset files, each checked against the digest `pack.json` records. */
export function loadPack(engineRoot: string, id: string): { ok: true; pack: Pack; files: ReadonlyMap<string, Uint8Array> } | { ok: false; message: string } {
  const dir = packDir(engineRoot, id);
  if (dir === null) return { ok: false, message: `no pack "${id}"` };
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
  /** Add pack `packId` to the project; stops at the first refused command (what ran before it stays, each undoable). */
  const add = (projectId: string, packId: string, origin: { kind: 'admin' | 'browser' | 'mcp'; clientId: string }): PackAddResult => {
    if (deps.engineRoot === undefined) return { ok: false, status: 503, code: 'unavailable', message: 'packs need the engine root (THIRDLIGHT_ENGINE_ROOT)' };
    const loaded = loadPack(deps.engineRoot, packId);
    if (!loaded.ok) return { ok: false, status: 404, code: 'not_found', message: loaded.message };
    const { pack, files } = loaded;
    const captured = service.readCapturedV3(projectId);
    if (!captured.ok) return { ok: false, status: 404, code: captured.error.code, message: captured.error.message ?? captured.error.code };
    const content = captured.read.content as unknown as Record<string, unknown>;
    const taken = packIds(pack).filter(({ list, key, id }) => Array.isArray(content[list]) && (content[list] as Record<string, unknown>[]).some((r) => r[key] === id));
    if (taken.length > 0) return { ok: false, status: 409, code: 'pack_present', message: `the project already has ${pack.name}'s ${taken.map((t) => t.id).join(', ')} (a pack is added once; its copies are the project's to change)` };
    const added: { op: string; id: string }[] = [];
    let revision = captured.read.revision;
    const run = (op: string, args: Record<string, unknown>, id: string): PackAddResult | null => {
      const r = runCommandNow(service, projectId, op, args, origin);
      if (!r.ok) return { ok: false, status: 400, code: r.code, message: `${op} ${id}: ${r.message}`, added };
      deps.onApplied(projectId, r.result, origin);
      revision = r.result.revision;
      added.push({ op, id });
      return null;
    };
    for (const a of pack.assets) {
      const bytes = files.get(a.file)!;
      const held = service.holdAssetBytes(projectId, bytes);
      if (!held.ok) return { ok: false, status: 500, code: held.error.code, message: `${a.file}: ${held.error.message ?? held.error.code}`, added };
      const p = deps.inspector(bytes, importJobPort(deps.now, 'pack', a.displayName), { kind: a.kind }) as unknown as { status: string; sourceDigest: string; sourceByteLength: number; importRecipe?: unknown; metrics?: unknown; diagnostics?: { message?: string }[] };
      if (p.status !== 'ok') return { ok: false, status: 400, code: 'import_rejected', message: `${a.file}: ${p.diagnostics?.[0]?.message ?? 'not accepted by the importer'}`, added };
      const importedAt = new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const refused = run('publishAsset', { mode: 'create', assetId: a.assetId, kind: a.kind, displayName: a.displayName, sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt, folder: pack.folder }, a.assetId);
      if (refused !== null) return refused;
    }
    for (const c of pack.commands) {
      const id = packIds({ ...pack, assets: [], commands: [c] })[0]?.id ?? c.op;
      const refused = run(c.op, c.args, id);
      if (refused !== null) return refused;
    }
    // Material mappings last: they name the pack's materials, made just above.
    for (const a of pack.assets) {
      if (a.materials === undefined) continue;
      const refused = run('setAssetOptions', { assetId: a.assetId, materials: a.materials }, a.assetId);
      if (refused !== null) return refused;
    }
    return { ok: true, packId, revision, added };
  };
  return { add };
}

export type PackInstaller = ReturnType<typeof createPackInstaller>;
