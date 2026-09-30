/**
 * Watching a project's folders for changes made outside the backend (Unity's
 * directory monitoring, Godot's filesystem scan on focus): a changed path is
 * reported as it happens, so a file check (on connect and focus, before
 * Play) looks at the files that changed instead of every asset's file.
 *
 * On Linux each directory gets its own watch. Node's recursive `fs.watch`
 * there is a JavaScript emulation that watches every file and stats every
 * entry synchronously when it starts (tens of thousands of watches and a
 * blocked event loop for a large game folder); a watch per directory is what
 * inotify supports natively and costs one kernel watch per folder. macOS and
 * Windows watch a whole tree natively (`recursive: true`). Other platforms
 * are not watched: their checks walk every file, as before.
 *
 * Whenever events may have been missed the owner is told (`onLost`) and must
 * treat every file as changed: a watch that failed or errored, a directory
 * that could not be watched, an event without a file name, or so many events
 * in one turn of the event loop that the kernel's queue may have overflowed
 * (libuv drops inotify's overflow notice, so the count is the only sign).
 */
import { promises as fsp, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';

/** How a platform's folders are watched. */
export type FolderWatchMode = 'directories' | 'recursive' | 'none';

/** The kernel's queue length when it cannot be read (Linux's default `max_queued_events`). */
export const INOTIFY_DEFAULT_QUEUED_EVENTS = 16_384;

export function folderWatchModeFor(platform: NodeJS.Platform = process.platform): FolderWatchMode {
  if (platform === 'linux') return 'directories';
  if (platform === 'darwin' || platform === 'win32') return 'recursive';
  return 'none';
}

/** The length of the kernel's event queue: a turn that delivers this many events may have lost some. */
export function inotifyQueueLength(): number {
  try {
    const n = Number(readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : INOTIFY_DEFAULT_QUEUED_EVENTS;
  } catch {
    return INOTIFY_DEFAULT_QUEUED_EVENTS;
  }
}

export interface FolderWatchOptions {
  /** The folders watched (real paths: events name paths under them). */
  readonly roots: readonly string[];
  /** Directories left out, with everything under them (real paths). */
  readonly skip: (dir: string) => boolean;
  /** A path under a root was created, written, removed or renamed. */
  readonly onChange: (path: string) => void;
  /** Events may have been missed: everything that relies on them must look at every file again. */
  readonly onLost: (reason: string) => void;
  readonly mode?: FolderWatchMode;
  /** Events in one turn of the event loop that count as a possible overflow (default: the kernel's queue length). */
  readonly maxEventsPerTurn?: number;
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export class FolderWatch {
  readonly mode: FolderWatchMode;
  private readonly watchers = new Map<string, FSWatcher>();
  private closed = false;
  private eventsThisTurn = 0;
  private turnPending = false;
  private readonly maxEventsPerTurn: number;
  private started = false;
  /** Settles once every directory present at the start is watched: true when the watch can be relied on. */
  readonly ready: Promise<boolean>;
  /** Whether `ready` settled true and nothing failed since (a failed watch stays off). */
  active = false;

  constructor(private readonly opts: FolderWatchOptions) {
    this.mode = opts.mode ?? folderWatchModeFor();
    this.maxEventsPerTurn = opts.maxEventsPerTurn ?? (this.mode === 'directories' ? inotifyQueueLength() : Number.POSITIVE_INFINITY);
    this.ready = this.start().then(
      (ok) => {
        this.started = true;
        this.active = ok && !this.closed;
        return this.active;
      },
      () => {
        this.started = true;
        this.fail('the folders could not be watched');
        return false;
      },
    );
  }

  /** How many directories (or trees) are watched. */
  get watchCount(): number {
    return this.watchers.size;
  }

  close(): void {
    this.closed = true;
    this.active = false;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private async start(): Promise<boolean> {
    if (this.mode === 'none') return false;
    for (const root of this.opts.roots) {
      if (this.closed) return false;
      if (this.mode === 'recursive') {
        if (!this.add(root, true)) return false;
      } else if (!(await this.watchTree(root))) return false;
    }
    return !this.closed;
  }

  /** Stop relying on the watch: the owner looks at every file from now on. */
  private fail(reason: string): void {
    const was = this.active || !this.started;
    this.close();
    if (was) this.opts.onLost(reason);
  }

  private add(dir: string, recursive: boolean): boolean {
    if (this.closed || this.watchers.has(dir)) return !this.closed;
    let w: FSWatcher;
    try {
      w = watch(dir, { persistent: false, recursive }, (_event, name) => this.event(dir, name));
    } catch (e) {
      // A directory removed before it was watched is simply gone; anything else (no inotify watches left) ends the watch.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
      this.fail(`${dir} could not be watched (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
      return false;
    }
    w.on('error', () => {
      // A watched directory that was removed errors on some platforms: its parent reported the removal already.
      if (this.watchers.get(dir) === w) this.watchers.delete(dir);
      w.close();
      if (this.opts.roots.includes(dir)) this.fail(`the watch of ${dir} failed`);
    });
    this.watchers.set(dir, w);
    return true;
  }

  /** Watch a directory and every directory under it (each watched before it is listed, so nothing created meanwhile is missed). */
  private async watchTree(top: string): Promise<boolean> {
    const queue = [top];
    while (queue.length > 0) {
      if (this.closed) return false;
      const dir = queue.pop()!;
      if (this.opts.skip(dir)) continue;
      if (!this.add(dir, false)) return false;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        // Removed meanwhile: its parent's watch reports it.
        continue;
      }
      for (const e of entries) if (e.isDirectory()) queue.push(join(dir, e.name));
    }
    return true;
  }

  private event(dir: string, name: string | Buffer | null): void {
    if (this.closed) return;
    if (name === null || name === undefined) {
      this.fail('an event came without a file name');
      return;
    }
    this.eventsThisTurn += 1;
    if (!this.turnPending) {
      this.turnPending = true;
      setImmediate(() => {
        this.turnPending = false;
        this.eventsThisTurn = 0;
      });
    }
    if (this.eventsThisTurn >= this.maxEventsPerTurn) {
      // The kernel's queue may have been full: events after it were dropped. The watches stay; the owner starts over.
      this.eventsThisTurn = 0;
      this.opts.onLost('more events arrived at once than the kernel queues');
      return;
    }
    const path = join(dir, name.toString());
    this.opts.onChange(path);
    if (this.mode === 'directories') void this.follow(path);
  }

  /** A path that appeared or went away: watch a new directory, drop the watches of a removed or renamed one. */
  private async follow(path: string): Promise<void> {
    let isDir = false;
    try {
      const st = await fsp.lstat(path);
      isDir = st.isDirectory();
    } catch {
      isDir = false;
    }
    if (this.closed) return;
    if (!isDir) {
      for (const [d, w] of this.watchers) {
        if (within(path, d)) {
          w.close();
          this.watchers.delete(d);
        }
      }
      return;
    }
    // A new directory's files are new to the owner too (it knows files by their paths); a directory it knew came back
    // under its old path, which the owner was told about above.
    if (!this.watchers.has(path) && !this.opts.skip(path)) await this.watchTree(path);
  }
}
