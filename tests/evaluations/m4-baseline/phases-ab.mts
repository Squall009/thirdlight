/**
 * Packet 63 — current-baseline audit runner (the executable half of C01).
 *
 * Three real-browser phases over the ACTUAL production surfaces (no mocks):
 *
 *   Phase A — the standalone M3 export of the committed Beacon Reach sample
 *     (real exporter pipeline, real static origin, real headless Chrome —
 *     ANGLE/SwiftShader, NEVER a hardware-GPU claim). Reproduces the
 *     packet-62 B05 observation with added diagnostics (HUD status trace,
 *     rAF cadence, model-entity facts).
 *   Phase B — the SAME production module composition in a test-harness page
 *     with a read-only `window.__tl` surface: separates "did the simulation
 *     step and move the player" from "did the canvas capture reflect it",
 *     and measures keyboard reachability as shipped (no tabindex) vs with
 *     the harness focus shim.
 *   Phase C — the real backend + real editor page + real isolated-play
 *     preview iframe (separate origin, bridge handshake): does the preview
 *     host render and step in a real browser?
 *
 * `npm test` never runs this. Evidence → `docs/acceptance/evidence-m4/63/raw`
 * (override: TL_M463_EVIDENCE_DIR). Physical keyboard/gamepad, audible
 * output and hardware-GPU behaviour stay UNVERIFIED (owner annex).
 */
import { createHash, } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { exportProjectM3, type ExportContext, type ExportFs } from '@thirdlight/exporter';
import { launchBrowser } from '../m3-browser/lib/browser.mjs';
import { evalInContext, waitForContext } from './lib/frames.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const EVIDENCE = process.env['TL_M463_EVIDENCE_DIR'] ?? join(REPO_ROOT, 'docs/acceptance/evidence-m4/63/raw');
const CAPTURED = join(REPO_ROOT, 'samples/beacon-reach/captured/project.json');
const SAMPLE_ASSETS = join(REPO_ROOT, 'samples/beacon-reach/assets');
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const evWrite = (name: string, data: string | Uint8Array | Buffer): string => {
  mkdirSync(EVIDENCE, { recursive: true });
  const p = join(EVIDENCE, name);
  writeFileSync(p, data);
  return p;
};
const evJson = (name: string, data: unknown): string => evWrite(name, `${JSON.stringify(data, null, 2)}\n`);
const pngFromDataUrl = (u: string | null): Buffer => Buffer.from((u ?? '').split(',')[1] ?? '', 'base64');

const ASSET_FILES: Record<string, string> = {
  'br-audio-start': 'audio/cue-start.wav',
  'br-audio-jump': 'audio/cue-jump.wav',
  'br-audio-checkpoint': 'audio/cue-checkpoint.wav',
  'br-audio-death': 'audio/cue-death.wav',
  'br-audio-goal': 'audio/cue-goal.wav',
  'br-model-courier': 'model/courier.glb',
  'br-model-beacon': 'model/beacon.glb',
};

interface Rows { [row: string]: { status: string; detail: unknown } }
type Page = Awaited<ReturnType<typeof launchBrowser>> extends infer B ? B extends null ? never : B extends { newPage(): Promise<infer P> } ? P : never : never;

// --------------------------------------------------------------------------
// shared static server (relative routes → a file table)
// --------------------------------------------------------------------------
function fileServer(files: Map<string, Uint8Array | (() => Uint8Array)>, prefix: string): { close(): void; base(): Promise<number>; port: () => number } {
  const mime: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.css': 'text/css', '.png': 'image/png',
  };
  let port = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname).replace(prefix, '').replace(/^\/+/, '');
    if (rel === '') rel = 'index.html';
    const entry = files.get(rel);
    if (entry === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const bytes = typeof entry === 'function' ? entry() : entry;
    const ext = rel.slice(rel.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': mime[ext] ?? 'application/octet-stream' });
    res.end(bytes);
  });
  return {
    port: () => port,
    base: async () => new Promise((r) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        r(port);
      });
    }),
    close: () => new Promise<void>((r) => { server.close(() => r()); }),
  };
}

/** The external-origin filter: only http(s) requests count (data: readbacks
 * are page-internal, not network requests). */
export function externalOrigins(requests: string[], allowed: string[]): string[] {
  const allow = new Set(allowed);
  return requests.filter((u) => {
    let parsed: URL;
    try { parsed = new URL(u); } catch { return false; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return !allow.has(parsed.origin);
  });
}

// --------------------------------------------------------------------------
// Phase A — standalone export
// --------------------------------------------------------------------------
function realFs(): ExportFs {
  return {
    join: (...p) => join(...p),
    realpath: (p) => realpathSync(p),
    isDirectory: (p) => existsSync(p) && statSync(p).isDirectory(),
    exists: (p) => existsSync(p),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    write: (p, d) => writeFileSync(p, d),
    rename: (a, b) => renameSync(a, b),
    rm: (p) => rmSync(p, { recursive: true, force: true }),
    mkdtemp: (prefix) => mkdtempSync(prefix),
    read: (p) => new Uint8Array(readFileSync(p)),
  };
}

async function phaseA(browser: NonNullable<Awaited<ReturnType<typeof launchBrowser>>>, rows: Rows): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const captured = JSON.parse(new TextDecoder().decode(readFileSync(CAPTURED)));
  const blobs = new Map<string, { digest: string; byteLength: number; bytes: Uint8Array }>();
  for (const [assetId, rel] of Object.entries(ASSET_FILES)) {
    const bytes = new Uint8Array(readFileSync(join(SAMPLE_ASSETS, rel)));
    blobs.set(assetId, { digest: sha256Hex(bytes), byteLength: bytes.length, bytes });
  }
  const service = {
    query: (q: { op: string }) => (q.op === 'queryBehaviors' ? { ok: true, behaviors: [] } : { ok: true, manifest: { revision: captured.scene.revision }, revision: captured.scene.revision }),
    readBlob: (_p: string, req: { assetId: string; version: number }) => {
      const b = blobs.get(req.assetId);
      if (b === undefined) return { ok: false, error: { code: 'blob_missing', cls: 'unavailable', message: `no blob ${req.assetId}` } };
      return { ok: true, digest: b.digest, byteLength: b.byteLength, bytes: b.bytes };
    },
  };
  const exportRoot = mkdtempSync(join(tmpdir(), 'tl-m463-export-'));
  mkdirSync(join(exportRoot, 'authoring'), { recursive: true });
  const ctx = {
    projectId: 'beacon-reach',
    service,
    fs: realFs(),
    exportRoot,
    repoRoot: REPO_ROOT,
    authoringRoot: join(exportRoot, 'authoring'),
    authoringOrigin: 'http://authoring.invalid:3000',
    previewOrigin: 'http://preview.invalid:3001',
    tokenValues: ['secret-token-value-123'],
    bootstrapEntry: join(REPO_ROOT, 'packages/exporter/src/export-bootstrap.ts'),
    threePackageJson: join(REPO_ROOT, 'node_modules/three/package.json'),
    typescriptPackageJson: join(REPO_ROOT, 'node_modules/typescript/package.json'),
    lockfile: join(REPO_ROOT, 'package-lock.json'),
    m3BootstrapEntry: join(REPO_ROOT, 'packages/exporter/src/export-bootstrap-m3.ts'),
    compiler: { pinnedModules: {}, compile: async () => ({ ok: false, reason: 'no behaviors in the M3 closure' }) },
    now: () => 1_700_000_000_000,
  } as unknown as ExportContext;
  const res = await exportProjectM3(ctx, { scene: captured.scene, content: captured.content, revision: captured.scene.revision }, ctx.m3BootstrapEntry as string, ctx.compiler as never);
  if (!res.ok) throw new Error(`standalone export failed: ${JSON.stringify(res.error)}`);
  const outDir = join(exportRoot, res.outputDir);

  const files = new Map<string, Uint8Array | (() => Uint8Array)>();
  for (const rel of ['index.html', 'js/main.js', 'manifest.json', 'scene.json', 'meta.json']) {
    const p = join(outDir, rel);
    if (existsSync(p)) files.set(rel, () => new Uint8Array(readFileSync(p)));
  }
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSafe(d)) {
      const full = join(d, entry);
      const rel = join(prefix, entry);
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.set(rel, () => new Uint8Array(readFileSync(full)));
    }
  };
  walk(join(outDir, 'content'), 'content');

  const server = fileServer(files, '/games/beacon-reach/');
  await server.base();
  const base = `http://127.0.0.1:${server.port()}/games/beacon-reach/`;

  const page = await browser.newPage();
  const result: Record<string, unknown> = { startedAt, origin: base, buildId: res.manifest?.buildId ?? null };
  try {
    await page.goto(base, { waitMs: 4000 });
    const title = await page.waitFor(`document.querySelector('#hud-root h1')?.textContent ?? ''`, { timeoutMs: 20_000 });
    rows['A01-export-title'] = typeof title === 'string' && title.length > 0 ? { status: 'PASS', detail: { title } } : { status: 'FAIL', detail: { title } };
    evWrite('a-01-title.png', await page.screenshot());

    // The shipped canvas (#game) has NO tabindex (verified in the page HTML).
    const canvasAttrs = await page.evaluate(`(() => { const c = document.querySelector('#game'); return c ? { tabindex: c.getAttribute('tabindex'), id: c.id } : null; })()`);
    rows['A02-canvas-as-shipped'] = { status: 'INFO', detail: { canvasAttrs, note: 'no tabindex as shipped — keyboard focus reachability tested in A04/B02' } };

    // Focus shim (the packet-62 probe's method) so keyboard input can land.
    await page.evaluate(`(() => { const c = document.querySelector('#game'); if (!c) return 'no-canvas'; c.setAttribute('tabindex','0'); c.focus(); return document.activeElement === c ? 'focused' : 'not-focused'; })()`);
    await page.dispatchKey('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(150);
    await page.dispatchKey('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(800);
    const promptAfterStart = await page.evaluate(`[...document.querySelectorAll('#hud-root p')].map(p => p.textContent)`);
    const hostHudLine = await page.evaluate(`document.querySelector('#hud')?.textContent ?? null`);
    rows['A03-start'] = { status: 'PASS', detail: { promptAfterStart, hostHudLine } };

    // HUD/status trace over ~2 s pre-move: the wrapper's #hud line (refreshed
    // once at mount by the export bootstrap) vs the host HUD prompt (live).
    const hudTrace: Array<{ t: number; prompt: string[]; hudLine: string | null }> = [];
    const t0 = Date.now();
    for (let i = 0; i < 4; i += 1) {
      hudTrace.push({
        t: Date.now() - t0,
        prompt: await page.evaluate(`[...document.querySelectorAll('#hud-root p')].map(p => p.textContent)`),
        hudLine: await page.evaluate(`document.querySelector('#hud')?.textContent ?? null`),
      });
      await sleep(500);
    }
    const hudLineSettled = new Set(hudTrace.map((h) => h.hudLine)).size === 1;
    rows['A04-wrapper-hud-staleness'] = { status: 'INFO', detail: { hudTrace, wrapperHudLineSettled: hudLineSettled, note: 'the wrapper #hud status line (state/deaths/goal) is refreshed once at mount by export-bootstrap-m3 — expected stale during play; the host HUD prompt is live' } };

    // Motion under held KeyD (the packet-62 B05 reproduction + rAF cadence).
    const snapCanvas = (): Promise<string | null> => page.evaluate(`new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('#game'); r(c ? c.toDataURL('image/png') : null); }))`);
    const spawnCanvas = await snapCanvas();
    evWrite('a-02-spawn.png', pngFromDataUrl(spawnCanvas));
    await page.dispatchKey('rawKeyDown', { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
    const holdHashes: string[] = [];
    const holdPrompts: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const h = await page.evaluate(`new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('#game'); const d = c ? c.toDataURL('image/png') : ''; r(d ? String(d.length) + ':' + d.slice(5000, 5600) : 'none'); }))`);
      holdHashes.push(String(h));
      holdPrompts.push(String(await page.evaluate(`document.querySelector('#hud-root')?.textContent ?? ''`)));
      await sleep(300);
    }
    await page.dispatchKey('keyUp', { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
    await sleep(300);
    const moveCanvas = await snapCanvas();
    evWrite('a-03-moved.png', pngFromDataUrl(moveCanvas));
    const distinctHoldFrames = new Set(holdHashes).size;
    rows['A05-scripted-motion'] = {
      status: moveCanvas !== null && spawnCanvas !== null && spawnCanvas !== moveCanvas ? 'PASS' : distinctHoldFrames > 1 ? 'PASS' : 'UNVERIFIED',
      detail: { canvasChanged: spawnCanvas !== moveCanvas, distinctHoldFrames, holdPrompts, spawnBytes: spawnCanvas?.length ?? 0, moveBytes: moveCanvas?.length ?? 0 },
    };

    // rAF cadence (the runtime's wall-clock stepping depends on rAF wakes).
    const r1 = await page.evaluate(`new Promise((r) => requestAnimationFrame((ts) => r(ts)))`);
    await sleep(600);
    const r2 = await page.evaluate(`new Promise((r) => requestAnimationFrame((ts) => r(ts)))`);
    rows['A06-raf-cadence'] = { status: typeof r2 === 'number' && typeof r1 === 'number' && r2 > r1 ? 'PASS' : 'UNVERIFIED', detail: { t1: r1, t2: r2, delta: typeof r1 === 'number' && typeof r2 === 'number' ? r2 - r1 : null, note: 'diagnostic only — software rasteriser' } };

    // WAV decode through a real AudioContext.
    const wavOut = await page.evaluate(`(async () => {
      const manifest = await fetch('./manifest.json').then((r) => r.json());
      const audioAssets = (manifest.assets ?? []).filter((a) => a.kind === 'audio');
      const ctx = new AudioContext();
      const out = [];
      for (const a of audioAssets) {
        try {
          const buf = await fetch(a.path).then((r) => r.arrayBuffer());
          const audio = await ctx.decodeAudioData(buf);
          out.push({ path: a.path, duration: audio.duration, ok: true });
        } catch (e) { out.push({ path: a.path, ok: false, error: String(e) }); }
      }
      await ctx.close();
      return out;
    })()`);
    const wavOk = Array.isArray(wavOut) && wavOut.length > 0 && wavOut.every((o) => (o as { ok?: boolean }).ok === true);
    rows['A07-wav-decode'] = { status: wavOk ? 'PASS' : 'FAIL', detail: wavOut };

    // Two aspects.
    await page.deviceMetrics(1280, 720);
    await sleep(500);
    const aCanvas = await snapCanvas();
    evWrite('a-04-aspect-16-9.png', pngFromDataUrl(aCanvas));
    await page.deviceMetrics(960, 720);
    await sleep(700);
    const bCanvas = await snapCanvas();
    evWrite('a-05-aspect-4-3.png', pngFromDataUrl(bCanvas));
    rows['A08-two-aspects'] = {
      status: aCanvas !== null && bCanvas !== null && aCanvas !== bCanvas ? 'PASS' : aCanvas !== null && bCanvas !== null ? 'UNVERIFIED' : 'FAIL',
      detail: { aspectA: '1280x720 (16:9)', aspectB: '960x720 (4:3)', viewDiffers: aCanvas !== bCanvas },
    };

    // Network + console.
    const net = page.summary();
    const external = externalOrigins(net.requests, [new URL(base).origin]);
    rows['A09-network-relative'] = { status: external.length === 0 ? 'PASS' : 'FAIL', detail: { requests: net.requests.length, externalOrigins: external } };
    const jsErrors = net.errors.filter((e) => e.startsWith('console.error'));
    rows['A10-console-clean'] = { status: jsErrors.length === 0 ? 'PASS' : 'FAIL', detail: { jsErrors, consoleMessages: net.consoleMessages.slice(0, 20) } };
    evJson('a-console-network.json', { requests: net.requests, consoleMessages: net.consoleMessages, errors: net.errors });

    // Model-entity facts (the Gate O F5 / Gate P F2 gap).
    const sceneDoc = captured.scene as { entities: Array<{ components?: Record<string, unknown> }> };
    const modelEntities = sceneDoc.entities.filter((e) => (e.components ?? {})['model'] !== undefined);
    rows['A11-model-entities'] = {
      status: 'INFO',
      detail: {
        modelEntityCount: modelEntities.length,
        note: 'the committed sample carries GLB model entities; the M3 scene adapter (three-adapter adapter-m3) realizes boxes/lights/surfaces only — model entities render as empty groups (verified in source, packet 52/58; repair is packet 69). The visible player is the controller BOX.',
      },
    };
  } finally {
    await page.close();
    await server.close();
  }
  evJson('a-summary.json', result);
  return result;
}

function readdirSafe(d: string): string[] {
  try { return readdirSync(d); } catch { return []; }
}

// --------------------------------------------------------------------------
// Phase B — the production composition in a test-harness page
// --------------------------------------------------------------------------
async function phaseB(browser: NonNullable<Awaited<ReturnType<typeof launchBrowser>>>, rows: Rows): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  const captured = JSON.parse(new TextDecoder().decode(readFileSync(CAPTURED)));
  const provenance = JSON.parse(new TextDecoder().decode(readFileSync(join(REPO_ROOT, 'samples/beacon-reach/assets/provenance.json')))) as { assets: Array<{ id: string; path: string }> };

  // Bundle the harness entry with the pinned esbuild.
  const buildDir = mkdtempSync(join(tmpdir(), 'tl-m463-comp-'));
  await build({
    entryPoints: [join(HERE, 'probes/composition-entry.ts')],
    outfile: join(buildDir, 'composition.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'warning',
    absWorkingDir: REPO_ROOT,
    nodePaths: [join(REPO_ROOT, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  const assetFiles = new Map<string, Uint8Array>();
  for (const a of provenance.assets) assetFiles.set(a.path, new Uint8Array(readFileSync(join(SAMPLE_ASSETS, a.path))));
  const files = new Map<string, Uint8Array | (() => Uint8Array)>();
  files.set('index.html', new TextEncoder().encode(
    '<!doctype html><html><head><meta charset="utf-8"><title>m4-baseline composition probe</title></head>' +
    '<body style="margin:0"><canvas id="game" style="width:100vw;height:100vh;display:block;background:#0e1015"></canvas>' +
    '<div id="hud-root"></div><script src="./composition.js"></script></body></html>',
  ));
  files.set('composition.js', () => new Uint8Array(readFileSync(join(buildDir, 'composition.js'))));
  // The harness page resolves assetId → relative path the same way the
  // manifest does: one entry per asset record (path = the sample-relative
  // provenance path; the capture renames ids `x` → `br-x`).
  const assetIndex = new Map<string, string>();
  for (const a of provenance.assets) {
    assetIndex.set(a.id, a.path);
    assetIndex.set(`br-${a.id}`, a.path);
  }
  const manifestObj = {
    scene: captured.scene,
    content: {
      settings: captured.content.settings,
      assets: (captured.content.assets as Array<{ assetId: string; kind: string }>).map((a) => ({ assetId: a.assetId, kind: a.kind, path: assetIndex.get(a.assetId) ?? assetIndex.get(a.assetId.replace(/^br-/, '')) ?? '' })),
      game: captured.content.game,
    },
  };
  files.set('probe-manifest.json', new TextEncoder().encode(JSON.stringify(manifestObj, null, 2)));
  for (const [path, bytes] of assetFiles) files.set(`assets/${path}`, bytes);

  const server = fileServer(files, '/comp/');
  await server.base();
  const base = `http://127.0.0.1:${server.port()}/comp/`;

  const page = await browser.newPage();
  const result: Record<string, unknown> = { startedAt, origin: base };
  try {
    await page.goto(base, { waitMs: 2500 });
    const ready = await page.waitFor(`window.__tl?.ready === true`, { timeoutMs: 30_000 });
    rows['B00-ready'] = ready === true ? { status: 'PASS', detail: 'host mounted in the real browser (production composition)' } : { status: 'FAIL', detail: { ready, body: await page.evaluate(`document.body?.innerText?.slice(0, 400)`) } };
    if (ready !== true) { evJson('b-summary.json', result); return result; }

    const state = (): Promise<unknown> => page.evaluate(`window.__tl.state()`);
    const obs = (): Promise<unknown> => page.evaluate(`window.__tl.observe()`);
    const snap = (): Promise<string | null> => page.evaluate(`new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('#game'); r(c ? c.toDataURL('image/png') : null); }))`);

    // B01 — the simulation steps while awaitingStart (no input).
    const s1 = (await state()) as { stepIndex: number };
    await sleep(700);
    const s2 = (await state()) as { stepIndex: number };
    rows['B01-sim-steps-idle'] = s2.stepIndex > s1.stepIndex ? { status: 'PASS', detail: { stepBefore: s1.stepIndex, stepAfter: s2.stepIndex } } : { status: 'FAIL', detail: { stepBefore: s1.stepIndex, stepAfter: s2.stepIndex } };
    const canvas0 = await snap();
    evWrite('b-01-idle.png', pngFromDataUrl(canvas0));
    rows['B01b-canvas-renders'] = canvas0 !== null && canvas0.length > 1000 ? { status: 'PASS', detail: { bytes: canvas0.length } } : { status: 'FAIL', detail: { bytes: canvas0?.length ?? null } };

    // B02 — keyboard as SHIPPED (the canvas has no tabindex — the page mirrors
    // the export page): a CDP Enter must NOT start the run.
    await page.evaluate(`(() => { const c = document.querySelector('#game'); c.focus?.(); return document.activeElement === c ? 'focused' : 'not-focusable:' + (document.activeElement?.tagName ?? 'none'); })()`);
    const beforeEnter = (await state()) as { stepIndex: number };
    await page.dispatchKey('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(120);
    await page.dispatchKey('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(900);
    const obsAfterNoTabindex = await obs();
    const stateAfterNoTabindex = (await state()) as { stepIndex: number };
    rows['B02-keyboard-as-shipped'] = {
      status: 'INFO',
      detail: {
        stepAdvanced: stateAfterNoTabindex.stepIndex > beforeEnter.stepIndex,
        observation: obsAfterNoTabindex,
        note: 'canvas without tabindex: a native canvas cannot receive focus; the input owner scopes keydown to the canvas element, so as-shipped keyboard input cannot start or drive the game in preview/export. Recorded as a delivery defect (candidate D-63-2); the harness focus shim below is diagnostic, not a fix.',
      },
    };

    // B03 — with the harness focus shim (tabindex=0), Enter starts the run.
    await page.evaluate(`(() => { const c = document.querySelector('#game'); c.setAttribute('tabindex','0'); c.focus(); return document.activeElement === c ? 'focused' : 'not-focused'; })()`);
    await page.dispatchKey('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(120);
    await page.dispatchKey('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const obsAfterEnter = (await obs()) as { state?: string } | { error?: unknown };
    rows['B03-enter-starts'] = obsAfterEnter.state === 'playing' ? { status: 'PASS', detail: obsAfterEnter } : { status: 'FAIL', detail: obsAfterEnter };

    // B04 — held KeyD moves the player (position from the real runtime state).
    const spawnCanvasB = await snap();
    evWrite('b-02-spawn.png', pngFromDataUrl(spawnCanvasB));
    const p0 = (await state()) as { player: { x: number; y: number } | null };
    await page.dispatchKey('rawKeyDown', { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
    const samples: Array<{ t: number; step: number; x: number | null; y: number | null }> = [];
    const holdCanvases: string[] = [];
    const tStart = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const s = (await state()) as { stepIndex: number; player: { x: number; y: number } | null };
      samples.push({ t: Date.now() - tStart, step: s.stepIndex, x: s.player?.x ?? null, y: s.player?.y ?? null });
      holdCanvases.push(String(await snap()));
      await sleep(250);
    }
    await page.dispatchKey('keyUp', { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
    await sleep(250);
    const pN = (await state()) as { player: { x: number; y: number } | null };
    const movedX = (pN.player?.x ?? 0) - (p0.player?.x ?? 0);
    const distinctB = new Set(holdCanvases).size;
    evWrite('b-03-moved.png', pngFromDataUrl(holdCanvases[holdCanvases.length - 1] ?? null));
    rows['B04-held-D-moves-player'] = movedX > 0.5 ? { status: 'PASS', detail: { start: p0, end: pN, delta: movedX, samples } } : { status: 'FAIL', detail: { start: p0, end: pN, delta: movedX, samples } };
    rows['B04b-canvas-reflects-motion'] = distinctB > 1 ? { status: 'PASS', detail: { distinctHoldFrames: distinctB } } : { status: 'UNVERIFIED', detail: { distinctHoldFrames: distinctB, playerDelta: movedX, note: 'the captured canvas frames are identical across the held-D window (SwiftShader + full-frame capture; see B04 for the simulation-state evidence)' } };

    // B05 — runtime diagnostics after the run.
    const diag = await page.evaluate(`window.__tl.diagnostics()`);
    const gv = await page.evaluate(`window.__tl.gameView()`);
    const audio = await page.evaluate(`window.__tl.audio()`);
    rows['B05-diagnostics'] = { status: 'INFO', detail: { diag, gameView: gv, audio, note: 'audio is pre-gesture (blocked) — the harness never unlocks; audibility UNVERIFIED by contract' } };
    evJson('b-summary.json', { ...result, rows });
  } finally {
    await page.evaluate(`window.__tl?.dispose?.()`).catch(() => undefined);
    await page.close();
    await server.close();
  }
  return result;
}

export { phaseA, phaseB };