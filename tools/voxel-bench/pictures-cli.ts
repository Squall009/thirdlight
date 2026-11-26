/**
 * The phase's picture set (`node tools/voxel-bench/run.mjs pictures --out DIR`; in the phase run,
 * `tools/gate.sh phase`, and alone, `tools/gate.sh pictures`): every picture of the fixed list (picture-list.ts)
 * taken, settled, and written as a pack an agent reads and the owner reviews (docs/pictures.md).
 *
 * The world pictures are `light-shots` runs (one a run of the list: the bench data each needs) on staging's
 * `voxel-slice` project, its 8 km world `far` on disk (staged once by `run.mjs far-world`: nothing is generated
 * here), at the low tier on WebGPU, 1280 × 720, each settled by the bench's own signals; the editor screens are
 * editor-screens.ts's. Staging is started (6G) when it is not running, and stopped after if it was started here.
 * One browser at a time; nothing is left running.
 *
 * The pack (DIR): one PNG a picture (`L01-street-noon.png` …; a picture that did not settle keeps its file with
 * `-UNSETTLED` in its name), `pictures.json` (id, title, what to look for, file, settle state, speck count, capture
 * facts), `README.md`, `perf-report.md` (the newest kept phase performance report beside the one before it), and
 * `read.md`'s skeleton for the agent's read (not overwritten when it exists). The benches' own output (every
 * picture they take, their JSON and logs) goes beside it in `DIR.raw/`.
 *
 * Exit code 1 when a picture could not be taken or did not settle (the run did not do its job); what a picture
 * shows never changes it.
 *
 *   --out DIR (default ~/.cache/thirdlight-pictures/<time>)   --only IDS (a part of the list, e.g. L1,E2)
 *   --perf-reports DIR (default ~/.cache/thirdlight-logs/perf-reports)   --origin URL (staging's)
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gpuAvailable } from '../../tests/e2e/browser-env.mjs';
import { launchGpuBrowser } from '../perf/frame-run';
import { stagingScreens, yardScreens } from './editor-screens';
import { camerasOf, PICTURE_RUNS, PICTURES, pictureListProblems, type PictureRun, type ScreenName, type ScreenPicture, type WorldPicture } from './picture-list';
import { failed, packFileName, packJson, packReadme, readSkeleton, worldResults, type PictureResult } from './picture-pack';

const REPO = process.env['TL_VOXEL_BENCH_REPO'] ?? process.cwd();
const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? null : (argv[i + 1] ?? null);
};
const t0 = Date.now();
const startedAt = new Date().toISOString();
const OUT = arg('out') ?? join(homedir(), '.cache', 'thirdlight-pictures', startedAt.slice(0, 16).replace(/[:T]/g, ''));
const RAW = `${OUT}.raw`;
const ONLY = arg('only')?.split(',').filter((x) => x !== '') ?? null;
const REPORTS = arg('perf-reports') ?? join(homedir(), '.cache', 'thirdlight-logs', 'perf-reports');
const STAGING = { origin: arg('origin') ?? 'http://127.0.0.1:4180', root: join(homedir(), 'thirdlight-staging-p45'), project: 'voxel-slice', world: 'far' };
const secs = (): number => Math.round((Date.now() - t0) / 1000);
const log = (s: string): void => console.log(`pictures (${secs()} s): ${s}`);

function run(cmd: string, args: readonly string[], logFile: string, env: Record<string, string> = {}, timeoutMs = 30 * 60_000): number {
  const r = spawnSync(cmd, args, { cwd: REPO, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(logFile, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error !== undefined ? `\n${String(r.error)}` : ''}`);
  return r.status ?? 1;
}

const stagingActive = (): boolean => spawnSync('systemctl', ['is-active', '--quiet', 'thirdlight-staging']).status === 0;

async function main(): Promise<number> {
  const listProblems = pictureListProblems(PICTURES);
  if (listProblems.length > 0) throw new Error(`the picture list: ${listProblems.join('; ')}`);
  const list = PICTURES.filter((p) => ONLY === null || ONLY.includes(p.id));
  if (existsSync(OUT) && readdirSync(OUT).some((f) => f.endsWith('.png'))) throw new Error(`${OUT} already holds a pack: give a new --out`);
  // /tmp is RAM on this host: the fresh backend's data root and the browser's files go to disk.
  if (tmpdir().startsWith('/tmp')) process.env['TMPDIR'] = join(homedir(), '.cache', 'tmp', 'pictures');
  mkdirSync(tmpdir(), { recursive: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(RAW, { recursive: true });
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
  const results: PictureResult[] = [];
  // Never SwiftShader pictures as the product's look: without the GPU nothing is taken.
  const gpu = gpuAvailable() as boolean;
  let startedStaging = false;
  try {
    if (!gpu) {
      for (const p of list) results.push({ id: p.id, source: null, settled: false, settle: 'not taken: no usable GPU on this host (software rendering is not the product\'s look)', specks: null, facts: {} });
    } else {
      if (!stagingActive()) {
        log('starting staging (6G)');
        startedStaging = run('tools/staging.sh', ['start'], join(RAW, 'staging.log'), { TL_STAGING_MEM: '6G' }) === 0;
      }
      const stagingUp = stagingActive();
      const worlds = list.filter((p): p is WorldPicture => p.kind === 'world');
      for (const runName of Object.keys(PICTURE_RUNS) as PictureRun[]) {
        const cams = camerasOf(worlds, runName);
        if (cams.length === 0) continue;
        if (!stagingUp) {
          results.push(...worldResults(worlds, runName, null, 'staging did not start (staging.log)'));
          continue;
        }
        const out = join(RAW, runName);
        log(`light-shots ${runName}: ${cams.join(', ')}`);
        const rc = run(process.execPath, ['tools/voxel-bench/run.mjs', 'light-shots', '--quality', 'low', '--edits', '0', ...PICTURE_RUNS[runName], '--only', cams.join(','), '--out', out], join(RAW, `${runName}.log`));
        const file = join(out, 'light-shots.json');
        const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
        results.push(...worldResults(worlds, runName, json, `the bench wrote no result (exit ${rc}, ${runName}.log)`));
        log(`light-shots ${runName}: exit ${rc}`);
      }
      const screens = list.filter((p): p is ScreenPicture => p.kind === 'screen');
      if (screens.length > 0) {
        const browser = await launchGpuBrowser({ vsync: true });
        const idOf = (s: ScreenName): string => screens.find((p) => p.screen === s)!.id;
        const fileOf = (s: ScreenName): string => join(RAW, `screen-${s}.png`);
        const taken = new Map<ScreenName, PictureResult>();
        const want = screens.map((p) => p.screen);
        try {
          const staged: ScreenName[] = want.filter((s) => s === 'voxel-world-page' || s === 'play-profiler');
          if (staged.length > 0 && stagingUp) {
            log(`editor screens on staging: ${staged.join(', ')}`);
            const token = readFileSync(join(STAGING.root, 'owner-token'), 'utf8').trim();
            for (const [k, v] of await stagingScreens(browser, staged, { ...STAGING, token }, idOf, fileOf).catch((e: unknown) => { log(`staging screens: ${String(e).slice(0, 300)}`); return new Map<ScreenName, PictureResult>(); })) taken.set(k, v);
          }
          const yard = want.filter((s) => !staged.includes(s));
          if (yard.length > 0) {
            log(`editor screens on a fresh backend: ${yard.join(', ')}`);
            for (const [k, v] of await yardScreens(browser, yard, idOf, fileOf).catch((e: unknown) => { log(`yard screens: ${String(e).slice(0, 300)}`); return new Map<ScreenName, PictureResult>(); })) taken.set(k, v);
          }
        } finally {
          await browser.close().catch(() => undefined);
        }
        for (const p of screens) results.push(taken.get(p.screen) ?? { id: p.id, source: null, settled: false, settle: `not taken: ${p.screen === 'voxel-world-page' || p.screen === 'play-profiler' ? (stagingUp ? 'the screen failed (see the log)' : 'staging did not start') : 'the screen failed (see the log)'}`, specks: null, facts: { screen: p.screen } });
      }
    }
  } finally {
    if (startedStaging) run('tools/staging.sh', ['stop'], join(RAW, 'staging-stop.log'));
  }
  // Into the pack: each picture under its list name.
  for (const r of results) {
    const p = list.find((x) => x.id === r.id)!;
    if (r.source !== null && existsSync(r.source)) copyFileSync(r.source, join(OUT, packFileName(p, !r.settled)));
  }
  const usable = results.map((r) => (r.source !== null && !existsSync(r.source) ? { ...r, source: null, settle: `not taken: ${basename(r.source)} was not written` } : r));
  const perf = spawnSync(process.execPath, ['tools/perf-report.mjs', '--latest', REPORTS], { cwd: REPO, encoding: 'utf8' });
  const perfNote = perf.status === 0 ? 'perf-report.md (the newest phase run\'s numbers beside the one before)' : `none (${(perf.stderr || 'no report').trim()})`;
  if (perf.status === 0) writeFileSync(join(OUT, 'perf-report.md'), perf.stdout);
  const json = packJson(list, usable, { run: basename(OUT), commit, startedAt, seconds: secs(), host: { load: loadavg().map((x) => Number(x.toFixed(2))) }, perf: perfNote });
  writeFileSync(join(OUT, 'pictures.json'), `${JSON.stringify(json, null, 1)}\n`);
  writeFileSync(join(OUT, 'README.md'), packReadme(json));
  if (!existsSync(join(OUT, 'read.md'))) writeFileSync(join(OUT, 'read.md'), readSkeleton(json));
  const bad = usable.filter(failed);
  for (const r of bad) console.error(`pictures: ${r.id}: ${r.settle}`);
  const bytes = readdirSync(OUT).reduce((n, f) => n + readFileSync(join(OUT, f)).length, 0);
  console.log(`pictures: ${list.length - bad.length} of ${list.length} taken and settled, pack ${OUT} (${(bytes / 1e6).toFixed(1)} MB), raw ${RAW}, ${secs()} s`);
  return bad.length === 0 ? 0 : 1;
}

process.exit(await main().catch((e: unknown) => {
  console.error(`pictures: ${String(e)}`);
  return 2;
}));
