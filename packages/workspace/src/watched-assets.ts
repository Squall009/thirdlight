/**
 * Which asset files changed since the file check last looked at all of them.
 *
 * A full check (every asset's file against its record) records where each
 * asset's file is and which files it found as recorded. From then on the
 * folder watch (file-watch.ts) reports every path that changes; a changed
 * file, its sidecar or its import-cache entry marks its asset changed and the
 * file unverified. A file check (the editor's on connect and focus, "check
 * files", the one before Play) then visits only the changed assets, and a
 * Play build trusts a verified file without a `stat`.
 *
 * Nothing is trusted unless the watch was running before the full check
 * started and has not lost an event since (`onLost` starts over): after a
 * restart, when the watch failed or overflowed, or on a platform without one,
 * the next check looks at every file again. A change to a directory an asset
 * file is under (a folder renamed, removed or replaced; a symlink changed) is
 * not followed file by file: it too makes the next check a full one.
 *
 * What a watch cannot see is still caught when the file is sent: Play hashes
 * every file while it serves it and refuses one whose bytes changed.
 */
import { dirname } from 'node:path';

import { fileOfSidecar } from './asset-files';
import { FolderWatch, type FolderWatchOptions } from './file-watch';

/** Where one asset's file was found by the last look at it. */
interface Indexed {
  /** The record's file (game-folder relative). */
  readonly file: string | null;
  /** What the file held when it was checked (null: it could not be read). */
  readonly found: { readonly digest: string; readonly size: number } | null;
  /** The file's real path (null: not found). */
  readonly real: string | null;
  /** A converted asset's import-cache entry (its real path and digest, once a build located it). */
  imported: { real: string; digest: string } | null;
  /** Every path this entry is known by (dropped from the path map with it). */
  readonly owned: string[];
}

/** What a file check must visit: some assets, or all of them. */
export type PendingAssets = { all: true; reason: string } | { all: false; assetIds: ReadonlySet<string> };

export interface WatchedAssetsStats {
  mode: string;
  active: boolean;
  /** Bumped whenever events may have been lost. */
  generation: number;
  /** Whether a full check since the last loss made the watch trustworthy. */
  trusted: boolean;
  watches: number;
  /** Full and partial checks since the project opened. */
  fullChecks: number;
  partialChecks: number;
  lastLoss: string | null;
}

export class WatchedAssets {
  private generation = 0;
  /** The generation a completed full check established (null: none since the last loss). */
  private baseline: number | null = null;
  /** The generation a running full check started in, if the watch was active at its start. */
  private walkGeneration: number | null = null;
  private readonly entries = new Map<string, Indexed>();
  /** Real paths (files, sidecars, import-cache entries) → the assets they belong to. */
  private readonly byPath = new Map<string, Set<string>>();
  /** Every directory an indexed file is under, by its real and its written path (a change there is structural). */
  private readonly dirs = new Set<string>();
  /** Real paths checked since the baseline with no event on them since. */
  private readonly verified = new Set<string>();
  private readonly changed = new Set<string>();
  private structural: string | null = null;
  /** The records' list the index was last brought up to date with (lists are replaced, never changed in place). */
  private indexedList: readonly unknown[] | null = null;
  private lastLoss: string | null = null;
  private fullChecks = 0;
  private partialChecks = 0;
  readonly watch: FolderWatch;

  constructor(options: Omit<FolderWatchOptions, 'onChange' | 'onLost'>) {
    this.watch = new FolderWatch({ ...options, onChange: (p) => this.onChange(p), onLost: (why) => this.onLost(why) });
  }

  close(): void {
    this.watch.close();
    this.onLost('closed');
  }

  private onLost(reason: string): void {
    this.generation += 1;
    this.baseline = null;
    this.verified.clear();
    this.changed.clear();
    this.lastLoss = reason;
  }

  private onChange(path: string): void {
    this.verified.delete(path);
    const owners = this.byPath.get(path) ?? this.byPath.get(fileOfSidecar(path) ?? '');
    if (owners !== undefined) {
      for (const id of owners) this.changed.add(id);
      return;
    }
    if (this.dirs.has(path)) {
      this.structural ??= `${path} changed`;
      this.verified.clear();
    }
  }

  private trusted(): boolean {
    return this.watch.active && this.baseline !== null && this.baseline === this.generation && this.structural === null;
  }

  /** A full check starts: the index is made again as it visits every asset. */
  beginFull(): void {
    this.walkGeneration = this.watch.active ? this.generation : null;
    this.baseline = null;
    this.entries.clear();
    this.byPath.clear();
    this.dirs.clear();
    this.verified.clear();
    this.changed.clear();
    this.structural = null;
    this.indexedList = null;
  }

  /** A full check visited every asset of `list`: from now on changes are followed. */
  endFull(list: readonly unknown[]): void {
    this.fullChecks += 1;
    if (this.walkGeneration !== null && this.walkGeneration === this.generation && this.structural === null && this.watch.active) {
      this.baseline = this.generation;
      this.indexedList = list;
    }
    this.walkGeneration = null;
  }

  /**
   * One asset's file as a check found it: `found` what it holds (null: not
   * there or unreadable), `logical` the path it was asked for (under the
   * game folder), `real` its real path, `imported` where a converted asset's
   * import-cache entry belongs.
   */
  noteVisit(assetId: string, file: string | null, found: { digest: string; size: number } | null, paths: { logical: string | null; real: string | null; imported: string | null }): void {
    this.unindex(assetId);
    this.entries.set(assetId, { file, found, real: paths.real, imported: null, owned: [] });
    this.changed.delete(assetId);
    for (const p of [paths.real, paths.logical]) {
      if (p === null) continue;
      this.own(p, assetId);
      for (let d = dirname(p); d.length > 1 && !this.dirs.has(d); d = dirname(d)) this.dirs.add(d);
    }
    if (paths.imported !== null) this.own(paths.imported, assetId);
    if (found !== null && paths.real !== null) this.verified.add(paths.real);
  }

  /** A converted asset's import-cache entry, found as recorded by a build. */
  noteImported(assetId: string, digest: string, real: string): void {
    const e = this.entries.get(assetId);
    if (e === undefined || !this.trusted() || this.changed.has(assetId)) return;
    e.imported = { real, digest };
    this.own(real, assetId);
    this.verified.add(real);
  }

  private own(path: string, assetId: string): void {
    let s = this.byPath.get(path);
    if (s === undefined) this.byPath.set(path, (s = new Set()));
    s.add(assetId);
    this.entries.get(assetId)?.owned.push(path);
  }

  private unindex(assetId: string): void {
    const e = this.entries.get(assetId);
    if (e === undefined) return;
    for (const p of e.owned) {
      const s = this.byPath.get(p);
      s?.delete(assetId);
      if (s?.size === 0) this.byPath.delete(p);
    }
    this.entries.delete(assetId);
  }

  /**
   * What a file check must visit. `list` is the records' current
   * list; `keyOf` gives a record's id, file and recorded digest (a record
   * added or moved since it was indexed, or naming bytes other than its file
   * held when checked, is visited too).
   */
  pending(list: readonly unknown[], keyOf: (r: unknown) => { assetId: string; file: string | null; digest: string } | null): PendingAssets {
    if (!this.watch.active) return { all: true, reason: this.lastLoss ?? `no watch (${this.watch.mode})` };
    if (this.baseline === null || this.baseline !== this.generation) return { all: true, reason: this.lastLoss ?? 'no full check since the watch started' };
    if (this.structural !== null) return { all: true, reason: this.structural };
    const ids = new Set(this.changed);
    if (list !== this.indexedList) {
      const present = new Set<string>();
      for (const r of list) {
        const k = keyOf(r);
        if (k === null) continue;
        present.add(k.assetId);
        const e = this.entries.get(k.assetId);
        if (e === undefined || e.file !== k.file || e.found?.digest !== k.digest) ids.add(k.assetId);
      }
      for (const id of [...this.entries.keys()]) if (!present.has(id)) this.unindex(id);
      this.indexedList = list;
    }
    this.partialChecks += 1;
    return { all: false, assetIds: ids };
  }

  /**
   * An asset's file, trusted without a `stat`: indexed for this file and
   * digest, checked since the watch became trustworthy and not changed since.
   */
  trustedFile(assetId: string, file: string, digest: string, byteLength: number): string | null {
    if (!this.trusted() || this.changed.has(assetId)) return null;
    const e = this.entries.get(assetId);
    if (e === undefined || e.file !== file || e.found?.digest !== digest || e.found.size !== byteLength || e.real === null || !this.verified.has(e.real)) return null;
    return e.real;
  }

  /** A converted asset's import-cache entry with this digest, trusted the same way. */
  trustedImported(assetId: string, digest: string): string | null {
    if (!this.trusted() || this.changed.has(assetId)) return null;
    const imported = this.entries.get(assetId)?.imported;
    return imported !== null && imported !== undefined && imported.digest === digest && this.verified.has(imported.real) ? imported.real : null;
  }

  stats(): WatchedAssetsStats {
    return { mode: this.watch.mode, active: this.watch.active, generation: this.generation, trusted: this.trusted(), watches: this.watch.watchCount, fullChecks: this.fullChecks, partialChecks: this.partialChecks, lastLoss: this.lastLoss };
  }
}

