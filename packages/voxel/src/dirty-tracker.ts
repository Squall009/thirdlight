/**
 * Dirty state and job ids for edited chunks: what keeps an unload, a save
 * and a slow or timed-out worker from losing or resurrecting an edit.
 *
 * - Every edit bumps its chunk's version. A chunk is dirty while its
 *   version is above the version last written to disk.
 * - A save is a job: it snapshots the versions of the chunks it writes and
 *   gets an id. Committing marks only those versions saved, so an edit made
 *   while the job ran stays dirty and goes into the next save.
 * - One save job per file at a time. A job that times out is expired: the
 *   file is free for a new job, and when the late job finishes its commit is
 *   refused (its bytes are older than the newer job's), so it can never
 *   overwrite newer content.
 * - A chunk cannot be unloaded while dirty or while a live save job holds
 *   it (the job's bytes may still be needed if the write fails).
 * - Any other job on a chunk (meshing, collision, lighting) carries the
 *   version it was started from; its result is accepted only while that is
 *   still the chunk's version and the job has not expired.
 */

/** A chunk of a grid: (grid id, chunk key). */
export interface DirtyChunk {
  readonly grid: number;
  readonly key: number;
}

export interface SaveJob {
  readonly id: number;
  readonly file: string;
  /** The chunks and the versions this job writes. */
  readonly chunks: readonly (DirtyChunk & { readonly version: number })[];
}

export interface ChunkJob {
  readonly id: number;
  readonly chunk: DirtyChunk;
  readonly version: number;
}

/** Why a commit or a result was refused. */
export type JobRefusal = 'expired' | 'superseded' | 'unknown_job';

interface ChunkState {
  version: number;
  saved: number;
  /** Live save jobs holding the chunk. */
  holds: number;
}

export class DirtyTracker {
  private readonly chunks = new Map<number, Map<number, ChunkState>>();
  private readonly saves = new Map<number, SaveJob>();
  private readonly fileJob = new Map<string, number>();
  private readonly jobs = new Map<number, ChunkJob>();
  private nextId = 1;

  private state(c: DirtyChunk): ChunkState {
    let g = this.chunks.get(c.grid);
    if (g === undefined) this.chunks.set(c.grid, (g = new Map()));
    let s = g.get(c.key);
    if (s === undefined) g.set(c.key, (s = { version: 0, saved: 0, holds: 0 }));
    return s;
  }

  private peek(c: DirtyChunk): ChunkState | undefined {
    return this.chunks.get(c.grid)?.get(c.key);
  }

  /** Records an edit of a chunk; returns its new version. */
  edited(c: DirtyChunk): number {
    return ++this.state(c).version;
  }

  version(c: DirtyChunk): number {
    return this.peek(c)?.version ?? 0;
  }

  isDirty(c: DirtyChunk): boolean {
    const s = this.peek(c);
    return s !== undefined && s.version > s.saved;
  }

  /** Every dirty chunk. */
  dirty(): DirtyChunk[] {
    const out: DirtyChunk[] = [];
    for (const [grid, m] of this.chunks) for (const [key, s] of m) if (s.version > s.saved) out.push({ grid, key });
    return out;
  }

  /**
   * Starts saving a file holding `chunks` (their versions now are what the
   * job writes); null while another live job saves the same file.
   */
  beginSave(file: string, chunks: readonly DirtyChunk[]): SaveJob | null {
    if (this.fileJob.has(file)) return null;
    const job: SaveJob = { id: this.nextId++, file, chunks: chunks.map((c) => ({ grid: c.grid, key: c.key, version: this.version(c) })) };
    for (const c of chunks) this.state(c).holds++;
    this.saves.set(job.id, job);
    this.fileJob.set(file, job.id);
    return job;
  }

  /** Whether a save job may still commit. */
  isLive(jobId: number): boolean {
    return this.saves.has(jobId);
  }

  /**
   * Commits a live save job: runs `write` (the atomic file replace) and,
   * when it returns true, marks the job's versions saved. A refused,
   * expired or failed job leaves every chunk as dirty as it was.
   */
  commitSave(jobId: number, write: () => boolean): { ok: true } | { ok: false; reason: JobRefusal | 'write_failed' } {
    const job = this.saves.get(jobId);
    if (job === undefined) return { ok: false, reason: 'expired' };
    let written = false;
    try {
      written = write();
    } finally {
      this.release(job);
    }
    if (!written) return { ok: false, reason: 'write_failed' };
    for (const c of job.chunks) {
      const s = this.state(c);
      if (c.version > s.saved) s.saved = c.version;
    }
    return { ok: true };
  }

  /** Gives up on a save job (worker timeout or failure): its file is free again, its commit will be refused. */
  expireSave(jobId: number): void {
    const job = this.saves.get(jobId);
    if (job !== undefined) this.release(job);
  }

  private release(job: SaveJob): void {
    this.saves.delete(job.id);
    if (this.fileJob.get(job.file) === job.id) this.fileJob.delete(job.file);
    for (const c of job.chunks) this.state(c).holds--;
  }

  /** Whether a chunk may be unloaded now (clean, and in no live save job). */
  canUnload(c: DirtyChunk): boolean {
    const s = this.peek(c);
    return s === undefined || (s.version <= s.saved && s.holds === 0);
  }

  /** Forgets a clean chunk's state when it unloads; false (and nothing forgotten) when it may not unload. */
  unload(c: DirtyChunk): boolean {
    if (!this.canUnload(c)) return false;
    this.chunks.get(c.grid)?.delete(c.key);
    return true;
  }

  /** Starts a job on a chunk's current version (meshing, collision, lighting). */
  beginJob(c: DirtyChunk): ChunkJob {
    const job: ChunkJob = { id: this.nextId++, chunk: { grid: c.grid, key: c.key }, version: this.version(c) };
    this.jobs.set(job.id, job);
    return job;
  }

  /** Whether a job's result may be used; the job is finished either way. */
  acceptResult(jobId: number): { ok: true } | { ok: false; reason: JobRefusal } {
    const job = this.jobs.get(jobId);
    if (job === undefined) return { ok: false, reason: 'unknown_job' };
    this.jobs.delete(jobId);
    return job.version === this.version(job.chunk) ? { ok: true } : { ok: false, reason: 'superseded' };
  }

  /** Gives up on a chunk job (timeout): a late result is refused as unknown. */
  expireJob(jobId: number): void {
    this.jobs.delete(jobId);
  }
}
