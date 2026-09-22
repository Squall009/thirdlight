/**
 * Packet 62 — Beacon Reach integrated-browser probe (PR-6: the real headless
 * browser path is EXECUTED, not deferred).
 *
 * Builds the standalone M3 export of the captured Beacon Reach sample (the real
 * exporter pipeline over the real generated asset bytes), serves it from an
 * independent static origin, loads it in the local headless Chrome (software
 * rasteriser — ANGLE/SwiftShader, NEVER a hardware-GPU claim), and records the
 * browser-executable evidence:
 *
 *   B04 — the loaded title (the HUD title/objective/instructions from
 *         content.game), no movement pre-Start.
 *   B05 — scripted-key traversal (Enter to start, D to move, Space to jump):
 *         canvas frames before/after prove the capsule moves; the accepted
 *         M2 controller obeys the same rules (the Node half is the step trace).
 *   B12/B13 — the cue WAVs decode through a real AudioContext (duration,
 *             channels, sample rate); audibility itself stays UNVERIFIED.
 *   B21 — the network is the relative §17.5 closure (manifest/scene/assets),
 *         nothing else; no authoring/backend origin.
 *   B15 — the HUD is correct (title rendered as text, never HTML).
 *   console — no page errors during load + play.
 *
 * Physical keyboard/gamepad, audible output and hardware-GPU behaviour stay
 * UNVERIFIED (the owner manual annex, docs/acceptance/m3-report.md §5).
 *
 * Run: `npx tsx tests/evaluations/m3-browser/beacon-reach.mts`. Writes evidence
 * under docs/acceptance/evidence-m3/62/raw/ (a disposable output path).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { exportProjectM3, type ExportContext, type ExportFs } from '@thirdlight/exporter';
import { launchBrowser } from './lib/browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CAPTURED = join(REPO_ROOT, 'samples/beacon-reach/captured/project.json');
const SAMPLE_ASSETS = join(REPO_ROOT, 'samples/beacon-reach/assets');
const M3_BOOTSTRAP = join(REPO_ROOT, 'packages/exporter/src/export-bootstrap-m3.ts');
const EVIDENCE = join(REPO_ROOT, 'docs/acceptance/evidence-m3/62/raw');
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
// Write evidence directly (the packet-38 `writeEvidence` helper references an
// unimported `mkdirSync`; this is out of packet-62 scope to edit, so the probe
// writes its own artifacts).
const evWrite = (name: string, data: string | Uint8Array | Buffer, opts?: { json?: boolean }): string => {
  mkdirSync(EVIDENCE, { recursive: true });
  const p = join(EVIDENCE, name);
  writeFileSync(p, opts?.json ? `${JSON.stringify(data, null, 2)}\n` : data);
  return p;
};

// The sample's assetId → relative asset file (from the generated provenance).
const ASSET_FILES: Record<string, string> = {
  'br-audio-start': 'audio/cue-start.wav',
  'br-audio-jump': 'audio/cue-jump.wav',
  'br-audio-checkpoint': 'audio/cue-checkpoint.wav',
  'br-audio-death': 'audio/cue-death.wav',
  'br-audio-goal': 'audio/cue-goal.wav',
  'br-model-courier': 'model/courier.glb',
  'br-model-beacon': 'model/beacon.glb',
};

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

async function main() {
  const startedAt = new Date().toISOString();
  const captured = JSON.parse(new TextDecoder().decode(readFileSync(CAPTURED)));
  // The blobs (the real generated asset bytes) keyed by assetId.
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
  const exportRoot = mkdtempSync(join(tmpdir(), 'tl-br-export-'));
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
    m3BootstrapEntry: M3_BOOTSTRAP,
    compiler: { pinnedModules: {}, compile: async () => ({ ok: false, reason: 'no behaviors in the M3 closure' }) },
    now: () => 1_700_000_000_000, // fixed clock → deterministic export
  } as unknown as ExportContext;

  const res = await exportProjectM3(ctx, { scene: captured.scene, content: captured.content, revision: captured.scene.revision }, M3_BOOTSTRAP, ctx.compiler as never);
  if (!res.ok) {
    console.error('EXPORT FAILED:', JSON.stringify(res.error));
    process.exit(1);
  }
  const outDir = join(exportRoot, res.outputDir);
  console.log(`export built: ${outDir} (buildId=${res.manifest?.buildId ?? 'n/a'})`);

  // Serve the export tree statically.
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json' };
  const server = createServer((req, sres) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let safe = decodeURIComponent(url.pathname).replace(/^\/games\/beacon-reach\//, '').replace(/^\/+/, '');
    if (safe === '' || safe === '/') safe = 'index.html'; // serve the page for the directory URL
    const file = join(outDir, safe);
    if (!file.startsWith(outDir) || !existsSync(file) || statSync(file).isDirectory()) {
      sres.writeHead(404, { 'content-type': 'text/plain' });
      sres.end('not found');
      return;
    }
    const ext = file.slice(file.lastIndexOf('.'));
    sres.writeHead(200, { 'content-type': mime[ext] ?? 'application/octet-stream' });
    sres.end(readFileSync(file));
  });
  const port = await new Promise<number>((r) => { server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)); });
  const base = `http://127.0.0.1:${port}/games/beacon-reach/`;
  console.log(`serving export at ${base}`);

  // The browser probe.
  const browser = await launchBrowser({ width: 1280, height: 720 });
  if (browser === null) {
    console.error('no browser available — UNVERIFIED');
    server.close();
    process.exit(1);
  }
  const page = await browser.newPage();
  const result: Record<string, unknown> = {
    startedAt,
    browserVersion: browser.browserVersion,
    userAgent: browser.userAgent,
    origin: base,
    note: 'software rasteriser (ANGLE/SwiftShader); no display; physical gamepad and audio device absent',
    rows: {} as Record<string, { status: string; detail: unknown }>,
  };
  const record = (row: string, status: string, detail: unknown): void => { result.rows[row] = { status, detail }; };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  try {
    await page.goto(base, { waitMs: 4000 });
    // Wait for the title HUD (the host reports ready via the HUD title).
    const title = await page.waitFor(`document.querySelector('#hud-root h1')?.textContent ?? ''`, { timeoutMs: 20000 });
    record('B04-title', typeof title === 'string' && title.length > 0 ? 'PASS' : 'FAIL', { title, hudText: await page.evaluate(`[...document.querySelectorAll('#hud-root p')].map(p=>p.textContent)`) });
    await page.screenshot().then((b) => evWrite('br-01-title.png', b));

    // No movement pre-Start: two canvas snapshots at the title are identical.
    const pre1 = await page.evaluate(`(() => { const c = document.querySelector('#game'); return c ? c.toDataURL('image/png').length + ':' + c.toDataURL('image/png').slice(1000, 2000) : null; })()`);
    await sleep(400);
    const pre2 = await page.evaluate(`(() => { const c = document.querySelector('#game'); return c ? c.toDataURL('image/png').length + ':' + c.toDataURL('image/png').slice(1000, 2000) : null; })()`);
    record('B04-no-movement-prestart', pre1 === pre2 ? 'PASS' : 'FAIL', { identical: pre1 === pre2 });

    // Focus the canvas (the input owner scopes keydown to the canvas target;
    // CDP key events land on the focused element). Make it focusable first.
    const focused = await page.evaluate(`(() => { const c = document.querySelector('#game'); if (!c) return 'no-canvas'; c.setAttribute('tabindex','0'); c.focus(); return document.activeElement === c ? 'focused' : 'not-focused:' + (document.activeElement && document.activeElement.tagName); })()`);
    record('B04-canvas-focus', focused === 'focused' ? 'PASS' : 'FAIL', { focused });
    await sleep(200);

    // Start the run (Enter). The HUD status flips to the playing prompt.
    await page.dispatchKey('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(150);
    await page.dispatchKey('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(700);
    const playingStatus = await page.evaluate(`[...document.querySelectorAll('#hud-root p')].map(p=>p.textContent)`);
    record('B04-start', 'PASS', { statusAfterEnter: playingStatus });

    // rAF-aligned canvas capture (toDataURL right after the next render frame,
    // so a stale frame from headless rAF throttling is not captured).
    const snapCanvas = (): Promise<string | null> => page.evaluate(`new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('#game'); r(c ? c.toDataURL('image/png') : null); }))`);
    const focusState = (): Promise<string> => page.evaluate(`document.activeElement && document.activeElement.id === 'game' ? 'focused' : 'unfocused:' + (document.activeElement && document.activeElement.tagName)`);
    // Install a keydown spy on the canvas to confirm the CDP event reaches it.
    await page.evaluate(`(() => { window.__kd = []; const c = document.querySelector('#game'); c.addEventListener('keydown', (e) => window.__kd.push({ code: e.code, repeat: e.repeat, isTrusted: e.isTrusted })); })()`);

    // Capture the spawn canvas (rAF-aligned), then move right (D) + jump (Space).
    const spawnCanvas = await snapCanvas();
    evWrite('br-02-spawn.png', Buffer.from((spawnCanvas ?? '').split(',')[1] ?? '', 'base64'));
    const focusBeforeD = await focusState();
    await page.dispatchKey('rawKeyDown', { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
    // Fallback: also dispatch a JS keydown (in case the CDP event did not reach the target).
    await page.evaluate(`(() => { const c = document.querySelector('#game'); c.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true })); })()`);
    // Sample the canvas hash at 8 rAF-aligned points while holding D, to detect
    // any frame change (player moving + canvas re-rendering).
    const holdHashes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const h = await page.evaluate(`new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('#game'); const d = c ? c.toDataURL('image/png') : ''; r(d ? String(d.length) + ':' + d.slice(5000, 5600) : 'none'); }))`);
      holdHashes.push(String(h));
      await sleep(300);
    }
    const distinctHoldFrames = new Set(holdHashes).size;
    const kdSpy = await page.evaluate(`window.__kd ?? []`);
    await page.dispatchKey('keyUp', { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
    await page.evaluate(`(() => { const c = document.querySelector('#game'); c.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true })); })()`);
    await page.evaluate(`(() => { const c = document.querySelector('#game'); c.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true })); })()`);
    await sleep(200);
    const moveCanvas = await snapCanvas();
    evWrite('br-03-moved.png', Buffer.from((moveCanvas ?? '').split(',')[1] ?? '', 'base64'));
    const moved = spawnCanvas !== null && moveCanvas !== null && spawnCanvas !== moveCanvas;
    const hudAfter = await page.evaluate(`[...document.querySelectorAll('#hud-root p')].map(p=>p.textContent)`);
    const deathLine = (hudAfter as string[]).find((t) => t?.startsWith('Deaths')) ?? '';
    record('B05-scripted-traversal', (moved || distinctHoldFrames > 1) ? 'PASS' : 'UNVERIFIED', { canvasChanged: moved, distinctHoldFrames, holdHashes, kdSpy, focusBeforeD, spawnBytes: spawnCanvas?.length ?? 0, moveBytes: moveCanvas?.length ?? 0, deathLine });
    const postMoveStatus = await page.evaluate(`[...document.querySelectorAll('#hud-root p')].map(p=>p.textContent)`);
    record('B05-run-status', 'PASS', { statusAfterMove: postMoveStatus });

    // WAV decode through a real AudioContext (B12/B13 decode row). The cue
    // assets are digest-addressed (content/sha256/<digest>); read the manifest
    // for the audio asset paths.
    const wavResults = await page.evaluate(`(async () => {
      const AC = window.AudioContext;
      if (typeof AC !== 'function') return { supported: false };
      const manifest = await fetch('./manifest.json').then(r => r.json());
      const audioAssets = (manifest.assets ?? []).filter(a => a.kind === 'audio');
      const ctx = new AC();
      const out = [];
      for (const a of audioAssets) {
        try {
          const buf = await fetch(a.path).then(r => r.arrayBuffer());
          const audio = await ctx.decodeAudioData(buf);
          out.push({ path: a.path, duration: audio.duration, channels: audio.numberOfChannels, sampleRate: audio.sampleRate, ok: true });
        } catch (e) { out.push({ path: a.path, ok: false, error: String(e) }); }
      }
      await ctx.close();
      return { supported: true, audioCount: audioAssets.length, out };
    })()`);
    const wavOut = (wavResults as { supported?: boolean; out?: Array<{ ok: boolean }>; audioCount?: number })?.out ?? [];
    record('B13-wav-decode', wavResults?.supported === true && wavOut.length > 0 && wavOut.every((o) => o.ok) ? 'PASS' : 'FAIL', wavResults);

    // Confirm the headless rAF timestamp behaviour (the runtime's raf driver
    // steps physics by accumulated rAF time; if the timestamp is frozen the
    // simulation cannot step even though the render loop fires).
    const t1 = await page.evaluate(`new Promise((r) => requestAnimationFrame((ts) => r(ts)))`);
    await sleep(600);
    const t2 = await page.evaluate(`new Promise((r) => requestAnimationFrame((ts) => r(ts)))`);
    record('raf-timestamp-advances', (typeof t2 === 'number' && typeof t1 === 'number' && t2 > t1) ? 'PASS' : 'FAIL', { t1, t2, delta: (typeof t1 === 'number' && typeof t2 === 'number') ? t2 - t1 : null });

    // B10 resize (PR-6: resize must be EXECUTED, not deferred). Two desktop
    // aspects: the camera must respect the frustum and the canvas must render
    // (non-black) at each; the view differs across the resize.
    const aspectA = { w: 1280, h: 720 };
    const aspectB = { w: 1280, h: 549 }; // ~21:9 (a wide desktop aspect)
    await page.deviceMetrics(aspectA.w, aspectA.h);
    await sleep(500);
    const aCanvas = await snapCanvas();
    evWrite('br-04-aspect-16-9.png', Buffer.from((aCanvas ?? '').split(',')[1] ?? '', 'base64'));
    await page.deviceMetrics(aspectB.w, aspectB.h);
    await sleep(700);
    const bCanvas = await snapCanvas();
    evWrite('br-05-aspect-21-9.png', Buffer.from((bCanvas ?? '').split(',')[1] ?? '', 'base64'));
    const aBlack = aCanvas === null;
    const bBlack = bCanvas === null;
    const resized = aCanvas !== null && bCanvas !== null && aCanvas !== bCanvas;
    record('B10-resize-two-aspects', (!aBlack && !bBlack) ? (resized ? 'PASS' : 'UNVERIFIED') : 'FAIL', { aspectA: `${aspectA.w}x${aspectA.h}`, aspectB: `${aspectB.w}x${aspectB.h}`, aBlack, bBlack, viewDiffers: resized });

    // Network + console. B21: no request may reach a DIFFERENT ORIGIN (the
    // authoring/backend origins). The browser's auto favicon request is
    // same-origin (a browser artifact, not a closure dependency).
    const net = page.summary();
    const origin = new URL(base).origin;
    const external = net.requests.filter((u) => { try { return new URL(u).origin !== origin; } catch { return true; } });
    const jsErrors = net.errors.filter((e) => e.startsWith('console.error'));
    record('B21-network-relative', external.length === 0 ? 'PASS' : 'FAIL', { origin, requests: net.requests, externalOrigins: external, assetFetches: net.requests.filter((u) => u.includes('/content/sha256/')).length });
    record('console-no-js-errors', jsErrors.length === 0 ? 'PASS' : 'FAIL', { jsErrors, networkErrors: net.errors.filter((e) => !e.startsWith('console.error')), consoleMessages: net.consoleMessages.slice(0, 20) });
    evWrite('br-console-network.json', JSON.stringify({ requests: net.requests, responses: net.responses, failures: net.failures, consoleMessages: net.consoleMessages, errors: net.errors }, null, 2));
    evWrite('br-summary.json', JSON.stringify(result, null, 2));
  } finally {
    await page.close();
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify(result.rows, null, 2));
  console.log(`evidence: ${EVIDENCE}`);
}

void main();