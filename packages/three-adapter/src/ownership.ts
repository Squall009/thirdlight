/**
 * Resource-ownership ledger (packet 26; three-adapter additions row in
 * dependencies.md §3: "the GLB realization/resource-owner helpers").
 *
 * Every resource this package's visual path can own is counted once when it is
 * allocated and once when it is released, so a disposal test can prove
 * `allocations === releases` after a full teardown (packet-26 acceptance:
 * "Repeated load/reimport/dispose releases owned GPU/CPU/listener resources").
 *
 * Internal module: `OwnershipLedger` is NOT part of the public surface — only
 * the `ResourceOwnership` report type is re-exported by `index.ts`.
 */

/** The resource kinds this package can own along the visual path. */
export const OWNERSHIP_KINDS = [
  /** `BufferGeometry` (shared by every instance of one prepared resource). */
  'geometry',
  /** `Material`, including the preview controller's local override materials. */
  'material',
  /** `Texture` reachable from a material. */
  'texture',
  /** `AnimationMixer` created by a local preview controller. */
  'mixer',
  /** Event/DOM listener owned by this package (or declared by a loader port). */
  'listener',
  /** Object URL created by a loader port (the adapter never creates one). */
  'objectUrl',
  /** A model instance handle. */
  'instance',
] as const;

export type OwnershipKind = (typeof OWNERSHIP_KINDS)[number];

/** Per-kind allocation/release counters. */
export interface OwnershipCounts {
  allocations: number;
  releases: number;
}

/** A full ownership report; `outstanding` is 0 when nothing leaked. */
export interface ResourceOwnership {
  allocations: number;
  releases: number;
  outstanding: number;
  byKind: Readonly<Record<OwnershipKind, OwnershipCounts>>;
}

/** Mutable per-ledger counters. One ledger per prepared visual resource. */
export class OwnershipLedger {
  private readonly counts = new Map<OwnershipKind, OwnershipCounts>();
  private disposed = false;

  private entry(kind: OwnershipKind): OwnershipCounts {
    let c = this.counts.get(kind);
    if (c === undefined) {
      c = { allocations: 0, releases: 0 };
      this.counts.set(kind, c);
    }
    return c;
  }

  /** Record `n` (default 1) newly owned resources of `kind`. */
  allocate(kind: OwnershipKind, n = 1): void {
    if (this.disposed || !Number.isFinite(n) || n <= 0) return;
    this.entry(kind).allocations += Math.floor(n);
  }

  /** Record `n` (default 1) releases; never goes below 0 or above allocations. */
  release(kind: OwnershipKind, n = 1): void {
    if (!Number.isFinite(n) || n <= 0) return;
    const c = this.entry(kind);
    c.releases = Math.min(c.allocations, c.releases + Math.floor(n));
  }

  report(): ResourceOwnership {
    const byKind = {} as Record<OwnershipKind, OwnershipCounts>;
    let allocations = 0;
    let releases = 0;
    for (const kind of OWNERSHIP_KINDS) {
      const c = this.counts.get(kind) ?? { allocations: 0, releases: 0 };
      byKind[kind] = { allocations: c.allocations, releases: c.releases };
      allocations += c.allocations;
      releases += c.releases;
    }
    return { allocations, releases, outstanding: allocations - releases, byKind };
  }
}

/** Sum several reports (the store's aggregate view). */
export function mergeOwnership(reports: readonly ResourceOwnership[]): ResourceOwnership {
  const byKind = {} as Record<OwnershipKind, OwnershipCounts>;
  for (const kind of OWNERSHIP_KINDS) byKind[kind] = { allocations: 0, releases: 0 };
  let allocations = 0;
  let releases = 0;
  for (const r of reports) {
    for (const kind of OWNERSHIP_KINDS) {
      byKind[kind].allocations += r.byKind[kind].allocations;
      byKind[kind].releases += r.byKind[kind].releases;
    }
    allocations += r.allocations;
    releases += r.releases;
  }
  return { allocations, releases, outstanding: allocations - releases, byKind };
}
