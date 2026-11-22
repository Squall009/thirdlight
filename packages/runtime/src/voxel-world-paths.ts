/**
 * A voxel world's path and reach queries where it runs: the world grid's walk
 * graph's queries (walk-graph-queries.ts) and, once the world has structure
 * grids, each grid's own walk graph (voxel-grid-host.ts) linked to the
 * world's at its doorsteps and foundation edges (walk-graph-links.ts), a path
 * between them joined at a link (walk-graph-linked.ts). With no grid it is
 * the world's queries alone, as before.
 *
 * The grids' graphs and their links are kept in what the derive slice leaves
 * after the world's graph; their bytes count in the walk graph's budget row.
 */
import { LinkedWalkQueries, WalkGraphLinks, WalkQueries, type WalkGraph, type WalkQueryOptions, type WalkReachAnswer } from '@thirdlight/voxel';

import type { VoxelPathAnswer } from './voxel-api';
import type { VoxelGridHost } from './voxel-grid-host';
import { voxelLinkedPathAnswer, voxelPathAnswer } from './voxel-paths';

/** The grids' walk graphs summed, and their links (diagnostics). */
export interface GridWalkStats {
  readonly chunks: number;
  readonly cells: number;
  readonly pieces: number;
  readonly exits: number;
  readonly buildMs: number;
  /** Grids whose graph has chunks to make. */
  readonly pending: number;
  readonly bytes: number;
  readonly links: number;
  readonly linkChunksMade: number;
  readonly linkMs: number;
}

export class WorldPaths {
  readonly queries: WalkQueries;
  private grids: readonly VoxelGridHost[] = [];
  private links: WalkGraphLinks | null = null;
  private linked: LinkedWalkQueries | null = null;

  constructor(readonly walk: WalkGraph) {
    this.queries = new WalkQueries(walk);
  }

  /** The world's structure grids: their graphs linked to the world's (none: nothing is made). */
  linkGrids(grids: readonly VoxelGridHost[]): void {
    if (grids.length === 0) return;
    this.grids = grids;
    const links = new WalkGraphLinks(this.walk);
    for (const g of grids) links.add({ id: g.frame.gridId, frame: g.frame, graph: g.walk });
    this.links = links;
    this.linked = new LinkedWalkQueries(this.queries, links);
  }

  /** A path between two world cells, answered as a script reads it (`answered`) once served. */
  path(id: number, world: string, from: readonly [number, number, number], to: readonly [number, number, number], options: WalkQueryOptions, answered: (a: VoxelPathAnswer) => void): void {
    if (this.linked !== null) this.linked.path(from, to, options, (w) => answered(voxelLinkedPathAnswer(id, world, w)));
    else this.queries.path(from, to, options, (w) => answered(voxelPathAnswer(id, world, w)));
  }

  /** The places within a cost of a world cell (the world grid's alone). */
  reach(from: readonly [number, number, number], maxCost: number, options: WalkQueryOptions & { readonly cells?: boolean }, done: (a: WalkReachAnswer) => void): void {
    this.queries.reach(from, maxCost, options, done);
  }

  /** Serves the queries in order within `ms` (the grids' legs after the world's). */
  serve(ms: number): void {
    (this.linked ?? this.queries).serve(ms);
  }

  /** Queries waiting (the grids' legs included). */
  get queued(): number {
    return (this.linked ?? this.queries).queued;
  }

  /** The grids' graphs, then their links, in `ms` (at least one unit when any waits). */
  update(ms: number): void {
    const links = this.links;
    if (links === null) return;
    const t0 = performance.now();
    let units = 0;
    for (const g of this.grids) {
      if (!g.walk.pending) continue;
      if (units > 0 && performance.now() - t0 >= ms) return;
      units += g.walk.update(ms - (performance.now() - t0));
    }
    if (links.pending && (units === 0 || performance.now() - t0 < ms)) links.update(ms - (performance.now() - t0));
  }

  /** Whether the grids' graphs or links have work waiting. */
  get pending(): boolean {
    if (this.links === null) return false;
    if (this.links.pending) return true;
    for (const g of this.grids) if (g.walk.pending) return true;
    return false;
  }

  /** Bytes the world's searches and, with grids, the grids' graphs, links and searches hold (the world's graph is its own row). */
  get bytes(): number {
    let b = this.queries.bytes;
    if (this.links === null) return b;
    b += this.links.bytes + this.linked!.bytes;
    for (const g of this.grids) b += g.walk.bytes;
    return b;
  }

  /** The grids' graphs and links (null: no grid). */
  gridStats(): GridWalkStats | null {
    if (this.links === null) return null;
    let chunks = 0;
    let cells = 0;
    let pieces = 0;
    let exits = 0;
    let buildMs = 0;
    let pending = 0;
    let bytes = this.links.bytes + this.linked!.bytes;
    for (const g of this.grids) {
      const st = g.walk.stats();
      chunks += st.chunks;
      cells += st.cells;
      pieces += st.pieces;
      exits += st.exits;
      buildMs += st.buildMs + st.pairMs;
      bytes += g.walk.bytes;
      if (g.walk.pending) pending++;
    }
    const l = this.links.stats();
    return { chunks, cells, pieces, exits, buildMs: Math.round(buildMs * 100) / 100, pending, bytes, links: l.links, linkChunksMade: l.made, linkMs: Math.round(l.ms * 100) / 100 };
  }

  /** Every query answered with what it has (unknown): a new run, or the world gone. */
  clear(): void {
    this.linked?.clear();
    this.queries.clear();
  }
}
