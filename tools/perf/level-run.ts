/**
 * The level-building measurement (`node tools/perf/run.mjs level …`): the
 * level classes (level.ts) built through a private backend, exported, and
 * each export measured like the village (frame-run.ts: 1920×1080 at DPR 1,
 * uncapped, the host's GPU, frame p50/p95/p99, draws, main-thread time, GPU
 * time per render pass, a CPU profile split by package), on both renderers.
 * The log ends with each class against the soft frame target and what the
 * landscape's far part adds to the area.
 *
 *   --classes area,landscape     (default both; `world`: the landscape at 8 × 8 km with block fields, all streamed)
 *   --live N                     N live door cells in each class (default 0: the classes as recorded)
 *   --edge-walls                 the rooms' walls as edge pieces (default: cell walls, as recorded)
 *   --wall-paint                 the layer with wall paint, the rooms' front walls painted (default: none, as recorded)
 *   --roofs                      a roof on each room (default: none, as recorded)
 *   --cutaway                    the roofs as cut-aways, half held cut, half swapped every 2 s by a script (implies --roofs)
 *   --kit-swap                   a script swaps the layer's kit (burnt twins of every block type) on and off every 2 s
 *   --vertex-ao                  the layer with corner shading (vertexAO 0.6; default: none, as recorded)
 *   --projection 1|2             every terrain layer read by slope (1) or biplanar (2) (default: top, as recorded)
 *   --macro M                    the terrain's tiles past M metres drawn from their macro textures (default: none, as recorded)
 *   --rules                      material rules on the block layer and the terrain (baked), and per-layer settings for
 *                                every terrain layer (default: none, as recorded)
 *   --flight                     the camera flies a 60 s loop over the class (a script; it hides, shows and removes
 *                                scatter copies on the way), recorded for 60 s at the display's rate (--uncapped:
 *                                not): the frames over 16.7 ms are counted (default: the still camera, as recorded)
 *   --vsync                      draw at the display's rate (a player's browser) instead of uncapped
 *   --flight-plain               the same flight without the scatter copies' hides, shows and removals (streaming alone)
 *   --missed-marks               with --flight: each missed refresh's time and the engine's marks just before it
 *   --impostors S                the landscape's trees, pines and rocks drawn as impostors below screen size S (default:
 *                                their meshes all the way, as recorded)
 *   --splines off                the landscape without its road and river (default: with them)
 *   --spline-edit                the landscape's editor Scene view open while a script moves a road point 5 m back and
 *                                forth every 4 s (6 edits; each one command that shapes the terrain again and makes
 *                                the road's mesh again): each edit's round trip and the page's frames meanwhile,
 *                                after three windows without an edit (the class's own slow frames), and what three
 *                                built meanwhile (node programs and pipelines by object, scatter sets made)
 *   --sculpt-edit                the same with a script raising and lowering the ground beside the road every 4 s
 *                                (one `editTerrain` each: tiles and their scatter baked again)
 *   --stamp-edit                 the same with a script placing and removing a 64 m heightmap stamp (a cone, 40 m
 *                                high) beside the road every 4 s (one `setComponent` of the terrain's layers each:
 *                                the ground under it combined again, its rules and scatter baked again)
 *   --erode-edit                 the same with a script eroding a 64 m square beside the road every 4 s (one
 *                                `editTerrain` erode each, on the backend's worker; the seed alternates)
 *   --edits-only                 only the editor edits (no export measured)
 *   --edit-profile               the edit windows' main thread by function (inclusive, a CPU profile each)
 *   --foliage off                the landscape's scatter without the foliage policy: every tree, rock and shrub casts
 *                                into the static shadow map, the wind moves foliage everywhere, nothing thins out
 *                                (default: on, the engine's scatter defaults)
 *   --renderers webgpu,webgl2    (default both)
 *   --query 'a=b&c=d'            add to the export's page query
 *   --switches 'a=off,b=off'     measure each export again with each query added (one switch at a time)
 *   --record-ms N --warmup-ms N --gpu-ms N --profile-ms N --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/level-<time>.json (latest-level.json too).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { moduleIndex } from './profile';
import { launchGpuBrowser, LONG_FRAME_MS, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult } from './frame-run';
import { buildLevel, FLIGHT_SECONDS, levelPlan, LEVEL_ALL_KINDS, LEVEL_KINDS, LEVEL_SEED, LEVEL_VERSION, type LevelBuild, type LevelKind, type LevelRoofs } from './level';
import { frameLine } from './village-run';
import { hitches, installFrameClock, pageNow, rafTimes, type HitchWindow } from './blocks-run';
import { FRAME_VIEWPORT } from './frame-run';
import type { PerfBackend } from './backend';
import { publishFileVia } from './build';
import { makePng } from '../../tests/e2e/png-make';

/** The corner shading `--vertex-ao` gives the layer. */
const LEVEL_VERTEX_AO = 0.6;

/** How long a flight waits for its scene to load before it is measured (the scene never settles while the camera flies). */
const FLIGHT_SETTLE_MS = 20_000;

/** The soft whole-frame target (ms): 60 fps, on the frame interval's p95, the GPU's time and the main thread's. */
export const LEVEL_FRAME_TARGET_MS = 16.7;

export interface LevelReport {
  reportVersion: 1;
  startedAt: string;
  commit: string;
  machine: { cpu: string; cores: number };
  version: number;
  seed: number;
  /** Live door cells per class (absent: none). */
  liveDoors?: number;
  /** The rooms' walls are edge pieces (absent: cell walls). */
  edgeWalls?: boolean;
  /** The layer has wall paint and painted walls (absent: none). */
  wallPaint?: boolean;
  /** The rooms' roofs (absent: none). */
  roofs?: 'roofs' | 'cutaway';
  /** A script swapped the layer's kit every 2 s (absent: none). */
  kitSwap?: boolean;
  /** The layer's corner shading (absent: none). */
  vertexAO?: number;
  /** Material rules on the layer and the terrain (absent: none). */
  rules?: boolean;
  /** Every terrain layer's projection (absent: top). */
  projection?: number;
  /** The terrain's macro distance (absent: none). */
  macro?: number;
  /** The landscape's scatter without the foliage policy (absent: with it). */
  foliage?: 'off';
  /** The camera flew a loop (absent: still). */
  flight?: boolean;
  /** The screen size below which the landscape's trees, pines and rocks were impostors (absent: none). */
  impostorSize?: number;
  /** The landscape without its road and river (absent: with them). */
  splines?: 'off';
  /** The scripted road edits in the editor's Scene view: each edit's round trip (ms) and the page's frames meanwhile. */
  splineEdit?: Partial<Record<FrameRenderer, EditRun>>;
  /** The scripted terrain sculpts in the editor's Scene view, recorded the same way. */
  sculptEdit?: Partial<Record<FrameRenderer, EditRun>>;
  stampEdit?: Partial<Record<FrameRenderer, EditRun>>;
  erodeEdit?: Partial<Record<FrameRenderer, EditRun>>;
  query: string;
  builds: Partial<Record<LevelKind, LevelBuild & { exportMs: number }>>;
  classes: Partial<Record<LevelKind, Partial<Record<FrameRenderer, FrameRunResult>>>>;
  switches?: Partial<Record<LevelKind, Record<string, Partial<Record<FrameRenderer, FrameRunResult>>>>>;
  errors: string[];
}

export interface LevelTargetRow {
  kind: LevelKind;
  renderer: FrameRenderer;
  p50: number;
  p95: number;
  p99: number;
  /** GPU time per frame over the render passes (null: the renderer gave no timestamps). */
  gpuMs: number | null;
  mainThreadMs: number;
  draws: number;
  /** Each measure within the target (a null GPU time counts as not shown, not as a miss). */
  within: { p95: boolean; gpu: boolean | null; mainThread: boolean };
}

/** Each measured class and renderer against the whole-frame target. */
export function levelTargetRows(report: Pick<LevelReport, 'classes'>, target = LEVEL_FRAME_TARGET_MS): LevelTargetRow[] {
  const rows: LevelTargetRow[] = [];
  for (const kind of LEVEL_ALL_KINDS) {
    for (const [renderer, r] of Object.entries(report.classes[kind] ?? {}) as [FrameRenderer, FrameRunResult][]) {
      const gpuMs = r.gpu?.available === true ? r.gpu.msPerFrame : null;
      rows.push({ kind, renderer, p50: r.frames.p50, p95: r.frames.p95, p99: r.frames.p99, gpuMs, mainThreadMs: r.mainThread.taskMsPerFrame, draws: r.draws.p50, within: { p95: r.frames.p95 <= target, gpu: gpuMs === null ? null : gpuMs <= target, mainThread: r.mainThread.taskMsPerFrame <= target } });
    }
  }
  return rows;
}

export interface FarCostRow {
  renderer: FrameRenderer;
  p50Ms: number;
  p95Ms: number;
  gpuMs: number | null;
  mainThreadMs: number;
  draws: number;
}

/** What the landscape adds to the area (landscape minus area), per renderer measured in both. */
export function farCostRows(report: Pick<LevelReport, 'classes'>): FarCostRow[] {
  const out: FarCostRow[] = [];
  const d = (a: number, b: number): number => Math.round((a - b) * 100) / 100;
  for (const [renderer, l] of Object.entries(report.classes.landscape ?? {}) as [FrameRenderer, FrameRunResult][]) {
    const a = report.classes.area?.[renderer];
    if (a === undefined) continue;
    const gl = l.gpu?.available === true ? l.gpu.msPerFrame : null;
    const ga = a.gpu?.available === true ? a.gpu.msPerFrame : null;
    out.push({ renderer, p50Ms: d(l.frames.p50, a.frames.p50), p95Ms: d(l.frames.p95, a.frames.p95), gpuMs: gl === null || ga === null ? null : d(gl, ga), mainThreadMs: d(l.mainThread.taskMsPerFrame, a.mainThread.taskMsPerFrame), draws: l.draws.p50 - a.draws.p50 });
  }
  return out;
}

const flagOf = (argv: readonly string[]) => (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

export async function runLevelCli(argv: readonly string[]): Promise<void> {
  const get = flagOf(argv);
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const log = (s: string): void => console.log(s);
  const kinds = (get('classes') ?? LEVEL_KINDS.join(',')).split(',') as LevelKind[];
  for (const k of kinds) if (!LEVEL_ALL_KINDS.includes(k)) throw new Error(`--classes: ${LEVEL_ALL_KINDS.join(', ')}, not ${k}`);
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  for (const r of renderers) if (r !== 'webgpu' && r !== 'webgl2') throw new Error(`--renderers: webgpu or webgl2, not ${r}`);
  const flight = has('flight') || has('flight-plain');
  const impostorSize = Number(get('impostors') ?? 0);
  if (!(Number.isFinite(impostorSize) && impostorSize >= 0 && impostorSize <= 1)) throw new Error(`--impostors: a screen size (0-1), not ${get('impostors')}`);
  // A flight draws at the display's rate as a player's browser does (a dropped frame shows as a long interval);
  // uncapped, a GPU-bound page runs ahead and then waits, so its intervals alternate whatever it costs.
  const vsync = has('vsync') || (flight && !has('uncapped'));
  const recordMs = Number(get('record-ms') ?? (flight ? FLIGHT_SECONDS * 1000 : 10000));
  const warmupMs = Number(get('warmup-ms') ?? 3000);
  const gpuMs = Number(get('gpu-ms') ?? 3000);
  const profileMs = Number(get('profile-ms') ?? 5000);
  const query = get('query') !== undefined ? `&${get('query')}` : '';
  const switches = (get('switches') ?? '').split(',').filter((x) => x !== '');
  const liveDoors = Number(get('live') ?? 0);
  if (!Number.isInteger(liveDoors) || liveDoors < 0) throw new Error(`--live: a whole number of door cells, not ${get('live')}`);
  const roofs: LevelRoofs = has('cutaway') ? 'cutaway' : has('roofs') ? 'roofs' : 'none';
  const projection = Number(get('projection') ?? 0);
  const macro = Number(get('macro') ?? 0);
  if (!(Number.isFinite(macro) && macro >= 0)) throw new Error(`--macro: metres, not ${get('macro')}`);
  if (![0, 1, 2].includes(projection)) throw new Error(`--projection: 1 (by slope) or 2 (biplanar), not ${get('projection')}`);
  const splines = get('splines') ?? 'on';
  if (splines !== 'on' && splines !== 'off') throw new Error(`--splines: on or off, not ${splines}`);
  const foliage = get('foliage') ?? 'on';
  if (foliage !== 'on' && foliage !== 'off') throw new Error(`--foliage: on or off, not ${foliage}`);

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `level-${stamp}`);
  const reportsDir = join(PERF_ROOT, 'reports');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: LevelReport = { reportVersion: 1, startedAt, commit, machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length }, version: LEVEL_VERSION, seed: LEVEL_SEED, ...(liveDoors > 0 ? { liveDoors } : {}), ...(has('edge-walls') ? { edgeWalls: true } : {}), ...(has('wall-paint') ? { wallPaint: true } : {}), ...(roofs !== 'none' ? { roofs } : {}), ...(has('kit-swap') ? { kitSwap: true } : {}), ...(has('vertex-ao') ? { vertexAO: LEVEL_VERTEX_AO } : {}), ...(has('rules') ? { rules: true } : {}), ...(projection > 0 ? { projection } : {}), ...(macro > 0 ? { macro } : {}), ...(foliage === 'off' ? { foliage: 'off' as const } : {}), ...(flight ? { flight: true } : {}), ...(impostorSize > 0 ? { impostorSize } : {}), ...(splines === 'off' ? { splines: 'off' as const } : {}), query, builds: {}, classes: {}, errors: [] };

  // Every class built and exported by one backend, then measured with it stopped (one backend or one browser at a time).
  const exportDirs: Partial<Record<LevelKind, string>> = {};
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  try {
    for (const kind of kinds) {
      const b = await buildLevel(be, `level-${kind}`, levelPlan(kind, LEVEL_SEED, liveDoors, has('edge-walls'), has('wall-paint'), roofs, has('kit-swap'), has('vertex-ao') ? LEVEL_VERTEX_AO : 0, has('rules'), projection, macro, foliage, flight, impostorSize, splines === 'on', !has('flight-plain')), log);
      if (has('spline-edit') && kind === 'landscape' && splines === 'on') report.splineEdit = await editWindows(be, b.projectId, renderers, 'spline', log, has('edit-profile'));
      if (has('sculpt-edit') && kind === 'landscape') report.sculptEdit = await editWindows(be, b.projectId, renderers, 'sculpt', log, has('edit-profile'));
      if (has('stamp-edit') && kind === 'landscape') report.stampEdit = await editWindows(be, b.projectId, renderers, 'stamp', log, has('edit-profile'));
      if (has('erode-edit') && kind === 'landscape') report.erodeEdit = await editWindows(be, b.projectId, renderers, 'erode', log, has('edit-profile'));
      if (has('edits-only')) continue;
      const t = performance.now();
      const res = await be.post(`/api/v1/admin/projects/${b.projectId}/export`, {});
      if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
      report.builds[kind] = { ...b, exportMs: Math.round(performance.now() - t) };
      exportDirs[kind] = join(be.exportRoot, String(res.json['outputDir']));
      log(`level ${kind}: built in ${b.ms} ms (${b.commands} commands), exported in ${report.builds[kind]!.exportMs} ms`);
    }
  } finally {
    await be.stop();
  }

  const browser = await launchGpuBrowser({ vsync });
  try {
    for (const kind of kinds) {
      if (exportDirs[kind] === undefined) continue;
      const site = await serveStatic(exportDirs[kind]!);
      try {
        for (const r of renderers) {
          const res = await measurePage(browser, { url: `${site.url}?renderer=${r}${query}`, warmupMs, recordMs, gpuMs, profileMs, sourceOf: sourcesOf(site), shot: join(runDir, `${kind}-${r}.png`), ...(flight ? { settleMs: FLIGHT_SETTLE_MS } : {}) });
          (report.classes[kind] ??= {})[r] = res;
          log(frameLine(`level ${kind} ${r}`, res));
          // Each restyle (a kit swapped) the page timed: its chunks, how long they took to arrive, its frames and long frames.
          const restyles = (res.marks ?? []).filter((m) => m.name === 'tl:blocks:restyle').map((m) => m.detail as { ms: number; chunks: number; frames: number; longFrames: number; longestFrameMs: number; longestFrameAt: number; longestUpdateMs: number });
          // Each scatter set made (a copy removed on the way, a re-bake): its main-thread and worker time.
          const made = (res.marks ?? []).filter((m) => m.name === 'tl:scatter:made').map((m) => m.detail as { ms: number; frameMs?: number; frames?: number; prepareMs: number; copies: number });
          // A set is made over frames: its most in one frame is what a refresh waits on, its whole the page's cost.
          if (made.length > 0) log(`level ${kind} ${r} scatter sets made: ${made.length}, main thread ≤ ${Math.max(...made.map((d) => d.frameMs ?? d.ms)).toFixed(2)} ms a frame (a set ≤ ${Math.max(...made.map((d) => d.ms)).toFixed(2)} ms over ≤ ${Math.max(...made.map((d) => d.frames ?? 1))} frames, mean ${(made.reduce((a, d) => a + d.ms, 0) / made.length).toFixed(2)}), prepared on the worker ≤ ${Math.max(...made.map((d) => d.prepareMs)).toFixed(2)} ms, ≤ ${Math.max(...made.map((d) => d.copies))} copies`);
          // At the display's rate a frame over 16.7 ms is one that missed a refresh (the intervals' jitter is not); uncapped, every interval over it counts.
          if (flight) log(`level ${kind} ${r} flight: ${res.frames.n} frames in ${Math.round(recordMs / 1000)} s, ${vsync ? `${res.frames.missed ?? 0} missed a 60 Hz refresh (vsync)` : `${res.frames.long ?? 0} over ${LONG_FRAME_MS} ms (uncapped)`}, longest ${res.frames.max ?? '-'} ms`);
          // Each missed refresh and the engine's marks in the 50 ms before it (a set made, a node build): what it waited on.
          if (flight && has('missed-marks')) for (const at of res.frames.missedAt ?? []) log(`level ${kind} ${r} missed at ${at} ms: ${(res.marks ?? []).filter((m) => m.at <= at && m.at >= at - 50).map((m) => `${m.name} ${JSON.stringify(m.detail)}`).join('; ') || 'no mark'}`);
          // World streaming (a class that streams): what is resident against the budget, the deciding's main-thread time.
          const st = res.scene.streaming as { budgetBytes: number; residentBytes: number; peakResidentBytes: number; ringBytes: number; overBudget: boolean; ms: { mean: number; max: number }; kinds: Record<string, { resident: number; bytes: number; inRing: number; kept: number; evicted: number }> } | undefined;
          if (st !== undefined) {
            const mb = (b: number): string => `${(b / (1024 * 1024)).toFixed(1)} MiB`;
            log(`level ${kind} ${r} streaming: resident ${mb(st.residentBytes)} (peak ${mb(st.peakResidentBytes)}) of a ${mb(st.budgetBytes)} budget${st.overBudget ? ' (OVER)' : ''}, ${Object.entries(st.kinds).map(([k, v]) => `${k} ${v.resident} (${mb(v.bytes)}; in rings ${v.inRing}, kept ${v.kept}, let go for the budget ${v.evicted})`).join(', ')}; deciding ${st.ms.mean} ms a frame (most ${st.ms.max})`);
          }
          if (restyles.length > 0) log(`level ${kind} ${r} restyles: ${restyles.length}, ${restyles.map((d) => `${d.chunks} chunks ${d.ms} ms ${d.frames} frames (${d.longFrames} over 16.7 ms, longest ${d.longestFrameMs} ms at frame ${d.longestFrameAt}, view update ≤ ${d.longestUpdateMs} ms)`).join('; ')}`);
          for (const sw of switches) {
            const off = await measurePage(browser, { url: `${site.url}?renderer=${r}${query}&${sw}`, warmupMs, recordMs, gpuMs, profileMs: 0, sourceOf: sourcesOf(site) });
            (((report.switches ??= {})[kind] ??= {})[sw] ??= {})[r] = off;
            log(frameLine(`level ${kind} ${r} ${sw}`, off));
          }
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await browser.close();
  }

  const out = get('out') ?? join(reportsDir, `level-${stamp}.json`);
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  copyFileSync(out, join(reportsDir, 'latest-level.json'));
  log(`level: report ${out}${has('keep') ? `, run folder ${runDir}` : ''}`);
  if (!has('keep')) rmSync(runDir, { recursive: true, force: true });

  const ok = (b: boolean | null): string => (b === null ? 'not shown' : b ? 'within' : 'over');
  for (const row of levelTargetRows(report)) {
    log(`level ${row.kind} ${row.renderer}: frame p50/p95/p99 ${row.p50}/${row.p95}/${row.p99} ms (p95 ${ok(row.within.p95)} ${LEVEL_FRAME_TARGET_MS} ms), gpu ${row.gpuMs ?? '-'} ms (${ok(row.within.gpu)}), main thread ${row.mainThreadMs} ms (${ok(row.within.mainThread)}), ${row.draws} draws`);
  }
  for (const row of farCostRows(report)) log(`level far part ${row.renderer} (landscape − area): p50 ${row.p50Ms} ms, p95 ${row.p95Ms} ms, gpu ${row.gpuMs ?? '-'} ms, main thread ${row.mainThreadMs} ms, ${row.draws} draws`);
  for (const e of report.errors) log(`level: error: ${e}`);
  for (const [kind, byR] of Object.entries(report.classes)) for (const [r, res] of Object.entries(byR ?? {})) for (const e of res?.errors.slice(0, 3) ?? []) log(`level ${kind} ${r}: page error: ${e}`);
}

/** How long the Scene view is watched after each scripted road edit (ms), and how many edits. */
const SPLINE_EDIT_WINDOW_MS = 4000;
const SPLINE_EDITS = 6;
const SPLINE_IDLE_WINDOWS = 3;

/** An edit window's frames, and what the page built in it: node programs and pipelines (by object), scatter sets made. */
export type EditWindow = HitchWindow & { over16: number; nodeBuilds?: number; nodeBuildMs?: number; pipelines?: number; pipelineMs?: number; built?: string[]; setsMade?: number; setMs?: number };

/** What `--spline-edit` / `--sculpt-edit` record per renderer. */
export interface EditRun {
  roundTripMs: number[];
  windows: EditWindow[];
  idle: EditWindow[];
}

/** A scripted sculpt's radius and height (m): it raises and lowers the ground under a stored tree near the road's edited point. */
const SCULPT_RADIUS = 12;
const SCULPT_METRES = 2;
/** A scripted stamp's side and height, and a scripted erosion's square side (m), at the same place. */
const STAMP_SIZE = 64;
const STAMP_METRES = 40;
const ERODE_SIDE = 64;
/** The stamp's shape: a cone, 128² 8-bit. */
const STAMP_ASSET = 'perf-stamp-cone';

/**
 * The landscape's editor Scene view open while a script edits it every few seconds: `spline` moves a road point 5 m
 * back and forth (one `setComponent` each: the backend shapes the terrain under the road again and makes its mesh
 * again), `sculpt` raises and lowers the ground beside it (one `editTerrain` each: the tiles and their scatter
 * baked again); the page re-reads and uploads the tiles and draws what is new. Each edit's round trip, the page's
 * frames in the window after it, and what three built meanwhile (the page's marks).
 */
async function editWindows(be: PerfBackend, projectId: string, renderers: readonly FrameRenderer[], kind: 'spline' | 'sculpt' | 'stamp' | 'erode', log: (s: string) => void, profile = false): Promise<Partial<Record<FrameRenderer, EditRun>>> {
  const p = be.project(projectId);
  const listed = ((await p.query('queryEntities', { limit: 4000, offset: 0 }))['entities'] as { id: string; name?: string; components: Record<string, unknown> }[]) ?? [];
  const road = listed.find((e) => e.name === 'Road' && e.components['spline'] !== undefined);
  const terrain = listed.find((e) => e.components['terrain'] !== undefined);
  if (road === undefined || terrain === undefined) throw new Error(`${kind} edit: no road or terrain`);
  const base = road.components['spline'] as { points: { at: number[] }[] };
  // Where a sculpt bakes scatter again: the stored copy nearest the edited road point that is 30 m or more off it.
  const [px, , pz] = base.points[5]!.at as [number, number, number];
  const near = ((((await p.query('queryTerrain', { entityId: terrain.id, scatter: { box: [px - 150, pz - 150, px + 150, pz + 150] } }))['scatter'] as { copies?: { x: number; z: number }[] } | undefined)?.copies) ?? [])
    .map((c) => ({ c, d: Math.hypot(c.x - px, c.z - pz) }))
    .filter((c) => c.d >= 30)
    .sort((a, b) => a.d - b.d)[0]?.c;
  const sculptAt: [number, number] = near !== undefined ? [near.x, near.z] : [px - 40, pz];
  if (kind === 'stamp') {
    const cone = makePng(128, 128, (x, y) => {
      const v = Math.round(Math.max(0, 1 - Math.hypot(x - 63.5, y - 63.5) / 63.5) * 255);
      return [v, v, v, 255];
    });
    await publishFileVia(be, projectId, (op, args) => p.command(op, args), { assetId: STAMP_ASSET, kind: 'texture', displayName: 'Stamp cone', bytes: cone });
  }
  const edit = async (k: number): Promise<void> => {
    if (kind === 'stamp') {
      const layers = k % 2 === 0 ? [{ id: 'perf-stamps', kind: 'stamps', stamps: [{ asset: STAMP_ASSET, at: sculptAt, size: STAMP_SIZE, height: STAMP_METRES }] }] : null;
      await p.command('setComponent', { entityId: terrain.id, component: 'terrain', value: { layers } });
    } else if (kind === 'erode') {
      const h = ERODE_SIDE / 2;
      await p.command('editTerrain', { entityId: terrain.id, kind: 'erode', rect: [sculptAt[0] - h, sculptAt[1] - h, sculptAt[0] + h, sculptAt[1] + h], hydraulic: {}, thermal: {}, seed: k % 2 });
    } else if (kind === 'spline') {
      const points = base.points.map((q, i) => (i === 5 ? { ...q, at: [q.at[0]!, q.at[1]!, q.at[2]! + (k % 2 === 0 ? 5 : 0)] } : q));
      await p.command('setComponent', { entityId: road.id, component: 'spline', value: { points } });
    } else {
      await p.command('editTerrain', { entityId: terrain.id, kind: k % 2 === 0 ? 'raise' : 'lower', dabs: [sculptAt], radius: SCULPT_RADIUS, strength: SCULPT_METRES, falloff: 'smooth' });
    }
  };
  const out: Partial<Record<FrameRenderer, EditRun>> = {};
  const browser = await launchGpuBrowser({ vsync: false });
  try {
    for (const r of renderers) {
      const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
      await context.addInitScript(installFrameClock);
      const page = await context.newPage();
      try {
        await page.goto(`${be.origin}/?project=${projectId}&renderer=${r}#token=${be.token}`);
        await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 180_000 });
        // Settled: the view stopped drawing for a few seconds (every tile, set and mesh in).
        let last = '';
        for (let same = 0, t0 = Date.now(); same < 3 && Date.now() - t0 < 180_000; ) {
          const now = await page.evaluate(() => document.querySelector('canvas.tl-viewport')?.getAttribute('data-frames') ?? '');
          same = now === last && now !== '' ? same + 1 : 0;
          last = now;
          await new Promise((res) => setTimeout(res, 1000));
        }
        const roundTripMs: number[] = [];
        const windows: EditWindow[] = [];
        // Windows without an edit first: the class's own slow frames (uncapped, this GPU) to read the edits' against.
        const idle: EditWindow[] = [];
        // The edit windows' main thread by function (inclusive), with --edit-profile.
        const cdp = profile ? await context.newCDPSession(page) : null;
        const inclusive = new Map<string, number>();
        for (let k = -SPLINE_IDLE_WINDOWS; k < SPLINE_EDITS; k++) {
          if (cdp !== null && k >= 0) {
            await cdp.send('Profiler.enable');
            await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
            await cdp.send('Profiler.start');
          }
          const from = await pageNow(page);
          // The profile's clock is not the page's: its start taken as this moment (a few ms out at most).
          const profiledFrom = from;
          if (k >= 0) {
            const t = performance.now();
            await edit(k);
            roundTripMs.push(Math.round(performance.now() - t));
          }
          await new Promise((res) => setTimeout(res, SPLINE_EDIT_WINDOW_MS));
          const times = await rafTimes(page);
          if (cdp !== null && k >= 0) {
            const { profile: prof } = (await cdp.send('Profiler.stop')) as unknown as { profile: EditProfile };
            // Only the samples in the window's frames over 16.7 ms (what they did that the others did not).
            const long: [number, number][] = [];
            for (let i = 1; i < times.length; i++) if (times[i]! > from && times[i]! - times[i - 1]! > 16.7) long.push([times[i - 1]!, times[i]!]);
            addInclusive(prof, inclusive, (t) => long.some(([a, b]) => t >= a - profiledFrom && t <= b - profiledFrom));
          }
          const to = await pageNow(page);
          let over16 = 0;
          for (let i = 1; i < times.length; i++) if (times[i]! > from && times[i]! <= to && times[i]! - times[i - 1]! > 16.7) over16 += 1;
          const marks = await page.evaluate(
            ([a, b]) =>
              performance
                .getEntriesByType('mark')
                .filter((m) => m.startTime > a! && m.startTime <= b! && (m.name === 'tl:node-build' || m.name === 'tl:pipeline' || m.name === 'tl:scatter:made'))
                .map((m) => ({ name: m.name, detail: (m as PerformanceMark).detail as { object?: string; material?: string; ms: number } })),
            [from, to],
          );
          const nb = marks.filter((m) => m.name === 'tl:node-build');
          const pl = marks.filter((m) => m.name === 'tl:pipeline');
          const sets = marks.filter((m) => m.name === 'tl:scatter:made');
          const sum = (xs: typeof marks): number => Math.round(xs.reduce((a, m) => a + m.detail.ms, 0) * 10) / 10;
          const names = new Map<string, number>();
          for (const m of [...nb, ...pl]) {
            const key = `${m.name === 'tl:node-build' ? 'node' : 'pipe'} ${(m.detail.object ?? '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '#')} [${m.detail.material ?? ''}]`;
            names.set(key, (names.get(key) ?? 0) + 1);
          }
          (k >= 0 ? windows : idle).push({ ...hitches(times, from, to), over16, nodeBuilds: nb.length, nodeBuildMs: sum(nb), pipelines: pl.length, pipelineMs: sum(pl), built: [...names].map(([n, c]) => `${c}× ${n}`).slice(0, 24), setsMade: sets.length, setMs: sum(sets) });
        }
        out[r] = { roundTripMs, windows, idle };
        const show = (ws: EditWindow[]): string => ws.map((w) => `${w.frames} frames, ${w.over16 ?? 0} > 16.7 ms, worst ${w.worst} ms, p95 ${w.p95} ms, ${w.nodeBuilds} builds ${w.nodeBuildMs} ms, ${w.pipelines} pipelines ${w.pipelineMs} ms, ${w.setsMade} sets ${w.setMs} ms`).join('; ');
        if (kind !== 'spline') log(`level landscape ${r} ${kind} at ${sculptAt.map((v) => v.toFixed(1)).join(', ')} (road point ${px.toFixed(1)}, ${pz.toFixed(1)})`);
        log(`level landscape ${r} ${kind} edits: round trips ${roundTripMs.join(', ')} ms; page frames per window: ${show(windows)}; without edits: ${show(idle)}`);
        const built = new Map<string, number>();
        for (const w of windows) for (const b of w.built ?? []) built.set(b, (built.get(b) ?? 0) + 1);
        if (built.size > 0) log(`level landscape ${r} ${kind} edits built (windows each was in): ${[...built].map(([b, c]) => `${b} (${c})`).join('; ')}`);
        if (inclusive.size > 0) log(`level landscape ${r} ${kind} edits' frames over 16.7 ms, main thread by function (inclusive ms, ${SPLINE_EDITS} windows): ${[...inclusive].sort((x, y) => y[1] - x[1]).slice(0, 40).map(([f, ms]) => `${f} ${ms.toFixed(1)}`).join('; ')}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

interface EditProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
}

/** The editor page's bundles' module starts (read from dist/editor by URL path). */
const editorModules = new Map<string, ReturnType<typeof moduleIndex> | null>();

/**
 * Add a profile's time per function (name and module, counted once per sample however deep it recurses) to `into`,
 * of the samples `when` keeps (ms since the profile started).
 */
function addInclusive(profile: EditProfile, into: Map<string, number>, when: (ms: number) => boolean = () => true): void {
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const moduleOf = (url: string, line: number): string => {
    const path = url.replace(/^[a-z]+:\/\/[^/]+\//, '').split('?')[0]!;
    if (!editorModules.has(path)) {
      const file = join(REPO, 'dist', 'editor', path);
      editorModules.set(path, path !== '' && existsSync(file) ? moduleIndex(readFileSync(file, 'utf8')) : null);
    }
    const idx = editorModules.get(path);
    if (idx === null || idx === undefined) return path;
    let k = -1;
    for (let lo = 0, hi = idx.lines.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (idx.lines[mid]! <= line) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return k >= 0 ? idx.paths[k]!.replace(/^(packages|node_modules)\//, '') : path;
  };
  const keyOf = new Map<number, string>();
  let at = 0;
  for (let i = 0; i < profile.samples.length; i += 1) {
    at += (profile.timeDeltas[i] ?? 0) / 1000;
    const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    if (!when(at)) continue;
    const seen = new Set<string>();
    for (let id: number | undefined = profile.samples[i]; id !== undefined; id = parent.get(id)) {
      let key = keyOf.get(id);
      if (key === undefined) {
        const n = byId.get(id)!;
        key = `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url === '' ? '' : moduleOf(n.callFrame.url, n.callFrame.lineNumber + 1)}`.trim();
        keyOf.set(id, key);
      }
      if (key === '(idle)' || key === '(root)' || key === '(program)') break;
      seen.add(key);
    }
    for (const key of seen) into.set(key, (into.get(key) ?? 0) + dt);
  }
}
