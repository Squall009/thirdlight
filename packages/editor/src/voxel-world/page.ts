/**
 * The voxel world page (`/voxel-world.html?project=…&world=…&at=x,y,z`):
 * a project's voxel world streamed from the backend's region-file range
 * route, decoded and derived in module workers by the streaming core, drawn
 * through the engine's renderer factory (WebGPU, or `?renderer=webgl2`),
 * and edited by sending voxel commands to the backend.
 *
 * The page never writes a file and never applies an edit itself: it sends
 * the stroke as a command, and when the backend answers with the chunks the
 * command changed, it reads those chunks again (the region files now hold
 * the edit) and the streamer swaps them in and rebuilds everything within
 * the rules' dependency radius. Reloading the page reads the same files.
 * When the backend refuses a command because someone else changed the
 * files (`world_changed`), the page reads every chunk it holds again and
 * says so in its status line; the edit is not resent for the user.
 *
 * Drag to orbit, wheel to zoom, W A S D to move; click digs a 1 m sphere,
 * shift-click adds one of the material picked bottom left (the project's
 * voxel materials only, page-materials.ts), Z undoes the newest edit. `window.__tlVoxelWorld`
 * is the hook a test or a measuring run drives.
 *
 * Every storage chunk within the collision ring around the camera's target
 * (the engine's default, 48 m around and 24 m up and down, collision-ring.ts)
 * also becomes one static body in the engine's physics backend
 * (`?collision=0` leaves physics out; `?heightfields=0` keeps all ground as
 * meshes, `?heightfields=level` only level ground as heightfields;
 * `?collisionRing=0` gives every resident chunk a body, to compare),
 * replaced when one of its sections is derived again; the hook drops
 * capsules and sweeps spheres against it and reports, per cell, what every
 * consumer of the derived data received.
 *
 * Everything is derived per section of `?section=` cells (8, 16 or 32, the
 * whole chunk; default the engine's {@link DEFAULT_SECTION_EDGE}): an edit
 * re-derives only the sections within the rules' reach of what it changed,
 * and they swap in together (the streamer's atomic swap). Draws are one
 * object a storage chunk, the chunk's sections joined (the adapter's chunk
 * view, as Play and exports draw), and so are bodies, built from the same
 * join in the same task. A swap's draws and bodies change in the same frame. The hook's
 * `blast` digs a sphere either through the backend (a command) or locally
 * in the streamer's runtime overlay (a game's runtime edit, no round trip,
 * nothing saved) and reports the frames from the edit to the swap; `reread`
 * drops local edits and goes back to the files.
 *
 * Surfaces are shaded by the engine's voxel surface shader from each
 * chunk's shader data: `?blend=` sets the blend distance in metres (default
 * a quarter metre, half a cell), `?shading=flat` draws one colour with no texture
 * reads (to measure what the blend costs), `?gpuTime=1` records GPU
 * timestamps where the device has them, `?sun=` sets the sun's elevation in degrees.
 * Each material's look comes from its material record (colour, tile,
 * relief depth; ids without one their stand-in), and its surfaces' texture
 * sets from the texture arrays the backend assembles of every voxel
 * material's sets (page-materials.ts); `?patterns=1` draws the test
 * patterns instead (the debug program, no arrays).
 *
 * Detail pieces are the project's voxel kits with its piece seed (read
 * through the command route, their GLBs from the backend), through the one
 * piece table the streamer derives with; a material no kit binds draws
 * plain voxel edges. `?kits=0` derives without a table (no pieces at all,
 * to compare).
 *
 * `?kitScene=x,y,z,material` writes the kit test scene there (every case of
 * the catalogue built from voxels, `writeKitTestScene`: the same command MCP
 * sends; a scene already there is left as it is) and labels each exhibit
 * with its role and case.
 */
import * as THREE from 'three';
import {
  canonicalEditCommand,
  ChunkDrawBatcher,
  chunkGrid,
  DEFAULT_LEVEL_RINGS,
  editBounds,
  chunkKey,
  type CellBox,
  createWorldStore,
  defaultVoxelWorkers,
  DEFAULT_REBASE_DISTANCE_M,
  FloatingOrigin,
  jobRadius,
  MATERIAL_BITS,
  WORLD_RULES,
  SampleRing,
  DEFAULT_SECTION_EDGE,
  SECTION_EDGES,
  type SectionEdge,
  type SwapReport,
  SHADER_BORDER_CELLS,
  SHADER_READ_DEPTH_CELLS,
  shaderGridSide,
  voxel,
  VOXEL_ROLE,
  VOXEL_SIZE_M,
  VOXEL_STREAM_BUDGET_BYTES,
  VoxelStreamer,
  WETNESS_MAX,
} from '@thirdlight/voxel';
import { applyChunkDrawBatch, createGpuTiming, createRenderer, createVoxelSurface, rendererMemory, resolveRendererPreference, VoxelChunkView, type VoxelGridRenderer } from '@thirdlight/three-adapter';
import { bindViewInput, PageRelief, PageSun, reliefParams } from './page-view';
import { pageKitPieces, readVoxelKits } from './kit-pieces';
import { backendArrays, PageMaterials } from './page-materials';
import { kitSceneHooks } from './kit-scene-labels';
import { pageToken } from '../config';
import { PageCollisionRing } from './collision';
import { assemblyProbes } from './probes';
import { PendingEdits, type SwapSeen } from './pending-edits';
import { EDIT_VISIBLE_TIMEOUT_MS, LevelDrawLog, localEditHooks } from './local-edits';
import { rangeReadStats } from './range-reads';
import { RangeWorld } from './range-world';

const params = new URLSearchParams(location.search);
const projectId = params.get('project') ?? '';
const worldName = params.get('world') ?? 'slice';
const at = (params.get('at') ?? '0,64,0').split(',').map(Number) as [number, number, number];
const rebaseM = Number(params.get('rebase') ?? DEFAULT_REBASE_DISTANCE_M);
const workers = Number(params.get('workers') ?? defaultVoxelWorkers());
/** Metres two neighbouring cells' materials blend over. */
const blendM = Number(params.get('blend') ?? VOXEL_SIZE_M / 2);
const shading = params.get('shading') === 'flat' ? 'flat' : 'blend';
/** `bands=1`: construction drawn with the band test texture (bands at fixed heights in the 4 m tile). */
const bands = params.get('bands') === '1';
const patterns = params.get('patterns') === '1';
const gpuTime = params.get('gpuTime') === '1';
/** `?sun=deg`: the sun's elevation in degrees (default the page's fixed light). */
const sunElevationDeg = params.get('sun') === null ? null : Number(params.get('sun'));
const grid = chunkGrid(32);
const sectionParam = Number(params.get('section') ?? DEFAULT_SECTION_EDGE) as SectionEdge;
const sectionEdge: SectionEdge = SECTION_EDGES.includes(sectionParam) ? sectionParam : DEFAULT_SECTION_EDGE;
/** `?levels=a,b`: level 0 drawn within a metres, level 1 within b (default the engine's rings). */
const levelsParam = params.get('levels');
/**
 * `?relief=n` (2, 4, 8): the chunks within `?reliefRadius=` metres (default 32) of the focus when derived also derive
 * the relief mesh n lattice steps a cell, drawn in place of their surfaces and moved in the vertex stage by the
 * engine's relief test heights (`voxelTestRelief`); every surface's lighting normal follows the heights. The
 * displacement fades to none between `?reliefFade=a,b` metres from the focus (default the 4 m up to the radius less a
 * chunk's half diagonal: a chunk at the ring's edge, plain or relief, does not move). `?displace=0` and `?bump=0`
 * start with either off (the hook's `setRelief` switches them).
 */
const relief = new PageRelief(reliefParams(params), grid.edge);
/** `?shadows=1`: the sun casts shadows (a map over the view round the focus), surfaces and pieces cast and receive them. */
const shadows = params.get('shadows') === '1';
const levelRings = (metres: readonly number[]): { radii: number[]; hysteresis: number } => ({ radii: metres.map((m) => Math.round(m / VOXEL_SIZE_M)), hysteresis: DEFAULT_LEVEL_RINGS.hysteresis });
/** A brush dab's half size in cells (a 1 m sphere). */
const BRUSH_CELLS = 2;
/** A frame that missed a 60 Hz display's next refresh: half a refresh longer than one. */
const MISSED_MS = 25;

const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:8px;top:8px;padding:6px 8px;background:rgba(0,0,0,.55);color:#fff;font:12px/1.4 system-ui,sans-serif;white-space:pre;pointer-events:none;border-radius:4px';
document.body.style.cssText = 'margin:0;overflow:hidden;background:#9fc4e8';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100vw;height:100vh';
document.body.append(canvas, hud);
// `?hud=0`: no status line and no picker (pictures compared pixel by pixel).
const hudShown = params.get('hud') !== '0';
if (!hudShown) hud.style.display = 'none';

function fail(message: string): never {
  hud.textContent = message;
  (window as unknown as Record<string, unknown>)['__tlVoxelWorld'] = { failed: message };
  throw new Error(message);
}

const token = pageToken();
if (token === null) fail('No token in this browser: open the editor once with your token, then this page again.');
if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) fail('?project= names the project');
const headers = { authorization: `Bearer ${token}` };
const api = `/api/v1/projects/${encodeURIComponent(projectId)}`;

const range = rangeReadStats();

/** What an edit cost, from the command sent to its meshes swapped and drawn. */
export interface EditTiming {
  ok: boolean;
  code?: string;
  revision?: number;
  cells?: number;
  chunks?: number;
  /** Command sent → answer (the backend's apply and save inside it). */
  answerMs?: number;
  server?: { apply: number; save: number };
  /** Command sent → every changed chunk re-read, re-derived and its meshes swapped. */
  swappedMs?: number;
  /** Command sent → the last changed chunk's physics body replaced. */
  collidersMs?: number;
  /** Chunks derived again from the command until everything settled ("cx,cy,cz"). */
  rederived?: string[];
  /** Command sent → the frame after the swap drawn. */
  visibleMs?: number;
  /** Frames drawn from the command sent to the first frame showing its swap (1: the next frame). */
  frames?: number;
  /** The swap's report: sections, jobs, worker and main-thread costs. */
  swap?: SwapReport;
  /** Main-thread ms replacing the swapped sections' meshes and colliders. */
  buildMs?: number;
  /** The frames drawn and performance.now() when the edit started (what the level draws an edit causes are timed from). */
  startFrame?: number;
  startedAt?: number;
}

// The bundle is a classic script (no top-level await): everything that waits runs in main.
/** What a swapped edit cost once the frame showing it is drawn (meshes and colliders swap in the same task). */
async function shownTiming(streamer: Pick<VoxelStreamer, 'settle'>, t0: number, startFrame: number, seen: SwapSeen): Promise<EditTiming> {
  const swappedMs = seen.at - t0;
  // Visible once the frame after the swap is drawn: the next animation frame renders it, the one after starts once it is shown.
  await new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok())));
  const visibleMs = performance.now() - t0;
  // Everything the edit invalidated (its dependents within the radius too) derived again.
  await streamer.settle();
  return { ok: true, swappedMs, collidersMs: swappedMs, visibleMs, frames: seen.frame - startFrame + 1, swap: seen.report, buildMs: seen.buildMs, startFrame, startedAt: t0 };
}

async function main(): Promise<void> {
  const world = await RangeWorld.open({ url: `${api}/voxels/${encodeURIComponent(worldName)}`, headers, workerUrl: './voxel-worker.js', workers, stats: range }).catch((e: unknown) => fail(`voxel world ${worldName}: ${e instanceof Error ? e.message : String(e)}`));
  /** The region files the world lists, by name, and their current tags. */
  const files = world.files;
  /** A line for the status: the last refusal, or that the world was read again. */
  let notice = '';

  const choice = resolveRendererPreference({ url: location.search });
  const handle = createRenderer({ canvas, preference: choice.preference, source: choice.source, antialias: false, clearColor: 0x9fc4e8, clearAlpha: 1, ...(gpuTime ? { trackTimestamp: true } : {}) });
  if (!(await handle.whenReady())) fail(`renderer: ${handle.info().reason}`);
  const renderer = handle.current()!;
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  const backendName = handle.info().backend ?? '?';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4e8);
  const sun = new PageSun(scene, sunElevationDeg, shadows);
  if (shadows) renderer.shadowMap.enabled = true;
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1500);

  // The camera orbits a target point (cells, 64-bit); everything drawn is relative to the floating origin.
  const target = { x: at[0], y: at[1] + 4, z: at[2] };
  const view = { yaw: -0.6, pitch: 0.45, distM: 22 };
  const origin = new FloatingOrigin({ grid, rebaseDistanceM: rebaseM, origin: { x: target.x, y: target.y, z: target.z } });
  // The project's kits and seed, one table for the derives and the draws; their meshes load beside the stream.
  const kitRoute = { api, projectId, headers };
  const project = await readVoxelKits(kitRoute).catch((e: unknown) => fail(`voxel kits: ${e instanceof Error ? e.message : String(e)}`));
  const kits = pageKitPieces(kitRoute, params.get('kits') === '0' ? null : project);
  // Each material's look from its record, over the stand-in (and the relief's test layer) for what it leaves out.
  const reliefOptions = relief.surfaceOptions();
  const materials = new PageMaterials(async () => (await readVoxelKits(kitRoute)).materials ?? [], reliefOptions.look, patterns ? null : backendArrays(api, headers));
  materials.take(project.materials ?? []);
  if (hudShown) document.body.append(materials.select);
  // Drawn per storage chunk (the sections joined), so the grids are a chunk's.
  const surface = createVoxelSurface({ cellMetres: VOXEL_SIZE_M, side: shaderGridSide(grid.edge), border: SHADER_BORDER_CELLS, materialBits: MATERIAL_BITS, wetnessMax: WETNESS_MAX, readDepthCells: SHADER_READ_DEPTH_CELLS }, { ...reliefOptions, look: materials.look(), blendMetres: blendM, shading, bands, patterns });
  relief.attach(surface);
  materials.attach(surface);
  const streamer = new VoxelStreamer({ store: createWorldStore(grid), source: world.source, pool: world.pool, budgetBytes: VOXEL_STREAM_BUDGET_BYTES.low, dependencyRadius: jobRadius(WORLD_RULES), derive: true, rules: WORLD_RULES, sectionEdge, pieces: kits.table, ...(relief.params.n !== null ? { relief: { n: relief.params.n, radius: Math.round(relief.params.radiusM / VOXEL_SIZE_M) } } : {}), ...(levelsParam !== null ? { levels: levelRings(levelsParam.split(',').map(Number)) } : {}) });
  const meshes = new VoxelChunkView({ grid, origin, surface, renderer: renderer as unknown as VoxelGridRenderer, kits: kits.set, shadows });
  const gpu = createGpuTiming();
  scene.add(meshes.root);
  const ring = params.get('collision') === '0' ? null : await PageCollisionRing.create(grid, origin, streamer, params.get('heightfields') === 'level' ? 'level' : params.get('heightfields') !== '0', params.get('collisionRing') !== '0');
  const collision = ring?.collision ?? null;
  origin.onRebase(() => meshes.rebase());

  const pending = new PendingEdits();
  /** Every resident chunk, so a world changed on disk can be read again whole. */
  const resident = new Map<number, { cx: number; cy: number; cz: number }>();
  /** Open logs of the chunks derived while an edit settles ("cx,cy,cz"). */
  const derivedLogs = new Set<Set<string>>();
  const meshMs = new SampleRing();
  /** Main-thread ms replacing meshes and colliders since the last swap (what the next swap's report gets). */
  let buildMs = 0;
  /** The frame (frames drawn before it) and swap count at which each storage chunk's body was last replaced. */
  const bodySetAt = new Map<number, { frame: number; swap: number }>();
  /** The same for each storage chunk's draw. */
  const chunkSetAt = new Map<number, { frame: number; swap: number }>();
  /** When the coarser levels' node and seam draws were replaced and mip node results came in (an edit's ancestors). */
  const levelLog = new LevelDrawLog();
  const swaps: SwapSeen[] = [];

  // A swap's chunks are joined and their bodies replaced, from the one join, in the task announcing them; the
  // draws (the levels drawn, their nodes and seams too) go in as one batch at the end of that task, as Play's do.
  const batcher = new ChunkDrawBatcher(worldName, streamer, sectionEdge, (b) => {
    const t0 = performance.now();
    const done = applyChunkDrawBatch(meshes, b);
    const ms = performance.now() - t0 + b.joinMs;
    buildMs += ms;
    levelLog.batch(b, frames, ms);
    const drawnChunks = done.chunkBytes.length / 4;
    if (drawnChunks > 0) meshMs.add(ms / drawnChunks);
    batcher.drawn(done.chunkBytes, done.coarseBytes, kits.meshes.gpuBytes());
  }, {
    inPlace: true,
    onJoined: (cx, cy, cz, joined, shaderOnly, drawn) => {
      const key = chunkKey(grid, cx, cy, cz);
      const at = { frame: frames, swap: streamer.counters.swaps };
      if (drawn) chunkSetAt.set(key, at);
      // Only shader data changed: the body stands as it is.
      if (shaderOnly || ring === null) return;
      const t0 = performance.now();
      if (ring.ring.changed(cx, cy, cz, joined)) bodySetAt.set(key, at);
      buildMs += performance.now() - t0;
    },
  });
  meshes.rebuilt = () => batcher.drawn(meshes.chunkBytes(), meshes.coarseBytes(), kits.meshes.gpuBytes()); // pieces built late change the bytes

  streamer.on((e) => {
    if (e.type === 'swap') {
      const seen: SwapSeen = { at: performance.now(), frame: frames, report: e.report, buildMs: Number(buildMs.toFixed(3)) };
      buildMs = 0;
      swaps.push(seen);
      if (swaps.length > 64) swaps.shift();
      pending.swapped(seen);
      return;
    }
    if (e.type === 'loaded') {
      resident.set(chunkKey(grid, e.cx, e.cy, e.cz), { cx: e.cx, cy: e.cy, cz: e.cz });
      return;
    }
    if (e.type === 'unloaded') {
      resident.delete(chunkKey(grid, e.cx, e.cy, e.cz));
      ring?.ring.unloaded(e.cx, e.cy, e.cz);
      return;
    }
    // Draws and bodies follow the batcher (above): chunks, level nodes, their seams and the levels chosen.
    if (e.type === 'node') return levelLog.node(e.level, frames);
    if (e.type === 'damaged' || e.type === 'mismatch' || e.type === 'chunk' || e.type === 'seams' || e.type === 'levels') return;
    if (e.type === 'shader') {
      // Only the shader data changed (material or wetness): bodies stand as they are; the view uploads the chunk's grid.
      for (const log of derivedLogs) log.add(`${e.cx},${e.cy},${e.cz}:shader`);
      return;
    }
    for (const log of derivedLogs) log.add(`${e.cx},${e.cy},${e.cz}`);
  });

  function placeCamera(): void {
    origin.update(target.x * VOXEL_SIZE_M, target.y * VOXEL_SIZE_M, target.z * VOXEL_SIZE_M);
    const o = origin.origin;
    const tx = (target.x - o.x) * VOXEL_SIZE_M;
    const ty = (target.y - o.y) * VOXEL_SIZE_M;
    const tz = (target.z - o.z) * VOXEL_SIZE_M;
    const c = Math.cos(view.pitch);
    camera.position.set(tx + Math.sin(view.yaw) * c * view.distM, ty + Math.sin(view.pitch) * view.distM, tz + Math.cos(view.yaw) * c * view.distM);
    camera.lookAt(tx, ty, tz);
    relief.follow(tx, ty, tz);
    sun.follow(tx, ty, tz);
    streamer.setFocus(target.x, target.y, target.z);
    ring?.ring.setFoci([target]);
  }

  // ---- input: orbit, zoom, move, pick to edit ----
  const keys = bindViewInput(canvas, view, {
    pick: (x, y, mode) => void pickAndEdit(x, y, mode),
    undo: () => void undo(),
    resize: () => {
      renderer.setSize(innerWidth, innerHeight, false);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    },
  });

  const raycaster = new THREE.Raycaster();
  /** The cell under a screen point: the one behind the hit surface (dig) or in front of it (add). */
  function pickCell(px: number, py: number, mode: 'dig' | 'add'): [number, number, number] | null {
    raycaster.setFromCamera(new THREE.Vector2((px / innerWidth) * 2 - 1, -(py / innerHeight) * 2 + 1), camera);
    const hit = raycaster.intersectObjects(meshes.pickable, false)[0];
    if (hit === undefined || hit.face === null || hit.face === undefined) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const p = hit.point.addScaledVector(n, mode === 'dig' ? -0.25 : 0.25);
    const o = origin.origin;
    return [Math.floor(p.x / VOXEL_SIZE_M) + o.x, Math.floor(p.y / VOXEL_SIZE_M) + o.y, Math.floor(p.z / VOXEL_SIZE_M) + o.z];
  }

  const lastEdits: EditTiming[] = [];

  let requestCounter = 0;
  function requestId(): string {
    const r = crypto.getRandomValues(new Uint8Array(12));
    return `req-${(++requestCounter).toString(16).padStart(8, '0')}${[...r].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  /**
   * Sends a voxel command and waits until what it changed is drawn. The
   * answer's box (the cells the edit, or the edit an undo takes back, can
   * change) bounds what is derived again.
   */
  async function send(op: 'editVoxels' | 'undoVoxels' | 'writeKitTestScene', args: Record<string, unknown>): Promise<EditTiming> {
    const log = new Set<string>();
    derivedLogs.add(log);
    try {
      return await sendLogged(op, args, log);
    } finally {
      derivedLogs.delete(log);
    }
  }

  async function sendLogged(op: 'editVoxels' | 'undoVoxels' | 'writeKitTestScene', args: Record<string, unknown>, log: Set<string>): Promise<EditTiming> {
    const t0 = performance.now();
    const startFrame = frames;
    const r = await fetch(`${api}/commands`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ op, projectId, requestId: requestId(), args: { world: worldName, ...args } }) });
    const body = (await r.json()) as { ok: boolean; error?: { code: string }; revision: number; cells: number; chunks: Array<[number, number, number]>; box: CellBox; parts: number; materialSwaps: number[]; files: Array<{ name: string; etag: string | null }>; ms: { apply: number; save: number } };
    const answerMs = performance.now() - t0;
    if (!body.ok) {
      const code = body.error?.code ?? String(r.status);
      notice = `${op === 'undoVoxels' ? 'undo' : 'edit'} refused: ${code}`;
      // Someone else changed the files (a checkout, a restore): what this page holds is not the world any more.
      if (code === 'world_changed') await readWorldAgain();
      return { ok: false, code, answerMs };
    }
    notice = '';
    // The group swaps once every changed chunk has landed again and every section within reach is derived again;
    // a chunk whose new content never lands (a failed read) must not hold the edit forever.
    const group = world.applyChange(streamer, body);
    const seen = await pending.wait(group, EDIT_VISIBLE_TIMEOUT_MS);
    if (seen === null) return { ok: false, code: 'not_visible', answerMs };
    const timing = await shown(t0, startFrame, seen);
    Object.assign(timing, { revision: body.revision, cells: body.cells, chunks: body.chunks.length, answerMs, server: body.ms, rederived: [...log].sort() });
    lastEdits.push(timing);
    return timing;
  }

  const shown = (t0: number, startFrame: number, seen: SwapSeen): Promise<EditTiming> => shownTiming(streamer, t0, startFrame, seen);

  /** The world's files changed on disk behind this page: everything resident is read again from them. */
  async function readWorldAgain(): Promise<void> {
    const why = await world.readAgain(streamer, resident.values());
    notice = why === null ? `world changed on disk: read again at r${world.revision}; send the edit again` : `world changed on disk: ${why}; reload the page`;
  }

  /** Any stroke command (a game's runtime set/dig, a fill, a brush), sent as it is. */
  function edit(command: unknown): Promise<EditTiming> {
    return send('editVoxels', { command });
  }

  /** A brush dab (dig, or add soil) centred on a cell. */
  function dab(cell: readonly [number, number, number], mode: 'dig' | 'add'): Promise<EditTiming> {
    return edit({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [BRUSH_CELLS, BRUSH_CELLS, BRUSH_CELLS], points: [...cell], mode, ...(mode === 'add' ? { voxel: { material: materials.material, role: VOXEL_ROLE.terrain, wetness: 0 } } : {}), smooth: false });
  }

  async function pickAndEdit(px: number, py: number, mode: 'dig' | 'add'): Promise<EditTiming | null> {
    const cell = pickCell(px, py, mode);
    return cell === null ? null : dab(cell, mode);
  }

  const undo = (): Promise<EditTiming> => send('undoVoxels', {});
  const kitScene = kitSceneHooks((args) => send('writeKitTestScene', args), document.body);

  // ---- frames ----
  const frameMs = new SampleRing();
  const renderMs = new SampleRing();
  let last = -1;
  let frames = 0;
  let missed = 0;
  /** The longest frame interval since the last blast started. */
  let longestMs = 0;
  let orbit = 0;
  let recording: number[] | null = null;
  const v = voxel();

  function frame(t: number): void {
    if (last >= 0) {
      const dt = t - last;
      frameMs.add(dt);
      if (dt > MISSED_MS) missed++;
      longestMs = Math.max(longestMs, dt);
      recording?.push(dt);
      const step = (dt / 1000) * 30;
      if (keys.has('w') || keys.has('s') || keys.has('a') || keys.has('d')) {
        const f = (keys.has('w') ? -1 : 0) + (keys.has('s') ? 1 : 0);
        const s = (keys.has('d') ? 1 : 0) + (keys.has('a') ? -1 : 0);
        target.x += (Math.sin(view.yaw) * f + Math.cos(view.yaw) * s) * step;
        target.z += (Math.cos(view.yaw) * f - Math.sin(view.yaw) * s) * step;
      }
      view.yaw += orbit * (dt / 1000);
    }
    last = t;
    placeCamera();
    streamer.update();
    ring?.update();
    const r0 = performance.now();
    renderer.render(scene, camera);
    renderMs.add(performance.now() - r0);
    kitScene.update(camera, origin.origin);
    surface.grids.frame();
    gpu.afterFrame(renderer);
    frames++;
    if (frames % 15 === 0) {
      const m = streamer.metrics();
      hud.textContent = `${backendName} · ${worldName} r${world.revision} · ${frameMs.quantile(0.5).toFixed(1)} ms p50 · ${missed} missed\n${notice === '' ? '' : `${notice}\n`}${m.resident} chunks (${meshes.levelCounts().join(' / ')} drawn by level, ${meshes.seamCount} seams), ${(m.bytes.total / 1e6).toFixed(1)} MB · ${meshes.triangles} tris, ${meshes.instances} pieces\nclick dig · shift-click add · Z undo · drag orbit · wheel zoom · WASD move`;
    }
    requestAnimationFrame(frame);
  }

  placeCamera();
  hud.textContent = `${backendName} · ${worldName} r${world.revision} · streaming…`;
  const t0 = performance.now();
  await streamer.settle();
  const coldMs = performance.now() - t0;
  notice = await kits.loaded; // kit meshes that failed draw nothing: the status names them
  requestAnimationFrame(frame);
  await kitScene.fromParam(params.get('kitScene'));

  const q = (r: SampleRing, p: number): number => Number(r.quantile(p).toFixed(3));


  (window as unknown as Record<string, unknown>)['__tlVoxelWorld'] = {
    ready: true,
    backend: backendName,
    coldMs,
    /** Records frame intervals for `seconds` while the camera orbits at `yawPerS` radians a second. */
    async frames(seconds: number, yawPerS = 0.15): Promise<{ intervals: number[]; renderMs: { p50: number; p95: number } }> {
      renderMs.clear();
      recording = [];
      orbit = yawPerS;
      await new Promise((ok) => setTimeout(ok, seconds * 1000));
      orbit = 0;
      const intervals = recording;
      recording = null;
      return { intervals, renderMs: { p50: q(renderMs, 0.5), p95: q(renderMs, 0.95) } };
    },
    /** Where levels 0 and 1 are drawn (metres; empty: the engine's rings): the change is one swap, waited for. */
    async setLevels(metres: readonly number[]): Promise<void> {
      streamer.mips?.lod.setRings(metres.length === 0 ? DEFAULT_LEVEL_RINGS : levelRings(metres));
      await streamer.settle();
    },
    /** Relief displacement and the height-bent lighting normal on or off (no new program; `?relief=` must be on). */
    setRelief(s: { displace?: boolean; bump?: boolean }): void {
      relief.set(s);
    },
    /** Metres two neighbouring cells' materials blend over (no new program). */
    setBlend(m: number): void {
      surface.setBlendMetres(m);
    },
    /** GPU ms and frames resolved since the last call (null: the renderer records no timestamps). */
    gpuTime: () => gpu.take(),
    /** Points the camera (target cell, yaw, pitch, distance in metres). */
    look(x: number, y: number, z: number, yaw: number, pitch: number, distM: number): void {
      Object.assign(target, { x, y, z });
      Object.assign(view, { yaw, pitch, distM });
      // The streamer's focus moves now, not at the next frame: a `settle` right after waits for the new ring.
      placeCamera();
    },
    dab,
    edit,
    undo,
    /** Writes the kit test scene and labels it; `labelsShown` counts the tags on the screen. */
    writeKitScene: kitScene.write,
    labelsShown: kitScene.shown,
    clearKitScene: kitScene.clear,
    ...localEditHooks({ streamer, grid, pending, derivedLogs, bodySetAt, chunkSetAt, levelLog, resident, shown, edit, frameStats: () => ({ frames, missed, longestMs }), resetLongest: () => (longestMs = 0) }),
    /** The last swaps seen (frame, report, page build ms). */
    swaps: () => swaps.slice(),
    ...assemblyProbes({ streamer, grid, origin, collision, scene, files, kitPiece: (material, piece, variant) => meshes.kits?.describe(material, piece, variant) ?? null }),
    /** A dab at the cell under a screen point. */
    pickAndEdit,
    /** The picker's voxel materials, the one shift-click adds, picking one, and reading the records again. */
    materials: () => ({ entries: materials.entries, picked: materials.material, options: [...materials.select.options].map((o) => o.text) }),
    pickMaterial: (id: number) => materials.pick(id),
    readMaterials: () => materials.readAgain(),
    tableEntry: (m: number) => surface.tableEntry(m),
    async settle(): Promise<void> {
      await kits.loaded;
      await streamer.settle();
      await ring?.settle();
    },
    voxelAt(x: number, y: number, z: number): { material: number; role: number; shape: number; wetness: number } {
      streamer.voxelAt(x, y, z, v);
      return { material: v.material, role: v.role, shape: v.shape, wetness: v.wetness };
    },
    derivedHash(cx: number, cy: number, cz: number): number | null {
      return streamer.derivedOf(cx, cy, cz)?.hash ?? null;
    },
    state(): Record<string, unknown> {
      const m = streamer.metrics();
      const mips = streamer.mips;
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? NaN;
      return {
        backend: backendName,
        revision: world.revision,
        resident: m.resident,
        stored: m.residentStored,
        drawn: meshes.count,
        levels: meshes.levelCounts(),
        seams: meshes.seamCount,
        seamTriangles: meshes.seamTriangles,
        lod: mips === null ? null : { ...mips.lod.counters, radii: mips.lod.levelRings.radii, swapMs: { p50: q(mips.lod.swapMs, 0.5), p95: q(mips.lod.swapMs, 0.95), n: mips.lod.swapMs.count } },
        triangles: meshes.triangles, vertices: meshes.vertices, reliefVertices: meshes.reliefVertices,
        pieces: meshes.instances, kitPieces: meshes.piecesDrawn.kit, pieceDraws: meshes.pieceDraws, drawCalls: (renderer.info as unknown as { render: { drawCalls: number } }).render.drawCalls,
        kits: { ids: kits.table?.kits.map((k) => k.id) ?? [], meshes: kits.meshes.states() },
        streamBytes: m.bytes,
        heapMB: Number((heap / 1e6).toFixed(1)),
        gpu: rendererMemory(renderer),
        deriveUs: { p50: q(streamer.deriveUs, 0.5), p95: q(streamer.deriveUs, 0.95), n: streamer.deriveUs.count },
        evaluateUs: m.evaluateUs, reliefUs: m.reliefUs,
        kitBytes: kits.meshes.bytes(),
        mips: mips === null ? null : { nodes: mips.nodeCount, bytes: mips.bytes, cellBytes: mips.cellBytes(), seamBytes: mips.seams.bytes, gpuBytes: mips.gpuBytes, downsampleUs: { p50: q(mips.downsampleUs, 0.5), p95: q(mips.downsampleUs, 0.95), n: mips.downsampleUs.count }, deriveUs: { p50: q(mips.deriveUs, 0.5), p95: q(mips.deriveUs, 0.95), n: mips.deriveUs.count }, counters: { ...mips.counters } },
        meshMs: { p50: q(meshMs, 0.5), p95: q(meshMs, 0.95), n: meshMs.count },
        relief: relief.state(),
        shadows,
        textures: { ...materials.textures, current: materials.texturesCurrent, textured: surface.textured },
        surface: { shading, blendM, tableUploads: surface.tableUploads, tableMs: surface.tableMs, meshBuilds: meshes.meshBuilds, shaderSets: meshes.shaderSets, regions: meshes.regions, gridGpuBytes: surface.grids.gpuBytes, gridUploads: surface.grids.uploads, gridUploadedBytes: surface.grids.uploadedBytes, gridGrown: surface.grids.grown, uploadMs: { p50: q(meshes.uploadMs, 0.5), p95: q(meshes.uploadMs, 0.95), n: meshes.uploadMs.count } },
        swaps: meshes.meshBuilds,
        section: sectionEdge,
        editSwaps: streamer.counters.swaps,
        range: { requests: range.requests, bytes: range.bytes, p50: q(range.ms, 0.5), p95: q(range.ms, 0.95) },
        counters: m.counters,
        frames,
        missed,
        rebases: origin.rebases,
        edits: lastEdits.slice(),
        collision: ring?.stats() ?? null,
      };
    },
  };
}

void main().catch((e: unknown) => {
  try {
    fail(`voxel world page: ${e instanceof Error ? e.message : String(e)}`);
  } catch {
    // fail() threw on purpose; the message is on the page.
  }
});
