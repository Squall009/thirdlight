/**
 * A game's voxel worlds as the simulation hands them to the page.
 *
 * A world runs with the simulation (the worker by default, else the page):
 * its streamer, overlay, derive workers and collision bodies are the
 * runtime's (`VoxelWorldHost`), opened through the ports the play gives
 * (Play: the backend's range route; an export: its content files). These
 * ports are wrapped so that every opened world's chunk draws leave the
 * simulation as batches, one a streamer task (`ChunkDrawBatcher`): a
 * worker posts each batch to the page in one transferred message, a page
 * simulation hands it straight to the page's draws. The page answers with
 * the drawn chunks' GPU bytes (`drawn`), counted in the world's budget,
 * and with what its far draws were seen at (`farSeen`), for the far field's
 * selection. The batches carry the occupancy walk's blocks only while the
 * page has a reader of its GPU walk (`setWalkFeed`): packing them is the
 * simulation thread's work, and with nothing reading them it goes to the
 * derive jobs instead.
 *
 * Every world derives its detail pieces from the build's voxel kits (a
 * material no kit binds draws plain voxel faces): one piece table
 * for all of them, the one the page draws the pieces from. The project's
 * quality levels go with the ports: the level the page reports scales
 * every world's distances and sets its budget; the build's voxel materials
 * go with them too (`ctx.voxels.materialOf`).
 *
 * Structure grids: a world streams each of its structure grids beside its
 * world grid where the project's structure objects place them (the
 * connection's `placements`: Play's world route, an export's catalog), or
 * where a bench's `?voxelGrids=` switch places them (`grids`, by world,
 * over the objects' places for that world), and
 * their draws leave as batches of their own (`gridDrawName`), each carrying
 * where the grid stands. A placement for a grid the world does not list is
 * left out with a warning.
 */
import type { QualityLevelConfig, VoxelMaterialSources, VoxelWorldConnection, VoxelWorldPorts } from '@thirdlight/runtime';
import { ChunkDrawBatcher, GRID_STAMP_URL_PARAM, gridDrawName, gridPlacementProblem, parseGridPlacements, setFineBricks, STRUCTURE_STAMP_RULES, VOXEL_GRIDS_URL_PARAM, type GridPlacement, type StructureStampRule, streamerWalkBlocks, streamerWalkSource, worldPieceTable, type ChunkDrawBatch, type FarSeenWire, type PieceKitSource, type PieceTable, type VoxelStreamer } from '@thirdlight/voxel';

export interface VoxelPresentation {
  /** The ports the runtime opens worlds through. */
  readonly ports: VoxelWorldPorts;
  /** The page's GPU bytes of a world's drawn chunks (`[cx, cy, cz, bytes]` repeated), of its nodes and seams summed, and of the kit meshes and textures. */
  drawn(world: string, bytes: readonly number[], coarse: number, kits: number): void;
  /** A round of a world's far field visibility feedback from the page. */
  farSeen(world: string, seen: FarSeenWire): void;
  /**
   * Fine far bricks on or off for every world, open and to come: the page turns them off when it cannot build them
   * (WebGL 2), so the near field draws its levels 1–2 again instead of nothing past the detail ring.
   */
  setFine(on: boolean): void;
  /**
   * The page's walk feed for every world, open and to come (0: no reader of the page's GPU walk, no walk blocks; another
   * number: the page's feed of that number, which gets every block known, then the changes; ChunkDrawBatcher.setWalkFeed).
   */
  setWalkFeed(feed: number): void;
  /** Where the page's see-through subjects stand (world cells; `n` its number for them): every world answers their rooms (ChunkDrawBatcher.setFocus). */
  setFocus(n: number, cells: readonly number[]): void;
}

/**
 * Wraps a play's world ports so each opened world sends its chunk draws through `send` and derives its pieces from
 * `kits` with the project's piece `seed`; `qualityLevels` the project's (absent: the engine's), `materials` the build's
 * voxel materials (absent: the ports'); `fineBricks` fine far bricks past the detail ring built in every world (the page's
 * bench switch; false: each world's own `fineBuild`, until {@link VoxelPresentation.setFine} says otherwise); `walkFeed`
 * the page's walk feed to start with ({@link VoxelPresentation.setWalkFeed}; 0: off).
 */
export function presentVoxelWorlds(ports: VoxelWorldPorts, send: (b: ChunkDrawBatch) => void, kits: readonly PieceKitSource[], seed: number, qualityLevels?: readonly QualityLevelConfig[], materials?: VoxelMaterialSources, fineBricks = false, walkFeed = 0, grids: ReadonlyMap<string, readonly GridPlacement[]> = new Map(), gridStamp?: StructureStampRule | null): VoxelPresentation {
  const batchers = new Map<string, ChunkDrawBatcher>();
  let walk = walkFeed;
  // The page's last focus: a world opened later answers it too.
  let focus: { readonly n: number; readonly cells: readonly number[] } | null = null;
  const streams = new Map<string, VoxelStreamer>();
  // The page's word over each world's own setting (undefined: the world's).
  let fine: boolean | undefined = fineBricks ? true : undefined;
  let table: PieceTable | null = null;
  const levels = qualityLevels ?? ports.qualityLevels;
  const mats = materials ?? ports.materials;
  return {
    ports: {
      ...(levels !== undefined ? { qualityLevels: levels } : {}),
      ...(mats !== undefined ? { materials: mats } : {}),
      open: async (world: string): Promise<VoxelWorldConnection> => {
        const conn = await ports.open(world);
        // A world reopened while this connection still opened (a scene reload) has its own batcher under
        // the same name: this connection closes only the one it made.
        let mine: ChunkDrawBatcher | null = null;
        const gridBatchers: Array<[string, ChunkDrawBatcher]> = [];
        const placed = await Promise.all(
          (grids.get(world) ?? conn.placements ?? []).map(async (place) => {
            const g = (await conn.openGrid?.(place.gridId)) ?? null;
            if (g === null) console.warn(`[voxels] world ${world} lists no structure grid ${place.gridId}: its placement is left out`);
            return g === null ? null : { place, source: g.source, extent: g.extent };
          }),
        );
        return {
          grid: conn.grid,
          worldId: conn.worldId,
          source: conn.source,
          pool: conn.pool,
          ...(conn.budgetBytes !== undefined ? { budgetBytes: conn.budgetBytes } : {}),
          ...(conn.far !== undefined ? { far: conn.far } : {}),
          get fineBricks() {
            return fine;
          },
          pieces: (table ??= worldPieceTable(kits, seed)),
          grids: placed.filter((g) => g !== null),
          ...(gridStamp !== undefined ? { gridStamp } : {}),
          presentGrid: (place, stream, sectionEdge) => {
            // A grid's draws: no walk blocks, sky heights or rooms (the world grid's alone feed the page's lighting).
            const name = gridDrawName(world, place.gridId);
            const b = new ChunkDrawBatcher(name, stream, sectionEdge, send, { place: { world, grid: place.gridId, position: place.position, yawRad: place.yawRad } });
            gridBatchers.push([name, b]);
            batchers.set(name, b);
          },
          present: (stream, sectionEdge, regions, props) => {
            conn.present?.(stream, sectionEdge, regions, props);
            // The batches carry the walk's blocks for the page's GPU walk while it has a reader (levels 0 and up; the far
            // field stays the CPU's; the lit props in the light stop, each change of theirs a block's change) and the sky
            // heights the open regions found, for lighting on the page.
            // And the rooms the page's see-through subjects stand in, as the regions answer them.
            const batcher = new ChunkDrawBatcher(world, stream, sectionEdge, send, { walk: { source: streamerWalkSource(stream, null, { props: props ?? null }), blocks: () => streamerWalkBlocks(stream) }, walkFeed: walk, ...(regions !== undefined ? { sky: regions, rooms: regions } : {}) });
            if (focus !== null) batcher.setFocus(focus.n, focus.cells);
            // A structure stamp's change, or a shut door's, is one at the mip levels too (its stopping cells stop light there).
            const levels = stream.mips?.maxLevel ?? 0;
            props?.listen((cx, cy, cz, classes, mips) => {
              batcher.walkChanged(0, cx, cy, cz);
              if (classes || mips) for (let l = 1; l <= levels; l++) batcher.walkChanged(l, cx >> l, cy >> l, cz >> l);
            });
            mine = batcher;
            batchers.set(world, mine);
            streams.set(world, stream);
          },
          close: () => {
            for (const [name, b] of gridBatchers.splice(0)) {
              b.close();
              if (batchers.get(name) === b) batchers.delete(name);
            }
            mine?.close();
            if (mine !== null && batchers.get(world) === mine) {
              batchers.delete(world);
              streams.delete(world);
            }
            mine = null;
            conn.close?.();
          },
        };
      },
    },
    drawn: (world, bytes, coarse, kits) => batchers.get(world)?.drawn(bytes, coarse, kits),
    farSeen: (world, seen) => batchers.get(world)?.farSeen(seen),
    setFine: (on) => {
      if (on === fine) return;
      fine = on;
      for (const s of streams.values()) setFineBricks(s, on);
    },
    setWalkFeed: (feed) => {
      walk = feed;
      for (const b of batchers.values()) b.setWalkFeed(feed);
    },
    setFocus: (n, cells) => {
      focus = { n, cells: [...cells] };
      for (const b of batchers.values()) b.setFocus(n, cells);
    },
  };
}

/**
 * The structure grids' placements a page's query names (`?voxelGrids=`, parseGridPlacements' text: a bench's
 * switch), by world; none when absent. A malformed one is refused whole, with a warning.
 */
export function gridPlacementsFromUrl(search: string): Map<string, GridPlacement[]> {
  const text = new URLSearchParams(search).get(VOXEL_GRIDS_URL_PARAM);
  if (text === null) return new Map();
  try {
    return parseGridPlacements(text);
  } catch (e) {
    console.warn(`[voxels] ?${VOXEL_GRIDS_URL_PARAM}= refused: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}

/**
 * How a page's query says structure grids are stamped into their worlds (`?gridStamp=`: a rule of
 * {@link STRUCTURE_STAMP_RULES}, or `off`; a bench's comparison): undefined when absent or not one of them (the
 * world's default).
 */
export function gridStampFromUrl(search: string): StructureStampRule | null | undefined {
  const v = new URLSearchParams(search).get(GRID_STAMP_URL_PARAM);
  if (v === 'off') return null;
  return (STRUCTURE_STAMP_RULES as readonly string[]).includes(v ?? '') ? (v as StructureStampRule) : undefined;
}

/** Placements as the page posts them to its simulation worker (checked again there). */
export function gridPlacementsOf(list: unknown): Map<string, GridPlacement[]> {
  const out = new Map<string, GridPlacement[]>();
  if (!Array.isArray(list)) return out;
  for (const e of list as Array<{ world?: unknown; places?: unknown }>) {
    if (typeof e?.world !== 'string' || !Array.isArray(e.places)) continue;
    const ok = (e.places as unknown[]).filter((p): p is GridPlacement => gridPlacementProblem(p) === null);
    if (ok.length > 0) out.set(e.world, ok);
  }
  return out;
}
