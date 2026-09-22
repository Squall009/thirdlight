/**
 * Packet 69 — the integration run (Node real-loader/mixer phase + real
 * browser visible-model phase).
 *
 * Run: `npx tsx tests/integration/m4-render/run.mts`
 *
 * Phase 0 (fixture integrity): the committed fixtures are byte-identical
 * to the deterministic regeneration (`generate-fixtures.mts --check`), and
 * the template source GLBs re-hash to the fixture index's
 * `sourceDigest` rows (the wrapper's digest-verification mirror).
 *
 * Phase 1 (Node, stub canvas — no GPU claim): the REAL adapter
 * `models` realization over the REAL template GLB bytes and the REAL
 * pinned GLTFLoader port: settle, the bounded counters, the L6 static
 * path, the `models_asset_unresolved` residual, and the ownership
 * baseline (a counting loader port proves the refcounted releases;
 * repeated dispose is a no-op).
 *
 * Phase 2 (real headless Chrome, SwiftShader GPU — never a hardware
 * claim): the full production composition (real runtime + M3 modules +
 * real physics + real adapter `models` block) through the in-page probe
 * (`probes/render-entry.ts`): visible model/pose frames (canvas PNG
 * captures), two model instances at distinct committed states (the
 * player `run` vs the non-player `idle`), the physics trajectory
 * intact (the root holders receive the physics motion, the animation
 * writes only the mixer poses), a single rAF consumer (C13), and the
 * ownership counters at baseline after 3 dispose/recreate cycles.
 *
 * Evidence: `docs/acceptance/evidence-m4/69/raw/` (summary.json, the
 * frame PNGs, the phase raw JSONs). Exit code 0 = every row PASS.
 */
import { createHash, } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import { createSceneAdapter, type ModelAnimationRoles, type SceneAdapterModels } from '@thirdlight/three-adapter';
import { createGltfLoaderPort } from '@thirdlight/three-adapter/gltf-loader';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const FIXTURES = join(HERE, 'fixtures');
const EVIDENCE_DIR = join(REPO_ROOT, 'docs/acceptance/evidence-m4/69/raw');
const BROWSER_LIB = join(REPO_ROOT, 'tests/evaluations/m3-browser/lib/browser.mjs');

// ---- evidence + row plumbing -------------------------------------------------
mkdirSync(EVIDENCE_DIR, { recursive: true });
mkdirSync(join(EVIDENCE_DIR, 'browser-frames'), { recursive: true });
const rows: Array<{ id: string; phase: string; status: string; detail: unknown }> = [];
function row(id: string, phase: string, ok: boolean, detail: unknown): void {
  rows.push({ id, phase, status: ok ? 'PASS' : 'FAIL', detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} (${phase})`);
}
function evJson(name: string, doc: unknown): void {
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(doc, null, 2)}\n`);
}
function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ---- the fixture documents ----------------------------------------------------
const sceneDoc = JSON.parse(readFileSync(join(FIXTURES, 'scene.json'), 'utf8')) as {
  schemaVersion: number;
  revision: number;
  entities: Array<{ id: string; components: Record<string, unknown>; parentId?: string | null }>;
};
const indexDoc = JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8')) as {
  provenance: { projectId: string; finalRevision: number };
  settings: Record<string, number>;
  game: Record<string, unknown>;
  assetRows: Array<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number }>;
  animationRows: Array<{ entityId: string; assetId: string; version: number; roles: ModelAnimationRoles }>;
  playerEntityId: string;
};
const snapshot: RuntimeSnapshot = {
  snapshotId: `${indexDoc.provenance.projectId}@r${indexDoc.provenance.finalRevision}`,
  projectId: indexDoc.provenance.projectId,
  revision: indexDoc.provenance.finalRevision,
  scene: sceneDoc,
  game: indexDoc.game,
} as unknown as RuntimeSnapshot;
const modelEntityCount = sceneDoc.entities.filter((e) => e.components['model'] !== undefined).length;
const modelAnimationCount = sceneDoc.entities.filter((e) => e.components['modelAnimation'] !== undefined).length;

// The packet-owned GLB sources (the documented substitution — see the
// fixture index's `sourceSubstitution` block: the template/sample source
// courier.glb carries corrupted animation data; the 69 fixture uses
// packet-owned GLB bytes of the same clip structure).
function sourcePathFor(assetId: string): string {
  const name = assetId.replace(/^br-model-/, '');
  return join(FIXTURES, 'sources', `${name}.glb`);
}

// The models block (the wrapper's view): the `assets` rows from the fixture
// index (the manifest `assets` rows, kind "model"); the `animation` rows
// derived from the SCENE's `modelAnimation` entities (the variant scenes
// R14/R15 tamper with, so the rows must follow the variant — the way the
// production wrapper derives them from the snapshot's committed mappings).
function modelsBlock(bytesByKey: Map<string, Uint8Array>, sceneOverride?: { entities: Array<{ id: string; components: Record<string, unknown> }> }): SceneAdapterModels {
  const entities = sceneOverride?.entities ?? sceneDoc.entities;
  return {
    assets: indexDoc.assetRows.map((r) => ({ assetId: r.assetId, version: r.version, sourceDigest: r.sourceDigest })),
    animation: entities
      .filter((e) => e.components['modelAnimation'] !== undefined)
      .map((e) => {
        const ma = e.components['modelAnimation'] as { roles: ModelAnimationRoles; version: number };
        return { entityId: e.id, roles: ma.roles, version: ma.version };
      }),
    resolveBytes: (assetId: string, version: number): Promise<ArrayBuffer> => {
      const bytes = bytesByKey.get(`${assetId}@${version}`);
      if (bytes === undefined) return Promise.reject(new Error(`no wrapper-verified bytes for ${assetId} v${version}`));
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return Promise.resolve(buffer);
    },
  };
}

// =============================================================================
// Phase 0 — fixture integrity
// =============================================================================
console.log('== phase 0: fixture integrity ==');
{
  const check = spawnSync('npx', ['tsx', join(HERE, 'tools/generate-fixtures.mts'), '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  row('R01', 'fixture', check.status === 0, { status: check.status, output: (check.stdout ?? '').trim().split('\n').slice(-3) });

  const digestOk: Record<string, boolean> = {};
  let allOk = true;
  for (const r of indexDoc.assetRows) {
    const bytes = new Uint8Array(readFileSync(sourcePathFor(r.assetId)));
    const ok = bytes.byteLength === r.sourceByteLength && sha256Hex(bytes) === r.sourceDigest;
    digestOk[r.assetId] = ok;
    allOk = allOk && ok;
  }
  // The documented defective template/sample source (the defect record —
  // its digest is recorded for the refile; it is NOT the fixture source).
  const defective = new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures/m4/templates/templates/platformer-starter/sources/model/courier.glb')));
  row('R02', 'fixture', allOk, { digests: digestOk, defectiveSourceDigest: sha256Hex(defective) });
}

// =============================================================================
// Phase 1 — Node: real loader + real mixer (stub canvas, no GPU)
// =============================================================================
console.log('== phase 1: node real loader / real mixer ==');
function stubCanvas(): unknown {
  return { getContext: () => null, width: 640, height: 480, clientWidth: 640, clientHeight: 480 };
}
function fakeRuntime(): Runtime {
  // The authored transforms (the physics motion is the browser phase's
  // concern; the Node phase proves the realization itself).
  const transforms = sceneDoc.entities.map((e) => {
    const t = (e.components['transform'] ?? {}) as { position?: number[]; rotation?: number[]; scale?: number[] };
    return {
      id: e.id,
      position: (t.position ?? [0, 0, 0]) as [number, number, number],
      rotation: (t.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
      scale: (t.scale ?? [1, 1, 1]) as [number, number, number],
    };
  });
  return {
    getInterpolatedState: () => ({ ok: true, state: { stepIndex: 120, simTime: 1, alpha: 0.5, transforms } }),
    getGameView: () => ({ ok: true, view: { stepIndex: 120, playerMotion: { speed: 4, grounded: true } } }),
    dispose: () => undefined,
  } as unknown as Runtime;
}

function countingPort(): { port: unknown; loads: () => number; releases: () => number } {
  const inner = createGltfLoaderPort();
  let loads = 0;
  let releases = 0;
  const port = {
    async load(bytes: Uint8Array, options: unknown): Promise<unknown> {
      loads += 1;
      const loaded = await (inner.load as (b: Uint8Array, o: unknown) => Promise<{ dispose(): void } & Record<string, unknown>>)(bytes, options);
      let released = false;
      const wrapped = { ...loaded, dispose: (): void => { if (!released) { released = true; releases += 1; (loaded as { dispose(): void }).dispose(); } } };
      return wrapped;
    },
  };
  return { port, loads: () => loads, releases: () => releases };
}

const nodeRaw: Record<string, unknown> = {};
{
  const bytesByKey = new Map<string, Uint8Array>();
  for (const r of indexDoc.assetRows) {
    bytesByKey.set(`${r.assetId}@${r.version}`, new Uint8Array(readFileSync(sourcePathFor(r.assetId))));
  }
  const { port, loads, releases } = countingPort();
  const adapter = createSceneAdapter(stubCanvas() as never, {
    runtime: fakeRuntime(),
    snapshot,
    models: modelsBlock(bytesByKey),
    modelsLoader: port as never,
  });
  const settle = await adapter.modelsSettled?.() ?? null;
  const diag = adapter.diagnostics();
  const counters = diag.ok === true ? (diag.diagnostics.models ?? null) : null;
  nodeRaw.settle = settle;
  nodeRaw.counters = counters;
  nodeRaw.expected = { assets: indexDoc.assetRows.length, instances: modelEntityCount, animations: modelAnimationCount };
  row('R11', 'node', settle !== null && settle.ok === true
    && settle.assets === indexDoc.assetRows.length
    && settle.instances === modelEntityCount
    && settle.animations === modelAnimationCount
    && settle.unresolved === 0, settle);
  row('R12', 'node', counters !== null && counters.assets === indexDoc.assetRows.length
    && counters.instances === modelEntityCount && counters.pending === 0
    && counters.animations === modelAnimationCount && counters.failed === 0, counters);

  const d1 = adapter.dispose();
  const d2 = adapter.dispose();
  const diagAfter = adapter.diagnostics();
  const modelsAfter = diagAfter.ok === true ? (diagAfter.diagnostics.models ?? null) : null;
  nodeRaw.dispose = { d1, d2, modelsAfter, loads: loads(), releases: releases() };
  row('R13', 'node', d1.ok === true && d2.ok === true && d2.alreadyDisposed === true
    && modelsAfter === null && releases() === loads() && loads() > 0,
    { d1, d2, modelsAfter, loads: loads(), releases: releases() });

  // R14 — the L6 static path: a committed mapping the GLB does not carry.
  const l6Scene = structuredClone(sceneDoc) as typeof sceneDoc;
  const l6Entity = l6Scene.entities.find((e) => e.id === 'model-0001');
  const l6Roles = (l6Entity?.components['modelAnimation'] as { roles: ModelAnimationRoles } | undefined)?.roles;
  if (l6Entity === undefined || l6Roles === undefined) row('R14', 'node', false, 'fixture shape unexpected');
  else {
    l6Roles.idle = { clipIndex: 0, clipName: 'Wrong' };
    const l6 = createSceneAdapter(stubCanvas() as never, {
      runtime: fakeRuntime(),
      snapshot: { ...snapshot, scene: l6Scene } as RuntimeSnapshot,
      models: modelsBlock(bytesByKey, l6Scene),
      modelsLoader: createGltfLoaderPort(),
    });
    const s6 = (await l6.modelsSettled?.()) ?? null;
    const c6 = l6.diagnostics();
    const cnt6 = c6.ok === true ? (c6.diagnostics.models ?? null) : null;
    nodeRaw.l6 = { settle: s6, counters: cnt6 };
    row('R14', 'node', s6 !== null && s6.ok === true
      && s6.animations === modelAnimationCount - 1
      && s6.unresolved === 0
      && cnt6 !== null && cnt6.animations === modelAnimationCount - 1, { settle: s6, counters: cnt6 });
    l6.dispose();
  }

  // R15 — the models_asset_unresolved residual: a model entity whose
  // assetId has no `assets` row (the plain group path; the run proceeds).
  const uScene = structuredClone(sceneDoc) as typeof sceneDoc;
  const uEntity = uScene.entities.find((e) => e.id === 'model-0004');
  if (uEntity === undefined) row('R15', 'node', false, 'fixture shape unexpected');
  else {
    (uEntity.components['model'] as { asset: { assetId: string } }).asset.assetId = 'asset-ghost';
    const u = createSceneAdapter(stubCanvas() as never, {
      runtime: fakeRuntime(),
      snapshot: { ...snapshot, scene: uScene } as RuntimeSnapshot,
      models: modelsBlock(bytesByKey, uScene),
      modelsLoader: createGltfLoaderPort(),
    });
    const su = (await u.modelsSettled?.()) ?? null;
    nodeRaw.unresolved = { settle: su };
    // The unresolved entity keeps only the base-scene plain group (no
    // ModelInstance): instances = the other model entities.
    row('R15', 'node', su !== null && su.ok === true && su.unresolved === 1 && su.instances === modelEntityCount - 1, { settle: su });
    u.dispose();
  }
  evJson('node-phase.json', nodeRaw);
}

// =============================================================================
// Phase 2 — the real browser (production composition, SwiftShader GPU)
// =============================================================================
console.log('== phase 2: real browser ==');
type Browser = Awaited<ReturnType<typeof import('../../evaluations/m3-browser/lib/browser.mjs').launchBrowser>>;
type Page = Browser extends { newPage(): Promise<infer P> } ? P : never;

function fileServer(files: Map<string, Uint8Array>): { close(): Promise<void>; base(): Promise<string>; port: () => number } {
  const mime: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.glb': 'model/gltf-binary', '.png': 'image/png',
  };
  let port = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const key = rel === '' ? 'index.html' : rel;
    const bytes = files.get(key);
    if (bytes === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = key.slice(key.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': mime[ext] ?? 'application/octet-stream' });
    res.end(bytes);
  });
  return {
    port: () => port,
    base: async () => new Promise((r) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        r(`http://127.0.0.1:${port}/`);
      });
    }),
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

const browserRaw: Record<string, unknown> = { frames: [] as unknown[] };
let teardownPage: { close(): Promise<void> } | null = null;
let teardownBrowser: { close(): Promise<void> } | null = null;
let teardownServer: { close(): Promise<void> } | null = null;
let serverBase = 'http://unavailable/';
let hardError: string | null = null;

try {
  // Bundle the probe.
  const buildDir = mkdtempSync(join(tmpdir(), 'tl-m469-'));
  await build({
    entryPoints: [join(HERE, 'probes/render-entry.ts')],
    outfile: join(buildDir, 'probe.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'silent',
    absWorkingDir: REPO_ROOT,
    nodePaths: [join(REPO_ROOT, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  const files = new Map<string, Uint8Array>();
  files.set('index.html', new TextEncoder().encode(
    '<!doctype html><html><head><meta charset="utf-8"><title>m4-69 render probe</title></head>'
    + '<body style="margin:0;background:#000"><script src="./probe.js"></script></body></html>',
  ));
  files.set('probe.js', new Uint8Array(readFileSync(join(buildDir, 'probe.js'))));
  files.set('scene.json', new Uint8Array(readFileSync(join(FIXTURES, 'scene.json'))));
  files.set('index.json', new Uint8Array(readFileSync(join(FIXTURES, 'index.json'))));
  for (const r of indexDoc.assetRows) {
    files.set(`assets/${r.assetId}.glb`, new Uint8Array(readFileSync(sourcePathFor(r.assetId))));
  }
  const server = fileServer(files);
  teardownServer = server;
  serverBase = await server.base();
  const { launchBrowser } = await import(BROWSER_LIB);
  const browser = await launchBrowser({ width: 1280, height: 720 });
  if (browser === null) {
    row('R20', 'browser', false, 'no local Chrome resolved');
    hardError = 'no local Chrome resolved';
  } else {
    teardownBrowser = browser;
    const page: Page = await browser.newPage();
    teardownPage = page;
    await page.goto(serverBase, { waitMs: 2000 });
    const ready = await page.waitFor('window.__tl69?.ready === true', { timeoutMs: 90_000 });
    const tl = (): Promise<unknown> => page.evaluate('window.__tl69');
    const settle = ready === true ? (await page.evaluate('window.__tl69.settleResult')) : null;
    const unhandledAtReady = (await tl()) as { unhandled?: unknown[] };
    browserRaw.settle = settle;
    browserRaw.ready = ready;
    row('R21', 'browser', ready === true && settle !== null && (settle as { ok?: boolean }).ok === true
      && (settle as { assets?: number }).assets === indexDoc.assetRows.length
      && (settle as { instances?: number }).instances === modelEntityCount
      && (settle as { animations?: number }).animations === modelAnimationCount
      && (settle as { unresolved?: number }).unresolved === 0,
      { ready, settle, unhandled: unhandledAtReady.unhandled });
    if (ready !== true) {
      browserRaw.fatal = (await tl()) as unknown;
      hardError = 'the probe never reported ready';
    } else {
      // The evidence window, anchored to the SIMULATION timeline inside the
      // page (the page's wall clock is the runtime's wall clock; Node-side
      // polls/round-trips overshoot under the headless Chrome's CPU
      // contention, so the Node side only hands control to the page — the
      // page then waits, in page time, until the run-up before jump 1:
      // step base+70, 10 steps before the press at base+80). From there the
      // 8 frames at 600 ms spacing cover jump 1's arc (base+80–166), the
      // run-up, jump 2's arc (base+211–297), the stop (base+341) and the
      // idle tail, so `run`, `airborne` and the stopped `idle` all appear
      // among the committed samples (robust to ±200 ms of timer jitter —
      // both arcs and the run segments cover most of the window).
      const windowed = (await page.evaluate(`(async () => {
        let s0 = window.__tl69.state();
        let guard = 0;
        while ((s0.baseStep === null || s0.stepIndex === null) && guard < 100) {
          await new Promise((r) => setTimeout(r, 50));
          s0 = window.__tl69.state();
          guard += 1;
        }
        const base = s0.baseStep;
        if (base !== null && s0.stepIndex < base + 70) {
          const waitMs = ((base + 70 - s0.stepIndex) / 120) * 1000 + 50;
          await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));
        }
        const stateA = window.__tl69.state();
        const frames = await window.__tl69.frames(8, 600);
        return { stateA, frames };
      })()`)) as {
        stateA: {
          stepIndex: number | null;
          runState: string | null;
          baseStep: number | null;
          playerRole: string | null;
          nonPlayerRole: string;
          playerMotion: { speed: number; grounded: boolean } | null;
          playerPosition: { x: number; y: number } | null;
          models: Record<string, number> | null;
        };
        frames: Array<{
          index: number;
          t: number;
          stepIndex: number | null;
          runState: string | null;
          playerRole: string | null;
          playerMotion: { speed: number; grounded: boolean } | null;
          playerPosition: { x: number; y: number } | null;
          models: Record<string, number> | null;
          capture: { dataUrl?: string; byteSize?: number; error?: unknown } | null;
          signature: { distinctPixels?: number; distinctColors?: number; error?: string } | null;
        }>;
      };
      const stateA = windowed.stateA;
      const frames = windowed.frames;
      browserRaw.stateA = stateA;
      browserRaw.frames = frames.map(({ capture, signature, ...rest }) => ({ ...rest, capture: capture === null ? null : { byteSize: capture.byteSize, error: capture.error }, signature }));

      // R22 — visible model/pose frames: real canvas captures, non-blank.
      const pngs: string[] = [];
      const sizes: number[] = [];
      for (const f of frames) {
        const dataUrl = f.capture?.dataUrl;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
          pngs.push(`missing:${JSON.stringify(f.capture).slice(0, 200)}`);
          sizes.push(0);
          continue;
        }
        const name = `frame-${String(f.index + 1).padStart(2, '0')}.png`;
        writeFileSync(join(EVIDENCE_DIR, 'browser-frames', name), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
        pngs.push(name);
        sizes.push(f.capture.byteSize ?? 0);
      }
      const nonBlank = frames.every((f) => (f.signature?.distinctPixels ?? 0) > 400);
      row('R22', 'browser', frames.length === 8 && pngs.every((p) => p.endsWith('.png')) && nonBlank && sizes.every((s) => s > 2000),
        { pngs, sizes, signatures: frames.map((f) => f.signature) });

      // R23 — the frames CHANGE over time (the player runs: the model
      // translates AND the courier's Run clip swings the arm).
      const changed: boolean[] = [];
      for (let i = 1; i < frames.length; i += 1) {
        const a = frames[i - 1];
        const b = frames[i];
        changed.push(
          (a.signature?.distinctPixels ?? 0) !== (b.signature?.distinctPixels ?? 0)
          || (a.signature?.distinctColors ?? 0) !== (b.signature?.distinctColors ?? 0)
          || JSON.stringify(a.playerPosition) !== JSON.stringify(b.playerPosition),
        );
      }
      const changedCount = changed.filter(Boolean).length;
      row('R23', 'browser', changedCount >= 3, { changed, changedCount });

      // R24 — distinct committed states over the window (the §2.4 rule):
      // the player's committed motion selects `run` while grounded + fast
      // AND `airborne` during a jump (the player's own animated model gets
      // the full committed selection); the non-player animated entity
      // always sees the neutral motion (`idle`); the committed steps
      // advance.
      const runFrame = frames.find((f) => f.playerRole === 'run' && (f.playerMotion?.speed ?? 0) > 0.5) ?? null;
      const airFrame = frames.find((f) => f.playerRole === 'airborne' && (f.playerMotion?.grounded ?? true) === false) ?? null;
      const nonPlayerAllIdle = frames.every((f) => f.nonPlayerRole === 'idle');
      const stepsAdvance = (frames[frames.length - 1].stepIndex ?? 0) > (stateA.stepIndex ?? -1);
      row('R24', 'browser',
        runFrame !== null && airFrame !== null && nonPlayerAllIdle && stepsAdvance,
        {
          runFrame: runFrame === null ? null : { index: runFrame.index, speed: runFrame.playerMotion?.speed, grounded: runFrame.playerMotion?.grounded },
          airFrame: airFrame === null ? null : { index: airFrame.index, grounded: airFrame.playerMotion?.grounded },
          nonPlayerAllIdle,
          steps: { first: stateA.stepIndex, last: frames[frames.length - 1].stepIndex },
        });

      // R25 — the physics trajectory is intact (the root holders receive
      // the physics motion: a full-course run at ≈ run_speed through a
      // jump, then a clean stop on the platform — the animation writes
      // only the mixer poses, no root contamination; no death: the run
      // state stays `playing` across the window).
      const maxX = Math.max(...frames.map((f) => f.playerPosition?.x ?? 0));
      const finalX = frames[frames.length - 1].playerPosition?.x ?? 0;
      const paces: number[] = [];
      for (let i = 1; i < frames.length; i += 1) {
        const a = frames[i - 1];
        const b = frames[i];
        const dt = (b.t - a.t) / 1000;
        if (a.playerPosition !== null && b.playerPosition !== null && dt > 0.3) {
          paces.push(Math.abs(b.playerPosition.x - a.playerPosition.x) / dt);
        }
      }
      const runSpeed = indexDoc.settings['run_speed'] ?? 4;
      const runPace = paces.find((p) => p >= runSpeed * 0.6 && p <= runSpeed * 1.4) ?? null;
      // No death across the window: every committed view says `playing`.
      const stayedPlaying = (stateA.runState ?? 'playing') === 'playing' && frames.every((f) => f.runState === 'playing');
      row('R25', 'browser',
        maxX >= 12 && finalX >= 13 && finalX <= 15.5 && runPace !== null && stayedPlaying,
        { maxX: Number(maxX.toFixed(2)), finalX: Number(finalX.toFixed(2)), paces: paces.map((p) => Number(p.toFixed(2))), runPace: runPace === null ? null : Number(runPace.toFixed(2)), runSpeed, runStates: frames.map((f) => f.runState) });

      // R26 — a single rAF consumer (C13): the runtime's raf driver is the
      // only consumer; the adapter never schedules a second loop.
      const raf = (await page.evaluate('window.__tl69.rafStats()')) as { peak: number; fired: number; pending: number };
      row('R26', 'browser', raf.peak === 1 && raf.fired > 50, raf);

      // R27 — the ownership baseline after 3 dispose/recreate cycles: the
      // settles are identical to the first (no accumulated resources), no
      // unhandled rejections, the raf peak stays 1, the counters are back
      // at baseline.
      const cycles: unknown[] = [];
      let cyclesOk = true;
      for (let i = 0; i < 3; i += 1) {
        const c = (await page.evaluate('window.__tl69.disposeCycle()')) as { ok: boolean; settle?: { ok?: boolean; assets?: number; instances?: number; animations?: number }; disposals?: unknown; code?: string; message?: string };
        cycles.push(c);
        cyclesOk = cyclesOk && c.ok === true && c.settle !== undefined && c.settle.ok === true
          && c.settle.assets === indexDoc.assetRows.length
          && c.settle.instances === modelEntityCount
          && c.settle.animations === modelAnimationCount;
        await new Promise((r) => setTimeout(r, 400));
      }
      const afterCycles = (await tl()) as { unhandled?: unknown[] };
      const rafAfter = (await page.evaluate('window.__tl69.rafStats()')) as { peak: number };
      const stateAfter = (await page.evaluate('window.__tl69.state()')) as { models: Record<string, number> | null };
      const baseline = stateAfter.models !== null
        && stateAfter.models.assets === indexDoc.assetRows.length
        && stateAfter.models.instances === modelEntityCount
        && stateAfter.models.animations === modelAnimationCount
        && stateAfter.models.pending === 0 && stateAfter.models.failed === 0;
      row('R27', 'browser', cyclesOk && (afterCycles.unhandled ?? []).length === 0 && rafAfter.peak === 1 && baseline,
        { cycles: cycles.map((c) => (c as { ok?: boolean; code?: string; message?: string; settle?: { ok?: boolean } }).ok === true ? { ok: true, settle: (c as { settle?: { ok?: boolean } }).settle } : c), unhandled: afterCycles.unhandled, rafAfter, models: stateAfter.models });

      // R28 — no external-origin traffic (the wrapper's origin discipline:
      // only the local fixture server is reached).
      const net = page.summary();
      const external = (net.requests ?? []).filter((u: string) => {
        let parsed: URL;
        try { parsed = new URL(u); } catch { return false; }
        return parsed.protocol === 'http:' && !u.startsWith(serverBase);
      });
      row('R28', 'browser', external.length === 0, { total: (net.requests ?? []).length, external });
      browserRaw.console = { messages: net.consoleMessages ?? [], errors: net.errors ?? [] };
      cpSync(join(buildDir, 'probe.js'), join(EVIDENCE_DIR, 'probe.js'), { force: true });
    }
  }
} catch (e) {
  row('R29', 'browser', false, { exception: String(e) });
  hardError = String(e);
} finally {
  // Guaranteed teardown (never leave an orphaned headless Chrome).
  try { await teardownPage?.close(); } catch { /* already closed */ }
  try { await teardownBrowser?.close(); } catch { /* already closed */ }
  try { await teardownServer?.close(); } catch { /* already closed */ }
  evJson('browser-phase.json', browserRaw);
  const failed = rows.filter((r) => r.status === 'FAIL');
  evJson('summary.json', { rows, failed, hardError, environment: envSummary(serverBase) });
  console.log(hardError !== null && failed.length === 0 ? '== browser phase aborted: ' + hardError + ' ==' : failed.length === 0 ? '== all rows PASS ==' : `== ${failed.length} rows FAILED: ${failed.map((f) => f.id).join(', ')} ==`);
  if (failed.length > 0) process.exitCode = 1;
}

function envSummary(base: string): Record<string, unknown> {
  return {
    node: process.version,
    gpu: 'SwiftShader (headless container; never a hardware-GPU claim)',
    fixtureServer: base,
    fixture: {
      sceneBytes: readFileSync(join(FIXTURES, 'scene.json')).byteLength,
      sceneDigest: sha256Hex(new Uint8Array(readFileSync(join(FIXTURES, 'scene.json')))),
      indexDigest: sha256Hex(new Uint8Array(readFileSync(join(FIXTURES, 'index.json')))),
    },
    modelEntities: modelEntityCount,
    modelAnimationEntities: modelAnimationCount,
  };
}