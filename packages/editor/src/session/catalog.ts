/**
 * The editor's view of the project catalog at any size: the project index
 * paged from the backend (`queryIndex`) for lists, pickers and search, and
 * the records the editor needs read by id — asset summaries
 * (`queryAssets {ids}`), prefab definitions (`queryPrefabs {ids}`) and
 * resource records (`queryIndex {kind, ids, records: true}`). Nothing here
 * assumes the editor holds a whole list: what is not read yet is asked for,
 * in batches, and the caller is told when it arrived.
 *
 * `version` goes up whenever an applied change may have changed what the
 * index lists (anything but an edit of objects in a scene), so a list reads
 * its pages again; `loaded` counts arrivals of records read by id.
 *
 * Pure transport logic: the caller injects the query function (the session
 * client's authenticated command route). No DOM.
 */
import type { AssetSummary } from '@thirdlight/commands';
import { ASSET_QUERY_PAGE_MAX } from '@thirdlight/project-model/limits';
import type { PrefabDefinition } from '@thirdlight/project-model';

/** One index entry as a list shows it (no reference lists: `refs: false`). */
export interface IndexEntryView {
  readonly kind: string;
  readonly id: string;
  readonly path: string | null;
  readonly name: string;
  readonly labels: readonly string[];
  readonly address?: string;
}

/** What a list or picker asks the index for (every field optional: all entries). */
export interface IndexQuery {
  readonly kinds?: readonly string[];
  readonly text?: string;
  readonly label?: string;
  readonly loadable?: boolean;
  /** Only the entries that name this id (what uses it). */
  readonly referencing?: string;
  /** Only entries with every one of these labels. */
  readonly labels?: readonly string[];
  /** Only entries whose file is in this folder of the game folder (`""`: its top). */
  readonly folder?: string;
  /** With `folder`: its subfolders too. */
  readonly recursive?: boolean;
  /** The order (absent: kind, then id). */
  readonly sort?: 'name' | 'kind' | 'path';
  readonly descending?: boolean;
}

/** One subfolder of a folder (the project window's tree). */
export interface FolderView {
  readonly path: string;
  readonly name: string;
  readonly hasFolders: boolean;
}

export interface IndexPage {
  readonly total: number;
  readonly entries: readonly IndexEntryView[];
}

/** The most entries one index page carries (the backend's `queryIndex` page). */
export const INDEX_PAGE_MAX = 1024;

/** Changes that edit the objects of a scene only: the index lists the same entries after them. */
const ENTITY_CHANGES: ReadonlySet<string> = new Set([
  'setTransform',
  'setComponent',
  'updateEntity',
  'createEntity',
  'deleteEntity',
  'moveEntities',
  'pasteEntities',
  'restoreSubtree',
  'instantiatePrefab',
  'applySurfacePreset',
  'setBehaviorProperties',
  'editBlocks',
]);

export type QueryFn = (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * One kind of record read by id: ids asked for in the same task go out
 * together, a page at a time; an id being read is not asked for twice; an id
 * the backend does not know is remembered until the index changes.
 */
class ByIdReader<T> {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly absent = new Set<string>();
  private queued = new Set<string>();
  private flush: Promise<void> | null = null;

  constructor(
    private readonly has: (id: string) => boolean,
    private readonly read: (ids: string[]) => Promise<{ records: T[]; missing: string[] }>,
    private readonly store: (records: T[]) => void,
    private readonly arrived: () => void,
    private readonly pageSize: number,
  ) {}

  /** Read the ids not held yet; resolves when every one arrived or is known not to exist. */
  ensure(ids: Iterable<string>): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const id of ids) {
      if (id === '' || this.has(id) || this.absent.has(id)) continue;
      const running = this.inFlight.get(id);
      if (running !== undefined) {
        waits.push(running);
        continue;
      }
      this.queued.add(id);
    }
    if (this.queued.size > 0) {
      this.flush ??= Promise.resolve().then(() => this.send());
      waits.push(this.flush);
    }
    return waits.length === 0 ? Promise.resolve() : Promise.all(waits).then(() => undefined);
  }

  /** Whether the backend said there is no such record (since the index last changed). */
  isAbsent(id: string): boolean {
    return this.absent.has(id);
  }

  /** Forget which ids were missing (the index changed: one may exist now). */
  reset(): void {
    this.absent.clear();
  }

  private async send(): Promise<void> {
    const ids = [...this.queued];
    this.queued = new Set();
    this.flush = null;
    const pages: string[][] = [];
    for (let i = 0; i < ids.length; i += this.pageSize) pages.push(ids.slice(i, i + this.pageSize));
    let any = false;
    await Promise.all(
      pages.map((page) => {
        const p = this.read(page).then(
          (r) => {
            if (r.records.length > 0) {
              this.store(r.records);
              any = true;
            }
            for (const id of r.missing) this.absent.add(id);
            if (r.missing.length > 0) any = true;
          },
          () => undefined,
        );
        const done = p.finally(() => {
          for (const id of page) if (this.inFlight.get(id) === done) this.inFlight.delete(id);
        });
        for (const id of page) this.inFlight.set(id, done);
        return done;
      }),
    );
    // Records arrived, or ids turned out to name none: views waiting on them draw again.
    if (any) this.arrived();
  }
}

export interface CatalogStores {
  readonly assets: { has(id: string): boolean; put(summaries: readonly AssetSummary[]): void };
  readonly prefabs: { hasDefinition(id: string): boolean; putDefinitions(defs: readonly PrefabDefinition[]): void };
  /** Resource records read by id (conversations, …): whether one is held, and where they go. */
  readonly resources: { has(kind: string, id: string): boolean; put(kind: string, records: readonly Record<string, unknown>[]): void };
}

export class Catalog {
  private versionValue = 0;
  private loadedValue = 0;
  private readonly listeners = new Set<() => void>();
  private readonly assetReader: ByIdReader<AssetSummary>;
  private readonly prefabReader: ByIdReader<PrefabDefinition>;
  private readonly resourceReaders = new Map<string, ByIdReader<Record<string, unknown>>>();

  constructor(
    private readonly query: QueryFn,
    private readonly stores: CatalogStores,
  ) {
    const notify = (): void => {
      this.loadedValue += 1;
      this.emit();
    };
    this.assetReader = new ByIdReader(
      (id) => stores.assets.has(id),
      async (ids) => {
        const r = await query('queryAssets', { ids, includeVersions: true, limit: ASSET_QUERY_PAGE_MAX });
        if (r['ok'] !== true) return { records: [], missing: [] };
        return { records: (r['assets'] as AssetSummary[] | undefined) ?? [], missing: (r['missing'] as string[] | undefined) ?? [] };
      },
      (records) => stores.assets.put(records),
      notify,
      ASSET_QUERY_PAGE_MAX,
    );
    this.prefabReader = new ByIdReader(
      (id) => stores.prefabs.hasDefinition(id),
      async (ids) => {
        const r = await query('queryPrefabs', { ids, includeEntities: true, limit: ASSET_QUERY_PAGE_MAX });
        if (r['ok'] !== true) return { records: [], missing: [] };
        return { records: (r['prefabs'] as PrefabDefinition[] | undefined) ?? [], missing: (r['missing'] as string[] | undefined) ?? [] };
      },
      (records) => stores.prefabs.putDefinitions(records),
      notify,
      ASSET_QUERY_PAGE_MAX,
    );
    this.notify = notify;
  }

  private readonly notify: () => void;

  /** Goes up when what the index lists may have changed (lists read their pages again). */
  get version(): number {
    return this.versionValue;
  }

  /** Goes up when records read by id arrived (views that were waiting for one draw again). */
  get loaded(): number {
    return this.loadedValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Records read earlier were changed by an applied change (an asset's options): views that show them draw again. */
  recordsChanged(): void {
    this.notify();
  }

  /** An applied change: a change other than an edit of scene objects may change what the index lists. */
  changed(changeType: string): void {
    if (ENTITY_CHANGES.has(changeType)) return;
    this.invalidate();
  }

  /** Everything may have changed (a full state). */
  invalidate(): void {
    this.versionValue += 1;
    this.assetReader.reset();
    this.prefabReader.reset();
    for (const r of this.resourceReaders.values()) r.reset();
    this.emit();
  }

  /** One page of the index (entries without their reference lists). */
  async page(q: IndexQuery, offset: number, limit: number): Promise<IndexPage> {
    const args: Record<string, unknown> = { refs: false, offset, limit: Math.max(1, Math.min(INDEX_PAGE_MAX, limit)) };
    if (q.kinds !== undefined && q.kinds.length > 0) args['kinds'] = [...q.kinds];
    if (q.text !== undefined && q.text.trim() !== '') args['text'] = q.text.trim();
    if (q.label !== undefined) args['label'] = q.label;
    if (q.loadable !== undefined) args['loadable'] = q.loadable;
    if (q.referencing !== undefined) args['referencing'] = q.referencing;
    if (q.labels !== undefined && q.labels.length > 0) args['labels'] = [...q.labels];
    if (q.folder !== undefined) args['folder'] = q.folder;
    if (q.recursive === true) args['recursive'] = true;
    if (q.sort !== undefined) args['sort'] = q.sort;
    if (q.descending === true) args['descending'] = true;
    const r = await this.query('queryIndex', args);
    if (r['ok'] !== true) throw new Error(String((r['error'] as { message?: string } | undefined)?.message ?? 'the index could not be read'));
    return { total: Number(r['total'] ?? 0), entries: (r['entries'] as IndexEntryView[] | undefined) ?? [] };
  }

  /** The subfolders of a folder of the game folder (`""`: its top), as they are now. */
  async folders(folder: string): Promise<FolderView[]> {
    const r = await this.query('queryIndex', { folder, folders: true, refs: false, limit: 1 });
    if (r['ok'] !== true) throw new Error(String((r['error'] as { message?: string } | undefined)?.message ?? 'the folders could not be read'));
    return (r['folders'] as FolderView[] | undefined) ?? [];
  }

  /** The index entries of these ids (names for values a picker shows, whatever page they are on). */
  async entries(ids: readonly string[], kinds?: readonly string[]): Promise<IndexEntryView[]> {
    const out: IndexEntryView[] = [];
    for (let i = 0; i < ids.length; i += INDEX_PAGE_MAX) {
      const args: Record<string, unknown> = { refs: false, ids: ids.slice(i, i + INDEX_PAGE_MAX), limit: INDEX_PAGE_MAX };
      if (kinds !== undefined && kinds.length > 0) args['kinds'] = [...kinds];
      const r = await this.query('queryIndex', args);
      if (r['ok'] === true) out.push(...((r['entries'] as IndexEntryView[] | undefined) ?? []));
    }
    return out;
  }

  private readonly firsts = new Map<string, { version: number; id: string | null | 'reading' }>();

  /**
   * The first index entry of these kinds (a starting choice for a new
   * reference), when it has been read since the index last changed; the
   * first ask reads it and the caller is told when it arrived.
   */
  firstOf(kinds: readonly string[]): string | undefined {
    const key = [...kinds].sort().join(',');
    const have = this.firsts.get(key);
    if (have !== undefined && have.version === this.versionValue) return have.id === null || have.id === 'reading' ? undefined : have.id;
    const version = this.versionValue;
    this.firsts.set(key, { version, id: 'reading' });
    void this.page({ kinds }, 0, 1).then(
      (r) => {
        this.firsts.set(key, { version, id: r.entries[0]?.id ?? null });
        this.notify();
      },
      () => this.firsts.delete(key),
    );
    return undefined;
  }

  /** Asset summaries by id (resolves when they arrived; unknown ids are skipped). */
  ensureAssets(ids: Iterable<string>): Promise<void> {
    return this.assetReader.ensure(ids);
  }

  /** Whether the backend said there is no asset with this id (since the index last changed). */
  assetAbsent(assetId: string): boolean {
    return this.assetReader.isAbsent(assetId);
  }

  /** Whether the backend said there is no resource of this kind with this id (since the index last changed). */
  resourceAbsent(kind: string, id: string): boolean {
    return this.resourceReaders.get(kind)?.isAbsent(id) === true;
  }

  /** Prefab definitions by id. */
  ensurePrefabs(ids: Iterable<string>): Promise<void> {
    return this.prefabReader.ensure(ids);
  }

  /** Resource records of one kind by id (`queryIndex {kind, ids, records: true}`). */
  ensureResources(kind: string, ids: Iterable<string>): Promise<void> {
    let reader = this.resourceReaders.get(kind);
    if (reader === undefined) {
      reader = new ByIdReader<Record<string, unknown>>(
        (id) => this.stores.resources.has(kind, id),
        async (page) => {
          const r = await this.query('queryIndex', { kind, ids: page, records: true, refs: false, limit: INDEX_PAGE_MAX });
          if (r['ok'] !== true) return { records: [], missing: [] };
          const entries = (r['entries'] as { id: string; record?: Record<string, unknown> }[] | undefined) ?? [];
          const found = new Set(entries.map((e) => e.id));
          return { records: entries.flatMap((e) => (e.record !== undefined ? [e.record] : [])), missing: page.filter((id) => !found.has(id)) };
        },
        (records) => this.stores.resources.put(kind, records),
        this.notify,
        INDEX_PAGE_MAX,
      );
      this.resourceReaders.set(kind, reader);
    }
    return reader.ensure(ids);
  }
}
