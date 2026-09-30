/**
 * The background flush of journaled transactions.
 *
 * A transaction of several files commits when its journal (every byte it
 * writes) is on disk; its files are then renamed into place at once, so every
 * reader sees the new bytes, and flushed to the disk here, after the command
 * is answered and off the event loop. Only once every file and every directory
 * the transaction touched is flushed is its journal removed (and that removal
 * flushed). A crash before then leaves the journal, and the next open replays
 * it (with any later ones, oldest first), so an answered command is never lost.
 *
 * While a journal waits here, every later transaction is journaled too (even
 * a single file): replaying an older journal after a crash must never undo a
 * newer write, and journals replay in the order they were written.
 *
 * Flushing one file after another costs a disk round trip each (1,000 files:
 * seconds on the GPU host's disk); here the files are flushed a few at a time
 * and each directory once per transaction.
 */

import { join } from 'node:path';

import type { WriteOps } from './write';

/**
 * How many files are flushed at once. libuv's pool has four threads by
 * default; two leave the others to the file reads the backend serves meanwhile
 * (Play, thumbnails), and concurrent flushes already share the disk's
 * journal commits.
 */
const FLUSH_CONCURRENCY = 2;

interface FlushJob {
  journal: string;
  files: string[];
  dirs: string[];
  /** Settled or dropped outside the runner: the runner leaves it alone. */
  over: boolean;
}

interface FlushQueue {
  /** The next journal's number (journals replay in number order). */
  seq: number;
  jobs: FlushJob[];
  /** The running flush (null: none); a runner that is not this one stops. */
  runner: object | null;
}

const queues = new Map<string, FlushQueue>();
const idle: (() => void)[] = [];

function queueOf(thirdlightDir: string): FlushQueue {
  let q = queues.get(thirdlightDir);
  if (q === undefined) {
    q = { seq: 0, jobs: [], runner: null };
    queues.set(thirdlightDir, q);
  }
  return q;
}

/** The name of a new transaction journal in `.thirdlight/`. */
export function nextJournalName(thirdlightDir: string): string {
  const q = queueOf(thirdlightDir);
  q.seq += 1;
  return `journal-${q.seq}.json`;
}

/** Whether a committed transaction of this project still waits for its flush. */
export function flushPending(thirdlightDir: string): boolean {
  return (queues.get(thirdlightDir)?.jobs.length ?? 0) > 0;
}

/** Whether this journal belongs to a transaction whose flush is under way (not one left by a failure). */
export function journalInFlight(thirdlightDir: string, journal: string): boolean {
  return queues.get(thirdlightDir)?.jobs.some((j) => j.journal === journal) ?? false;
}

/** Queue a committed transaction's flush: its files (absolute), the directories it touched, then its journal's removal. */
export function scheduleFlush(ops: WriteOps, thirdlightDir: string, journal: string, files: Iterable<string>, dirs: Iterable<string>): void {
  const q = queueOf(thirdlightDir);
  q.jobs.push({ journal, files: [...new Set(files)], dirs: [...new Set(dirs)], over: false });
  if (q.runner === null) {
    const token = {};
    q.runner = token;
    void run(ops, thirdlightDir, q, token);
  }
}

/** A path gone since it was written was removed or replaced by a later transaction, whose own journal covers it. */
async function flushOne(ops: WriteOps, path: string): Promise<void> {
  try {
    await ops.flushPath(path);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
}

async function flushAll(ops: WriteOps, paths: readonly string[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const p = paths[next] as string;
      next += 1;
      await flushOne(ops, p);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FLUSH_CONCURRENCY, paths.length) }, worker));
}

async function run(ops: WriteOps, thirdlightDir: string, q: FlushQueue, token: object): Promise<void> {
  try {
    while (q.runner === token && q.jobs.length > 0) {
      const job = q.jobs[0] as FlushJob;
      await flushAll(ops, job.files);
      await flushAll(ops, job.dirs);
      if (job.over || q.runner !== token) return;
      ops.removeFile(join(thirdlightDir, job.journal));
      // Removed for good before the next write may skip the journal: a journal back after a crash would replay over it.
      await flushOne(ops, thirdlightDir);
      if (job.over || q.runner !== token) return;
      q.jobs.shift();
    }
  } catch {
    // An I/O error: the journals stay on disk and are no longer in flight;
    // the next transaction (or the next open) replays them all, oldest first,
    // flushing each file as it goes.
    if (q.runner === token) for (const j of q.jobs.splice(0)) j.over = true;
  } finally {
    if (q.runner === token) q.runner = null;
    wakeIfIdle();
  }
}

function wakeIfIdle(): void {
  for (const q of queues.values()) if (q.jobs.length > 0) return;
  for (const w of idle.splice(0)) w();
}

/**
 * Finish every waiting flush of a project now, blocking (a graceful close or
 * release, where the next owner may open the project right after).
 */
export function settleFlushSync(ops: WriteOps, thirdlightDir: string): void {
  const q = queues.get(thirdlightDir);
  if (q === undefined || q.jobs.length === 0) return;
  q.runner = null;
  for (const job of q.jobs.splice(0)) {
    job.over = true;
    try {
      // `fsyncDir` opens read-only and flushes, which serves a file as well as a directory.
      for (const p of [...job.files, ...job.dirs]) if (ops.fileExists(p) || ops.dirExists(p)) ops.fsyncDir(p);
      ops.removeFile(join(thirdlightDir, job.journal));
      ops.fsyncDir(thirdlightDir);
    } catch {
      // This journal and the later ones stay: the next open replays them in order.
      break;
    }
  }
  wakeIfIdle();
}

/**
 * Stop tracking a project's flushes without finishing them (the process
 * exits, or the project is opened again and replays what is on disk).
 */
export function dropFlushes(thirdlightDir: string): void {
  const q = queues.get(thirdlightDir);
  if (q === undefined) return;
  q.runner = null;
  for (const j of q.jobs.splice(0)) j.over = true;
  wakeIfIdle();
}

/** Resolves once no committed transaction waits for its flush. */
export function whenFlushed(): Promise<void> {
  for (const q of queues.values()) {
    if (q.jobs.length > 0) return new Promise((r) => idle.push(r));
  }
  return Promise.resolve();
}
