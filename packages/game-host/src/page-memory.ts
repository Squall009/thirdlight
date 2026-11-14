/**
 * The resident-bytes report: per entry of the tier's memory budget table
 * (project-model `MEMORY_BUDGET_BY_TIER`), the bytes its system holds now
 * against its budget, and the page and GPU sums against the tier's hardware
 * target. Each number is the system's own count, read where it already is:
 * the voxel streamers' and the physics memory through the threads'
 * resident-bytes registries (the simulation worker posts its reading with
 * each tick), the texture streamer's, the scene streaming's, the probes' and
 * the surface cache's from the adapter's diagnostics, the far field's GPU
 * bytes from the voxel draws. A budget whose system keeps no count on the
 * page reads null, never a guess.
 */
import { MEMORY_BUDGET_BY_TIER, type FrameBudget, type MemoryBudgetEntry } from '@thirdlight/runtime';

type LightingTier = FrameBudget['tier'];
import type { MemoryBudgetId, ResidentReading } from '@thirdlight/shared';

/** One budget's row. */
export interface ProfileMemoryRow {
  readonly id: MemoryBudgetId;
  readonly label: string;
  readonly side: MemoryBudgetEntry['side'];
  /** Bytes held now (null: no count here). */
  readonly resident: number | null;
  /** The budget the system holds to now (the table's, or the project's own where the system reports one). */
  readonly budget: number;
  /** resident ÷ budget (null: no count). */
  readonly use: number | null;
}

/** One side's sums: what is held (of the rows that know), the rows' budgets, the tier's target (null: none of its own yet). */
export interface ProfileMemorySide {
  readonly resident: number;
  readonly budget: number;
  readonly target: number | null;
}

export interface ProfileMemory {
  readonly tier: LightingTier;
  readonly rows: readonly ProfileMemoryRow[];
  readonly page: ProfileMemorySide;
  readonly gpu: ProfileMemorySide;
}

/** The adapter's diagnostics fields the report reads (each absent part reads as no count). */
interface MemoryDiagnostics {
  readonly textures?: { readonly residentBytes?: number; readonly budgetBytes?: number };
  readonly streaming?: { readonly residentBytes?: number; readonly budgetBytes?: number };
  readonly probes?: { readonly textureBytes?: number; readonly budgetBytes?: number };
  readonly surfaceCache?: { readonly usedBytes?: number; readonly budgetBytes?: number };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The report at `tier` from the threads' readings (the page's own and the
 * simulation worker's last), the adapter's diagnostics and the far field's
 * GPU bytes (null: no voxel world drawn).
 */
export function memoryReport(tier: LightingTier, readings: readonly ResidentReading[], diagnostics: unknown, farGpuBytes: number | null): ProfileMemory {
  const d = (diagnostics ?? {}) as MemoryDiagnostics;
  const fromThreads = (id: MemoryBudgetId): number | null => {
    let sum: number | null = null;
    for (const r of readings) {
      const v = num(r[id]);
      if (v !== null) sum = (sum ?? 0) + v;
    }
    return sum;
  };
  const seen: Partial<Record<MemoryBudgetId, { resident: number | null; budget: number | null }>> = {
    voxelStream: { resident: fromThreads('voxelStream'), budget: null },
    physics: { resident: fromThreads('physics'), budget: null },
    farGpu: { resident: farGpuBytes, budget: null },
    textures: { resident: num(d.textures?.residentBytes), budget: num(d.textures?.budgetBytes) },
    worldStream: { resident: num(d.streaming?.residentBytes), budget: num(d.streaming?.budgetBytes) },
    probes: { resident: num(d.probes?.textureBytes), budget: num(d.probes?.budgetBytes) },
    surfaceCache: { resident: num(d.surfaceCache?.usedBytes), budget: num(d.surfaceCache?.budgetBytes) },
  };
  const table = MEMORY_BUDGET_BY_TIER[tier];
  const rows = table.entries.map((e): ProfileMemoryRow => {
    const s = seen[e.id];
    const resident = s?.resident ?? fromThreads(e.id);
    const budget = s?.budget ?? e.bytes;
    return { id: e.id, label: e.label, side: e.side, resident, budget, use: resident !== null && budget > 0 ? resident / budget : null };
  });
  const side = (which: 'page' | 'gpu'): ProfileMemorySide => {
    const of = rows.filter((r) => r.side === which);
    return { resident: of.reduce((n, r) => n + (r.resident ?? 0), 0), budget: of.reduce((n, r) => n + r.budget, 0), target: table.target?.[which] ?? null };
  };
  return { tier, rows, page: side('page'), gpu: side('gpu') };
}
