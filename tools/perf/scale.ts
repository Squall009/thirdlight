/**
 * The scale bench: one generated project of a given size (scale-generate.ts)
 * measured in a real browser against a real backend — the open, one
 * command's latency, the Play start, scene loads while walking through the
 * scenes (with what stays resident), a script loading the labelled assets
 * by their label and releasing them (what is resident before, while held
 * and after), a long voiced dialogue played through (the silence between
 * two lines), and the export.
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
import { SCALE_BATCH_LABEL, type ScaleResult } from './scale-generate';
import { checkerPng, opusVoice } from './scale-media';
import { summarize, type Summary } from './stats';
import { measureEditorAtScale, type EditorScaleReport } from './scale-editor';
import { measureProjectWindowAtScale, type ProjectWindowScaleReport } from './scale-project';

export type ScaleStep = 'files' | 'open' | 'commands' | 'editor' | 'import' | 'play' | 'walk' | 'handles' | 'dialogue' | 'stream' | 'replay' | 'export';
/**
 * Every step; `import` (a folder of new files imported in one command), `stream` (large KTX2 textures
 * streamed past the camera under a small texture budget) and `replay` (the run restarted with scenes
 * loaded) run only when asked for.
 */
export const SCALE_STEPS: readonly ScaleStep[] = ['files', 'open', 'commands', 'editor', 'import', 'play', 'walk', 'handles', 'dialogue', 'stream', 'replay', 'export'];
export const SCALE_DEFAULT_STEPS: readonly ScaleStep[] = ['files', 'open', 'commands', 'editor', 'play', 'walk', 'handles', 'dialogue', 'export'];

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
  /** The `stream` step: large KTX2 textures (2048²) imported, and the texture budget (MiB) Play runs with. */
  streamTextures?: number;
  streamBudgetMb?: number;
  /** The `replay` step: restarts asked for, and the on-demand scenes loaded before each (the restart unloads them). */
  replays?: number;
  replayScenes?: number;
  /** Where Play runs the simulation (the project's `sim_thread`; absent: the project's setting). */
  threads?: 'worker' | 'single';
  steps: ScaleStep[];
  /**
   * Play after the open has settled: the editor's connect-time file check
   * answered, then this many ms more (the backend builds the next Play ahead
   * meanwhile). Absent: Play is clicked as soon as the editor is connected
   * (it then waits for that check).
   */
  settleMs?: number;
  log: (s: string) => void;
}

/** What the page holds at one moment. */
export interface MemorySample {
  heapMiB: number | null;
  gpuMiB: number;
  live: PageSample['live'];
  three?: { geometries: number; textures: number; programs: number };
  assetReads?: { reads: number; bytes: number };
  /** The game page's fetches so far: all, answered by the browser's HTTP cache, bytes over the network and in the bodies. */
  fetches?: { n: number; cached: number; networkBytes: number; bodyBytes: number };
  /** Catalog files the page read so far (absent before Play diagnostics carried them). */
  catalogReads?: { files: number; bytes: number };
  /** What the game holds from assets (the resource manager: resident count and bytes per kind, loads, frees, script handles open); absent before it existed. */
  resources?: { resident: Record<string, { count: number; bytes: number }>; loads: Record<string, number>; frees: Record<string, number>; handles?: number };
  /** Resident texture bytes against the texture budget (streamed textures, each GPU copy, and the ones that do not stream). */
  textures?: { budgetBytes: number; residentBytes: number; streamedBytes: number; over: boolean };
  backendRssMiB: number | null;
}

export interface ScaleReport {
  projectId: string;
  generated?: Omit<ScaleResult, 'dir' | 'sceneIds'>;
  open?: { backendMs: number; editorConnectedMs: number; editorFirstFrameMs: number | null; editorHeapMiB: number | null; backendRssMiB: number | null; assetsListed: number | null };
  commands?: { sceneEdit: Summary; contentEdit: Summary | null; contentBytes: number | null };
  /** The editor at this size (scale-editor.ts): open to usable, the asset list scrolled through, a picker search, a placement, a line's voice. */
  editor?: EditorScaleReport;
  /** The project window: files chosen, labelled and moved in one command each (then undone). */
  projectWindow?: ProjectWindowScaleReport;
  /** One `importAssets` of a folder of new voice files: the command's round trip (inspection included), and one scene edit after it. */
  import?: { files: number; added: number; ms: number; sceneEditAfterMs: number; backendRssMiB: number | null };
  /**
   * The file check ("check files", run by the editor on connect and focus and before Play): the first after the
   * project is copied in (every file hashed), again at once (stats only), and the first after a restart (the
   * stamps the last run kept); each with the backend's resident set after it.
   */
  files?: { firstMs: number; againMs: number; afterRestartMs: number; entries: number; backendRssMiB: { first: number | null; again: number | null; afterRestart: number | null } };
  /** `backendRssPeakMiB`: sampled every 50 ms from the click to the first frame; `backendRssAfterStopMiB`: once the play stopped. */
  /** `renderer`: the backend that drew the play and its API (Play diagnostics), so a run names the renderer it measured. */
  play?: { split: PlayStartSplit; memory: MemorySample; renderer?: { backend?: string; state?: string; reason?: string }; settledMs?: number; backendRssPeakMiB?: number | null; backendRssAfterStopMiB?: number | null };
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
  /**
   * A script loads every asset with the bench's label (`ctx.assets.load(label)`), and releases the
   * handle once it is ready: the command → ready in the observation, the ids the handle names, and
   * what is resident before, while it is held and after the release settled.
   */
  handles?: {
    label: string;
    assets: number;
    readyMs: number;
    releasedMs: number;
    before: MemorySample;
    loaded: MemorySample;
    after: MemorySample;
    /** The same load and release again: what the first left behind is a cache if this one adds nothing. */
    again: { readyMs: number; loaded: MemorySample; after: MemorySample };
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
    /** Voices that started after their play command (read or decoded first) and voices dropped past their bound. */
    late: { started: number; dropped: number; maxLateMs: number };
    /** Resident audio KiB per kind (decoded, compressed, streams) before, at most during, and after the dialogue (settled). */
    audioKiB: { before: Record<string, number>; most: Record<string, number>; after: Record<string, number> };
  };
  /**
   * Texture streaming: large KTX2 textures (their files cut by mip level) on boxes in a scene of their own,
   * brought up to the camera one after another (the one before sent far again) under a small texture
   * budget: each texture's full-size level arriving after it came close, and the resident texture bytes
   * at every observation, against the budget.
   */
  stream?: {
    textures: number;
    budgetBytes: number;
    /** One texture's whole chain and its mip tail, as resident (one copy). */
    fullChainBytes: number;
    tailBytes: number;
    /** Brought close → its full-size level resident (ms). */
    upgradeMs: Summary;
    maxResidentBytes: number;
    samples: number;
    overBudgetSamples: number;
    upgrades: number;
    drops: number;
    /** After the scene was unloaded (settled): resident texture bytes. */
    afterBytes: number;
    /** Encoding and importing the textures (before Play), and the backend's resident set before and after it. */
    importMs: number;
    importBackendRssMiB: { before: number | null; after: number | null };
  };
  /**
   * The run restarted (`replay` through the control relay) with on-demand scenes loaded, which the restart
   * unloads: each call's answer (time, HTTP status, the answer's state or error code) and the time until the
   * observation shows the new run (its run step counting from the restart, the loaded scenes gone).
   */
  replay?: {
    threads: string | null;
    scenesLoaded: number;
    answerMs: Summary;
    appliedMs: Summary;
    answers: { status: number; ms: number; code?: string; state?: string; runId?: string; appliedMs: number | null }[];
  };
  /**
   * The export request (its time, the backend's resident set before it and its peak while it ran, sampled every
   * 50 ms), its output on disk, and the exported game played from a static server with the backend stopped.
   */
  export?: { ms: number; files: number; bytes: number; backendRssBeforeMiB: number | null; backendRssPeakMiB: number | null; firstFrameMs: number | null; state: string | null; pageErrors: string[] };
  /** Steps that could not be taken, and why. */
  broke: Partial<Record<ScaleStep, string>>;
}

const MiB = (b: number): number => Math.round((b / 1048576) * 100) / 100;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The script the bench attaches to the driver entity: debug commands that
 * start a dialogue (a debug command runs as step input, so the bench starts
 * the conversation after the click that unlocks sound), load assets by a key
 * and release them, and move an object (the stream step's boxes).
 */
export const DRIVER_SCRIPT = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const call of ctx.debug.command('benchDialogue', { description: 'Start a dialogue', args: [{ name: 'id', type: 'string' }] })) ctx.dialogue?.start(String(call.id));",
  "    for (const call of ctx.debug.command('benchLoad', { description: 'Load assets by id, address or label', args: [{ name: 'key', type: 'string' }] })) state.handle = ctx.assets.load(String(call.key));",
  "    for (const _call of ctx.debug.command('benchRelease', { description: 'Release the loaded assets', args: [] })) { ctx.assets.release(state.handle); state.handle = 0; }",
  "    for (const c of ctx.debug.command('benchPlace', { description: 'Move an object', args: [{ name: 'id', type: 'string' }, { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) ctx.entity(String(c.id))?.set('transform', { position: [Number(c.x), Number(c.y), Number(c.z)] });",
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
  resources?: { loading: number; waiting: number; handles: number; open?: { handle: number; key: string; state: string; assets: number }[]; resident?: Partial<Record<string, { count: number; bytes: number }>> };
  sound?: { unlocked?: boolean };
  scenes?: { loaded?: string[] };
  dialogue?: { running?: boolean; line?: { id?: string } | null } | null;
  audio?: { voices?: { assetId: string; bus: string; state: string }[]; late?: { started: number; dropped: number; recent: { lateMs: number }[] } };
};

/** Resident audio KiB per audio resource kind (decoded buffers, compressed bytes, streams). */
const audioKiB = (o: Obs | null): Record<string, number> => Object.fromEntries(Object.entries(o?.resources?.resident ?? {}).filter(([k, v]) => k.startsWith('audio') && v !== undefined).map(([k, v]) => [k, Math.round((v!.bytes / 1024) * 10) / 10]));

export class ScaleBench {
  readonly report: ScaleReport;
  private be: PerfBackend | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private connectCheck: Promise<void> = Promise.resolve();
  private play: { psid: string; frame: Frame } | null = null;
  private streamSetup: { boxes: { id: string; texture: string; far: [number, number, number] }[]; near: [number, number, number]; importMs: number; rss: { before: number | null; after: number | null } } | null = null;

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
      if (want('files')) await this.attempt('files', () => this.measureFileCheck());
      const opened = await this.attempt('open', () => this.measureOpen());
      if (!opened) return this.report;
      if (want('commands')) await this.attempt('commands', () => this.measureCommands());
      if (want('editor')) await this.attempt('editor', () => this.measureEditor());
      if (want('import')) await this.attempt('import', () => this.measureFolderImport());
      if (want('stream')) await this.attempt('stream', () => this.setUpStreaming());
      const needPlay = want('play') || want('walk') || want('handles') || want('dialogue') || want('stream') || want('replay');
      if (needPlay && (await this.attempt('play', () => this.measurePlayStart()))) {
        if (want('walk')) await this.attempt('walk', () => this.walkScenes());
        if (want('handles')) await this.attempt('handles', () => this.loadByLabel());
        if (want('dialogue')) await this.attempt('dialogue', () => this.playDialogue());
        if (want('stream') && this.streamSetup !== null) await this.attempt('stream', () => this.streamPastCamera());
        if (want('replay')) await this.attempt('replay', () => this.replayRuns());
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

  /** One file check over HTTP (what the editor asks for), its time and the report's size. */
  private async fileCheck(): Promise<{ ms: number; entries: number }> {
    const t = performance.now();
    const r = await this.backend.post(`/api/v1/projects/${this.opts.projectId}/content/files/check`, { problems: true });
    const ms = Math.round(performance.now() - t);
    if (r.status !== 200) throw new Error(`the file check was refused: ${JSON.stringify(r.json).slice(0, 300)}`);
    return { ms, entries: Number((r.json['summary'] as { total?: number } | undefined)?.total ?? 0) };
  }

  /**
   * The file check's cost: the first after the copy (every file is hashed), a second at once, and the first
   * after a restart; the backend is started again after it so the open step measures a fresh open.
   */
  private async measureFileCheck(): Promise<void> {
    await this.backend.project(this.opts.projectId).query('queryProject');
    const first = await this.fileCheck();
    const firstRss = backendRssMiB(this.backend.pid);
    const again = await this.fileCheck();
    const againRss = backendRssMiB(this.backend.pid);
    const restart = async (): Promise<void> => {
      await this.backend.stop();
      this.be = await startPerfBackend(this.opts.dataRoot, this.opts.exportRoot);
    };
    await restart();
    await this.backend.project(this.opts.projectId).query('queryProject');
    const after = await this.fileCheck();
    const afterRss = backendRssMiB(this.backend.pid);
    await restart();
    this.report.files = { firstMs: first.ms, againMs: again.ms, afterRestartMs: after.ms, entries: first.entries, backendRssMiB: { first: firstRss, again: againRss, afterRestart: afterRss } };
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
    // The editor's connect-time file check (a settled Play waits for its answer).
    this.connectCheck = this.page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/content/files/check'), { timeout: 600_000 }).then(
      () => undefined,
      () => undefined,
    );
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

  /** The editor at this size: the open step's page opens the editor again (one editor per project; later steps go on in it). */
  private async measureEditor(): Promise<void> {
    const p = this.backend.project(this.opts.projectId);
    this.report.editor = await measureEditorAtScale(this.page!, {
      query: (op, args) => p.query(op, args),
      // A fling at frame rate (what scrolling costs), not a wait on every screen.
      settle: false,
      url: `${this.backend.origin}/?project=${this.opts.projectId}&renderer=${this.opts.renderer}#token=${this.backend.token}`,
      log: this.opts.log,
    });
    const voices = this.opts.generated?.spec.voices ?? 0;
    if (voices > 0) {
      this.report.projectWindow = await measureProjectWindowAtScale(this.page!, {
        query: (op, args) => p.query(op, args),
        files: Math.min(1000, voices),
        folder: 'assets/voice',
        log: this.opts.log,
      });
    }
  }

  /** One scene edit (a transform: rewrites one scene file) and one content edit (a material: rewrites its own file and content.json's record). */
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
      // The index says where the material's file is (a data-root project is its own game folder).
      const found = (await p.query('queryIndex', { kind: 'material', limit: 1 }))['entries'] as { path: string }[] | undefined;
      const path = found?.[0]?.path;
      if (path !== undefined) mat = (JSON.parse(readFileSync(join(this.opts.dataRoot, 'projects', this.opts.projectId, ...path.split('/')), 'utf8')) as { data: Record<string, unknown> }).data;
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
    let catalogReads: MemorySample['catalogReads'];
    let resources: (MemorySample['resources'] & { textures?: MemorySample['textures'] }) | undefined;
    if (this.play !== null) {
      const d = (await this.relay(`${this.play.psid}/diagnostics`)).json as { diagnostics?: { renderer?: { gpu?: MemorySample['three'] }; assetReads?: { reads: number; bytes: number }; catalogReads?: { files: number; bytes: number }; resources?: MemorySample['resources'] & { textures?: MemorySample['textures'] } } };
      three = d.diagnostics?.renderer?.gpu;
      assetReads = d.diagnostics?.assetReads;
      catalogReads = d.diagnostics?.catalogReads;
      resources = d.diagnostics?.resources;
    }
    const tex = resources?.textures;
    return {
      heapMiB: s?.heap === null || s === null ? null : Math.round(s.heap.usedMiB * 100) / 100,
      gpuMiB: s === null ? 0 : MiB(s.bytes.buffers + s.bytes.textures),
      live: s?.live ?? { programs: 0, textures: 0, buffers: 0, vaos: 0, pipelines: 0 } as PageSample['live'],
      ...(three !== undefined ? { three } : {}),
      ...(assetReads !== undefined ? { assetReads } : {}),
      ...(catalogReads !== undefined ? { catalogReads } : {}),
      ...(s?.fetches !== undefined ? { fetches: s.fetches } : {}),
      ...(resources !== undefined ? { resources: { resident: resources.resident, loads: resources.loads, frees: resources.frees, ...(resources.handles !== undefined ? { handles: resources.handles } : {}) } } : {}),
      ...(tex !== undefined ? { textures: { budgetBytes: tex.budgetBytes, residentBytes: tex.residentBytes, streamedBytes: tex.streamedBytes, over: tex.over } } : {}),
      backendRssMiB: backendRssMiB(this.backend.pid),
    };
  }

  /** Play from the editor's button to the first frame, split into its stages. */
  private async measurePlayStart(): Promise<void> {
    if (this.opts.generated !== undefined && (this.opts.steps.includes('dialogue') || this.opts.steps.includes('handles') || this.opts.steps.includes('stream') || this.opts.steps.includes('replay'))) await this.installDriver();
    if (this.opts.threads !== undefined) await this.backend.project(this.opts.projectId).command('setSettings', { settings: { sim_thread: this.opts.threads === 'worker' ? 1 : 2 } });
    const page = this.page!;
    if (this.opts.settleMs !== undefined) {
      await this.connectCheck;
      await sleep(this.opts.settleMs);
    }
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'), { timeout: 600_000 });
    const before = new Set(page.frames());
    // The backend's resident set, sampled until the first frame.
    let rssPeak: number | null = null;
    const sampler = setInterval(() => {
      const v = backendRssMiB(this.backend.pid);
      if (v !== null && (rssPeak === null || v > rssPeak)) rssPeak = v;
    }, 50);
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
    const firstEpoch = await poll(() => frame!.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null), (v) => v !== null, 300_000, 'the first Play frame').finally(() => clearInterval(sampler));
    const wait = firstEpoch! + 10_500 - Date.now();
    if (wait > 0) await sleep(wait);
    const diag = (await this.relay(`${psid}/diagnostics`)).json as { diagnostics?: { startTimings?: StartTimingsReport }; buildTimings?: Record<string, number> };
    // What drew the play: the renderer factory mirrors its choice on the canvas.
    const drawn = await frame!.evaluate(() => {
      const c = document.querySelector('canvas[data-tl-renderer]');
      return c === null ? null : { backend: c.getAttribute('data-tl-renderer') ?? undefined, state: c.getAttribute('data-tl-renderer-state') ?? undefined, reason: c.getAttribute('data-tl-renderer-reason') ?? undefined };
    });
    this.report.play = {
      split: splitOf(t0, responseEpoch, diag.buildTimings ?? null, diag.diagnostics?.startTimings),
      memory: await this.memory(),
      ...(drawn !== null ? { renderer: drawn } : {}),
      ...(this.opts.settleMs !== undefined ? { settledMs: this.opts.settleMs } : {}),
      backendRssPeakMiB: rssPeak,
    };
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
   * A script loads every asset carrying the bench's label and releases the
   * handle: resident memory (per kind, and the heap after a collection)
   * before, while held, and after the release was settled.
   */
  private async loadByLabel(): Promise<void> {
    const label = SCALE_BATCH_LABEL;
    const settled = async (what: string): Promise<void> => {
      await this.until((o) => o?.resources !== undefined && o.resources.loading === 0 && o.resources.waiting === 0, 120_000, what);
    };
    const control = async (name: string, args: Record<string, string>): Promise<void> => {
      const r = await this.relay(`${this.play!.psid}/control`, { command: 'debugCommand', name, args });
      if (r.status !== 200) throw new Error(`${name} refused: ${JSON.stringify(r.json).slice(0, 300)}`);
    };
    /** Load the label, wait for ready, sample; release, wait for the settle, sample. */
    const cycle = async (): Promise<{ assets: number; readyMs: number; releasedMs: number; loaded: MemorySample; after: MemorySample }> => {
      const t0 = performance.now();
      await control('benchLoad', { key: label });
      let assets = 0;
      await this.until((o) => {
        const h = o?.resources?.open?.find((x) => x.key === label);
        if (h?.state === 'failed') throw new Error(`the label's handle failed: ${JSON.stringify(h)}`);
        if (h?.state !== 'ready') return false;
        assets = h.assets;
        return true;
      }, 600_000, `the handle of ${label} to be ready`);
      const readyMs = Math.round(performance.now() - t0);
      await settled('the resources to settle with the handle held');
      const loaded = await this.memory();
      const t1 = performance.now();
      await control('benchRelease', {});
      await this.until((o) => o?.resources?.handles === 0 && o.resources.loading === 0 && o.resources.waiting === 0, 120_000, 'the release to settle');
      const releasedMs = Math.round(performance.now() - t1);
      await sleep(2_000);
      return { assets, readyMs, releasedMs, loaded, after: await this.memory() };
    };
    await settled('the resources to settle before the load');
    const before = await this.memory();
    const first = await cycle();
    const second = await cycle();
    this.report.handles = { label, assets: first.assets, readyMs: first.readyMs, releasedMs: first.releasedMs, before, loaded: first.loaded, after: first.after, again: { readyMs: second.readyMs, loaded: second.loaded, after: second.after } };
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
    const first = await this.observe();
    const before = audioKiB(first);
    const lateBefore = { started: first?.audio?.late?.started ?? 0, dropped: first?.audio?.late?.dropped ?? 0 };
    const most: Record<string, number> = { ...before };
    let maxLateMs = 0;
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
      for (const [k, v] of Object.entries(audioKiB(o))) most[k] = Math.max(most[k] ?? 0, v);
      for (const r of o.audio?.late?.recent ?? []) maxLateMs = Math.max(maxLateMs, r.lateMs);
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
    // After: the voices' files let go once the conversation ended and the last voice stopped.
    const settled = await poll(() => this.observe(), (o) => o !== null && (o.audio?.voices ?? []).every((v) => v.bus !== 'voice') && (o.resources?.loading ?? 0) + (o.resources?.waiting ?? 0) === 0, 30_000, 'the voices to end').catch(() => null);
    const end = settled ?? (await this.observe());
    const late = { started: (end?.audio?.late?.started ?? 0) - lateBefore.started, dropped: (end?.audio?.late?.dropped ?? 0) - lateBefore.dropped, maxLateMs };
    this.report.dialogue = { lines, linesSeen: Math.min(order.length, lines), voicesHeard: heard, startLatencyMs: summarize(latency), gapMs: summarize(gaps), wallMs, trace, late, audioKiB: { before, most, after: audioKiB(end) } };
  }

  /**
   * Before Play: large KTX2 textures (2048² checkers, each its own colours, encoded on import as a user's
   * import would), a scene of their own with a box wearing each (unlit, a quarter tiling) far down the
   * start camera's view, and the small texture budget Play runs with.
   */
  private async setUpStreaming(): Promise<void> {
    const pid = this.opts.projectId;
    const p = this.backend.project(pid);
    const n = this.opts.streamTextures ?? 6;
    const ents = ((await p.query('queryEntities', { limit: 200, offset: 0 }))['entities'] ?? []) as { id: string; components: Record<string, unknown> }[];
    const cam = ents.find((e) => e.components['camera'] !== undefined);
    const at = ((cam?.components['transform'] as { position?: number[] } | undefined)?.position ?? [0, 0, 6]) as [number, number, number];
    const rssBefore = backendRssMiB(this.backend.pid);
    const t0 = performance.now();
    const boxes: { id: string; texture: string; far: [number, number, number] }[] = [];
    await p.command('createScene', { sceneId: 'bench-stream', name: 'Streamed textures' });
    for (let i = 0; i < n; i++) {
      const hue = (i * 47) % 360;
      const a: [number, number, number] = [200 + ((hue * 3) % 55), 180 + ((hue * 7) % 75), 150 + ((hue * 11) % 105)];
      const png = checkerPng(2048, a, [20 + (i % 5) * 5, 20, 40 + i]);
      const stageId = await this.backend.stage(pid, png);
      const inspected = await this.backend.post(`/api/v1/projects/${pid}/content/stages/${stageId}/inspect`, { kind: 'texture', ktx2: 'color' });
      const prop = inspected.json['proposal'] as Record<string, unknown> | undefined;
      if (prop === undefined || prop['status'] !== 'ok') throw new Error(`a streamed texture could not be encoded: ${JSON.stringify(inspected.json).slice(0, 300)}`);
      const texture = `bench-stream-${i}`;
      await p.command('publishAsset', { mode: 'create', assetId: texture, kind: 'texture', displayName: texture, sourceDigest: prop['sourceDigest'], sourceByteLength: prop['sourceByteLength'], convertedFrom: inspected.json['convertedFrom'], importRecipe: prop['importRecipe'], metrics: prop['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
      await this.backend.discardStage(pid, stageId).catch(() => undefined);
      await p.command('setMaterial', { material: { materialId: `mat-${texture}`, name: `Streamed ${i}`, shader: 'unlit', params: { tiling: [0.25, 0.25] }, textures: { map: texture } } });
      const far: [number, number, number] = [at[0] + (i - (n - 1) / 2) * 3, at[1], at[2] - 80];
      const created = await p.command('createEntity', { sceneId: 'bench-stream', kind: 'box', name: `Streamed ${i}`, transform: { position: far }, box: { size: [2, 2, 0.05], material: { color: '#ffffff' } }, components: { materials: { '*': `mat-${texture}` } } });
      boxes.push({ id: String(created['createdId']), texture, far });
    }
    await p.command('setSettings', { settings: { texture_budget_mb: this.opts.streamBudgetMb ?? 8 } });
    this.streamSetup = { boxes, near: [at[0], at[1], at[2] - 1.2], importMs: Math.round(performance.now() - t0), rss: { before: rssBefore, after: backendRssMiB(this.backend.pid) } };
  }

  /** The stream scene loaded; each box brought up to the camera in turn (the one before sent back); the scene unloaded. */
  private async streamPastCamera(): Promise<void> {
    const setup = this.streamSetup!;
    type Tex = { budgetBytes: number; residentBytes: number; over: boolean; upgrades: number; drops: number; textures: { id: string; resident: number; tail: number; bytes: number; copies: number }[] };
    const texturesOf = (o: Obs | null): Tex | undefined => (o?.resources as { textures?: Tex } | undefined)?.textures;
    let maxResident = 0;
    let samples = 0;
    let over = 0;
    let last: Tex | undefined;
    const sample = (o: Obs | null): Tex | undefined => {
      const t = texturesOf(o);
      if (t !== undefined) {
        samples += 1;
        maxResident = Math.max(maxResident, t.residentBytes);
        if (t.residentBytes > t.budgetBytes) over += 1;
        last = t;
      }
      return t;
    };
    const control = async (body: Record<string, unknown>): Promise<void> => {
      const r = await this.relay(`${this.play!.psid}/control`, body);
      if (r.status !== 200) {
        const o = (await this.relay(`${this.play!.psid}/observe`)).json as { debugCommands?: { registered?: { name: string }[] } };
        throw new Error(`${JSON.stringify(body).slice(0, 80)} refused: ${JSON.stringify(r.json).slice(0, 300)} (declared: ${(o.debugCommands?.registered ?? []).map((c) => c.name).join(', ')})`);
      }
    };
    const place = (id: string, p: [number, number, number]) => control({ command: 'debugCommand', name: 'benchPlace', args: { id, x: p[0], y: p[1], z: p[2] } });
    await control({ command: 'loadScene', sceneId: 'bench-stream' });
    await this.until((o) => (sample(o)?.textures.length ?? 0) >= setup.boxes.length && o?.scenes?.loaded?.includes('bench-stream') === true, 120_000, 'the streamed textures to load');
    const tailBytes = Math.max(...last!.textures.map((t) => t.bytes / Math.max(1, t.copies)));
    const upgrade: number[] = [];
    let fullChain = 0;
    let before: (typeof setup.boxes)[number] | null = null;
    for (const box of setup.boxes) {
      if (before !== null) await place(before.id, before.far);
      const t0 = performance.now();
      await place(box.id, setup.near);
      await this.until((o) => {
        const t = sample(o)?.textures.find((x) => x.id === box.texture);
        if (t === undefined || t.resident !== 0) return false;
        fullChain = Math.max(fullChain, t.bytes / Math.max(1, t.copies));
        return true;
      }, 60_000, `${box.texture} at full size`);
      upgrade.push(performance.now() - t0);
      before = box;
    }
    await control({ command: 'unloadScene', sceneId: 'bench-stream' });
    await this.until((o) => o?.scenes?.loaded?.includes('bench-stream') === false && (o.resources?.loading ?? 0) + (o.resources?.waiting ?? 0) === 0, 60_000, 'the stream scene to unload');
    await sleep(1_000);
    const end = texturesOf(await this.observe());
    this.report.stream = {
      textures: setup.boxes.length,
      budgetBytes: last!.budgetBytes,
      fullChainBytes: fullChain,
      tailBytes,
      upgradeMs: summarize(upgrade),
      maxResidentBytes: maxResident,
      samples,
      overBudgetSamples: over,
      upgrades: last!.upgrades,
      drops: last!.drops,
      afterBytes: end?.residentBytes ?? 0,
      importMs: setup.importMs,
      importBackendRssMiB: setup.rss,
    };
  }

  /** Restart the run with scenes loaded: each answer, and when the observation shows the new run. */
  private async replayRuns(): Promise<void> {
    const psid = this.play!.psid;
    const ids = (this.opts.generated?.sceneIds ?? []).slice(1, 1 + (this.opts.replayScenes ?? 10));
    const n = this.opts.replays ?? 10;
    const answers: NonNullable<ScaleReport['replay']>['answers'] = [];
    let threads: string | null = null;
    for (let i = 0; i < n; i += 1) {
      for (const id of ids) {
        const r = await this.relay(`${psid}/control`, { command: 'loadScene', sceneId: id });
        if (r.status !== 200) throw new Error(`loadScene ${id} refused: ${JSON.stringify(r.json).slice(0, 300)}`);
      }
      await this.until((o) => ids.every((id) => o?.scenes?.loaded?.includes(id) === true), 300_000, 'the scenes to load before the replay');
      const before = (await this.observe()) as (Obs & { run?: { runStep: number }; stepIndex?: number; simulation?: { mode?: string } }) | null;
      threads = before?.simulation?.mode ?? threads;
      const t0 = performance.now();
      const r = await this.relay(`${psid}/control`, { command: 'replay' });
      const ms = Math.round(performance.now() - t0);
      const err = r.json['error'] as { code?: string } | undefined;
      const answer: (typeof answers)[number] = { status: r.status, ms, appliedMs: null, ...(err?.code !== undefined ? { code: err.code } : {}), ...(typeof r.json['state'] === 'string' ? { state: r.json['state'] } : {}), ...(typeof r.json['runId'] === 'string' ? { runId: r.json['runId'] } : {}) };
      // The new run: its steps count from the restart (below the steps since the old run's start) and the loaded scenes are gone.
      this.opts.log(`scale: replay ${i + 1}/${n} answered: ${JSON.stringify(answer)} (before: step ${String(before?.stepIndex)}, run step ${String(before?.run?.runStep)})`);
      const since = (before?.run?.runStep ?? 0) + 1;
      let last: unknown = null;
      await this.until((o) => {
        const run = (o as { run?: { runStep: number } } | null)?.run;
        last = { stepIndex: (o as { stepIndex?: number } | null)?.stepIndex, run, loaded: o?.scenes?.loaded?.length, state: o?.state };
        return run !== undefined && run.runStep < since && ids.every((id) => o?.scenes?.loaded?.includes(id) !== true);
      }, 60_000, 'the restarted run').catch((e: Error) => {
        throw new Error(`${e.message} (answer ${JSON.stringify(answer)}; last observation ${JSON.stringify(last)})`);
      });
      answer.appliedMs = Math.round(performance.now() - t0);
      answers.push(answer);
      this.opts.log(`scale: replay ${i + 1}/${n}: ${JSON.stringify(answer)}`);
    }
    this.report.replay = { threads, scenesLoaded: ids.length, answerMs: summarize(answers.map((a) => a.ms)), appliedMs: summarize(answers.flatMap((a) => (a.appliedMs === null ? [] : [a.appliedMs]))), answers };
  }

  private async stopPlay(): Promise<void> {
    if (this.play === null) return;
    const psid = this.play.psid;
    await this.page?.getByTitle('Stop the play preview').click().catch(() => undefined);
    await poll(async () => (await this.relay(`${psid}/observe`)).status, (st) => st === 404, 60_000, 'the play to stop').catch(() => undefined);
    this.play = null;
    if (this.report.play !== undefined) this.report.play.backendRssAfterStopMiB = backendRssMiB(this.backend.pid);
  }

  /**
   * The export request, its output on disk, and the exported game's first frame in its own page, served by a
   * static server with the backend stopped (an exported game needs nothing of the editor). The last step.
   */
  private async measureExport(): Promise<void> {
    const pid = this.backend.pid;
    const rssBefore = backendRssMiB(pid);
    let rssPeak: number | null = rssBefore;
    const sampler = setInterval(() => {
      const v = backendRssMiB(pid);
      if (v !== null && (rssPeak === null || v > rssPeak)) rssPeak = v;
    }, 50);
    const t = performance.now();
    const res = await this.backend.post(`/api/v1/admin/projects/${this.opts.projectId}/export`, {}).finally(() => clearInterval(sampler));
    const ms = Math.round(performance.now() - t);
    if (res.status !== 200) throw new Error(`the export was refused after ${ms} ms: ${JSON.stringify(res.json).slice(0, 500)}`);
    const dir = join(this.backend.exportRoot, String(res.json['outputDir']));
    const size = dirSize(dir);
    await this.context?.close().catch(() => undefined);
    this.context = null;
    await this.be?.stop();
    this.be = null;
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
      this.report.export = { ms, files: size.files, bytes: size.bytes, backendRssBeforeMiB: rssBefore, backendRssPeakMiB: rssPeak, firstFrameMs: first === null ? null : first - t0, state, pageErrors };
    } finally {
      await context.close();
      await site.close();
    }
  }
}
