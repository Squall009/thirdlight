/**
 * The scale bench: one generated project of a given size (scale-generate.ts)
 * measured in a real browser against a real backend — the open, one
 * command's latency, the Play start, scene loads while walking through the
 * scenes (with what stays resident), a long voiced dialogue played through
 * (the silence between two lines), and the export.
 *
 * Every step is attempted and records either its numbers or why it could not
 * be taken (a cap refusing the open, a Play build refusing the content, a
 * timeout), so a run at a size the engine cannot hold still says where it
 * broke. Resident bytes by kind are not observable in the game host today;
 * the bench records what is: the JS heap after a collection
 * (performance.memory), the graphics API's live objects and bytes (the
 * instrumentation), three's renderer counts and the asset bytes read (Play
 * diagnostics), and the backend's resident set.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Browser, BrowserContext, Frame, Page } from '@playwright/test';

import type { StartTimingsReport } from '../../packages/game-host/src/start-timings';
import { startPerfBackend, type PerfBackend } from './backend';
import { launch, poll, serveDir, splitOf, type PlayStartSplit, type RendererName } from './browser';
import { installPerfInstrumentation, readSample, type PageSample } from './instrument';
import type { ScaleResult } from './scale-generate';
import { opusVoice } from './scale-media';
import { summarize, type Summary } from './stats';

export type ScaleStep = 'open' | 'commands' | 'import' | 'play' | 'walk' | 'dialogue' | 'export';
/** Every step; `import` (a folder of new files imported in one command) runs only when asked for. */
export const SCALE_STEPS: readonly ScaleStep[] = ['open', 'commands', 'import', 'play', 'walk', 'dialogue', 'export'];
export const SCALE_DEFAULT_STEPS: readonly ScaleStep[] = ['open', 'commands', 'play', 'walk', 'dialogue', 'export'];

export interface ScaleBenchOptions {
  dataRoot: string;
  exportRoot: string;
  projectId: string;
  /** The generated project (absent: a project the backend creates from a template, e.g. the Starter). */
  generated?: ScaleResult;
  renderer: RendererName;
  gpu: boolean;
  /** Command round trips per kind. */
  commands: number;
  /** Scenes loaded and unloaded one after another (at most the generated on-demand scenes). */
  walk: number;
  /** Dialogue lines played through (at most the walkthrough's). */
  lines: number;
  /** Voice files written into a new folder and imported in one command (the `import` step). */
  importFiles?: number;
  steps: ScaleStep[];
  log: (s: string) => void;
}

/** What the page holds at one moment. */
export interface MemorySample {
  heapMiB: number | null;
  gpuMiB: number;
  live: PageSample['live'];
  three?: { geometries: number; textures: number; programs: number };
  assetReads?: { reads: number; bytes: number };
  backendRssMiB: number | null;
}

export interface ScaleReport {
  projectId: string;
  generated?: Omit<ScaleResult, 'dir' | 'sceneIds'>;
  open?: { backendMs: number; editorConnectedMs: number; editorFirstFrameMs: number | null; editorHeapMiB: number | null; backendRssMiB: number | null; assetsListed: number | null };
  commands?: { sceneEdit: Summary; contentEdit: Summary | null; contentBytes: number | null };
  /** One `importAssets` of a folder of new voice files: the command's round trip (inspection included), and one scene edit after it. */
  import?: { files: number; added: number; ms: number; sceneEditAfterMs: number; backendRssMiB: number | null };
  play?: { split: PlayStartSplit; memory: MemorySample };
  walk?: {
    scenes: number;
    /** Request → loaded in the observation, and → unloaded (as the relay sees it). */
    loadMs: Summary;
    unloadMs: Summary;
    /** The game's own timings: request → file read, and request → the first frame that drew the scene. */
    readMs: Summary;
    attachMs: Summary;
    before: MemorySample;
    /** After each scene's load (one row per scene, in order). */
    loaded: MemorySample[];
    after: MemorySample;
  };
  dialogue?: {
    lines: number;
    linesSeen: number;
    voicesHeard: number;
    /** Line start → its voice playing (ms). */
    startLatencyMs: Summary;
    /** The previous voice gone → this voice playing (ms; 0 when they overlap). */
    gapMs: Summary;
    wallMs: number;
    /** The first lines' times from the dialogue start (ms): line start, voice playing, voice gone. */
    trace: { line: string; voice: string | null; start: number; playing: number | null; gone: number | null }[];
  };
  export?: { ms: number; files: number; bytes: number; firstFrameMs: number | null; state: string | null; pageErrors: string[] };
  /** Steps that could not be taken, and why. */
  broke: Partial<Record<ScaleStep, string>>;
}

const MiB = (b: number): number => Math.round((b / 1048576) * 100) / 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The script the bench attaches to the driver entity: a debug command that
 * starts a dialogue (a debug command runs as step input, so the bench starts
 * the conversation after the click that unlocks sound).
 */
export const DRIVER_SCRIPT = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const call of ctx.debug.command('benchDialogue', { description: 'Start a dialogue', args: [{ name: 'id', type: 'string' }] })) ctx.dialogue?.start(String(call.id));",
  '  },',
  '};',
].join('\n');

function backendRssMiB(pid: number): number | null {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m === null ? null : Math.round((Number(m[1]) / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

function dirSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const d = dirSize(p);
      files += d.files;
      bytes += d.bytes;
    } else {
      files += 1;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

type Obs = {
  state?: string;
  sound?: { unlocked?: boolean };
  scenes?: { loaded?: string[] };
  dialogue?: { running?: boolean; line?: { id?: string } | null } | null;
  audio?: { voices?: { assetId: string; bus: string; state: string }[] };
};

export class ScaleBench {
  readonly report: ScaleReport;
  private be: PerfBackend | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private play: { psid: string; frame: Frame } | null = null;

  constructor(private readonly opts: ScaleBenchOptions) {
    const { dir: _dir, sceneIds: _ids, ...generated } = opts.generated ?? ({} as ScaleResult);
    this.report = { projectId: opts.projectId, ...(opts.generated !== undefined ? { generated } : {}), broke: {} };
  }

  private get backend(): PerfBackend {
    if (this.be === null) throw new Error('the backend is not running');
    return this.be;
  }

  private relay(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    return this.backend.post(`/api/v1/projects/${this.opts.projectId}/play/${path}`, body);
  }

  private async observe(): Promise<Obs | null> {
    if (this.play === null) return null;
    const r = await this.relay(`${this.play.psid}/observe`);
    return r.status === 200 ? (r.json as Obs) : null;
  }

  /** Poll the observation back to back (no sleep: the relay's round trip is the resolution). */
  private async until(ok: (o: Obs | null) => boolean, timeoutMs: number, what: string): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!ok(await this.observe())) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }

  /** Run every requested step in order; a step that breaks is recorded and the ones that need it are skipped. */
  async run(): Promise<ScaleReport> {
    const want = (s: ScaleStep): boolean => this.opts.steps.includes(s);
    try {
      this.be = await startPerfBackend(this.opts.dataRoot, this.opts.exportRoot);
      this.browser = await launch(this.opts.renderer, this.opts.gpu);
      if (this.opts.generated === undefined) {
        const made = await this.backend.post('/api/v1/admin/projects', { projectId: this.opts.projectId, name: 'Scale bench starter', template: 'starter' });
        if (made.status !== 200 && made.status !== 201) throw new Error(`template project: ${JSON.stringify(made.json).slice(0, 300)}`);
      }
      const opened = await this.attempt('open', () => this.measureOpen());
      if (!opened) return this.report;
      if (want('commands')) await this.attempt('commands', () => this.measureCommands());
      if (want('import')) await this.attempt('import', () => this.measureFolderImport());
      const needPlay = want('play') || want('walk') || want('dialogue');
      if (needPlay && (await this.attempt('play', () => this.measurePlayStart()))) {
        if (want('walk')) await this.attempt('walk', () => this.walkScenes());
        if (want('dialogue')) await this.attempt('dialogue', () => this.playDialogue());
        await this.stopPlay();
      }
      if (want('export')) await this.attempt('export', () => this.measureExport());
      return this.report;
    } finally {
      await this.context?.close().catch(() => undefined);
      await this.browser?.close().catch(() => undefined);
      await this.be?.stop().catch(() => undefined);
    }
  }

  private async attempt(step: ScaleStep, fn: () => Promise<void>): Promise<boolean> {
    const t = Date.now();
    try {
      await fn();
      this.opts.log(`scale: ${step} done in ${Math.round((Date.now() - t) / 1000)} s`);
      return true;
    } catch (e) {
      const msg = String((e as Error).message ?? e).replace(/\s+/g, ' ').slice(0, 4000);
      this.report.broke[step] = msg;
      this.opts.log(`scale: ${step} broke: ${msg.slice(0, 300)}`);
      return false;
    }
  }

  /** The backend's first read of the project, then the editor page connected and drawn. */
  private async measureOpen(): Promise<void> {
    const p = this.backend.project(this.opts.projectId);
    const t0 = performance.now();
    const project = await p.query('queryProject');
    const backendMs = Math.round(performance.now() - t0);
    if (project['ok'] === false || project['revision'] === undefined) {
      // Every reason the model gave, one line each (the caps a full-size project meets).
      const err = project['error'] as { reason?: string; details?: { path?: string; message?: string; found?: unknown; max?: unknown; detailCount?: number }[]; detailCount?: number } | undefined;
      const lines = (err?.details ?? []).map((d) => `${d.path}: ${d.message} (${typeof d.found === 'object' ? '' : `found ${String(d.found)}`}${d.max !== undefined ? `, max ${String(d.max)}` : ''})`);
      throw new Error(`the backend refused the project (${err?.reason ?? 'unknown'}, ${err?.detailCount ?? lines.length} problems): ${lines.join('; ') || JSON.stringify(project).slice(0, 500)}`);
    }
    const assets = await p.query('queryAssets', { limit: 1, offset: 0 });
    this.context = await this.browser!.newContext({ viewport: { width: 1280, height: 720 } });
    await this.context.addInitScript(installPerfInstrumentation);
    this.page = await this.context.newPage();
    const t1 = Date.now();
    await this.page.goto(`${this.backend.origin}/?project=${this.opts.projectId}&renderer=${this.opts.renderer}#token=${this.backend.token}`);
    await this.page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 600_000 });
    const editorConnectedMs = Date.now() - t1;
    const first = await poll(() => this.page!.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null), (v) => v !== null, 120_000, 'the Scene view first frame').catch(() => null);
    const sample = await this.page.evaluate(readSample, false);
    const total = assets['total'];
    this.report.open = {
      backendMs,
      editorConnectedMs,
      editorFirstFrameMs: first === null ? null : first - t1,
      editorHeapMiB: sample.heap === null ? null : Math.round(sample.heap.usedMiB * 100) / 100,
      backendRssMiB: backendRssMiB(this.backend.pid),
      assetsListed: typeof total === 'number' ? total : null,
    };
  }

  /** One scene edit (a transform: rewrites one scene file) and one content edit (a material: rewrites content.json). */
  private async measureCommands(): Promise<void> {
    const p = this.backend.project(this.opts.projectId);
    const entities = ((await p.query('queryEntities', { limit: 50, offset: 0 }))['entities'] ?? []) as { id: string; components: Record<string, unknown> }[];
    const target = entities.find((e) => e.components['box'] !== undefined) ?? entities.find((e) => e.components['transform'] !== undefined);
    if (target === undefined) throw new Error('no entity with a transform in the start scene');
    const base = (target.components['transform'] as { position: number[] }).position;
    const scene: number[] = [];
    for (let i = 0; i < this.opts.commands; i++) {
      const t = performance.now();
      await p.command('setTransform', { entityId: target.id, transform: { position: [base[0]!, base[1]!, base[2]! + ((i % 2) + 1) * 0.01] } });
      scene.push(performance.now() - t);
    }
    await p.command('setTransform', { entityId: target.id, transform: { position: base } });
    let content: number[] | null = null;
    // The first material as stored (the project's own file; commands only replace whole materials).
    let mat: Record<string, unknown> | undefined;
    try {
      const file = JSON.parse(readFileSync(join(this.opts.dataRoot, 'projects', this.opts.projectId, 'content.json'), 'utf8')) as { content: { materials?: Record<string, unknown>[] } };
      mat = file.content.materials?.[0];
    } catch {
      mat = undefined;
    }
    if (mat !== undefined) {
      content = [];
      for (let i = 0; i < this.opts.commands; i++) {
        const t = performance.now();
        await p.command('setMaterial', { material: { ...mat, params: { ...(mat['params'] as object), roughness: 0.5 + ((i % 2) + 1) * 0.01 } } });
        content.push(performance.now() - t);
      }
    }
    let contentBytes: number | null = null;
    try {
      contentBytes = statSync(join(this.opts.dataRoot, 'projects', this.opts.projectId, 'content.json')).size;
    } catch {
      /* a folder project keeps its files elsewhere */
    }
    this.report.commands = { sceneEdit: summarize(scene), contentEdit: content === null ? null : summarize(content), contentBytes };
  }

  /** Publish and attach the driver script (the same HTTP route the editor's script publish takes). */
  /** Write a folder of new voice lines into the project and import it in one command, labelled. */
  private async measureFolderImport(): Promise<void> {
    const p = this.backend.project(this.opts.projectId);
    const files = this.opts.importFiles ?? 1000;
    const folder = 'assets/bench-import/voice';
    const dir = join(this.opts.dataRoot, 'projects', this.opts.projectId, ...folder.split('/'));
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < files; i++) writeFileSync(join(dir, `line-${String(i + 1).padStart(5, '0')}.opus`), opusVoice(9000 + i, 1000 + (i % 5) * 500, `bench line ${i + 1}`));
    const t0 = performance.now();
    const r = await p.command('importAssets', { folder: 'assets/bench-import', labels: ['bench', 'voice'] });
    const ms = Math.round(performance.now() - t0);
    const added = ((r['change'] as { added?: unknown[] } | undefined)?.added ?? []).length;
    // A scene edit after it: the catalog is larger now.
    const ents = ((await p.query('queryEntities', { limit: 50, offset: 0 }))['entities'] ?? []) as { id: string; components: Record<string, unknown> }[];
    let sceneEditAfterMs = -1;
    const target = ents.find((e) => e.components['transform'] !== undefined);
    if (target !== undefined) {
      const pos = (target.components['transform'] as { position: number[] }).position;
      const t1 = performance.now();
      await p.command('setTransform', { entityId: target.id, transform: { position: [pos[0]!, pos[1]! + 0.01, pos[2]!] } });
      sceneEditAfterMs = Math.round(performance.now() - t1);
    }
    this.report.import = { files, added, ms, sceneEditAfterMs, backendRssMiB: backendRssMiB(this.backend.pid) };
  }

  private async installDriver(): Promise<void> {
    const be = this.backend;
    const pid = this.opts.projectId;
    const p = be.project(pid);
    const behaviorId = 'bench-driver';
    const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: DRIVER_SCRIPT }] }, null, 2)}\n`);
    const stageId = await be.stage(pid, bytes);
    const declaration = { properties: [] };
    await p.command('publishBehavior', { behaviorId, displayName: 'Bench driver', mode: 'declaration-create', declaration });
    await p.command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
    const published = await be.post(`/api/v1/projects/${pid}/content/behaviors/source`, { stageId, behaviorId, displayName: 'Bench driver', declaration, expectedRevision: await p.revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
    if (published.status !== 200) throw new Error(`the driver script was refused: ${JSON.stringify(published.json).slice(0, 300)}`);
    await p.revision();
    await p.command('setBehaviorProperties', { entityId: this.opts.generated!.driverEntityId, behaviorId, values: {} });
  }

  private async memory(): Promise<MemorySample> {
    const frame = this.play?.frame;
    const s = frame !== undefined ? await frame.evaluate(readSample, false) : null;
    let three: MemorySample['three'];
    let assetReads: MemorySample['assetReads'];
    if (this.play !== null) {
      const d = (await this.relay(`${this.play.psid}/diagnostics`)).json as { diagnostics?: { renderer?: { gpu?: MemorySample['three'] }; assetReads?: { reads: number; bytes: number } } };
      three = d.diagnostics?.renderer?.gpu;
      assetReads = d.diagnostics?.assetReads;
    }
    return {
      heapMiB: s?.heap === null || s === null ? null : Math.round(s.heap.usedMiB * 100) / 100,
      gpuMiB: s === null ? 0 : MiB(s.bytes.buffers + s.bytes.textures),
      live: s?.live ?? { programs: 0, textures: 0, buffers: 0, vaos: 0, pipelines: 0 } as PageSample['live'],
      ...(three !== undefined ? { three } : {}),
      ...(assetReads !== undefined ? { assetReads } : {}),
      backendRssMiB: backendRssMiB(this.backend.pid),
    };
  }

  /** Play from the editor's button to the first frame, split into its stages. */
  private async measurePlayStart(): Promise<void> {
    if (this.opts.generated !== undefined && (this.opts.steps.includes('dialogue'))) await this.installDriver();
    const page = this.page!;
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'), { timeout: 600_000 });
    const before = new Set(page.frames());
    const t0 = Date.now();
    await page.getByTitle('Start an isolated play preview').click();
    const response = await started;
    const responseEpoch = Date.now();
    const body = (await response.json()) as { playSessionId?: string };
    if (typeof body.playSessionId !== 'string') throw new Error(`Play was refused: ${JSON.stringify(body).slice(0, 500)}`);
    const psid = body.playSessionId;
    const frame = await poll(async () => page.frames().find((f) => !before.has(f) && f.url().startsWith(this.backend.previewOrigin)), (f) => f !== undefined, 300_000, 'the preview iframe');
    this.play = { psid, frame: frame! };
    await poll(() => this.observe(), (o) => o?.state === 'running', 600_000, 'the play preview to run');
    const firstEpoch = await poll(() => frame!.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null), (v) => v !== null, 300_000, 'the first Play frame');
    const wait = firstEpoch! + 10_500 - Date.now();
    if (wait > 0) await sleep(wait);
    const diag = (await this.relay(`${psid}/diagnostics`)).json as { diagnostics?: { startTimings?: StartTimingsReport }; buildTimings?: Record<string, number> };
    this.report.play = { split: splitOf(t0, responseEpoch, diag.buildTimings ?? null, diag.diagnostics?.startTimings), memory: await this.memory() };
  }

  /** Load each on-demand scene, sample, unload it; memory before, after each load, and after the walk. */
  private async walkScenes(): Promise<void> {
    const ids = (this.opts.generated?.sceneIds ?? []).slice(1, 1 + this.opts.walk);
    if (ids.length === 0) throw new Error('the project has no scene that loads on demand');
    const before = await this.memory();
    const loaded: MemorySample[] = [];
    const loadMs: number[] = [];
    const unloadMs: number[] = [];
    for (const id of ids) {
      let t = performance.now();
      const asked = await this.relay(`${this.play!.psid}/control`, { command: 'loadScene', sceneId: id });
      if (asked.status !== 200) throw new Error(`loadScene ${id} refused: ${JSON.stringify(asked.json).slice(0, 300)}`);
      await this.until((o) => o?.scenes?.loaded?.includes(id) === true, 120_000, `scene ${id} to load`);
      loadMs.push(performance.now() - t);
      loaded.push(await this.memory());
      t = performance.now();
      await this.relay(`${this.play!.psid}/control`, { command: 'unloadScene', sceneId: id });
      await this.until((o) => o?.scenes?.loaded?.includes(id) === false, 120_000, `scene ${id} to unload`);
      unloadMs.push(performance.now() - t);
    }
    await sleep(2_000);
    const d = (await this.relay(`${this.play!.psid}/diagnostics`)).json as { diagnostics?: { startTimings?: StartTimingsReport } };
    const timings = (d.diagnostics?.startTimings?.sceneLoads ?? []).filter((l) => ids.includes(l.sceneId));
    const since = (v: number | null, from: number): number[] => (v === null ? [] : [v - from]);
    this.report.walk = {
      scenes: ids.length,
      loadMs: summarize(loadMs),
      unloadMs: summarize(unloadMs),
      readMs: summarize(timings.flatMap((l) => since(l.readMs, l.requestedMs))),
      attachMs: summarize(timings.flatMap((l) => since(l.attachedMs, l.requestedMs))),
      before,
      loaded,
      after: await this.memory(),
    };
  }

  /**
   * The walkthrough dialogue played through after a click unlocks sound:
   * each line's start and its voice's playing and gone times, from the
   * observation polled as fast as the relay answers.
   */
  private async playDialogue(): Promise<void> {
    const gen = this.opts.generated;
    if (gen === undefined) throw new Error('only a generated project has the walkthrough dialogue');
    const page = this.page!;
    const box = await page.locator('iframe.tl-app__preview-frame').boundingBox();
    if (box === null) throw new Error('the preview iframe is not visible');
    await page.mouse.click(box.x + box.width / 2, box.y + 20);
    await poll(() => this.observe(), (o) => o?.sound?.unlocked === true, 30_000, 'sound to unlock');
    const lines = Math.min(this.opts.lines, gen.walkthrough.lines);
    const asked = await this.relay(`${this.play!.psid}/control`, { command: 'debugCommand', name: 'benchDialogue', args: { id: gen.walkthrough.dialogueId } });
    if (asked.status !== 200) throw new Error(`the dialogue could not be started: ${JSON.stringify(asked.json).slice(0, 300)}`);
    // Line k of the walkthrough is node `l<k>` and says the k-th walkthrough voice.
    const expected = (line: string): string | null => {
      const k = /^l(\d+)$/.exec(line);
      return k === null ? null : (gen.walkthrough.voices[Number(k[1])] ?? null);
    };
    const lineStart = new Map<string, number>();
    const order: string[] = [];
    const playing = new Map<string, number>();
    const gone = new Map<string, number>();
    const t0 = Date.now();
    const deadline = t0 + lines * (gen.spec.walkthroughVoiceMs + 3_000) + 60_000;
    let started = false;
    let current: string | null = null;
    for (;;) {
      const o = await this.observe();
      const now = Date.now();
      if (o === null) throw new Error('the play stopped during the dialogue');
      const id = o.dialogue?.line?.id;
      if (o.dialogue?.running === true) started = true;
      if (typeof id === 'string' && !lineStart.has(id)) {
        lineStart.set(id, now);
        order.push(id);
        current = id;
      }
      const voices = (o.audio?.voices ?? []).filter((v) => v.bus === 'voice');
      // The current line's voice starts; an earlier line's voice ends when it is no longer playing.
      const want = current === null ? null : expected(current);
      if (current !== null && want !== null && !playing.has(current) && voices.some((v) => v.assetId === want && v.state === 'playing')) playing.set(current, now);
      for (const [line] of playing) {
        const asset = expected(line);
        const stillCurrent = line === current;
        if (!gone.has(line) && (!voices.some((v) => v.assetId === asset && v.state === 'playing') || (!stillCurrent && asset === want && playing.get(current!) === now))) gone.set(line, now);
      }
      if (started && o.dialogue?.running !== true) break;
      if (order.length >= lines + 1) break;
      if (now > deadline) throw new Error(`the dialogue did not finish in time (${order.length} of ${lines} lines seen)`);
    }
    const wallMs = Date.now() - t0;
    const latency: number[] = [];
    const gaps: number[] = [];
    let prevGone: number | null = null;
    let heard = 0;
    for (const line of order.slice(0, lines)) {
      const at = playing.get(line);
      if (at === undefined) {
        prevGone = null;
        continue;
      }
      heard += 1;
      latency.push(Math.max(0, at - lineStart.get(line)!));
      if (prevGone !== null) gaps.push(Math.max(0, at - prevGone));
      prevGone = gone.get(line) ?? null;
    }
    const rel = (v: number | undefined): number | null => (v === undefined ? null : v - t0);
    const trace = order.slice(0, 20).map((line) => ({ line, voice: expected(line), start: lineStart.get(line)! - t0, playing: rel(playing.get(line)), gone: rel(gone.get(line)) }));
    this.report.dialogue = { lines, linesSeen: Math.min(order.length, lines), voicesHeard: heard, startLatencyMs: summarize(latency), gapMs: summarize(gaps), wallMs, trace };
  }

  private async stopPlay(): Promise<void> {
    if (this.play === null) return;
    const psid = this.play.psid;
    await this.page?.getByTitle('Stop the play preview').click().catch(() => undefined);
    await poll(async () => (await this.relay(`${psid}/observe`)).status, (st) => st === 404, 60_000, 'the play to stop').catch(() => undefined);
    this.play = null;
  }

  /** The export request, its output on disk, and the exported game's first frame in its own page. */
  private async measureExport(): Promise<void> {
    const t = performance.now();
    const res = await this.backend.post(`/api/v1/admin/projects/${this.opts.projectId}/export`, {});
    const ms = Math.round(performance.now() - t);
    if (res.status !== 200) throw new Error(`the export was refused after ${ms} ms: ${JSON.stringify(res.json).slice(0, 500)}`);
    const dir = join(this.backend.exportRoot, String(res.json['outputDir']));
    const size = dirSize(dir);
    const site = await serveDir(dir);
    const context = await this.browser!.newContext({ viewport: { width: 1280, height: 720 } });
    await context.addInitScript(installPerfInstrumentation);
    const game = await context.newPage();
    const pageErrors: string[] = [];
    game.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
    try {
      const t0 = Date.now();
      await game.goto(site.url);
      const first = await poll(() => game.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null), (v) => v !== null, 300_000, 'the exported game first frame').catch(() => null);
      const state = await game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { state?: string } }).__thirdlightObserve?.()?.state ?? null)).catch(() => null);
      this.report.export = { ms, files: size.files, bytes: size.bytes, firstFrameMs: first === null ? null : first - t0, state, pageErrors };
    } finally {
      await context.close();
      await site.close();
    }
  }
}
