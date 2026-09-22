#!/usr/bin/env node
/**
 * Packet 38 — M3 browser baseline runner.
 *
 * Serves the built probes from a local HTTP origin with the **production
 * preview CSP** (sessions.md §17.4 / the backend's `previewCsp`), drives a real
 * Chrome over CDP, and writes raw evidence:
 *
 *   <evidenceDir>/capability.json        measured capability values
 *   <evidenceDir>/capability-page.png    DOM page screenshot
 *   <evidenceDir>/capability-canvas.png  in-page canvas PNG (the real render)
 *   <evidenceDir>/engine.json            production-stack measurements
 *   <evidenceDir>/engine-canvas.png
 *   <evidenceDir>/engine-nocsp.json      the same page without CSP (isolation)
 *   <evidenceDir>/console-network.json   sanitized console/log/network records
 *   <evidenceDir>/summary.json           machine-readable PASS/FAIL/UNVERIFIED
 *
 * `npm test` never runs this: it is an explicitly invoked evaluation, and it
 * writes only under `TL_M3_EVIDENCE_DIR` (default `docs/acceptance/
 * evidence-m3/38/raw`), so committed evidence is only rewritten on purpose.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import { BUILD_DIR, buildProbes } from './build-probes.mjs';
import { launchBrowser } from './lib/browser.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const EVIDENCE_DIR = process.env['TL_M3_EVIDENCE_DIR'] ?? join(REPO_ROOT, 'docs', 'acceptance', 'evidence-m3', '38', 'raw');
const PORT = Number(process.env['TL_M3_BROWSER_PORT'] ?? 8793);

/** sessions.md §17.4 / backend `previewCsp()` — the production preview policy. */
const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "style-src 'self'; font-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

/** The candidate M3 repair: the same policy with WebAssembly compilation allowed. */
const CSP_WITH_WASM = PRODUCTION_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'");

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
};

function startServer(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    let file = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
    if (file.endsWith('engine-nocsp.html')) {
      // deliberately no CSP: the isolation control for the WebAssembly finding
    } else if (file.endsWith('engine-csp-wasm.html')) {
      headers['content-security-policy'] = CSP_WITH_WASM;
    } else {
      headers['content-security-policy'] = PRODUCTION_CSP;
    }
    res.writeHead(200, headers);
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${PORT}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

const write = (name, data, json = false) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const body = json ? `${JSON.stringify(data, null, 2)}\n` : data;
  writeFileSync(join(EVIDENCE_DIR, name), body);
  return `${name} (${Buffer.byteLength(body)} bytes)`;
};

const summary = { packet: 38, ranAt: new Date().toISOString(), rows: {} };
const record = (row, status, detail) => {
  summary.rows[row] = { status, ...detail };
};

async function main() {
  await buildProbes();
  const server = await startServer(BUILD_DIR);
  const browser = await launchBrowser({ width: 1280, height: 720 });
  if (browser === null) {
    record('browser-launch', 'UNVERIFIED', { reason: 'no local Chrome binary/libraries and no TL_CHROME_PATH' });
    write('summary.json', summary, true);
    await server.close();
    return;
  }
  summary.environment = {
    browserVersion: browser.browserVersion,
    protocolVersion: browser.protocolVersion,
    userAgent: browser.userAgent,
    chromePath: browser.chrome,
    libraryPath: browser.libs,
    stubPath: browser.stubs,
    origin: server.origin,
    csp: PRODUCTION_CSP,
    cspWithWasm: CSP_WITH_WASM,
    display: process.env['DISPLAY'] ?? null,
    note: 'software rasteriser (ANGLE/SwiftShader); no display; physical gamepad and audio device absent',
  };
  record('browser-launch', 'PASS', { browserVersion: browser.browserVersion });

  try {
    // --- probe A: capability -------------------------------------------------
    const cap = await browser.newPage();
    cap.resetEvents();
    await cap.goto(`${server.origin}/capability.html`, { waitMs: 1500 });
    // A real user gesture before any audio work.
    await cap.click(20, 60);
    await cap.dispatchKey('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cap.dispatchKey('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cap.dispatchKey('keyDown', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await cap.dispatchKey('keyUp', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    const capDone = await cap.waitFor('window.__done === true', { timeoutMs: 20000 });
    const capProbe = await cap.evaluate('JSON.stringify(window.__probe ?? null)');
    write('capability.json', { done: capDone === true, probe: JSON.parse(capProbe ?? 'null') }, true);
    const capKeys = await cap.evaluate('JSON.stringify(window.__keys ?? [])');
    const capCanvas = await cap.canvasPng('canvas');
    if (capCanvas !== null) write('capability-canvas.png', capCanvas);
    write('capability-page.png', await cap.screenshot());
    write('capability-console-network.json', cap.summary(), true);
    record('webgl2', capProbe?.includes('"webgl2":true') ? 'PASS' : 'FAIL', {
      evidence: 'capability.json',
    });
    record('three-render', capProbe?.includes('"drawCalls"') ? 'PASS' : 'FAIL', { evidence: 'capability-canvas.png' });
    record('keyboard-events', capKeys != null ? 'PASS' : 'UNVERIFIED', { keys: capKeys });

    // --- hidden tab: a second target really hides the first -------------------
    const targetId = await browser.createTarget('about:blank');
    await new Promise((r) => setTimeout(r, 800));
    const hiddenState = await cap.evaluate('document.visibilityState');
    const hiddenSeen = await cap.evaluate('JSON.stringify(window.__visibilitySeen ?? [])');
    record('hidden-tab', hiddenState === 'hidden' ? 'PASS' : 'UNVERIFIED', { visibilityState: hiddenState, seen: hiddenSeen });
    await browser.closeTarget(targetId);

    // --- probes B/C/D: production engine stack under three CSP variants -------
    for (const [name, path] of [
      ['engine', 'engine.html'],
      ['engine-nocsp', 'engine-nocsp.html'],
      ['engine-csp-wasm', 'engine-csp-wasm.html'],
    ]) {
      const page = await browser.newPage();
      page.resetEvents();
      await page.goto(`${server.origin}/${path}`, { waitMs: 1500 });
      const done = await page.waitFor('window.__done === true', { timeoutMs: 30000 });
      const probe = await page.evaluate('JSON.stringify(window.__probe ?? null)');
      write(`${name}.json`, { done: done === true, probe: JSON.parse(probe ?? 'null') }, true);
      write(`${name}-console-network.json`, page.summary(), true);
      if (name === 'engine') {
        const canvas = await page.canvasPng('canvas');
        if (canvas !== null) write('engine-canvas.png', canvas);
        write('engine-page.png', await page.screenshot());
      }
      const parsed = JSON.parse(probe ?? 'null') ?? {};
      record(`engine-${name}`, parsed['physicsOk'] === true && parsed['glbLoaded'] === true ? 'PASS' : 'FAIL', {
        physicsOk: parsed['physicsOk'] ?? null,
        physicsError: parsed['physicsError'] ?? null,
        wasmCompile: parsed['wasmCompile'] ?? null,
        glbLoaded: parsed['glbLoaded'] ?? null,
        glbError: parsed['glbError'] ?? null,
        clipCount: parsed['glbClipCount'] ?? null,
        evidence: `${name}.json`,
      });
      await page.close();
    }
    await cap.close();
  } finally {
    write('summary.json', summary, true);
    await browser.close();
    await server.close();
  }
  console.log(JSON.stringify(summary.rows, null, 2));
  console.log(`evidence: ${EVIDENCE_DIR}`);
}

await main();
