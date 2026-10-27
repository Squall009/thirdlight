/**
 * The village measurement (`node tools/perf/run.mjs village …`): the
 * village class (village.ts) built through a private backend and exported,
 * its export measured on both renderers, and the same content as a plain
 * three.js page (tools/perf/bare/, rebuilt from a dump of the export's
 * drawn scene) measured the same way.
 *
 *   --renderers webgpu,webgl2    (default both)
 *   --project <folder>           measure a copy of a game project instead of the village (never the game's own folder:
 *                                the backend writes into what it registers); --steps '<json>' reaches its view
 *   --no-bare                    skip the plain three.js page
 *   --scene-view                 also measure the editor's Scene view on the same content (scene-view-run.ts),
 *                                orbiting the editor's opening view; --no-export skips the export; --orbit F sizes the
 *                                orbit's pointer circle as a fraction of the view's width (default 0.04: a slow look
 *                                round; 0.4 swings the camera across the level)
 *   --ablation                   the per-draw ablation on the plain page: + 16 dark point lights, + per-object
 *                                material copies, + the engine's node materials (each alone)
 *   --first-bare                 also measure the first plain page (`fair=0`: noise textures, no environment
 *                                lighting or grading, skinned meshes at rest) beside the plain page of the same content
 *   --query 'a=b&c=d'            add to the export's and the Scene view's page query (e.g. merging=off to compare)
 *   --switches 'a=off,b=off&c=d' measure the export again with each of these queries in the same browser after its own
 *                                run (one optimization switched off at a time: each one's share of the frame)
 *                                (`occlusion=hiz`: occlusion culling on, as the setting's auto culls nothing; each frame line logs the page's
 *                                `data-tl-occlusion` path|occludees|tested|culled|stand-ins)
 *   --vsync                      draw at the display's rate (a player's browser) instead of uncapped: frame drops
 *                                show as intervals of two refreshes or more
 *   --busy N                     also trace N ms of each export run for busy time per second: the page's main thread, its
 *                                workers and the GPU process (with --vsync and --switches 'frameRateCap=60,frameRateCap=30':
 *                                what a frame-rate cap saves)
 *   --point-lights N             add N point lights over the scatter (village.ts addVillageLamps; not in the baseline):
 *                                what local lights over foliage cost
 *   --flight R                   the camera flies a loop of R metres round the village's middle, a lap a minute
 *                                (village.ts addVillageFlight; not in the baseline): what streams round a moving view
 *   --fire-gpu-systems           every fire also has flames (64) and smoke (48, alpha-sorted) beside its sparks (village.ts
 *                                addFireGpuSystems; not in the baseline): many plays of one GPU-simulated effect
 *   --bake                       "Bake lighting" in the editor (WebGPU) before the export: the export then draws the
 *                                saved light where it is not live (its cost against a run without; the bake's time)
 *   --synthetic-probes N         record about N synthetic probe tiles (probe-synthetic.ts: a 2 m grid over a square
 *                                around the village, ~2 km a side for 512) as the scene's probe bake: probe streaming
 *                                at world scale (its frame time against --switches probes=off, the tiles' arrival)
 *   --gate                       the fast gate's check: the export only, at the display's cap (implies --vsync; no GPU
 *                                passes, profile or plain page)
 *   --check FILE                 compare the export at the cap with a recorded baseline: exit 1 when more than
 *                                CAP_MISSED_SHARE of the frames missed a refresh or the main thread's CPU time per
 *                                frame is worse than CAP_MAIN_REGRESSION (a fraction) on any renderer
 *   --write-baseline FILE        record this run's main-thread times at the cap as the baseline
 *   --view street                also export the village seen from the street (village.ts villageViewCamera: eye height,
 *                                level, the props in front hiding much of the rest) and measure it after the open view,
 *                                both with the occlusion oracle (implies --oracle); `--switches` are measured there too
 *   --oracle                     after each export run, count what the view drew that no pixel showed (three-adapter
 *                                occlusion-oracle.ts): hidden draws, items (copies, merged members) and triangles
 *   --see-through N              N figures nearest the camera's line of sight named see-through's subjects by a script:
 *                                the export measured again with it on, then switched on mid-run (see-through-run.ts);
 *                                measure with --vsync
 *   --see-through-fade F         with --see-through: the subjects' max fade (0: the mask runs, nothing thinned: its own cost)
 *   --record-ms N --warmup-ms N --gpu-ms N --profile-ms N --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/<village or the project folder's name>-<time>.json
 * (latest-<name>.json too). tools/perf/games.sh runs it on copies of game projects.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join, resolve } from 'node:path';

import * as esbuild from 'esbuild';

import { hiddenFractions, ORACLE_KINDS, type OracleShare } from '@thirdlight/three-adapter';

import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult, type PageStep } from './frame-run';
import { bakeLightingInEditor } from './bake-run';
import { addSyntheticProbes } from './probe-synthetic';
import { measureSceneView, sceneViewLine, type SceneViewResult } from './scene-view-run';
import { FRAME_HISTOGRAM_EDGES_MS } from './stats';
import { addFireGpuSystems, addVillageFlight, addVillageLamps, buildVillage, villagePlan, villageViewCamera, VILLAGE_SEED, VILLAGE_VERSION, type VillageBuild, type VillagePlan, type VillageView } from './village';
import { addSeeThroughSubjects, candidatesOf, exportPrebuilt, seeThroughRuns, subjectsInView, type SeeThroughReport } from './see-through-run';

/**
 * The fast gate's check measures at the display's 60 Hz cap (vsync), never uncapped: uncapped, frame times read how
 * hard this mobile chip's CPU and iGPU (one power budget) were pushed and by what else, run to run, so a check
 * on them missed on host state on most commits. At the cap every frame is one refresh, so the check reads what a
 * player sees (refreshes missed) and the work behind a frame (the main thread's CPU time).
 *
 * A run fails when more than this share of its frames missed a refresh: a frame over budget misses most
 * refreshes, while a busy host (another session's Blender on 5 cores) costs a few percent.
 */
export const CAP_MISSED_SHARE = 0.1;
/**
 * A run fails when the main thread's CPU time per frame (CDP `ThreadTime`, not task wall time, which grows with
 * the time the thread waited for a core) is worse than the baseline's by more than this fraction. Generous: on
 * this host a busy neighbour still costs the thread up to ~50 % (shared cores run slower), so the check catches
 * a frame's work growing by more than half, and a frame over budget through the missed share.
 */
export const CAP_MAIN_REGRESSION = 0.6;

/** The plain page's variants: the default, and the ablation's additions one at a time. */
export const BARE_VARIANTS = {
  bare: '',
  first: 'fair=0',
  'dark-lights': 'lights=16',
  'material-copies': 'copies=1',
  'node-materials': 'nodemat=1',
} as const;
export type BareVariant = keyof typeof BARE_VARIANTS;

export interface VillageReport {
  reportVersion: 1;
  kind: 'village' | 'project';
  startedAt: string;
  commit: string;
  machine: { cpu: string; cores: number; gpu: string };
  subject: { name: string; version?: number; seed?: number; build?: VillageBuild; exportMs?: number };
  export: Partial<Record<FrameRenderer, FrameRunResult>>;
  /** `--synthetic-probes`: the probe tiles recorded before the export. */
  probes?: Record<string, unknown>;
  /** `--bake`: "Bake lighting" before the export. */
  bake?: Record<string, unknown>;
  bare: Partial<Record<BareVariant, Partial<Record<FrameRenderer, FrameRunResult>>>>;
  /** The editor's Scene view on the same content (`--scene-view`). */
  sceneView?: Partial<Record<FrameRenderer, SceneViewResult>>;
  /** The export with each `--switches` query added, per query. */
  switches?: Record<string, Partial<Record<FrameRenderer, FrameRunResult>>>;
  /** `--view`: the export seen from that view instead of the open one; `switches` as above, at the view. */
  views?: Partial<Record<VillageView, { camera: VillagePlan['camera']; export: Partial<Record<FrameRenderer, FrameRunResult>>; switches?: Record<string, Partial<Record<FrameRenderer, FrameRunResult>>> }>>;
  /** `--see-through N`: the export with see-through on round N subjects, and switched on mid-run. */
  seeThrough?: SeeThroughReport;
  errors: string[];
}

export interface FrameBaseline {
  note: string;
  recordedAt: string;
  commit: string;
  machine: VillageReport['machine'];
  subject: string;
  version: number;
  /** The display rate the baseline was measured at (vsync); a baseline without one was measured uncapped. */
  capHz?: number;
  /** The export's main-thread CPU ms per drawn frame, per renderer: the checked number. */
  mainCpuMsPerFrame?: Partial<Record<FrameRenderer, number>>;
  /** The same frames' main-thread task wall time (reported beside the CPU time, not checked). */
  mainTaskMsPerFrame?: Partial<Record<FrameRenderer, number>>;
}

/** The display rate the gate's check measures at. */
export const CAP_HZ = 60;

export interface FrameRegression {
  renderer: FrameRenderer;
  metric: 'main' | 'missed';
  baseline: number;
  value: number;
  limit: number;
}

/**
 * The comparison the gate makes on a run at the cap: renderers that missed more than {@link CAP_MISSED_SHARE} of
 * their refreshes, or whose main-thread CPU per frame is over the baseline by more than {@link CAP_MAIN_REGRESSION}.
 * A renderer the baseline names that the run did not measure (or that drew nothing) fails too: the check proves
 * nothing then. A baseline recorded uncapped is refused: it must be re-recorded at the cap.
 */
export function frameRegressions(base: FrameBaseline, report: Pick<VillageReport, 'export'>, mainTolerance = CAP_MAIN_REGRESSION, missedShare = CAP_MISSED_SHARE): FrameRegression[] {
  const out: FrameRegression[] = [];
  if (base.capHz !== CAP_HZ || base.mainCpuMsPerFrame === undefined) throw new Error('the baseline was recorded uncapped: re-record it at the cap');
  for (const [r, b] of Object.entries(base.mainCpuMsPerFrame) as [FrameRenderer, number][]) {
    const res = report.export[r];
    const n = res?.frames.n ?? 0;
    const missedLimit = Math.floor(n * missedShare);
    const missed = res?.frames.missed;
    if (res === undefined || n === 0 || missed === undefined || missed > missedLimit) out.push({ renderer: r, metric: 'missed', baseline: 0, value: missed ?? -1, limit: missedLimit });
    const cpu = res?.mainThread.cpuMsPerFrame;
    const limit = frameLimit(b, mainTolerance);
    if (cpu === undefined || cpu <= 0 || cpu > limit) out.push({ renderer: r, metric: 'main', baseline: b, value: cpu ?? -1, limit });
  }
  return out;
}

const frameLimit = (baseline: number, tolerance: number): number => Math.round(baseline * (1 + tolerance) * 100) / 100;

export interface AblationRow {
  renderer: FrameRenderer;
  variant: BareVariant;
  frameMs: number;
  /** Against the plain page without the addition (same renderer). */
  deltaMs: number;
  gpuMs: number | null;
  draws: number;
  /** The added frame time spread over the plain page's draws (µs). */
  usPerDraw: number;
}

/** The class against the plain page of the same content, per renderer (median frame time; lower is faster). */
export interface PlainPageRow {
  readonly renderer: FrameRenderer;
  readonly classP50Ms: number;
  readonly plainP50Ms: number;
  readonly classFps: number;
  readonly plainFps: number;
  /** Percent the class's median frame is shorter than the plain page's (negative: the plain page is faster). */
  readonly aheadPercent: number;
}

/**
 * The done-bar of the performance phase as a number: the class's export
 * against the plain three.js page drawing the same content, measured the
 * same way. Reported by the fast gate's perf check, never failing it
 * (whether it should is the owner's call).
 */
export function plainPageRows(report: Pick<VillageReport, 'export' | 'bare'>): PlainPageRow[] {
  const out: PlainPageRow[] = [];
  for (const [renderer, c] of Object.entries(report.export) as [FrameRenderer, FrameRunResult | undefined][]) {
    const p = report.bare.bare?.[renderer];
    if (c === undefined || p === undefined) continue;
    out.push({ renderer, classP50Ms: c.frames.p50, plainP50Ms: p.frames.p50, classFps: c.frames.fps, plainFps: p.frames.fps, aheadPercent: Math.round(((p.frames.p50 - c.frames.p50) / p.frames.p50) * 1000) / 10 });
  }
  return out;
}

/** Each ablation step's cost against the plain page: frame time added, and per draw. */
export function ablationRows(report: Pick<VillageReport, 'bare'>): AblationRow[] {
  const rows: AblationRow[] = [];
  for (const [variant, byRenderer] of Object.entries(report.bare) as [BareVariant, Partial<Record<FrameRenderer, FrameRunResult>>][]) {
    for (const [renderer, r] of Object.entries(byRenderer) as [FrameRenderer, FrameRunResult][]) {
      const base = report.bare.bare?.[renderer];
      if (base === undefined) continue;
      const delta = r.frames.mean - base.frames.mean;
      const draws = base.draws.p50;
      rows.push({ renderer, variant, frameMs: r.frames.mean, deltaMs: Math.round(delta * 1000) / 1000, gpuMs: r.gpu?.available === true ? r.gpu.msPerFrame : null, draws: r.draws.p50, usPerDraw: draws > 0 ? Math.round((delta * 1000 * 100) / draws) / 100 : 0 });
    }
  }
  return rows;
}

const flagOf = (argv: readonly string[]) => (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** The frame histogram for the log: share of frames per bucket, in percent. */
const hist = (h: readonly number[] | undefined): string => {
  if (h === undefined) return '';
  const e = FRAME_HISTOGRAM_EDGES_MS;
  const names = h.map((_, i) => (i === 0 ? `<${e[0]}` : i === e.length ? `≥${e[e.length - 1]}` : `${e[i - 1]}–${e[i]}`));
  return ` (${h.map((v, i) => `${names[i]}: ${Math.round(v * 1000) / 10}%`).join(', ')})`;
};

/** One line per measured page for the log. */
/** The surface cache at the end of a run: what it holds against its budget, how far it streamed. */
export function surfaceCacheNote(r: FrameRunResult): string {
  const c = r.scene.surfaceCache as { budgetBytes: number; usedBytes: number; peakUsedBytes: number; ringBytes: number; rings: Record<string, number>; tiles: { offered: number; resident: number; beyond: number }; levels: number[]; charts: number; evicted: number; allocated: number; relevelled: number; ms: number; preparing: number; reading: number } | undefined;
  if (c === undefined) return '';
  const mb = (b: number): string => (b / (1024 * 1024)).toFixed(1);
  return `, surface cache ${mb(c.usedBytes)} MiB (peak ${mb(c.peakUsedBytes)}${c.peakUsedBytes > c.budgetBytes ? ' OVER' : ''}) of ${mb(c.budgetBytes)} (rings ${mb(c.ringBytes)}: ${Object.values(c.rings).join('+') || 0}), ${c.tiles.resident}/${c.tiles.offered} tiles (${c.tiles.beyond} beyond) by level ${c.levels.join('/')}, ${c.charts} charts, ${c.allocated} taken/${c.evicted} let go/${c.relevelled} relevelled, last decision ${c.ms.toFixed(2)} ms, ${c.preparing} preparing, ${c.reading} files reading`;
}

/** The reflections' traced rays on the last frame (where the scene draws reflections). */
export function reflectionsNote(r: FrameRunResult): string {
  const f = r.scene.reflections as { width: number; height: number; spacing: number; rays: number; every?: number; traceMs: number | null } | undefined;
  if (f === undefined) return '';
  return `, reflections ${f.width}x${f.height}, traced ${f.rays} rays (1 per ${f.spacing}x${f.spacing}) every ${f.every ?? 1} frames in ${f.traceMs?.toFixed(3) ?? '-'} ms`;
}

export function frameLine(what: string, r: FrameRunResult): string {
  const c = r.gpuClock;
  const clock = c === undefined || c === null ? '' : `, gpu clock ${c.recordMhz}${c.gpuWindowMhz !== null ? `/${c.gpuWindowMhz}` : ''} of ${c.maxMhz} MHz`;
  const full = c?.gpuWindowMhz != null && c.maxMhz > 0 && r.gpu?.available === true ? ` = ${Math.round((r.gpu.msPerFrame * c.gpuWindowMhz) / c.maxMhz * 100) / 100} ms at full clock` : '';
  const gpu = (r.gpu === null ? '' : r.gpu.available ? `, gpu ${r.gpu.msPerFrame} ms${full} (${r.gpu.passes.slice(0, 4).map((p) => `${p.label} ${p.msPerFrame}`).join(', ')})` : `, gpu not measured (${r.gpu.note ?? 'no timestamp queries'})`) + clock;
  const pk = r.profile === null ? '' : `, main thread: ${r.profile.packages.slice(0, 5).map((p) => `${p.name} ${p.share}%`).join(', ')}`;
  return `${what}: ${r.frames.fps} fps, frame p50/p95/p99/max ${r.frames.p50}/${r.frames.p95}/${r.frames.p99}/${r.frames.max ?? '-'} ms${hist(r.frames.histogram)}, ${r.draws.p50} draws (scene ${r.scene.passDraws?.scene ?? '-'}, shadow ${r.scene.passDraws?.shadow ?? '-'}, post ${r.scene.passDraws?.post ?? '-'}; shadow per frame mean/p95/max ${r.scene.shadowDraws?.mean ?? '-'}/${r.scene.shadowDraws?.p95 ?? '-'}/${r.scene.shadowDraws?.max ?? '-'}), ${Math.round(r.tris.p50 / 1000)}k tris, ${r.scene.objects} Object3Ds (${r.scene.groups} groups, ${r.scene.lods} LOD, ${r.scene.meshes} meshes of which ${r.scene.hiddenMeshes} hidden, ${r.scene.bones} bones, ${r.scene.pointLights} point lights)${r.scene.merged !== undefined && r.scene.merged.meshes > 0 ? `, ${r.scene.merged.shown}/${r.scene.merged.meshes} merged cells drawn (${Math.round((r.scene.merged.vertexBytes + r.scene.merged.indexBytes) / 1024)} KiB)` : ''}${r.scene.lod !== undefined ? `, ${r.scene.lod.copiesInView} instance copies drawn, LOD switches ${r.scene.lod.switches} models/${r.scene.lod.copySwitches} copies last frame` : ''}${r.scene.effectsMs != null ? `, effects ${r.scene.effectsMs} ms/frame main thread (${r.scene.effectsGpuPlays ?? 0} plays on the GPU)` : ''}, ${r.live.uniformBuffers} uniform buffers${r.gpuCalls ? `, per frame ${r.gpuCalls.renderPasses} render/${r.gpuCalls.computePasses} compute passes, ${r.gpuCalls.setPipeline} pipeline and ${r.gpuCalls.setBindGroup} bind-group sets, ${r.gpuCalls.createBindGroup} bind groups made, ${r.gpuCalls.writeBuffer} buffer writes (${Math.round(r.gpuCalls.writeBufferBytes / 1024)} KiB), ${r.gpuCalls.textureUploads} texture uploads, ${r.gpuCalls.submits} submits` : ''}${r.shaders ? `, ${r.shaders.distinct} shader modules (${Math.round(r.shaders.totalChars / 1024)} KiB WGSL, largest ${Math.round(r.shaders.maxChars / 1024)} KiB)` : ''}, ${r.live.pipelines} pipelines, main thread ${r.mainThread.taskMsPerFrame} ms/frame (${Math.round(r.mainThread.busyShare * 100)}%${r.mainThread.cpuMsPerFrame !== undefined ? `, CPU ${r.mainThread.cpuMsPerFrame} ms` : ''})${r.rendererChoice?.occlusion !== undefined ? `, occlusion ${r.rendererChoice.occlusion} (path|occludees|tested|culled)` : ''}${gpu}${pk}${surfaceCacheNote(r)}${reflectionsNote(r)}${r.errors.length > 0 ? `; ${r.errors.length} page errors: ${r.errors[0]}` : ''}`;
}

/** The occlusion oracle's count for the log: what the view drew that no pixel showed, in all and by kind. */
export function oracleLine(what: string, r: FrameRunResult): string {
  const o = r.oracle;
  if (o === undefined) return `${what}: oracle not run`;
  if ('error' in o) return `${what}: oracle failed: ${o.error}`;
  const pc = (v: number): string => `${Math.round(v * 1000) / 10}%`;
  const share = (s: OracleShare): string => {
    const f = hiddenFractions(s);
    return `items ${s.hiddenItems}/${s.items} (${pc(f.items)}), draws ${s.hiddenDraws}/${s.draws} (${pc(f.draws)}), triangles ${Math.round(s.hiddenTriangles / 1000)}k/${Math.round(s.triangles / 1000)}k (${pc(f.triangles)})`;
  };
  const kinds = ORACLE_KINDS.filter((k) => o.byKind[k].items > 0).map((k) => `${k}: ${share(o.byKind[k])}`);
  const c = r.oracleCulled;
  const gpuOf = (g: FrameRunResult['gpu']): string => (g === null || !g.available ? '-' : String(g.msPerFrame));
  const culled = c === undefined ? '' : `; the ${c.hiddenDraws} wholly hidden draws left out: frame p50/p95/p99 ${c.frames.p50}/${c.frames.p95}/${c.frames.p99} ms (with them ${r.frames.p50}/${r.frames.p95}/${r.frames.p99}), gpu ${gpuOf(c.gpu)} ms (with ${gpuOf(r.gpu)}), main thread ${c.mainThread.taskMsPerFrame} ms (with ${r.mainThread.taskMsPerFrame}), ${c.draws.p50} draws (with ${r.draws.p50}), ${Math.round(c.tris.p50 / 1000)}k tris (with ${Math.round(r.tris.p50 / 1000)}k)`;
  return `${what}: oracle hidden ${share(o.total)}; ${kinds.join('; ')}; ${o.width}x${o.height}, ${o.covered} px written, ${o.stray} stray, skipped ${JSON.stringify(o.skipped)}, ${o.ms} ms${culled}`;
}

/** Busy time per second (`--busy`): drawn frames, the page's main thread (untraced, and traced), workers, GPU process. */
export function busyLine(what: string, r: FrameRunResult): string {
  const b = r.busy!;
  const main = Math.round(r.mainThread.busyShare * 1000);
  return `${what}: ${b.fps} drawn fps, main thread ${main} ms/s untraced (${b.mainMsPerS} traced), workers ${b.workerMsPerS} ms/s, GPU process ${b.gpuProcessMsPerS} ms/s (${b.seconds} s traced)`;
}

export async function runVillageCli(argv: readonly string[]): Promise<void> {
  const get = flagOf(argv);
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const log = (s: string): void => console.log(s);
  const gate = has('gate');
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  for (const r of renderers) if (r !== 'webgpu' && r !== 'webgl2') throw new Error(`--renderers: webgpu or webgl2, not ${r}`);
  const recordMs = Number(get('record-ms') ?? (gate ? 6000 : 10000));
  const warmupMs = Number(get('warmup-ms') ?? (gate ? 2000 : 3000));
  const gpuMs = gate ? 0 : Number(get('gpu-ms') ?? 3000);
  const profileMs = gate ? 0 : Number(get('profile-ms') ?? 5000);
  const projectFolder = get('project');
  const steps = JSON.parse(get('steps') ?? '[]') as PageStep[];
  const sceneView = !gate && has('scene-view');
  const exporting = !has('no-export');
  // The gate measures at the display's cap; the plain page then draws every refresh like the class and says nothing.
  const capped = gate || has('vsync');
  const bare = exporting && !gate && !has('no-bare');
  const ablation = !gate && has('ablation');
  const query = get('query') !== undefined ? `&${get('query')}` : '';
  const switches = gate ? [] : (get('switches') ?? '').split(',').filter((x) => x !== '');
  const busyMs = gate ? 0 : Number(get('busy') ?? 0);
  const view = get('view') as VillageView | undefined;
  if (view !== undefined && (gate || projectFolder !== undefined)) throw new Error('--view: the village class, not with --gate or --project');
  const viewCamera = view === undefined ? null : villageViewCamera(view);
  const oracle = has('oracle') || view !== undefined;
  const seeThroughN = gate ? 0 : Number(get('see-through') ?? 0);
  if (!Number.isInteger(seeThroughN) || seeThroughN < 0) throw new Error(`--see-through: a number of subjects, not ${get('see-through')}`);
  const seeThroughFade = get('see-through-fade') === undefined ? undefined : Number(get('see-through-fade'));
  if (seeThroughFade !== undefined && !(seeThroughFade >= 0 && seeThroughFade <= 0.95)) throw new Error(`--see-through-fade: a max fade 0-0.95, not ${get('see-through-fade')}`);
  if (seeThroughN > 0 && projectFolder !== undefined) throw new Error('--see-through: the village class, not --project');

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `village-${stamp}`);
  const reportsDir = join(PERF_ROOT, 'reports');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: VillageReport = {
    reportVersion: 1,
    kind: projectFolder === undefined ? 'village' : 'project',
    startedAt,
    commit,
    machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, gpu: 'unknown' },
    subject: projectFolder === undefined ? { name: 'village', version: VILLAGE_VERSION, seed: VILLAGE_SEED } : { name: basename(resolve(projectFolder)) },
    export: {},
    bare: {},
    errors: [],
  };

  // ---- the export -------------------------------------------------------------------
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  let exportDir: string | null = null;
  let viewDir: string | null = null;
  let prebuiltDir: string | null = null;
  try {
    let projectId = 'village';
    if (projectFolder === undefined) {
      report.subject.build = await buildVillage(be, projectId, undefined, log);
      log(`village: built in ${report.subject.build.ms} ms (${report.subject.build.commands} commands)`);
      if (get('point-lights') !== undefined) {
        await addVillageLamps(be, projectId, Number(get('point-lights')));
        log(`village: ${get('point-lights')} lamps over the scatter`);
      }
      if (has('fire-gpu-systems')) {
        await addFireGpuSystems(be, projectId);
        log('village: flames and smoke in every fire');
      }
      if (get('flight') !== undefined) {
        await addVillageFlight(be, projectId, Number(get('flight')));
        log(`village: the camera flies a ${get('flight')} m loop`);
      }
    } else {
      const reg = await be.post('/api/v1/admin/projects/register', { folder: resolve(projectFolder) });
      if (typeof reg.json['projectId'] !== 'string') throw new Error(`register failed: ${JSON.stringify(reg.json).slice(0, 400)}`);
      projectId = reg.json['projectId'];
    }
    if (seeThroughN > 0) {
      const plan = villagePlan();
      const subjects = subjectsInView(candidatesOf(plan.batches.flat(), (e) => e.id.startsWith('figure-')), plan.camera, seeThroughN);
      await addSeeThroughSubjects(be, projectId, subjects, seeThroughFade);
      report.seeThrough = { subjects, byRenderer: {} };
      log(`village: see-through subjects ${subjects.join(', ')}`);
    }
    if (has('bake')) report.bake = await bakeLightingInEditor(be, projectId, log);
    if (get('synthetic-probes') !== undefined) report.probes = { synthetic: await addSyntheticProbes(be, projectId, 'scene-main', Number(get('synthetic-probes')), log) };
    if (sceneView) {
      const browser = await launchGpuBrowser({ vsync: capped });
      try {
        for (const r of renderers) {
          const res = await measureSceneView(browser, be, projectId, r, { warmupMs, recordMs, query, shot: join(runDir, `scene-view-${r}.png`), ...(get('orbit') !== undefined ? { orbit: Number(get('orbit')) } : {}) });
          (report.sceneView ??= {})[r] = res;
          log(sceneViewLine(`scene view ${r}`, res));
        }
      } finally {
        await browser.close();
      }
    }
    if (exporting) {
      const t = performance.now();
      const res = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
      if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
      report.subject.exportMs = Math.round(performance.now() - t);
      exportDir = join(be.exportRoot, String(res.json['outputDir']));
      if (report.seeThrough !== undefined) prebuiltDir = await exportPrebuilt(be, projectId);
      if (viewCamera !== null) {
        // The same build seen from the view: the camera moved, exported again.
        await be.project(projectId).command('setTransform', { entityId: 'cam-main', transform: { position: viewCamera.position, rotation: viewCamera.rotation } });
        const again = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
        if (again.status !== 200) throw new Error(`view export failed: ${JSON.stringify(again.json).slice(0, 400)}`);
        viewDir = join(be.exportRoot, String(again.json['outputDir']));
      }
    }
  } finally {
    await be.stop();
  }

  const browser = await launchGpuBrowser({ vsync: capped });
  const dumpDir = join(runDir, 'dump');
  try {
    report.machine.gpu = await gpuName(browser);
    const site = exportDir === null ? null : await serveStatic(exportDir, {}, dumpDir);
    try {
      for (const [i, r] of (site === null ? [] : renderers).entries()) {
        const res = await measurePage(browser, { url: `${site!.url}?renderer=${r}${query}`, warmupMs, recordMs, gpuMs, profileMs, steps, sourceOf: sourcesOf(site!), dump: bare && i === 0, shot: join(runDir, `export-${r}.png`), busyMs, oracle, oracleCull: oracle });
        report.export[r] = res;
        log(frameLine(`export ${r}`, res));
        if (oracle) log(oracleLine(`export ${r}`, res));
        for (const m of res.marks ?? []) log(`mark ${r} ${m.name} at ${m.at} ms (first frame ${res.firstFrameMs ?? '-'} ms)${m.detail !== null ? ` ${JSON.stringify(m.detail)}` : ''}`);
        if (res.busy !== undefined) log(busyLine(`busy ${r}`, res));
        for (const sw of switches) {
          const off = await measurePage(browser, { url: `${site!.url}?renderer=${r}${query}&${sw}`, warmupMs, recordMs, gpuMs, profileMs: 0, steps, sourceOf: sourcesOf(site!), shot: join(runDir, `export-${r}-${sw.replace(/[^a-z0-9]+/gi, '_')}.png`), busyMs });
          ((report.switches ??= {})[sw] ??= {})[r] = off;
          log(frameLine(`export ${r} ${sw}`, off));
          if (off.busy !== undefined) log(busyLine(`busy ${r} ${sw}`, off));
          log(`switch ${r} ${sw}: ${off.frames.fps} fps (on ${res.frames.fps}), p50 ${off.frames.p50} ms (on ${res.frames.p50}), main thread ${off.mainThread.taskMsPerFrame} ms (on ${res.mainThread.taskMsPerFrame}), draws ${off.draws.p50} (on ${res.draws.p50})`);
        }
        if (report.seeThrough !== undefined && prebuiltDir !== null) {
          const pre = await serveStatic(prebuiltDir);
          try {
            const page = (url: string): Promise<FrameRunResult> => measurePage(browser, { url, warmupMs, recordMs, gpuMs, profileMs, steps, sourceOf: sourcesOf(site!), busyMs });
            report.seeThrough.byRenderer[r] = await seeThroughRuns(browser, `${site!.url}?renderer=${r}${query}`, `${pre.url}?renderer=${r}${query}`, res, page, `see-through ${r}`, log);
          } finally {
            await pre.close();
          }
        }
      }
    } finally {
      await site?.close();
    }
    if (view !== undefined && viewDir !== null) {
      const viewSite = await serveStatic(viewDir);
      try {
        const seen: Partial<Record<FrameRenderer, FrameRunResult>> = {};
        const at: NonNullable<VillageReport['views']>[VillageView] = { camera: viewCamera!, export: seen };
        report.views = { [view]: at };
        for (const r of renderers) {
          const res = await measurePage(browser, { url: `${viewSite.url}?renderer=${r}${query}`, warmupMs, recordMs, gpuMs, profileMs, steps, sourceOf: sourcesOf(viewSite), shot: join(runDir, `export-${view}-${r}.png`), oracle: true, oracleCull: true });
          seen[r] = res;
          log(frameLine(`export ${view} ${r}`, res));
          log(oracleLine(`export ${view} ${r}`, res));
          // The switches at the view too: what each saves where much is hidden, not only in the open view.
          for (const sw of switches) {
            const off = await measurePage(browser, { url: `${viewSite.url}?renderer=${r}${query}&${sw}`, warmupMs, recordMs, gpuMs, profileMs: 0, steps, sourceOf: sourcesOf(viewSite) });
            ((at!.switches ??= {})[sw] ??= {})[r] = off;
            log(frameLine(`export ${view} ${r} ${sw}`, off));
          }
        }
      } finally {
        await viewSite.close();
      }
    }
    if (bare) {
      const dumped = report.export[renderers[0]!]?.dump;
      if (typeof dumped === 'string' || dumped === undefined || !existsSync(join(dumpDir, 'scene.json'))) report.errors.push(`no scene dump: ${String(dumped)}`);
      else {
        log(`dump: ${dumped.items} drawn items (${dumped.instanced} instanced), ${dumped.geos} geometries, ${dumped.mats} materials, ${Math.round(dumped.bytes / 1048576)} MiB`);
        const post = postSettingsOf(exportDir!);
        if (post !== null) writeFileSync(join(dumpDir, 'post.json'), JSON.stringify(post));
        log(`dump: ${dumped.textures} textures, ${dumped.skeletons} skeletons, environment ${dumped.environment ? 'yes' : 'no'}, post ${post === null ? 'none' : JSON.stringify(post)}`);
        const engineDir = join(runDir, 'engine');
        if (ablation) await bundleEngineMaterials(join(engineDir, 'materials.js'));
        const page = await serveStatic(join(REPO, 'tools', 'perf', 'bare'), { 'three/': join(REPO, 'node_modules', 'three'), 'scene/': dumpDir, 'engine/': engineDir });
        try {
          const variants = (ablation ? Object.keys(BARE_VARIANTS).filter((v) => v !== 'first') : ['bare']) as BareVariant[];
          if (has('first-bare')) variants.push('first');
          for (const v of variants) {
            for (const r of renderers) {
              const q = [`renderer=${r}`, BARE_VARIANTS[v]].filter((x) => x !== '').join('&');
              const res = await measurePage(browser, { url: `${page.url}?${q}`, warmupMs, recordMs, gpuMs, profileMs: v === 'bare' ? profileMs : 0, sourceOf: sourcesOf(page), shot: join(runDir, `bare-${v}-${r}.png`) });
              (report.bare[v] ??= {})[r] = res;
              log(frameLine(`plain three.js ${v} ${r}`, res));
            }
          }
        } finally {
          await page.close();
        }
        if (ablation) for (const row of ablationRows(report)) log(`ablation ${row.renderer} ${row.variant}: frame ${row.frameMs} ms (${row.deltaMs >= 0 ? '+' : ''}${row.deltaMs} ms), gpu ${row.gpuMs ?? '-'} ms, ${row.draws} draws: ${row.usPerDraw >= 0 ? '+' : ''}${row.usPerDraw} µs per draw`);
      }
    }
  } finally {
    await browser.close();
  }

  const out = get('out') ?? join(reportsDir, `${report.subject.name}-${stamp}.json`);
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  copyFileSync(out, join(reportsDir, `latest-${report.subject.name}.json`));
  log(`village: report ${out}${has('keep') ? `, run folder ${runDir}` : ''}`);
  if (!has('keep')) rmSync(runDir, { recursive: true, force: true });

  const write = get('write-baseline');
  if (write !== undefined) {
    if (!capped) throw new Error('--write-baseline: the baseline is measured at the display\'s cap (--gate or --vsync)');
    const mainCpuMsPerFrame: NonNullable<FrameBaseline['mainCpuMsPerFrame']> = {};
    const mainTaskMsPerFrame: NonNullable<FrameBaseline['mainTaskMsPerFrame']> = {};
    for (const r of renderers) {
      const m = report.export[r]?.mainThread;
      if (m?.cpuMsPerFrame === undefined) continue;
      mainCpuMsPerFrame[r] = m.cpuMsPerFrame;
      mainTaskMsPerFrame[r] = m.taskMsPerFrame;
    }
    const base: FrameBaseline = { note: `the village class's export (tools/perf/village.ts) at the display's ${CAP_HZ} Hz cap on this host's GPU: main-thread ms per frame; re-record with tools/perf/run.mjs village --gate --write-baseline <this file>`, recordedAt: new Date().toISOString(), commit, machine: report.machine, subject: report.subject.name, version: VILLAGE_VERSION, capHz: CAP_HZ, mainCpuMsPerFrame, mainTaskMsPerFrame };
    writeFileSync(write, `${JSON.stringify(base, null, 1)}\n`);
    log(`village: baseline written to ${write}`);
  }
  const check = get('check');
  if (check !== undefined) {
    const base = JSON.parse(readFileSync(check, 'utf8')) as FrameBaseline;
    if (base.version !== VILLAGE_VERSION) log(`village: the baseline is for village version ${base.version}, this is ${VILLAGE_VERSION}: re-record it`);
    if (base.machine.gpu !== report.machine.gpu) log(`village: the baseline was recorded on ${base.machine.gpu}, this host has ${report.machine.gpu}`);
    const atCap = capped && base.capHz === CAP_HZ && base.mainCpuMsPerFrame !== undefined;
    if (!atCap) log(`village: REGRESSION check not made: ${capped ? 'the baseline was recorded uncapped; re-record it at the cap' : 'the check measures at the display\'s cap (--gate or --vsync)'}`);
    const bad = atCap ? frameRegressions(base, report) : [];
    for (const b of bad) log(`village: REGRESSION ${b.renderer} ${b.metric === 'missed' ? `missed ${b.value} refreshes of ${report.export[b.renderer]?.frames.n ?? 0} frames > ${b.limit} (${CAP_MISSED_SHARE * 100} %)` : `main thread CPU ${b.value} ms/frame > ${b.limit} ms (baseline ${b.baseline} ms + ${CAP_MAIN_REGRESSION * 100} %)`}`);
    for (const r of renderers) {
      const b = base.mainCpuMsPerFrame?.[r];
      const res = report.export[r];
      if (b === undefined || res === undefined) continue;
      log(`village: ${r} at ${CAP_HZ} Hz: frame p50/p95/max ${res.frames.p50}/${res.frames.p95}/${res.frames.max ?? '-'} ms, missed ${res.frames.missed ?? '-'} of ${res.frames.n} (limit ${Math.floor(res.frames.n * CAP_MISSED_SHARE)}), main thread CPU ${res.mainThread.cpuMsPerFrame ?? '-'} ms/frame (baseline ${b} ms, limit ${frameLimit(b, CAP_MAIN_REGRESSION)} ms; task ${res.mainThread.taskMsPerFrame} ms, baseline ${base.mainTaskMsPerFrame?.[r] ?? '-'} ms)`);
    }
    if (!atCap || bad.length > 0 || base.version !== VILLAGE_VERSION) process.exitCode = 1;
  }
  for (const row of plainPageRows(report)) log(`village: plain page ${row.renderer}: class p50 ${row.classP50Ms} ms (${row.classFps} fps) vs plain three.js ${row.plainP50Ms} ms (${row.plainFps} fps): class ${row.aheadPercent >= 0 ? `${row.aheadPercent} % ahead` : `${-row.aheadPercent} % behind`} (reported, not gated)`);
  for (const e of report.errors) log(`village: error: ${e}`);
}

/** The WebGPU adapter's description (vendor and architecture), for the report and the baseline. */
async function gpuName(browser: import('@playwright/test').Browser): Promise<string> {
  const site = await serveStatic(join(REPO, 'tools', 'perf', 'bare'));
  const page = await browser.newPage();
  try {
    await page.goto(`${site.url}gpu.html`).catch(() => undefined);
    return await page.evaluate(async () => {
      const a = await (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu?.requestAdapter();
      const i = a?.info;
      return i === undefined ? 'no WebGPU adapter' : [i.vendor, i.architecture, i.description].filter((x) => x !== undefined && x !== '').join(' ');
    });
  } finally {
    await page.close();
    await site.close();
  }
}

/**
 * The post settings the plain page draws with: the exported scene's environment (`environment.post`). The scene
 * with the most entities is the one measured (a game's title scene is small), which holds for the village and
 * the game copies' default views.
 */
function postSettingsOf(exportDir: string): Record<string, unknown> | null {
  const dir = join(exportDir, 'scenes');
  if (!existsSync(dir)) return null;
  let best: { n: number; post: Record<string, unknown> | null } = { n: -1, post: null };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { entities?: unknown[]; environment?: { post?: Record<string, unknown> } };
    const n = doc.entities?.length ?? 0;
    if (n > best.n) best = { n, post: doc.environment?.post ?? null };
  }
  return best.post;
}

/** The engine's node materials for the plain page (bare-engine-materials.ts), three left to the page's import map. */
async function bundleEngineMaterials(out: string): Promise<void> {
  await esbuild.build({ entryPoints: [join(REPO, 'tools', 'perf', 'bare-engine-materials.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: out, external: ['three', 'three/*'], logLevel: 'warning' });
}
