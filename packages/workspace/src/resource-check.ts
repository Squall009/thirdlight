/**
 * The file check's side for project resources and scenes placed in the game
 * folder: the files are the truth, and the backend brings the open project in
 * step with them when it notices a change (the same check as the assets':
 * the editor on connect, on window focus and on "check files"; MCP's
 * integrity check). As Unity's and Godot's editors do with their asset
 * folders:
 *
 * - a file moved or renamed outside the editor is the same resource or scene
 *   (it carries its id): the project follows it. Paths are found, not stored,
 *   so a move changes no project file and takes no revision;
 * - a file added there comes into the project, and a copy (a second file with
 *   an id the project has) gets a new id from its file name, the rule folder
 *   import uses for assets (`<name>`, `<name>-2`, …); a copied scene's objects
 *   get new ids too (entity ids are unique across the project);
 * - a resource file changed there is reloaded: its record becomes the file's;
 *   one removed there leaves the project, unless something uses it;
 * - all of that is one ordinary command (`importResources`: the change feed,
 *   one undo), prepared here from the files.
 *
 * What cannot be taken in pauses the project on that file, the protocol a
 * changed project file has always had (accept the disk, or put back what the
 * editor wrote): a resource file that no longer reads or validates, one
 * removed while something uses it, and a scene file changed or removed
 * outside the editor (a scene is edited in the editor; Godot asks before it
 * reloads an open scene too). A new file that cannot be read is reported and
 * left alone.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { nextFreeEntityIdOf, validateContentV4, validateSceneV4, type ContentCatalogV4, type SceneV4 } from '@thirdlight/project-model';
import type { AdoptedScene, PreparedResourceImport, PreparedResourceRecord } from '@thirdlight/commands';

import { sha256Hex } from './digest';
import { freeAssetId, idStemOf } from './folder-import';
import { ENV_PRESETS, gamePathOf, gameRel, parseResourceFile, recordsOfKind, resourceKindOfList, resourceStem, scanResourceFiles, type ResourceKind } from './resource-files';
import { formerKey, joinChunkFiles, projectOwnSkip, readGameScenes, type GameSceneFile, type KnownFile, type V4State } from './store-v4';
import { detectExternalChangeV4, gameRootOf, publishV4 } from './session-v4';
import type { Core, ProjectSession } from './session';

/** What the next `importResources` of a project applies (read once by the command). */
export interface PreparedResourceFiles {
  prepared: PreparedResourceImport;
  /** Where each adopted resource or scene is (`formerKey` → game-folder path). */
  at: Map<string, string>;
  /** The files the command takes as they were read here (`@game/…` key → bytes; null: removed). */
  disk: Map<string, KnownFile | null>;
}

/** What one check found. */
export interface ResourceCheckReport {
  followed: { kind: string; id: string; from: string; to: string }[];
  adopted: { kind: string; id: string; path: string; copyOf?: string }[];
  reloaded: { kind: string; id: string; path: string }[];
  removed: { kind: string; id: string; path: string }[];
  /** Files that could not come in (they stay as they are). */
  problems: { path: string; message: string }[];
  /** The file the project paused on (null: none). */
  paused: string | null;
}

type Rec = Record<string, unknown>;

interface Untracked {
  path: string;
  bytes: Uint8Array;
  kind: ResourceKind;
  id: string;
  data: Rec;
}

/** The content with one record of a resource list set (null: removed); the other records stay the same objects. */
function withResource(content: ContentCatalogV4, k: ResourceKind, id: string, record: Rec | null): ContentCatalogV4 {
  const list = [...(recordsOfKind(content, k) ?? [])];
  const at = list.findIndex((r) => String(r[k.idKey]) === id);
  if (record === null) {
    if (at >= 0) list.splice(at, 1);
  } else if (at >= 0) list[at] = record;
  else list.push(record);
  if (k.list !== ENV_PRESETS) return { ...content, [k.list]: list } as unknown as ContentCatalogV4;
  return { ...content, environment: { ...(content.environment ?? {}), presets: list } } as unknown as ContentCatalogV4;
}

/** New ids for every object of a copied scene; references inside it (parents, components naming them, block layers) follow. */
function reidScene(scene: SceneV4, taken: Set<string>): SceneV4 {
  const map = new Map<string, string>();
  for (const e of scene.entities) {
    const prefix = e.id.replace(/-\d+$/, '') || 'entity';
    const id = nextFreeEntityIdOf(taken, prefix) ?? nextFreeEntityIdOf(taken, 'entity')!;
    taken.add(id);
    map.set(e.id, id);
  }
  const remap = (v: unknown): unknown => {
    if (typeof v === 'string') return map.get(v) ?? v;
    if (Array.isArray(v)) return v.map(remap);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x)]));
    return v;
  };
  return {
    ...scene,
    entities: scene.entities.map((e) => remap(e) as SceneV4['entities'][number]),
    ...(scene.blocks !== undefined ? { blocks: scene.blocks.map((b) => ({ ...b, entityId: map.get(b.entityId) ?? b.entityId })) } : {}),
  };
}

/** A scene's index name from its file name (`Level 2.scene.json` → `Level 2`). */
function sceneNameOf(path: string, fallback: string): string {
  const stem = resourceStem(path).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 128);
  return stem.length > 0 ? stem : fallback;
}

/**
 * Compare the game folder's resource and scene files with the open project:
 * follow moves in the session, pause on what cannot be taken in, and prepare
 * the rest for one `importResources` command (`s.preparedResources`).
 */
export function checkResourceFiles(core: Core, s: ProjectSession): { report: ResourceCheckReport; prepared: boolean } {
  const report: ResourceCheckReport = { followed: [], adopted: [], reloaded: [], removed: [], problems: [], paused: null };
  s.preparedResources = undefined;
  let state = s.v4;
  if (state === null || state === undefined || s.pendingChange !== null) return { report, prepared: false };
  const gameRoot = gameRootOf(s);
  const scan = scanResourceFiles(gameRoot, projectOwnSkip(s.dir, gameRoot));
  const read = (path: string): Uint8Array | null => {
    try {
      return core.ops.readFile(join(gameRoot, ...path.split('/')));
    } catch {
      return null;
    }
  };

  // What the project tracks in the game folder.
  const trackedRes = new Map<string, { k: ResourceKind; id: string }>();
  for (const [list, byId] of state.resourcePaths) {
    const k = resourceKindOfList(list);
    if (k !== undefined) for (const [id, path] of byId) trackedRes.set(path, { k, id });
  }
  const trackedScenes = new Map<string, string>();
  for (const [id, rel] of state.scenePaths) {
    const p = gamePathOf(rel);
    if (p !== null) trackedScenes.set(p, id);
  }
  const onDisk = new Set([...scan.resources, ...scan.scenes]);

  // The files the project does not track yet.
  const untracked: Untracked[] = [];
  for (const path of scan.resources) {
    if (trackedRes.has(path)) continue;
    const bytes = read(path);
    if (bytes === null) continue;
    const r = parseResourceFile(path, bytes);
    if (!r.ok) report.problems.push({ path, message: r.message });
    else untracked.push({ path, bytes, kind: r.kind, id: r.id, data: r.data });
  }
  const sceneFiles = readGameScenes(core.ops, gameRoot, scan.scenes.filter((p) => !trackedScenes.has(p)));
  for (const u of sceneFiles.unreadable) report.problems.push(u);
  const untrackedScenes: GameSceneFile[] = [...sceneFiles.chosen.values(), ...sceneFiles.copies].sort((a, b) => (a.path < b.path ? -1 : 1));
  const sceneIdOf = (f: GameSceneFile): string => (f.value['scene'] as { sceneId: string }).sceneId;
  const prefer = <T extends { path: string }>(list: T[], id: string): T | undefined => list.find((x) => resourceStem(x.path) === id) ?? list[0];

  // Moves: a tracked file gone from its path, the same kind and id elsewhere.
  const resourcePaths = new Map([...state.resourcePaths].map(([list, byId]) => [list, new Map(byId)]));
  const scenePaths = new Map(state.scenePaths);
  const files = new Map(state.files);
  let moved = false;
  const gone: { path: string; k: ResourceKind; id: string }[] = [];
  for (const [path, t] of trackedRes) {
    if (onDisk.has(path)) continue;
    const to = prefer(untracked.filter((u) => u.kind === t.k && u.id === t.id), t.id);
    if (to === undefined) {
      gone.push({ path, ...t });
      continue;
    }
    untracked.splice(untracked.indexOf(to), 1);
    resourcePaths.get(t.k.list)?.set(t.id, to.path);
    const known = files.get(gameRel(path));
    files.delete(gameRel(path));
    if (known !== undefined) files.set(gameRel(to.path), known);
    report.followed.push({ kind: t.k.kind, id: t.id, from: path, to: to.path });
    moved = true;
  }
  const goneScenes: { path: string; id: string }[] = [];
  for (const [path, id] of trackedScenes) {
    if (onDisk.has(path)) continue;
    const to = prefer(untrackedScenes.filter((f) => sceneIdOf(f) === id), id);
    if (to === undefined) {
      goneScenes.push({ path, id });
      continue;
    }
    untrackedScenes.splice(untrackedScenes.indexOf(to), 1);
    scenePaths.set(id, gameRel(to.path));
    const known = files.get(gameRel(path));
    files.delete(gameRel(path));
    if (known !== undefined) files.set(gameRel(to.path), known);
    report.followed.push({ kind: 'scene', id, from: path, to: to.path });
    moved = true;
  }
  if (moved) {
    state = { ...state, resourcePaths, scenePaths, files };
    publishV4(s, state);
  }
  const current = state;

  const pause = (rel: string, bytes: Uint8Array): { report: ResourceCheckReport; prepared: boolean } => {
    detectExternalChangeV4(core, s, { rel, bytes, hash: sha256Hex(bytes) });
    report.paused = gamePathOf(rel) ?? rel;
    return { report, prepared: false };
  };

  // Scenes are edited in the editor: one changed or removed outside it pauses the project.
  for (const [path] of trackedScenes) {
    const rel = scenePaths.get(trackedScenes.get(path)!) ?? gameRel(path);
    const p = gamePathOf(rel)!;
    const bytes = read(p);
    if (bytes === null) {
      if (goneScenes.some((g) => g.path === path)) return pause(rel, new Uint8Array(0));
      continue;
    }
    if (sha256Hex(bytes) !== current.files.get(rel)?.hash) return pause(rel, bytes);
  }

  const records: PreparedResourceRecord[] = [];
  const at = new Map<string, string>();
  const disk = new Map<string, KnownFile | null>();
  let content = current.content;
  /** Whether the content with this record set still validates on its own (the command validates the whole result again). */
  const fits = (next: ContentCatalogV4): string | null => {
    const v = validateContentV4(next, content);
    return v.ok ? null : (v.errors[0]?.message ?? 'the record does not validate');
  };

  // Changed resource files: reloaded, or the project pauses on one that cannot be.
  // A file whose size and time are those it had when it last matched is not read again.
  const seen = (s.resourceStats ??= new Map());
  for (const [list, byId] of current.resourcePaths) {
    const k = resourceKindOfList(list);
    if (k === undefined) continue;
    for (const [id, path] of byId) {
      const rel = gameRel(path);
      const known = current.files.get(rel);
      let stamp: string | null = null;
      try {
        const st = statSync(join(gameRoot, ...path.split('/')));
        stamp = `${st.size}:${st.mtimeMs}:${known?.hash ?? ''}`;
      } catch {
        continue;
      }
      if (seen.get(rel) === stamp) continue;
      const bytes = read(path);
      if (bytes === null) continue;
      const hash = sha256Hex(bytes);
      if (hash === known?.hash) {
        seen.set(rel, stamp);
        continue;
      }
      const r = parseResourceFile(path, bytes);
      if (!r.ok || r.kind !== k || r.id !== id) return pause(rel, bytes);
      const next = withResource(content, k, id, r.data);
      if (fits(next) !== null) return pause(rel, bytes);
      content = next;
      records.push({ list: k.list, idKey: k.idKey, id, record: r.data });
      disk.set(rel, { bytes, hash });
      report.reloaded.push({ kind: k.kind, id, path });
    }
  }

  // Removed resource files: out of the project, unless something uses them.
  for (const g of gone) {
    const users = [...(s.index?.referrers.get(g.id) ?? [])].filter((key) => key !== `${g.k.kind}:${g.id}`);
    if (users.length > 0) return pause(gameRel(g.path), new Uint8Array(0));
    content = withResource(content, g.k, g.id, null);
    records.push({ list: g.k.list, idKey: g.k.idKey, id: g.id, record: null });
    disk.set(gameRel(g.path), null);
    report.removed.push({ kind: g.k.kind, id: g.id, path: g.path });
  }

  // New resource files: adopted, a copy with a new id.
  const idsOf = (k: ResourceKind): Set<string> => new Set((recordsOfKind(content, k) ?? []).map((r) => String(r[k.idKey])));
  for (const u of [...untracked].sort((a, b) => (resourceStem(a.path) === a.id ? 0 : 1) - (resourceStem(b.path) === b.id ? 0 : 1) || (a.path < b.path ? -1 : 1))) {
    const taken = idsOf(u.kind);
    const copy = taken.has(u.id);
    const id = copy ? freeAssetId(idStemOf(resourceStem(u.path)), taken) : u.id;
    const record = copy ? { ...u.data, [u.kind.idKey]: id } : u.data;
    const next = withResource(content, u.kind, id, record);
    const why = fits(next);
    if (why !== null) {
      report.problems.push({ path: u.path, message: `${u.path} was not taken in: ${why}` });
      continue;
    }
    content = next;
    records.push({ list: u.kind.list, idKey: u.kind.idKey, id, record });
    at.set(formerKey(u.kind.list, id), u.path);
    disk.set(gameRel(u.path), { bytes: u.bytes, hash: sha256Hex(u.bytes) });
    report.adopted.push({ kind: u.kind.kind, id, path: u.path, ...(copy ? { copyOf: u.id } : {}) });
  }

  // New scene files: adopted where they are; a copy gets a new scene id and new object ids.
  const scenes: AdoptedScene[] = [];
  const sceneIds = new Set(current.scenes.keys());
  const entityIds = new Set<string>();
  for (const sc of current.scenes.values()) for (const e of sc.entities) entityIds.add(e.id);
  for (const f of untrackedScenes) {
    const fromId = sceneIdOf(f);
    const joined = joinChunkFiles(core.ops, s.dir, s.projectId, fromId, f.value['scene'], f.value['blockChunks'], new Map());
    if (!joined.ok) {
      report.problems.push({ path: f.path, message: `${f.path} was not taken in: ${joined.error.message}` });
      continue;
    }
    const v = validateSceneV4(joined.scene);
    if (!v.ok) {
      const e = v.errors[0];
      report.problems.push({ path: f.path, message: `${f.path} was not taken in: ${e === undefined ? 'the scene does not validate' : `${e.path !== undefined && e.path !== '' ? `${e.path}: ` : ''}${e.message}`}` });
      continue;
    }
    const copy = sceneIds.has(fromId);
    const sceneId = copy ? freeAssetId(idStemOf(resourceStem(f.path)), sceneIds) : fromId;
    let scene: SceneV4 = { ...v.normalized, sceneId };
    if (scene.entities.some((e) => entityIds.has(e.id))) scene = reidScene(scene, entityIds);
    for (const e of scene.entities) entityIds.add(e.id);
    sceneIds.add(sceneId);
    scenes.push({ sceneId, name: sceneNameOf(f.path, sceneId), scene });
    at.set(formerKey('scene', sceneId), f.path);
    disk.set(gameRel(f.path), { bytes: f.bytes, hash: sha256Hex(f.bytes) });
    report.adopted.push({ kind: 'scene', id: sceneId, path: f.path, ...(copy ? { copyOf: fromId } : {}) });
  }

  if (records.length === 0 && scenes.length === 0) return { report, prepared: false };
  s.preparedResources = { prepared: { records, scenes }, at, disk };
  return { report, prepared: true };
}
