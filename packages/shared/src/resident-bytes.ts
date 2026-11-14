/**
 * Resident bytes by memory budget: what each system that keeps memory against
 * a budget holds now, read by the one memory report (the profiler's Memory
 * table). A system registers a reader of its own existing count under its
 * budget's id; nothing is counted a second way. The budgets themselves are
 * project-model's table (`MEMORY_BUDGET_BY_TIER`), each entry the constant
 * its system already had.
 *
 * One registry per thread (each page and worker has its own copy of this
 * module): the simulation worker posts its registry's reading with each
 * tick's frame, and the page's report adds it to the page's own.
 */

/** The memory budgets the report knows, in the table's order. */
export const MEMORY_BUDGET_IDS = ['voxelStream', 'physics', 'farSelection', 'sceneObjects', 'farGpu', 'textures', 'worldStream', 'surfaceCache', 'probes', 'undo'] as const;
export type MemoryBudgetId = (typeof MEMORY_BUDGET_IDS)[number];

/** Bytes a system holds now (null: not known now). */
export type ResidentReader = () => number | null;

/** Bytes resident by budget, as a thread reads them (an id without a reader that knows is left out). */
export type ResidentReading = Partial<Record<MemoryBudgetId, number>>;

export class ResidentBytes {
  private readonly readers = new Map<MemoryBudgetId, Set<ResidentReader>>();

  /** Count what `read` returns under `id` (several systems of one budget add up: two voxel worlds); returns the unregister. */
  register(id: MemoryBudgetId, read: ResidentReader): () => void {
    let set = this.readers.get(id);
    if (set === undefined) this.readers.set(id, (set = new Set()));
    set.add(read);
    return () => {
      set.delete(read);
      if (set.size === 0) this.readers.delete(id);
    };
  }

  /** Each budget's bytes now, summed over its readers that know (a reader that throws counts as not knowing). */
  read(): ResidentReading {
    const out: ResidentReading = {};
    for (const [id, set] of this.readers) {
      let sum = 0;
      let known = false;
      for (const r of set) {
        let v: number | null;
        try {
          v = r();
        } catch {
          v = null;
        }
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          sum += v;
          known = true;
        }
      }
      if (known) out[id] = sum;
    }
    return out;
  }
}

/** This thread's registry. */
export const residentBytes = new ResidentBytes();
