/**
 * The scale bench command line (`node tools/perf/run.mjs scale …`):
 *
 *   --preset full|caps|small|starter   the generated size (starter: the Starter template, no generation)
 *   --factor F                         the full size times F instead of a preset
 *   --steps open,commands,play,walk,dialogue,export
 *   --walk N --lines N --commands N    scenes walked (50), dialogue lines played (500), command round trips (20)
 *   --seed N --gpu --renderer webgl2|webgpu --keep --out FILE
 *
 * The project is generated under ~/.cache/thirdlight-perf/scale/<name>/pristine
 * once per size, seed and generator version (the full size takes minutes to
 * write) and copied for each run, since a run edits it. The report goes to
 * ~/.cache/thirdlight-perf/reports/scale-<name>-<time>.json.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';

import { PERF_ROOT, REPO } from './backend';
import type { RendererName } from './browser';
import { ScaleBench, SCALE_STEPS, type ScaleReport, type ScaleStep } from './scale';
import { generateScaleProject, SCALE_DEFAULT_SEED, SCALE_GENERATOR_VERSION, SCALE_PRESETS, scaledSpec, type ScaleResult, type ScaleSpec } from './scale-generate';

export async function runScaleCli(argv: readonly string[]): Promise<void> {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const log = (s: string): void => console.log(s);
  const factor = get('factor');
  const preset = get('preset') ?? (factor === undefined ? 'small' : undefined);
  const seed = Number(get('seed') ?? SCALE_DEFAULT_SEED);
  let spec: ScaleSpec | null = null;
  if (factor !== undefined) spec = scaledSpec(Number(factor));
  else if (preset !== 'starter') {
    const p = SCALE_PRESETS[preset!];
    if (p === undefined) throw new Error(`--preset: one of ${[...Object.keys(SCALE_PRESETS), 'starter'].join(', ')}`);
    spec = { ...p };
  }
  const name = factor !== undefined ? `x${factor}` : preset!;
  const steps = (get('steps')?.split(',') ?? [...SCALE_STEPS]) as ScaleStep[];
  for (const s of steps) if (!SCALE_STEPS.includes(s)) throw new Error(`--steps: unknown ${s}`);
  const base = join(PERF_ROOT, 'scale', name);
  const dataRoot = join(base, 'data');
  const exportRoot = join(base, 'exports');
  rmSync(exportRoot, { recursive: true, force: true });
  mkdirSync(exportRoot, { recursive: true });
  const projectId = 'scale';
  let generated: ScaleResult | undefined;
  if (spec !== null) {
    const stamp = join(base, 'generated.json');
    const key = JSON.stringify({ v: SCALE_GENERATOR_VERSION, seed, spec });
    const pristine = join(base, 'pristine');
    const cached = existsSync(stamp) ? (JSON.parse(readFileSync(stamp, 'utf8')) as { key: string; result: ScaleResult }) : null;
    let made: ScaleResult;
    if (cached !== null && cached.key === key) made = cached.result;
    else {
      made = generateScaleProject(pristine, projectId, spec, seed, log);
      writeFileSync(stamp, JSON.stringify({ key, result: made }));
    }
    // A run edits its project (the driver script, the command round trips): each run gets a fresh copy.
    rmSync(dataRoot, { recursive: true, force: true });
    const t = Date.now();
    cpSync(join(pristine, 'projects', projectId), join(dataRoot, 'projects', projectId), { recursive: true });
    log(`scale: copied the generated project in ${Date.now() - t} ms`);
    generated = { ...made, dir: join(dataRoot, 'projects', projectId) };
  } else {
    rmSync(dataRoot, { recursive: true, force: true });
  }
  mkdirSync(dataRoot, { recursive: true });
  const bench = new ScaleBench({
    dataRoot,
    exportRoot,
    projectId,
    ...(generated !== undefined ? { generated } : {}),
    renderer: (get('renderer') ?? 'webgl2') as RendererName,
    gpu: argv.includes('--gpu'),
    commands: Number(get('commands') ?? 20),
    walk: Number(get('walk') ?? 50),
    lines: Number(get('lines') ?? 500),
    steps,
    log,
  });
  const startedAt = new Date().toISOString();
  const report: ScaleReport = await bench.run();
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const out = {
    reportVersion: 1,
    kind: 'scale',
    name,
    startedAt,
    finishedAt: new Date().toISOString(),
    commit,
    generatorVersion: SCALE_GENERATOR_VERSION,
    machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30), node: process.version, gpu: argv.includes('--gpu') ? 'the host GPU (ANGLE on Vulkan)' : 'SwiftShader (CPU)' },
    report,
  };
  const reports = join(PERF_ROOT, 'reports');
  mkdirSync(reports, { recursive: true });
  const path = get('out') ?? join(reports, `scale-${name}-${startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`);
  log(`scale: report ${path}`);
  for (const [step, why] of Object.entries(report.broke)) log(`scale: BROKE ${step}: ${why}`);
  if (!argv.includes('--keep')) rmSync(exportRoot, { recursive: true, force: true });
}
