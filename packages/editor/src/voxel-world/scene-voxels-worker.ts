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
 */
import { ChunkDrawBatcher, chunkDrawBatchTransfer, chunkKey, VOXEL_SIZE_M, worldPieceTable, worldStreamer, type ChunkCoord, type VoxelStreamer } from '@thirdlight/voxel';
import { RangeWorld, type WorldChange } from './range-world';
import type { SceneVoxelsIn, SceneVoxelsOut } from './scene-voxels-wire';

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
}

const scope = self as unknown as { postMessage(m: SceneVoxelsOut, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<SceneVoxelsIn>) => void) | null };
const post = (m: SceneVoxelsOut, transfer: Transferable[] = []): void => scope.postMessage(m, transfer);
const worlds = new Map<string, Streamed>();
/** The view's focus in cells (where it looks). */
let focus: { x: number; y: number; z: number } | null = null;

function kick(w: Streamed): void {
  const k = w.kick;
  w.kick = null;
  k?.();
}

async function stream(w: Streamed, streamer: VoxelStreamer): Promise<void> {
  while (!w.closed) {
    try {
      await streamer.settle();
    } catch (e) {
      post({ t: 'problem', world: w.name, message: e instanceof Error ? e.message : String(e) });
    }
    if (w.closed) return;
    post({ t: 'state', world: w.name, revision: w.world!.revision, resident: w.resident.size, settled: true, bytes: streamer.metrics().bytes.total });
    await new Promise<void>((ok) => (w.kick = ok));
  }
}

/** A change the backend applied: the next revision is read in place; a gap (a change missed) reads the world again. */
async function change(w: Streamed, c: WorldChange): Promise<void> {
  const world = w.world!;
  const streamer = w.streamer!;
  if (c.revision <= world.revision) return;
  if (c.revision === world.revision + 1) world.applyChange(streamer, c);
  else {
    const why = await world.readAgain(streamer, w.resident.values());
    if (why !== null) post({ t: 'problem', world: w.name, message: why });
  }
  kick(w);
}

async function open(m: Extract<SceneVoxelsIn, { t: 'open' }>): Promise<void> {
  const w: Streamed = { name: m.world, world: null, streamer: null, batcher: null, resident: new Map(), early: [], relief: null, kits: null, closed: false, kick: null };
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
  const streamer = worldStreamer({ grid: world.grid, source: world.source, pool: world.pool, pieces: worldPieceTable(kits.kits, kits.pieceSeed) }, m);
  w.world = world;
  w.streamer = streamer;
  streamer.on((e) => {
    if (e.type === 'loaded') w.resident.set(chunkKey(world.grid, e.cx, e.cy, e.cz), { cx: e.cx, cy: e.cy, cz: e.cz });
    else if (e.type === 'unloaded') w.resident.delete(chunkKey(world.grid, e.cx, e.cy, e.cz));
  });
  if (w.relief !== null) streamer.relief?.set(w.relief.ring);
  w.batcher = new ChunkDrawBatcher(m.world, streamer, m.sectionEdge, (batch) => post({ t: 'batch', batch }, chunkDrawBatchTransfer(batch)));
  if (focus !== null) streamer.setFocus(focus.x, focus.y, focus.z);
  void stream(w, streamer);
  for (const c of w.early.splice(0)) await change(w, c);
}

function close(name: string): void {
  const w = worlds.get(name);
  if (w === undefined) return;
  worlds.delete(name);
  w.closed = true;
  w.batcher?.close();
  w.world?.pool.close();
  kick(w);
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
      const f = { x: Math.floor(m.x / VOXEL_SIZE_M), y: Math.floor(m.y / VOXEL_SIZE_M), z: Math.floor(m.z / VOXEL_SIZE_M) };
      focus = f;
      for (const w of worlds.values()) {
        if (w.streamer === null) continue;
        w.streamer.setFocus(f.x, f.y, f.z);
        kick(w);
      }
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
    case 'drawn':
      worlds.get(m.world)?.batcher?.drawn(m.bytes, m.coarse, m.kits);
      break;
    case 'kits': {
      const w = worlds.get(m.world);
      if (w === undefined) break;
      if (w.streamer === null) {
        w.kits = m;
        post({ t: 'kits', world: m.world, group: 0 });
        break;
      }
      const { group } = w.streamer.pieces.set(worldPieceTable(m.kits, m.pieceSeed));
      post({ t: 'kits', world: m.world, group });
      kick(w);
      break;
    }
  }
};
