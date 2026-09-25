/**
 * Phase 21.1: the headless simulation benchmark (a child process started
 * with `--expose-gc`, see sim-run.ts). It plays a generated project from its
 * saved files through the production composition — the real game host, the
 * platformer, Rapier and the project's published scripts compiled by the
 * pinned behavior compiler and linked like an export — driven by a fixed
 * input pattern (run right, jump every 1.5 s), and measures:
 *
 * - boot (compile + link + physics + mount),
 * - the cost of one fixed step (percentiles over the timed steps),
 * - the bytes allocated per steady step: the heap is collected, a window of
 *   steps runs, and the growth of the used heap is the allocation (windows
 *   during which V8 collected garbage are discarded; the young generation is
 *   enlarged by the runner so most windows see none),
 * - a CPU calibration (a fixed arithmetic workload) for relative numbers.
 *
 * Input: env TL_SIM = JSON { projectDir, warmup, steps, window, windows }.
 * Output: one JSON line on stdout.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import v8 from 'node:v8';

import { createBehaviorCompiler } from '@thirdlight/behavior-build';
import { createGameHost, linkBehaviorModules } from '@thirdlight/game-host';
import { createPhysicsPort } from '@thirdlight/physics-rapier';
import { M2_SETTINGS_KEYS } from '@thirdlight/project-model';
import { playerCapsuleOf, playerPhysicsOf } from '@thirdlight/runtime';

import { cpuCalibration } from './stats';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface SimInput {
  projectDir: string;
  warmup: number;
  steps: number;
  window: number;
  windows: number;
  /**
   * Phase 21.2: write the allocation sites of the steady loop (V8's sampling
   * heap profiler over `profileSteps` steps after the warm-up, collected
   * objects included) to this JSON file.
   */
  profile?: string;
  profileSteps?: number;
}

export interface SimResult {
  ok: true;
  entities: number;
  colliders: number;
  scriptInstances: number;
  bootMs: number;
  stepMs: { p50: number; p95: number; p99: number; max: number; mean: number };
  steps: number;
  bytesPerStep: { median: number; min: number; windows: number; windowSteps: number; discarded: number };
  calibrationMs: number;
  heapUsedMiB: number;
  state: string;
  counters: unknown;
}

class FakeNode {
  textContent = '';
  children: FakeNode[] = [];
  appendChild(c: FakeNode): void {
    this.children.push(c);
  }
  remove(): void {}
  setAttribute(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function percentile(sorted: Float64Array | number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

async function behaviorsOf(dir: string, content: Any): Promise<{ modules: Any[]; count: number }> {
  const compiler = createBehaviorCompiler();
  const rows: Any[] = [];
  const outputs = new Map<string, Uint8Array>();
  let enginePins: Any[] = [];
  for (const b of content.behaviors ?? []) {
    if (b.source === null || b.source === undefined) continue;
    const containerBytes = new Uint8Array(readFileSync(join(dir, 'sources', 'sha256', b.source.sourceDigest)));
    const out: Any = await compiler.compile({ behaviorId: b.behaviorId, declaration: b.declaration, containerBytes, pinnedModules: compiler.pinnedModules });
    if (!out.ok) throw new Error(`compile ${b.behaviorId}: ${JSON.stringify(out).slice(0, 400)}`);
    enginePins = out.manifest.enginePins;
    outputs.set(b.behaviorId, out.outputBytes);
    rows.push({ behaviorId: b.behaviorId, sourceDigest: b.source.sourceDigest, manifestDigest: out.manifestDigest, outputDigest: out.outputDigest, declaration: b.declaration, ownedTransforms: out.manifest.ownedTransforms, requiredModules: out.manifest.requiredModules, path: b.behaviorId });
  }
  const modules = await linkBehaviorModules(rows, enginePins, async (path: string) => import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(outputs.get(path)!).toString('base64')}`));
  return { modules: modules as Any[], count: rows.length };
}

export async function runSim(input: SimInput): Promise<SimResult> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') throw new Error('run with --expose-gc');
  const dir = input.projectDir;
  const t0 = performance.now();
  const content = JSON.parse(readFileSync(join(dir, 'content.json'), 'utf8')).content;
  const start: string[] = content.startScenes;
  const scenes: Record<string, Any[]> = Object.fromEntries(content.scenes.map((s: Any) => [s.sceneId, JSON.parse(readFileSync(join(dir, 'scenes', `${s.sceneId}.json`), 'utf8')).scene.entities]));
  const entities = start.flatMap((id) => scenes[id]!);
  const settings: Any = Object.fromEntries(M2_SETTINGS_KEYS.map((k: Any) => [k.key, k.default]));
  for (const [k, v] of Object.entries(content.settings ?? {})) if (typeof v === 'number') settings[k] = v;

  // The scene-derived Rapier config (the same rules as the preview and the export bootstrap).
  const statics: Any[] = [];
  let character: Any = null;
  let tuning = playerPhysicsOf(undefined);
  for (const e of entities) {
    const c = e.components ?? {};
    const pos = c.transform?.position ?? [0, 0, 0];
    if (c.collider !== undefined) statics.push({ entityId: e.id, position: { x: pos[0], y: pos[1] }, rotationZ: c.collider.rotationZ ?? 0, shape: c.collider.shape, ...(c.mover !== undefined ? { kinematic: true } : {}), ...(c.collider.oneWay === true ? { oneWay: true } : {}) });
    if (c.controller !== undefined) {
      const capsule = playerCapsuleOf(c.controller);
      tuning = playerPhysicsOf(c.controller);
      character = { x: pos[0], y: pos[1], radius: capsule.radius, halfHeight: capsule.halfHeight, offset: { x: capsule.offset.x, y: capsule.offset.y }, parentId: e.parentId ?? null, rotation: c.transform?.rotation ?? [0, 0, 0, 1], scale: c.transform?.scale ?? [1, 1, 1] };
    }
  }
  if (character === null) throw new Error('the project has no player (controller)');
  const hz = settings.fixed_step_hz ?? 120;
  const physics = await createPhysicsPort({
    character,
    statics,
    solver: { hz, gravityY: settings.gravity_y },
    controller: { offsetSkin: tuning.offsetSkin, groundSnap: tuning.groundSnap, maxSlopeClimbRad: (settings.max_slope_climb_deg * Math.PI) / 180, minSlopeSlideRad: (settings.min_slope_slide_deg * Math.PI) / 180, autostep: tuning.autostep, ...(tuning.autostep ? { autostepHeight: tuning.autostepHeight } : {}) },
  } as Any);
  if (!physics.ok) throw new Error(JSON.stringify(physics.error));
  const behaviors = await behaviorsOf(dir, content);

  // The input: one reused frame (the runtime validates and copies it), run right, jump every 1.5 s.
  const frame: Any = { stepIndex: 0, moveX: 1, jump: 'none' };
  const ui: Any = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
  const period = Math.round(hz * 1.5);
  const host = createGameHost({
    snapshot: {
      snapshotId: 'bench@r1',
      projectId: 'bench',
      revision: 1,
      scene: { schemaVersion: 4, sceneId: start[0], revision: 1, entities },
      scenes: content.scenes.map((s: Any) => ({ sceneId: s.sceneId, start: start.includes(s.sceneId), ...(start.includes(s.sceneId) ? { entityIds: scenes[s.sceneId]!.map((e: Any) => e.id) } : {}) })),
      game: content.game,
      ...(content.animators !== undefined ? { animators: content.animators } : {}),
      ...(content.prefabs !== undefined ? { prefabs: content.prefabs } : {}),
    },
    settings,
    physics: physics.port,
    behaviorModules: behaviors.modules,
    adapter: () => null,
    input: {
      sample: (stepIndex: number) => {
        frame.stepIndex = stepIndex;
        const k = stepIndex % period;
        frame.jump = k === 0 ? 'pressed' : k < 24 ? 'held' : k === 24 ? 'released' : 'none';
        return frame;
      },
      sampleMenu: () => ({ confirm: false, mute: false, confirmNeedsRelease: false }),
      markConfirmConsumed: () => undefined,
      sampleUi: () => ui,
      dispose: () => undefined,
    },
    audio: { registerCue: () => ({ ok: true }), submit: () => ({ ok: true }), unlock: async () => ({ state: 'blocked' }), setMuted: () => ({}), setHidden: () => ({}), status: () => ({ state: 'blocked', reason: 'autoplay_denied' }), dispose: () => ({ ok: true }), liveVoices: () => 0 },
    readArtifact: async () => new ArrayBuffer(0),
    container: new FakeNode(),
    buildId: 'bench',
    document: { createElement: () => new FakeNode() },
    loadScene: async (id: string) => scenes[id] as Any,
    ...(content.flow !== undefined ? { flow: content.flow } : {}),
  } as Any);
  const mounted = host.mount();
  if (!mounted.ok) throw new Error(JSON.stringify(mounted.error));
  const rt: Any = host.runtime;
  const dt = 1 / hz;
  let now = 0;
  const tick = (): void => {
    now += dt;
    const r = rt.tick(now);
    if (r.ok !== true) {
      // The runtime's own diagnostics name the failure (a script error, a limit).
      const d = rt.getDiagnostics?.();
      throw new Error(`${JSON.stringify(r.error ?? r).slice(0, 300)} ${JSON.stringify(d?.diagnostics?.failure ?? d?.diagnostics?.lastError ?? d?.diagnostics ?? null).slice(0, 1200)}`);
    }
  };
  tick();
  const started = rt.gameCommand('start');
  if (!started.ok) throw new Error(`${JSON.stringify(started.error)} ${JSON.stringify(rt.getDiagnostics?.()?.diagnostics ?? null).slice(0, 1500)}`);
  const bootMs = performance.now() - t0;

  for (let i = 0; i < input.warmup; i += 1) tick();
  if (input.profile !== undefined) await profileSteps(input.profile, input.profileSteps ?? 240, tick);

  // Allocation windows (no timing calls inside them).
  const gcs: number[] = [];
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push(e.startTime, e.startTime + e.duration);
  });
  obs.observe({ entryTypes: ['gc'] });
  const perStep: number[] = [];
  let discarded = 0;
  // A window that saw a collection is discarded and the next one is halved (down to one step).
  let win = input.window;
  for (let attempt = 0; perStep.length < input.windows && attempt < input.windows * 4; attempt += 1) {
    gc();
    await new Promise((r) => setImmediate(r));
    gcs.length = 0;
    const ws = performance.now();
    const h0 = v8.getHeapStatistics().used_heap_size;
    for (let i = 0; i < win; i += 1) tick();
    const h1 = v8.getHeapStatistics().used_heap_size;
    const we = performance.now();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 0));
    let collected = false;
    for (let i = 0; i < gcs.length; i += 2) if (gcs[i + 1]! >= ws && gcs[i]! <= we) collected = true;
    if (collected || h1 < h0) {
      discarded += 1;
      win = Math.max(1, Math.floor(win / 2));
    } else perStep.push((h1 - h0) / win);
  }
  obs.disconnect();

  // Timed steps.
  const times = new Float64Array(input.steps);
  for (let i = 0; i < input.steps; i += 1) {
    const a = performance.now();
    tick();
    times[i] = performance.now() - a;
  }
  const mean = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
  times.sort();
  perStep.sort((a, b) => a - b);
  const calibrationMs = cpuCalibration();
  gc();
  const view = rt.getGameView?.()?.view;
  return {
    ok: true,
    entities: entities.length,
    colliders: statics.length,
    scriptInstances: entities.filter((e: Any) => e.components?.behavior !== undefined).length,
    bootMs: round(bootMs),
    stepMs: { p50: round(percentile(times, 0.5)), p95: round(percentile(times, 0.95)), p99: round(percentile(times, 0.99)), max: round(times[times.length - 1] ?? 0), mean: round(mean) },
    steps: input.steps,
    bytesPerStep: { median: Math.round(percentile(perStep, 0.5)), min: Math.round(perStep[0] ?? 0), windows: perStep.length, windowSteps: win, discarded },
    calibrationMs: round(calibrationMs),
    heapUsedMiB: round(v8.getHeapStatistics().used_heap_size / 1048576),
    state: String(view?.state ?? 'unknown'),
    counters: rt.gameCounters?.() ?? null,
  };
}

/** The top allocation sites (self bytes per step) of `steps` steps, from V8's sampling heap profiler. */
async function profileSteps(path: string, steps: number, tick: () => void): Promise<void> {
  const { Session } = await import('node:inspector');
  const session = new Session();
  session.connect();
  const post = (method: string, params?: object): Promise<Any> =>
    new Promise((ok, no) => session.post(method, params ?? {}, (e: Error | null, r: Any) => (e ? no(e) : ok(r))));
  await post('HeapProfiler.enable');
  // Keep the samples of objects collected during the window: garbage is what we look for.
  await post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  for (let i = 0; i < steps; i += 1) tick();
  const { profile } = await post('HeapProfiler.stopSampling');
  session.disconnect();
  const sites = new Map<string, number>();
  const walk = (node: Any, stack: string[]): void => {
    const f = node.callFrame;
    const here = `${f.functionName || '(anon)'} ${String(f.url).split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
    const next = [...stack, here].slice(-4);
    if (node.selfSize > 0) {
      const key = next.slice().reverse().join(' < ');
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
    }
    for (const c of node.children ?? []) walk(c, next);
  };
  walk(profile.head, []);
  const top = [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([site, bytes]) => ({ bytesPerStep: Math.round(bytes / steps), site }));
  writeFileSync(path, `${JSON.stringify(top, null, 1)}\n`);
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

if (process.env['TL_SIM'] !== undefined) {
  runSim(JSON.parse(process.env['TL_SIM']) as SimInput)
    .then((r) => {
      process.stdout.write(`${JSON.stringify(r)}\n`);
      process.exit(0);
    })
    .catch((e: Error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(e.stack ?? e) })}\n`);
      process.exit(1);
    });
}
