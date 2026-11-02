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
 *
 * Drag to orbit, wheel to zoom, W A S D to move; click digs a 1 m sphere,
 * shift-click adds one, Z undoes the newest edit. `window.__tlVoxelWorld`
 * is the hook a test or a measuring run drives.
 *
 * Every derived chunk also becomes a static body in the engine's physics
 * backend (`?collision=0` leaves physics out), replaced when the chunk is
 * derived again; the hook drops capsules and sweeps spheres against it and
 * reports, per cell, what every consumer of the derived data received.
 */
import * as THREE from 'three';
import { hexToBytes } from '@thirdlight/shared';
import {
  chunkGrid,
  chunkKey,
  type CellBox,
  createWorldStore,
  DEFAULT_REBASE_DISTANCE_M,
  eventTargetWorker,
  FloatingOrigin,
  jobRadius,
  PLACEHOLDER_RULES,
  RegionChunkSource,
  SampleRing,
  STREAM_POOL_SETTINGS,
  voxel,
  VOXEL_CATEGORY,
  VOXEL_SIZE_M,
  VOXEL_STREAM_BUDGET_BYTES,
  VoxelStreamer,
  WORLD_GRID_ID,
  WorkerPool,
  type RegionByteSource,
} from '@thirdlight/voxel';
import { createRenderer, rendererMemory, resolveRendererPreference } from '@thirdlight/three-adapter';
import { pageToken } from '../config';
import { ChunkMeshes } from './chunk-meshes';
import { VoxelCollision } from './collision';
import { assemblyProbes } from './probes';

const params = new URLSearchParams(location.search);
const projectId = params.get('project') ?? '';
const worldName = params.get('world') ?? 'slice';
const at = (params.get('at') ?? '0,64,0').split(',').map(Number) as [number, number, number];
const rebaseM = Number(params.get('rebase') ?? DEFAULT_REBASE_DISTANCE_M);
const workers = Number(params.get('workers') ?? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));
const grid = chunkGrid(32);
/** A brush dab's half size in cells (a 1 m sphere). */
const BRUSH_CELLS = 2;
/** A frame that missed a 60 Hz display's next refresh: half a refresh longer than one. */
const MISSED_MS = 25;
/** How long an edit may take to show before it is reported as not shown. */
const EDIT_VISIBLE_TIMEOUT_MS = 10_000;

const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:8px;top:8px;padding:6px 8px;background:rgba(0,0,0,.55);color:#fff;font:12px/1.4 system-ui,sans-serif;white-space:pre;pointer-events:none;border-radius:4px';
document.body.style.cssText = 'margin:0;overflow:hidden;background:#9fc4e8';
const canvas = document.createElement('canvas');
canvas.style.cssText = 'display:block;width:100vw;height:100vh';
document.body.append(canvas, hud);
// `?hud=0`: no status line (pictures compared pixel by pixel).
if (params.get('hud') === '0') hud.style.display = 'none';

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

/** The region files the world lists, by name, and their current tags (null: listed but unreadable, so its chunks are damaged; a file not listed holds only air). */
const files = new Map<string, string | null>();

interface VoxelInfo {
  ok: boolean;
  manifest: { revision: number; worldId: string; edge: number; layout: 'stacked' | 'column'; footprint: 512 | 1024 };
  files: Array<{ name: string; etag: string | null }>;
  error?: { message: string };
}

const rangeMs = new SampleRing();
let rangeRequests = 0;
let rangeBytes = 0;

function byteSource(name: string): RegionByteSource | null {
  if (!files.has(name)) return null;
  const url = `${api}/voxels/${encodeURIComponent(worldName)}/regions/${encodeURIComponent(name)}`;
  return {
    read: async (offset, length) => {
      const t0 = performance.now();
      const r = await fetch(url, { headers: { ...headers, range: `bytes=${offset}-${offset + length - 1}` } });
      // Past the end of the file: fewer bytes (none), as a byte source may answer.
      if (r.status === 416) return new Uint8Array(0);
      if (r.status !== 206 && r.status !== 200) throw new Error(`${name}: HTTP ${r.status}`);
      const all = new Uint8Array(await r.arrayBuffer());
      const b = r.status === 200 ? all.subarray(offset, offset + length) : all;
      rangeRequests++;
      rangeBytes += b.length;
      rangeMs.add(performance.now() - t0);
      return b;
    },
  };
}

// The bundle is a classic script (no top-level await): everything that waits runs in main.
async function main(): Promise<void> {
  const infoRes = await fetch(`${api}/voxels/${encodeURIComponent(worldName)}`, { headers });
  const info = (await infoRes.json()) as VoxelInfo;
  if (!info.ok) fail(`voxel world ${worldName}: ${info.error?.message ?? infoRes.status}`);
  for (const f of info.files) files.set(f.name, f.etag);
  let revision = info.manifest.revision;

  const choice = resolveRendererPreference({ url: location.search });
  const handle = createRenderer({ canvas, preference: choice.preference, source: choice.source, antialias: false, clearColor: 0x9fc4e8, clearAlpha: 1 });
  if (!(await handle.whenReady())) fail(`renderer: ${handle.info().reason}`);
  const renderer = handle.current()!;
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  const backendName = handle.info().backend ?? '?';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4e8);
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a4030, 1.3));
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.2);
  sun.position.set(0.5, 1, 0.3);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1500);

  // The camera orbits a target point (cells, 64-bit); everything drawn is relative to the floating origin.
  const target = { x: at[0], y: at[1] + 4, z: at[2] };
  const view = { yaw: -0.6, pitch: 0.45, distM: 22 };
  const origin = new FloatingOrigin({ grid, rebaseDistanceM: rebaseM, origin: { x: target.x, y: target.y, z: target.z } });
  const meshes = new ChunkMeshes(grid, origin);
  scene.add(meshes.root);
  const collision = params.get('collision') === '0' ? null : await VoxelCollision.create(grid, origin);
  origin.onRebase(() => {
    meshes.rebase();
    collision?.rebase();
  });

  const pool = new WorkerPool({ size: workers, create: () => eventTargetWorker(new Worker('./voxel-worker.js', { type: 'module' })), ...STREAM_POOL_SETTINGS });
  const worldId = hexToBytes(info.manifest.worldId);
  const source = new RegionChunkSource({ worldId, gridId: WORLD_GRID_ID, grid, layout: info.manifest.layout, footprint: info.manifest.footprint, open: byteSource, maxOpen: 64 });
  const streamer = new VoxelStreamer({ store: createWorldStore(grid), source, pool, budgetBytes: VOXEL_STREAM_BUDGET_BYTES.low, dependencyRadius: jobRadius(PLACEHOLDER_RULES), derive: true, rules: PLACEHOLDER_RULES });

  /** Chunks an edit is waiting on (key → landed with the new content yet), and when each edit's meshes were all swapped. */
  interface PendingEdit {
    readonly waiting: Map<number, boolean>;
    readonly done: (atMs: number, collidersAtMs: number) => void;
    /** When the newest of its chunks' bodies was replaced. */
    collidersAt: number;
  }
  const pending = new Set<PendingEdit>();
  /** Open logs of the chunks derived while an edit settles ("cx,cy,cz"). */
  const derivedLogs = new Set<Set<string>>();
  const meshMs = new SampleRing();
  let meshSwaps = 0;

  streamer.on((e) => {
    const key = chunkKey(grid, e.cx, e.cy, e.cz);
    if (e.type === 'loaded') {
      for (const p of pending) if (p.waiting.has(key)) p.waiting.set(key, true);
    } else if (e.type === 'unloaded') {
      meshes.remove(key);
      collision?.remove(key);
    } else if (e.type === 'derived') {
      const d = streamer.derivedOf(e.cx, e.cy, e.cz)?.assembly ?? null;
      for (const log of derivedLogs) log.add(`${e.cx},${e.cy},${e.cz}`);
      if (collision !== null) streamer.setPart(e.cx, e.cy, e.cz, 'collision', collision.set(key, e.cx, e.cy, e.cz, d));
      const collidersAt = performance.now();
      const bytes = meshes.set(key, e.cx, e.cy, e.cz, d);
      meshMs.add(performance.now() - collidersAt);
      meshSwaps++;
      streamer.setPart(e.cx, e.cy, e.cz, 'mesh', bytes);
      for (const p of [...pending]) {
        if (p.waiting.get(key) !== true) continue;
        p.waiting.delete(key);
        p.collidersAt = collidersAt;
        if (p.waiting.size === 0) {
          pending.delete(p);
          p.done(performance.now(), p.collidersAt);
        }
      }
    }
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
    streamer.setFocus(target.x, target.y, target.z);
  }

  // ---- input: orbit, zoom, move, pick to edit ----
  const keys = new Set<string>();
  let drag: { x: number; y: number; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false };
  });
  addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    if (d !== null && !d.moved && e.target === canvas) void pickAndEdit(e.clientX, e.clientY, e.shiftKey ? 'add' : 'dig');
  });
  addEventListener('pointermove', (e) => {
    if (drag === null) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    view.yaw -= dx * 0.005;
    view.pitch = Math.min(1.45, Math.max(-0.2, view.pitch + dy * 0.005));
  });
  canvas.addEventListener('wheel', (e) => {
    view.distM = Math.min(400, Math.max(4, view.distM * Math.exp(e.deltaY * 0.001)));
    e.preventDefault();
  });
  addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    if (e.key.toLowerCase() === 'z') void undo();
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
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

  /** What an edit cost, from the command sent to its meshes swapped and drawn. */
  interface EditTiming {
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
  async function send(op: 'editVoxels' | 'undoVoxels', args: Record<string, unknown>): Promise<EditTiming> {
    const log = new Set<string>();
    derivedLogs.add(log);
    try {
      return await sendLogged(op, args, log);
    } finally {
      derivedLogs.delete(log);
    }
  }

  async function sendLogged(op: 'editVoxels' | 'undoVoxels', args: Record<string, unknown>, log: Set<string>): Promise<EditTiming> {
    const t0 = performance.now();
    const r = await fetch(`${api}/commands`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ op, projectId, requestId: requestId(), args: { world: worldName, ...args } }) });
    const body = (await r.json()) as { ok: boolean; error?: { code: string }; revision: number; cells: number; chunks: Array<[number, number, number]>; box: CellBox; files: Array<{ name: string; etag: string | null }>; ms: { apply: number; save: number } };
    const answerMs = performance.now() - t0;
    if (!body.ok) return { ok: false, code: body.error?.code ?? String(r.status), answerMs };
    revision = body.revision;
    for (const f of body.files) {
      if (f.etag === null) files.delete(f.name);
      else files.set(f.name, f.etag);
    }
    const chunks = body.chunks.map(([cx, cy, cz]) => ({ cx, cy, cz }));
    const waiting = new Map<number, boolean>();
    for (const c of chunks) if (streamer.isResident(c.cx, c.cy, c.cz)) waiting.set(chunkKey(grid, c.cx, c.cy, c.cz), false);
    let collidersAt = NaN;
    const swapped = new Promise<boolean>((done) => {
      if (waiting.size === 0) {
        done(true);
        return;
      }
      const p: PendingEdit = {
        waiting,
        collidersAt: NaN,
        done: (_at, colliders) => {
          collidersAt = colliders;
          done(true);
        },
      };
      pending.add(p);
      // A chunk whose new content never lands (a failed read) must not hold the edit forever.
      setTimeout(() => {
        if (pending.delete(p)) done(false);
      }, EDIT_VISIBLE_TIMEOUT_MS);
    });
    streamer.refresh(chunks, body.box);
    if (!(await swapped)) return { ok: false, code: 'not_visible', answerMs };
    const swappedMs = performance.now() - t0;
    // Visible once the frame after the swap is drawn: the next animation frame renders it, the one after starts once it is shown.
    await new Promise<void>((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok())));
    const visibleMs = performance.now() - t0;
    // Everything the edit invalidated (its dependents within the radius too) derived again.
    await streamer.settle();
    const timing: EditTiming = { ok: true, revision: body.revision, cells: body.cells, chunks: chunks.length, answerMs, server: body.ms, swappedMs, collidersMs: collidersAt - t0, visibleMs, rederived: [...log].sort() };
    lastEdits.push(timing);
    return timing;
  }

  /** Any stroke command (a game's runtime set/dig, a fill, a brush), sent as it is. */
  function edit(command: unknown): Promise<EditTiming> {
    return send('editVoxels', { command });
  }

  /** A brush dab (dig, or add soil) centred on a cell. */
  function dab(cell: readonly [number, number, number], mode: 'dig' | 'add'): Promise<EditTiming> {
    return edit({ v: 1, grid: 0, kind: 'brush', shape: 'sphere', size: [BRUSH_CELLS, BRUSH_CELLS, BRUSH_CELLS], points: [...cell], mode, ...(mode === 'add' ? { voxel: { material: 2, category: VOXEL_CATEGORY.terrain, orientation: 0 } } : {}), smooth: false });
  }

  async function pickAndEdit(px: number, py: number, mode: 'dig' | 'add'): Promise<EditTiming | null> {
    const cell = pickCell(px, py, mode);
    return cell === null ? null : dab(cell, mode);
  }

  const undo = (): Promise<EditTiming> => send('undoVoxels', {});

  // ---- frames ----
  const frameMs = new SampleRing();
  const renderMs = new SampleRing();
  let last = -1;
  let frames = 0;
  let missed = 0;
  let orbit = 0;
  let recording: number[] | null = null;
  const v = voxel();

  function frame(t: number): void {
    if (last >= 0) {
      const dt = t - last;
      frameMs.add(dt);
      if (dt > MISSED_MS) missed++;
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
    const r0 = performance.now();
    renderer.render(scene, camera);
    renderMs.add(performance.now() - r0);
    frames++;
    if (frames % 15 === 0) {
      const m = streamer.metrics();
      hud.textContent = `${backendName} · ${worldName} r${revision} · ${frameMs.quantile(0.5).toFixed(1)} ms p50 · ${missed} missed\n${m.resident} chunks (${meshes.count} drawn), ${(m.bytes.total / 1e6).toFixed(1)} MB · ${meshes.triangles} tris, ${meshes.instances} pieces\nclick dig · shift-click add · Z undo · drag orbit · wheel zoom · WASD move`;
    }
    requestAnimationFrame(frame);
  }

  placeCamera();
  hud.textContent = `${backendName} · ${worldName} r${revision} · streaming…`;
  const t0 = performance.now();
  await streamer.settle();
  const coldMs = performance.now() - t0;
  requestAnimationFrame(frame);

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
    /** Points the camera (target cell, yaw, pitch, distance in metres). */
    look(x: number, y: number, z: number, yaw: number, pitch: number, distM: number): void {
      Object.assign(target, { x, y, z });
      Object.assign(view, { yaw, pitch, distM });
    },
    dab,
    edit,
    undo,
    ...assemblyProbes({ streamer, grid, origin, collision, scene, files }),
    /** A dab at the cell under a screen point. */
    pickAndEdit,
    async settle(): Promise<void> {
      await streamer.settle();
    },
    voxelAt(x: number, y: number, z: number): { material: number; category: number; shape: number } {
      streamer.store.voxelAt(x, y, z, v);
      return { material: v.material, category: v.category, shape: v.shape };
    },
    derivedHash(cx: number, cy: number, cz: number): number | null {
      return streamer.derivedOf(cx, cy, cz)?.hash ?? null;
    },
    state(): Record<string, unknown> {
      const m = streamer.metrics();
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? NaN;
      return {
        backend: backendName,
        revision,
        resident: m.resident,
        stored: m.residentStored,
        drawn: meshes.count,
        triangles: meshes.triangles,
        pieces: meshes.instances,
        streamBytes: m.bytes,
        heapMB: Number((heap / 1e6).toFixed(1)),
        gpu: rendererMemory(renderer),
        deriveUs: { p50: q(streamer.deriveUs, 0.5), p95: q(streamer.deriveUs, 0.95), n: streamer.deriveUs.count },
        meshMs: { p50: q(meshMs, 0.5), p95: q(meshMs, 0.95), n: meshMs.count },
        swaps: meshSwaps,
        range: { requests: rangeRequests, bytes: rangeBytes, p50: q(rangeMs, 0.5), p95: q(rangeMs, 0.95) },
        counters: m.counters,
        frames,
        missed,
        rebases: origin.rebases,
        edits: lastEdits.slice(),
        collision: collision?.stats() ?? null,
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
