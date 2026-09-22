/**
 * Packet 38 — minimal Chrome DevTools Protocol driver.
 *
 * No new dependency: it speaks CDP over the repository's already-pinned `ws`
 * (backend transport) and launches the local Chrome resolved by
 * `lib/stublibs.mjs`. It is intentionally small: navigate, evaluate, read the
 * canvas from inside the page, screenshot the page, and collect console /
 * network / log events.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import { browserEnvironment, resolveBrowser } from './stublibs.mjs';

const kConsole = (e) => e.method === 'Runtime.consoleAPICalled';
const kLog = (e) => e.method === 'Log.entryAdded';
const kRequest = (e) => e.method === 'Network.requestWillBeSent';
const kResponse = (e) => e.method === 'Network.responseReceived';
const kFailed = (e) => e.method === 'Network.loadingFailed';

function argText(a) {
  if (a === null || typeof a !== 'object') return String(a);
  if (typeof a.value === 'string') return a.value;
  if (typeof a.value === 'number' || typeof a.value === 'boolean') return String(a.value);
  if (typeof a.description === 'string') return a.description;
  return JSON.stringify(a.preview?.properties ?? a.unserializableValue ?? '');
}

export async function launchBrowser({ width = 1280, height = 720 } = {}) {
  const resolved = resolveBrowser();
  if (resolved === null) return null;
  const userDataDir = mkdtempSync(join(tmpdir(), 'tl-m3-chrome-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    `--window-size=${width},${height}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ];
  const proc = spawn(resolved.chrome, args, {
    env: browserEnvironment(resolved),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 300 && port === 0; i++) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').split('\n')[0];
      port = Number(first);
    }
    if (port === 0) await new Promise((r) => setTimeout(r, 50));
  }
  if (port === 0) {
    proc.kill('SIGKILL');
    throw new Error(`no DevToolsActivePort; stderr=${stderr.slice(-400)}`);
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = {
    chrome: resolved.chrome,
    libs: resolved.libs,
    stubs: resolved.stubs,
    browserVersion: version['Browser'],
    protocolVersion: version['Protocol-Version'],
    userAgent: version['User-Agent'],
    pid: proc.pid,
    async newPage() {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === 'page');
      if (target === undefined) throw new Error(`no page target; list=${JSON.stringify(list.map((t) => t.type))}`);
      return connect(target.webSocketDebuggerUrl);
    },
    /** Create an extra page target (used for the real hidden-tab probe). */
    async createTarget(url) {
      const client = await connect(version['webSocketDebuggerUrl'], { pageDomains: false });
      const result = await client.send('Target.createTarget', { url });
      await client.close();
      return result['targetId'];
    },
    async closeTarget(targetId) {
      const client = await connect(version['webSocketDebuggerUrl'], { pageDomains: false });
      await client.send('Target.closeTarget', { targetId });
      await client.close();
    },
    async close() {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* best effort */
      }
    },
    stderrTail: () => stderr.slice(-2000),
  };
  return browser;
}

async function connect(wsUrl, { pageDomains = true } = {}) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (typeof msg.method === 'string') {
      events.push(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  if (pageDomains) {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
  }
  return {
    send,
    events,
    async goto(url, { waitMs = 2500 } = {}) {
      await send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, waitMs));
      return this;
    },
    async waitFor(expression, { timeoutMs = 15000, pollMs = 100 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        const value = r.result?.value;
        if (value !== null && value !== undefined && value !== false) return value;
        if (Date.now() > deadline) return null;
        await new Promise((r2) => setTimeout(r2, pollMs));
      }
    },
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __exception: r.exceptionDetails.text ?? 'exception' };
      return r.result?.value;
    },
    async dispatchKey(type, { key, code, windowsVirtualKeyCode, text }) {
      await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, text });
    },
    async deviceMetrics(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async screenshot() {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(r.data, 'base64');
    },
    /** A real rendered canvas PNG read from inside the page (M2 relay path). */
    async canvasPng(selector) {
      const dataUrl = await this.evaluate(
        `(() => { const c = document.querySelector(${JSON.stringify(selector)}); return c ? c.toDataURL('image/png') : null; })()`,
      );
      if (typeof dataUrl !== 'string') return null;
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    },
    /** Clear collected events so each page's records are its own. */
    resetEvents() {
      events.length = 0;
    },
    summary() {
      const consoleMessages = events.filter(kConsole).map((e) => ({
        type: e.params.type,
        text: (e.params.args ?? []).map(argText).join(' '),
      }));
      const logs = events.filter(kLog).map((e) => ({
        level: e.params.entry.level,
        source: e.params.entry.source,
        text: e.params.entry.text,
      }));
      const requests = events.filter(kRequest).map((e) => e.params.request.url);
      const responses = events.filter(kResponse).map((e) => ({
        url: e.params.response.url,
        status: e.params.response.status,
        mimeType: e.params.response.mimeType,
        fromDiskCache: e.params.response.fromDiskCache ?? false,
      }));
      const failures = events.filter(kFailed).map((e) => ({ url: e.params.requestId, error: e.params.errorText }));
      const errors = [
        ...consoleMessages.filter((m) => m.type === 'error').map((m) => `console.error: ${m.text}`),
        ...logs.filter((l) => l.level === 'error').map((l) => `log.error(${l.source}): ${l.text}`),
      ];
      return { consoleMessages, logs, requests, responses, failures, errors };
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* best effort */
      }
    },
    async click(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
  };
}

export function writeEvidence(dir, name, data, { json = false } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), json ? `${JSON.stringify(data, null, 2)}\n` : data);
  return join(dir, name);
}
