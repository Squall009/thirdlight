/**
 * The editor Scene view's voxel worlds, streamed off the page's thread: a
 * world named by a `voxelWorld` object in the open scenes is opened from
 * the backend's voxel route (its region files read by range), streamed
 * around where the view looks, decoded and derived in module workers this
 * worker starts, and each streamer task's chunk draws go to the page as one
 * transferred batch (the batcher Play's simulation uses), drawn there by the
 * same chunk views. Nothing collides: the editor has no bodies.
 *
 * Edits reach the files through the command route (the editor's, MCP's);
 * the editor feed's `voxelsChanged` comes here, and the chunks it names are
 * read again and swap in together. A revision missed (the feed is best
 * effort) or files changed behind the backend: the world is read again whole.
 * A kit or piece seed change sets the streamer's piece table, which derives
 * again only the chunks whose pieces it changes, swapping in as one group.
 *
 * Streaming runs while there is work (the streamer's `settle`) and waits
 * for the next focus move or change once everything around the focus is
 * drawn, so an idle view costs nothing here.
 *
 * A world's structure grids stream beside it where the page says their
 * objects place them (scene-voxels-grids.ts); a change naming a grid's
 * chunks reads only those again. A pick walks every world and its grids,
 * each grid in its own frame (`walkWithGrids`).
 */
import { ChunkDrawBatcher, chunkDrawBatchTransfer, chunkKey, streamerWalkSource, VOXEL_SIZE_M, walkRay, walkWithGrids, worldPieceTable, worldStreamer, type ChunkCoord, type GridPlacement, type PieceKitSource, type VoxelStreamer, type WalkSource } from '@thirdlight/voxel';
import { RangeWorld, type WorldChange } from './range-world';
import { SceneGridStream } from './scene-voxels-grids';
import { CELL_NOT_LOADED, type SceneVoxelsIn, type SceneVoxelsOut } from './scene-voxels-wire';

interface Streamed {
  readonly name: string;
  world: RangeWorld | null;
  streamer: VoxelStreamer | null;
  batcher: ChunkDrawBatcher | null;
  readonly resident: Map<number, ChunkCoord>;
  /** Changes that arrived while the world opened. */
  readonly early: WorldChange[];
  /** A relief ring that arrived while the world opened (it opens with it). */
  relief: Extract<SceneVoxelsIn, { t: 'relief' }> | null;
  /** Kits that arrived while the world opened (it opens with these). */
  kits: Extract<SceneVoxelsIn, { t: 'kits' }> | null;
  closed: boolean;
  /** Wakes the streaming loop (a focus move, a change). */
  kick: (() => void) | null;
  /** The open message (what a grid streams with too) and the kits it derives with now. */
  open: Extract<SceneVoxelsIn, { t: 'open' }> | null;
  pieces: { readonly kits: readonly PieceKitSource[]; readonly seed: number };
  /** Where the page places the world's grids (by id), and those streamed (a grid opening is a promise until it is). */
  places: Map<number, GridPlacement>;
  readonly grids: Map<number, SceneGridStream | Promise<SceneGridStream | null>>;
  /** The world's cells as a pick walks them (made with the streamer). */
  walk: WalkSource | null;
  settled: boolean;
}

const scope = self as unknown as { postMessage(m: SceneVoxelsOut, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<SceneVoxelsIn>) => void) | null };
const post = (m: SceneVoxelsOut, transfer: Transferable[] = []): void => scope.postMessage(m, transfer);
const worlds = new Map<string, Streamed>();
/** The view's focus in cells (where it looks). */
let focus: { x: number; y: number; z: number; m: readonly [number, number, number] } | null = null;

function kick(w: Streamed): void {
  const k = w.kick;
  w.kick = null;
  k?.();
}

/** What a world holds and whether it and its grids are settled (tests and the status read it). */
function postState(w: Streamed): void {
  if (w.closed || w.world === null || w.streamer === null) return;
  const grids: Record<string, { resident: number; settled: boolean }> = {};
  for (const g of w.grids.values()) if (g instanceof SceneGridStream) grids[g.name] = { resident: g.streamer.metrics().resident, settled: g.settled };
  post({ t: 'state', world: w.name, revision: w.world.revision, resident: w.resident.size, settled: w.settled, bytes: w.streamer.metrics().bytes.total, ...(w.grids.size > 0 ? { grids } : {}) });
}

async function stream(w: Streamed, streamer: VoxelStreamer): Promise<void> {
  while (!w.closed) {
    try {
      await streamer.settle();
    } catch (e) {
      post({ t: 'problem', world: w.name, message: e instanceof Error ? e.message : String(e) });
    }
    if (w.closed) return;
    w.settled = true;
    postState(w);
    await new Promise<void>((ok) => (w.kick = ok));
    w.settled = false;
  }
}

/** Opens grid `id` of `w` where it is placed (null: the world lists no files for it yet; a change naming them opens it). */
async function openGrid(w: Streamed, place: GridPlacement): Promise<SceneGridStream | null> {
  const world = w.world!;
  const opened = await world.openGrid(place.gridId);
  if (opened === null || opened.extent === null || w.closed || w.places.get(place.gridId) === undefined) return null;
  const g = new SceneGridStream(world, w.name, w.places.get(place.gridId)!, opened.source, opened.extent, w.open!, { tracker: w.streamer!.tracker, pieces: worldPieceTable(w.pieces.kits, w.pieces.seed) }, (batch) => post({ t: 'batch', batch }, chunkDrawBatchTransfer(batch)), () => postState(w));
  if (focus !== null) g.focus(focus.m[0], focus.m[1], focus.m[2]);
  return g;
}

/** The grids the page places are streamed, those it no longer places closed; `again`: these are opened again whatever they were. */
function syncGrids(w: Streamed, again: ReadonlySet<number> = new Set()): void {
  if (w.world === null || w.streamer === null) return;
  for (const [id, g] of [...w.grids]) {
    if (w.places.has(id) && !again.has(id)) continue;
    w.grids.delete(id);
    void Promise.resolve(g).then((s) => s?.close());
  }
  for (const [id, place] of w.places) {
    const had = w.grids.get(id);
    if (had instanceof SceneGridStream) {
      had.place(place);
      if (focus !== null) had.focus(focus.m[0], focus.m[1], focus.m[2]);
      continue;
    }
    if (had !== undefined) continue;
    const p = openGrid(w, place);
    w.grids.set(id, p);
    void p.then((g) => {
      if (w.grids.get(id) !== p) return void g?.close();
      if (g === null) w.grids.delete(id);
      else w.grids.set(id, g);
      postState(w);
    });
  }
  postState(w);
}

/** A change the backend applied: the next revision is read in place; a gap (a change missed) reads the world again. */
async function change(w: Streamed, c: WorldChange): Promise<void> {
  const world = w.world!;
  const streamer = w.streamer!;
  if (c.revision <= world.revision) return;
  if (c.revision === world.revision + 1) {
    world.applyChange(streamer, c);
    // A grid's chunks are read again in place; one the change reaches past (a taller house) or not open yet opens again.
    const again = new Set<number>();
    for (const { grid, chunks } of c.grids ?? []) {
      const g = w.grids.get(grid);
      if (g instanceof SceneGridStream && g.covers(chunks)) g.changed(chunks, c.parts, c.materialSwaps);
      else again.add(grid);
    }
    if (again.size > 0) syncGrids(w, again);
  } else {
    const why = await world.readAgain(streamer, w.resident.values());
    if (why !== null) post({ t: 'problem', world: w.name, message: why });
    syncGrids(w, new Set(w.grids.keys()));
  }
  kick(w);
}

async function open(m: Extract<SceneVoxelsIn, { t: 'open' }>): Promise<void> {
  const w: Streamed = { name: m.world, world: null, streamer: null, batcher: null, resident: new Map(), early: [], relief: null, kits: null, closed: false, kick: null, open: m, pieces: { kits: m.kits, seed: m.pieceSeed }, places: new Map(), grids: new Map(), walk: null, settled: false };
  worlds.set(m.world, w);
  let world: RangeWorld;
  try {
    world = await RangeWorld.open({ url: m.url, headers: m.headers, workerUrl: m.workerUrl, workerName: `thirdlight-voxels ${m.world}` });
  } catch (e) {
    post({ t: 'problem', world: m.world, message: `could not be opened: ${e instanceof Error ? e.message : String(e)}` });
    return;
  }
  if (w.closed) {
    world.pool.close();
    return;
  }
  // The project's kits and piece seed: the table the page draws the pieces from too.
  const kits = w.kits ?? m;
  w.pieces = { kits: kits.kits, seed: kits.pieceSeed };
  const streamer = worldStreamer({ grid: world.grid, source: world.source, pool: world.pool, pieces: worldPieceTable(kits.kits, kits.pieceSeed), far: world.far }, m);
  w.world = world;
  w.streamer = streamer;
  w.walk = streamerWalkSource(streamer, null);
  streamer.on((e) => {
    if (e.type === 'loaded') w.resident.set(chunkKey(world.grid, e.cx, e.cy, e.cz), { cx: e.cx, cy: e.cy, cz: e.cz });
    else if (e.type === 'unloaded') w.resident.delete(chunkKey(world.grid, e.cx, e.cy, e.cz));
  });
  if (w.relief !== null) streamer.relief?.set(w.relief.ring);
  w.batcher = new ChunkDrawBatcher(m.world, streamer, m.sectionEdge, (batch) => post({ t: 'batch', batch }, chunkDrawBatchTransfer(batch)));
  if (focus !== null) streamer.setFocus(focus.x, focus.y, focus.z);
  void stream(w, streamer);
  syncGrids(w);
  for (const c of w.early.splice(0)) await change(w, c);
}

function close(name: string): void {
  const w = worlds.get(name);
  if (w === undefined) return;
  worlds.delete(name);
  w.closed = true;
  for (const g of w.grids.values()) void Promise.resolve(g).then((s) => s?.close());
  w.grids.clear();
  w.batcher?.close();
  w.world?.pool.close();
  kick(w);
}

/** The nearest stop of a ray through every world and its grids (each grid in its own frame). */
function pick(m: Extract<SceneVoxelsIn, { t: 'pick' }>): Extract<SceneVoxelsOut, { t: 'picked' }>['hit'] {
  const ray = walkRay([m.origin[0], m.origin[1], m.origin[2]], [m.dir[0], m.dir[1], m.dir[2]]);
  if (ray === null) return null;
  let best: Extract<SceneVoxelsOut, { t: 'picked' }>['hit'] = null;
  for (const w of worlds.values()) {
    if (w.walk === null) continue;
    const grids = [...w.grids.values()].filter((g): g is SceneGridStream => g instanceof SceneGridStream).map((g) => g.walk());
    const h = walkWithGrids(w.walk, grids, ray, best?.t ?? m.maxM, { far: false });
    if (h !== null && (best === null || h.t < best.t)) best = { world: w.name, grid: h.gridId, t: h.t, cell: h.hit.cell, normal: h.hit.normal, record: h.hit.record };
  }
  return best;
}

/** A box of a world's own cells as the pick's walk reads them (null: the world is not open here). */
function cells(m: Extract<SceneVoxelsIn, { t: 'cells' }>): Uint32Array | null {
  const record = worlds.get(m.world)?.walk?.record;
  if (record === undefined) return null;
  const [x0, y0, z0] = m.min;
  const [x1, y1, z1] = m.max;
  const out = new Uint32Array(Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) * Math.max(0, z1 - z0 + 1));
  let i = 0;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) out[i++] = record(x, y, z) ?? CELL_NOT_LOADED;
  return out;
}

scope.onmessage = (e) => {
  const m = e.data;
  switch (m.t) {
    case 'open':
      close(m.world);
      void open(m);
      break;
    case 'close':
      close(m.world);
      break;
    case 'focus': {
      const f = { x: Math.floor(m.x / VOXEL_SIZE_M), y: Math.floor(m.y / VOXEL_SIZE_M), z: Math.floor(m.z / VOXEL_SIZE_M), m: [m.x, m.y, m.z] as const };
      focus = f;
      for (const w of worlds.values()) {
        if (w.streamer === null) continue;
        w.streamer.setFocus(f.x, f.y, f.z);
        for (const g of w.grids.values()) if (g instanceof SceneGridStream) g.focus(m.x, m.y, m.z);
        kick(w);
      }
      break;
    }
    case 'grids': {
      const w = worlds.get(m.world);
      if (w === undefined) break;
      w.places = new Map(m.places.map((p) => [p.gridId, p]));
      syncGrids(w);
      break;
    }
    case 'pick':
      post({ t: 'picked', id: m.id, hit: pick(m) });
      break;
    case 'cells': {
      const values = cells(m);
      post({ t: 'cells', id: m.id, values }, values === null ? [] : [values.buffer]);
      break;
    }
    case 'changed': {
      const w = worlds.get(m.world);
      if (w === undefined) break;
      if (w.streamer === null) w.early.push(m.change);
      else void change(w, m.change);
      break;
    }
    case 'relief': {
      const w = worlds.get(m.world);
      if (w === undefined) break;
      if (w.streamer === null) w.relief = m;
      else {
        w.streamer.relief?.set(m.ring);
        kick(w);
      }
      break;
    }
    case 'drawn': {
      const w = worlds.get(m.world);
      if (w !== undefined) w.batcher?.drawn(m.bytes, m.coarse, m.kits);
      // A grid's draws report under its draw name.
      else for (const v of worlds.values()) for (const g of v.grids.values()) if (g instanceof SceneGridStream && g.name === m.world) g.batcher.drawn(m.bytes, m.coarse, m.kits);
      break;
    }
    case 'kits': {
      const w = worlds.get(m.world);
      if (w === undefined) break;
      if (w.streamer === null) {
        w.kits = m;
        post({ t: 'kits', world: m.world, group: 0 });
        break;
      }
      const { group } = w.streamer.pieces.set(worldPieceTable(m.kits, m.pieceSeed));
      w.pieces = { kits: m.kits, seed: m.pieceSeed };
      for (const g of w.grids.values()) if (g instanceof SceneGridStream) g.setPieces(worldPieceTable(m.kits, m.pieceSeed));
      post({ t: 'kits', world: m.world, group });
      kick(w);
      break;
    }
  }
};
