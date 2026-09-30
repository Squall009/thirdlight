/**
 * A game page's runtime content: the manifest, and the catalog read as the
 * game needs it (shared by the editor's Play page and the exported game).
 *
 * `openRuntimeContent` reads what the game needs before its first frame:
 *
 * - v5: the small manifest (its buildId checked), the catalog root, every
 *   block file (prefabs, materials, UI documents, dialogue, behaviors, the
 *   simulation's asset facts, …, not the loadable index), and the
 *   dependency files of the start scenes and of the project-wide blocks.
 *   Those entries are the rows known at start; any other entry is found when
 *   something asks for it: a scene's load reads that scene's dependency file
 *   (`sceneEntries`), and an id no loaded scene named reads the one shard
 *   whose id range holds it (`lookup`).
 * - v4 (a build before the catalog): the manifest and its content files, as
 *   before; every asset row is known at start. So a v4 build opens into the
 *   same shape, upgraded where it is loaded.
 *
 * Every file is read through the page's reader and checked against its row
 * (length and SHA-256) before it is parsed; the rows are bound by the
 * manifest's buildId. A missing or changed file throws, naming it.
 */
import {
  catalogRootProblem,
  joinCatalogParts,
  manifestBuildIdInputV2,
  manifestBuildIdInputV5,
  RUNTIME_CONTENT_MANIFEST_VERSION_4,
  RUNTIME_CONTENT_MANIFEST_VERSION_5,
  validateManifestV5,
  type CatalogEntry,
  type CatalogFileRef,
  type CatalogRootV5,
  type CatalogSceneRow,
  type CatalogShardRow,
} from '@thirdlight/runtime';

import { expandManifestContentFiles, type ManifestContentFileRowLike, type SceneCatalogIo } from './scene-catalog';
import type { DeclaredAssetRow } from './asset-reader';

/** One catalog row (an asset row with its load settings, names and dependencies). */
export type CatalogRow = DeclaredAssetRow & Readonly<Record<string, unknown>>;

/**
 * The catalog as a page reads it: rows known now, and the reads that find
 * the others. The verified asset reader, the scene loads and the host go
 * through it.
 */
export interface RuntimeCatalog {
  /** The catalog version (4: every row was known at open). */
  readonly version: 4 | 5;
  /** A row read so far (a version, else the asset's last version). */
  row(assetId: string, version?: number): CatalogRow | undefined;
  /** A row read so far, by its artifact path. */
  rowAt(path: string): CatalogRow | undefined;
  /** An asset's row, reading its shard when no read so far had it (undefined: not in this build). */
  lookup(assetId: string): Promise<CatalogRow | undefined>;
  /** What a scene needs (reads its dependency file once); null: the build lists no dependencies (v4). */
  sceneEntries(sceneId: string): Promise<readonly CatalogRow[]> | null;
  /** A scene's entries once read (undefined: not read yet, or none listed). */
  sceneEntriesRead(sceneId: string): readonly CatalogRow[] | undefined;
  /** Every row known now. */
  known(): readonly CatalogRow[];
  /** What the project-wide blocks need (event cues, timelines, the shell, the UI; v4: every row). */
  shared(): readonly CatalogRow[];
  /** What scripts may load by address or label (read once, on first ask). */
  loadable(): Promise<readonly { kind: string; id: string; address?: string; labels?: readonly string[] }[]>;
  /** Catalog files read and their bytes (the manifest's content files for v4). */
  stats(): { files: number; bytes: number };
}

/** The opened content: the manifest in the shape a page composes from, and the catalog. */
export interface RuntimeContent<M> {
  readonly version: 4 | 5;
  /**
   * The manifest with every block under its key (v4's shape): `assets` are
   * the rows known at open (v4: every row; v5: what the start scenes and the
   * project-wide blocks need); `scenes` every scene's row.
   */
  readonly manifest: M;
  /** What the simulation reads of every asset (bounds, material maps, durations, texture ids): rows by asset. */
  readonly facts: readonly Readonly<Record<string, unknown>>[];
  readonly catalog: RuntimeCatalog;
}

async function readChecked(io: SceneCatalogIo, ref: CatalogFileRef, what: string): Promise<unknown> {
  const buf = await io.read(ref.path);
  if (buf.byteLength !== ref.byteLength) throw new Error(`${what} (${ref.path}): ${buf.byteLength} bytes, the catalog says ${ref.byteLength}`);
  if ((await io.sha256Hex(new Uint8Array(buf))) !== ref.digest) throw new Error(`${what} (${ref.path}): the digest does not match the catalog`);
  return JSON.parse(new TextDecoder().decode(buf)) as unknown;
}

function createCatalog(version: 4 | 5, io: SceneCatalogIo, root: CatalogRootV5 | null, counted: { files: number; bytes: number }): RuntimeCatalog & { add(rows: readonly CatalogRow[]): void; setShared(rows: readonly CatalogRow[]): void } {
  let sharedRows: readonly CatalogRow[] | null = null;
  const byKey = new Map<string, CatalogRow>();
  const byId = new Map<string, CatalogRow>();
  const byPath = new Map<string, CatalogRow>();
  const shards: readonly CatalogShardRow[] = root?.entries ?? [];
  const shardReads = new Map<number, Promise<void>>();
  const scenes = new Map<string, CatalogSceneRow>((root?.scenes ?? []).map((s) => [s.sceneId, s]));
  const sceneReads = new Map<string, Promise<readonly CatalogRow[]>>();
  const sceneRead = new Map<string, readonly CatalogRow[]>();
  const loadableFiles = (root?.files ?? []).filter((f) => f.key === 'loadable');
  let loadableRead: Promise<readonly { kind: string; id: string; address?: string; labels?: readonly string[] }[]> | null = null;
  const read = async (ref: CatalogFileRef, what: string): Promise<unknown> => {
    const v = await readChecked(io, ref, what);
    counted.files += 1;
    counted.bytes += ref.byteLength;
    return v;
  };
  const add = (rows: readonly CatalogRow[]): void => {
    for (const r of rows) {
      byKey.set(`${r.assetId}@${r.version}`, r);
      const had = byId.get(r.assetId);
      if (had === undefined || had.version <= r.version) byId.set(r.assetId, r);
      byPath.set(r.path, r);
    }
  };
  /** The shard whose id range holds an id (-1: none). */
  const shardOf = (assetId: string): number => {
    let lo = 0;
    let hi = shards.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = shards[mid]!;
      if (assetId < s.first) hi = mid - 1;
      else if (assetId > s.last) lo = mid + 1;
      else return mid;
    }
    return -1;
  };
  return {
    version,
    add,
    row(assetId, v) {
      return v === undefined ? byId.get(assetId) : byKey.get(`${assetId}@${v}`);
    },
    rowAt(path) {
      return byPath.get(path);
    },
    async lookup(assetId) {
      const known = byId.get(assetId);
      if (known !== undefined) return known;
      const at = shardOf(assetId);
      if (at < 0) return undefined;
      let p = shardReads.get(at);
      if (p === undefined) {
        p = read(shards[at]!, 'an entry shard').then((rows) => add(rows as CatalogRow[]));
        shardReads.set(at, p);
        // A failed read is not kept: a later ask reads again.
        p.catch(() => shardReads.delete(at));
      }
      await p;
      return byId.get(assetId);
    },
    sceneEntries(sceneId) {
      const row = scenes.get(sceneId);
      if (row === undefined) return null;
      let p = sceneReads.get(sceneId);
      if (p === undefined) {
        p = read(row.dependencies, `the ${sceneId} dependency file`).then((rows) => {
          const list = rows as CatalogRow[];
          add(list);
          sceneRead.set(sceneId, list);
          return list;
        });
        sceneReads.set(sceneId, p);
        p.catch(() => sceneReads.delete(sceneId));
      }
      return p;
    },
    sceneEntriesRead(sceneId) {
      return sceneRead.get(sceneId);
    },
    known() {
      return [...byKey.values()];
    },
    shared() {
      return sharedRows ?? [...byKey.values()];
    },
    setShared(rows) {
      sharedRows = rows;
    },
    loadable() {
      loadableRead ??= Promise.all(loadableFiles.map((f) => read(f, 'the loadable file'))).then((parts) => (parts.length === 0 ? [] : (joinCatalogParts('loadable', parts) as { kind: string; id: string }[])));
      return loadableRead;
    },
    stats() {
      return { ...counted };
    },
  };
}

/** The manifest header keys a v5 build keeps in `manifest.json` (the page's composed manifest keeps them). */
const HEADER_KEYS = ['manifestVersion', 'type', 'projectId', 'revision', 'snapshotId', 'capturedAt', 'sceneDigest', 'contentDigest', 'settingsDigest', 'mediaDigest', 'settings', 'start', 'modules', 'enginePins', 'recipes', 'toolchain', 'buildOptionsDigest', 'buildId'] as const;

/**
 * Open a build's runtime content from its manifest document (parsed
 * `manifest.json`): the buildId checked against the document, then what the
 * start needs read (see the module comment). Throws on an unsupported or
 * changed document or file.
 */
export async function openRuntimeContent<M = Record<string, unknown>>(doc: unknown, io: SceneCatalogIo): Promise<RuntimeContent<M>> {
  const d = (doc ?? {}) as Record<string, unknown>;
  if (d['type'] !== 'thirdlight-runtime-content') throw new Error('unsupported manifest document (not runtime content)');
  const counted = { files: 0, bytes: 0 };
  if (d['manifestVersion'] === RUNTIME_CONTENT_MANIFEST_VERSION_4) {
    const preimage = manifestBuildIdInputV2(d);
    if (preimage === null || (await io.sha256Hex(preimage)) !== d['buildId']) throw new Error('the manifest buildId does not match the manifest document');
    const expanded = await expandManifestContentFiles(d as { contentFiles?: readonly ManifestContentFileRowLike[] }, io);
    for (const r of (d['contentFiles'] as ManifestContentFileRowLike[] | undefined) ?? []) {
      counted.files += 1;
      counted.bytes += r.byteLength;
    }
    const rows = ((expanded as Record<string, unknown>)['assets'] as CatalogRow[] | undefined) ?? [];
    const catalog = createCatalog(4, io, null, counted);
    catalog.add(rows);
    const start = ((d['scenes'] as { sceneId: string; start: boolean }[] | undefined) ?? []).filter((s) => s.start).map((s) => s.sceneId);
    return { version: 4, manifest: { ...(expanded as Record<string, unknown>), start } as M, facts: rows, catalog };
  }
  if (d['manifestVersion'] !== RUNTIME_CONTENT_MANIFEST_VERSION_5) throw new Error(`unsupported manifest version ${String(d['manifestVersion'])} (this page reads 4 and 5)`);
  const valid = validateManifestV5(d, { buildId: false });
  if (!valid.ok) throw new Error(valid.error.message);
  const preimage = manifestBuildIdInputV5(d);
  if (preimage === null || (await io.sha256Hex(preimage)) !== d['buildId']) throw new Error('the manifest buildId does not match the manifest document');
  const m = valid.manifest;
  const root = (await readChecked(io, m.catalog, 'the catalog root')) as CatalogRootV5;
  counted.files += 1;
  counted.bytes += m.catalog.byteLength;
  const why = catalogRootProblem(root);
  if (why !== null) throw new Error(why);
  const catalog = createCatalog(5, io, root, counted);
  // Every block but the loadable index (read when a script loads by name), in parallel, parts in order.
  const blockFiles = root.files.filter((f) => f.key !== 'loadable');
  const [parts, startEntries] = await Promise.all([
    Promise.all(blockFiles.map(async (f) => {
      const v = await readChecked(io, f, `the ${f.key} file`);
      counted.files += 1;
      counted.bytes += f.byteLength;
      return v;
    })),
    Promise.all(m.start.map((id) => catalog.sceneEntries(id) ?? Promise.resolve([] as readonly CatalogRow[]))),
  ]);
  const grouped = new Map<string, unknown[]>();
  blockFiles.forEach((f, i) => {
    const list = grouped.get(f.key) ?? [];
    list.push(parts[i]);
    grouped.set(f.key, list);
  });
  const blocks: Record<string, unknown> = {};
  for (const [key, list] of grouped) blocks[key] = joinCatalogParts(key, list);
  const shared = (blocks['dependencies'] as CatalogEntry[] | undefined) ?? [];
  catalog.add(shared as unknown as CatalogRow[]);
  catalog.setShared(shared as unknown as CatalogRow[]);
  const header: Record<string, unknown> = {};
  for (const k of HEADER_KEYS) header[k] = (m as unknown as Record<string, unknown>)[k];
  const { media, behaviors, facts, dependencies: _shared, ...rest } = blocks;
  const knownAtOpen = new Map<string, CatalogRow>();
  for (const r of [...shared, ...startEntries.flat()] as unknown as CatalogRow[]) knownAtOpen.set(`${r.assetId}@${r.version}`, r);
  const manifest = {
    ...header,
    ...rest,
    ...(root.scenes !== undefined ? { scenes: root.scenes } : {}),
    assets: [...knownAtOpen.values()].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : a.version - b.version)),
    media: { animation: (media as unknown[] | undefined) ?? [] },
    behaviors: (behaviors as unknown[] | undefined) ?? [],
    ...(root.libraries !== undefined ? { libraries: root.libraries } : {}),
  };
  return { version: 5, manifest: manifest as M, facts: (facts as Record<string, unknown>[] | undefined) ?? [], catalog };
}
