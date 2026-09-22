/**
 * Packet 63 — Phase C: real backend + real editor page + real isolated-play
 * preview (separate origin, bridge handshake) in the local headless Chrome.
 *
 * The committed Beacon Reach captured envelope is seeded as an ordinary v3
 * workspace project in a disposable data root. The REAL deployed backend
 * bundle (`dist/backend/backend.mjs`) serves the authoring origin (with a
 * config-injected copy of the editor page) and the preview origin (the real
 * `dist/preview/preview-m3.js` as the v3 `game.js`). The browser loads the
 * real editor, clicks the real Play button, and the real preview iframe runs
 * the real production composition.
 *
 * Keyboard: the shipped preview canvas has no tabindex (the wrapper creates
 * it via `document.createElement`), so as-shipped keyboard input cannot reach
 * the canvas-scoped input owner. The harness focus shim (tabindex=0, applied
 * inside the frame context) is diagnostic and labelled as such — the same
 * finding Phase B records for the export page.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser } from '../m3-browser/lib/browser.mjs';
import { contextEvents, evalInFrame, waitForContext } from './lib/frames.mjs';
import { externalOrigins } from './phases-ab.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const CAPTURED = join(REPO_ROOT, 'samples/beacon-reach/captured/project.json');
const SAMPLE_ASSETS = join(REPO_ROOT, 'samples/beacon-reach/assets');
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const AUTHORING_PORT = 18501;
const PREVIEW_PORT = 18502;
const AUTHORING_ORIGIN = `http://127.0.0.1:${AUTHORING_PORT}`;
const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`;
const PROJECT_ID = 'beacon-reach';
const AUTH_TOKEN = 'm463-authoring-token';
const ADMIN_TOKEN = 'm463-admin-token';

/**
 * The backend session log (sessions.md §11.1) — the authoritative record of
 * the authoring-session + play lifecycle (`started` → `presented` /
 * `preview_timeout` / `session_lost` / `stopped`). Fetched over the public
 * HTTP routes with the authoring token. Returns the bounded entries or null
 * (backend down / no session).
 */
async function sessionLog(): Promise<unknown> {
  try {
    const listRes = await fetch(`${AUTHORING_ORIGIN}/api/v1/sessions?projectId=${PROJECT_ID}`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    if (!listRes.ok) return { listError: listRes.status };
    const list = (await listRes.json()) as { sessions?: Array<{ sessionId?: string; connected?: boolean }> };
    const sid = list.sessions?.[0]?.sessionId;
    if (sid === undefined) return { sessions: list.sessions };
    const logRes = await fetch(`${AUTHORING_ORIGIN}/api/v1/sessions/${sid}/log?limit=128`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    if (!logRes.ok) return { sessionId: sid, logError: logRes.status };
    return { sessionId: sid, ...(await logRes.json()) as object };
  } catch (e) {
    return { fetchError: e instanceof Error ? e.message : String(e) };
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}

interface Rows { [row: string]: { status: string; detail: unknown } }
type Browser = NonNullable<Awaited<ReturnType<typeof launchBrowser>>>;

export async function phaseC(evidence: string, rows: Rows): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  if (!(await portFree(AUTHORING_PORT)) || !(await portFree(PREVIEW_PORT))) {
    rows['C00-ports'] = { status: 'FAIL', detail: { note: `ports ${AUTHORING_PORT}/${PREVIEW_PORT} busy; phase C not run` } };
    return { skipped: true, reason: 'ports busy' };
  }

  // ---- seed the disposable workspace -------------------------------------
  const root = mkdtempSync(join(tmpdir(), 'tl-m463-preview-'));
  const dataRoot = join(root, 'data');
  const editorDir = join(root, 'editor');
  const captured = JSON.parse(new TextDecoder().decode(readFileSync(CAPTURED)));
  const provenance = JSON.parse(new TextDecoder().decode(readFileSync(join(REPO_ROOT, 'samples/beacon-reach/assets/provenance.json')))) as { assets: Array<{ id: string; path: string }> };
  const projDir = join(dataRoot, 'projects', PROJECT_ID);
  mkdirSync(join(projDir, 'scenes'), { recursive: true });
  mkdirSync(join(projDir, 'sources', 'sha256'), { recursive: true });
  const sceneId = (captured.scene as { sceneId: string }).sceneId;
  writeFileSync(join(projDir, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    engineVersion: '0.1.0',
    id: PROJECT_ID,
    name: 'Beacon Reach',
    createdAt: '2026-09-21T00:00:00Z',
    scenes: [{ id: sceneId, path: 'scenes/main.json' }],
  }, null, 2));
  // The committed captured envelope carries the canonical v3 scene + content
  // plus the capture `recipe` key; the loadable project envelope is the same
  // scene/content with the `retry` block, in the canonical key order
  // `storageVersion, type, projectId, scene, content, retry` (envelope.ts
  // §4.4: UTF-8, LF, 2-space indent, one trailing newline). Verified
  // loadable through the public `openWorkspaceService.query(queryProject)`.
  const envelopeDoc = {
    storageVersion: 3,
    type: 'authoring-state',
    projectId: PROJECT_ID,
    scene: captured.scene,
    content: captured.content,
    retry: { retention: 128, records: [] },
  };
  writeFileSync(join(projDir, 'scenes', 'main.json'), JSON.stringify(envelopeDoc, null, 2) + '\n');
  for (const a of provenance.assets) {
    const bytes = new Uint8Array(readFileSync(join(SAMPLE_ASSETS, a.path)));
    const digest = sha256Hex(bytes);
    writeFileSync(join(projDir, 'sources', 'sha256', digest), bytes);
  }

  // The editor page with the injected page config (the deployment's job).
  cpSync(join(REPO_ROOT, 'dist/editor'), editorDir, { recursive: true });
  const html = readFileSync(join(editorDir, 'index.html'), 'utf8')
    .replace(/window\.__thirdlightEditor = .*?;/,
      `window.__thirdlightEditor = { v: 1, projectId: "${PROJECT_ID}", previewOrigin: "${PREVIEW_ORIGIN}", authoringToken: "${AUTH_TOKEN}" };`);
  if (!html.includes(PREVIEW_ORIGIN)) throw new Error('editor config injection failed');
  writeFileSync(join(editorDir, 'index.html'), html);

  // ---- the real backend (the deployed bundle's env-var contract) ------------
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env['THIRDLIGHT_DATA_ROOT'] = dataRoot;
  env['THIRDLIGHT_AUTHORING_ORIGIN'] = AUTHORING_ORIGIN;
  env['THIRDLIGHT_PREVIEW_ORIGIN'] = PREVIEW_ORIGIN;
  env['THIRDLIGHT_AUTHORING_BIND'] = `127.0.0.1:${AUTHORING_PORT}`;
  env['THIRDLIGHT_PREVIEW_BIND'] = `127.0.0.1:${PREVIEW_PORT}`;
  env['THIRDLIGHT_AUTHORING_ORIGINS'] = AUTHORING_ORIGIN;
  env['THIRDLIGHT_EDITOR_DIR'] = editorDir;
  env['THIRDLIGHT_PREVIEW_DIR'] = join(REPO_ROOT, 'dist/preview');
  env['THIRDLIGHT_ENGINE_ROOT'] = REPO_ROOT;
  env['THIRDLIGHT_TOKENS'] = `authoring:${PROJECT_ID}:${AUTH_TOKEN},admin:${ADMIN_TOKEN}`;
  const proc: ChildProcess = spawn(process.execPath, [join(REPO_ROOT, 'dist/backend/backend.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let stderr = '';
  proc.stderr?.on('data', (d) => { stderr += d.toString(); });
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    const check = (): void => {
      if (stderr.includes('listening')) { clearTimeout(timer); resolve(true); }
    };
    proc.stderr?.on('data', check);
    proc.on('exit', () => { clearTimeout(timer); resolve(stderr.includes('listening')); });
  });
  if (!ready) {
    rows['C01-backend-start'] = { status: 'FAIL', detail: { stderr: stderr.slice(-1200) } };
    proc.kill('SIGKILL');
    return { failed: 'backend' };
  }
  rows['C01-backend-start'] = { status: 'PASS', detail: { stderrLine: stderr.split('\n').find((l) => l.includes('listening')) } };

  const browser = await launchBrowser({ width: 1280, height: 800 });
  const result: Record<string, unknown> = { startedAt, authoringOrigin: AUTHORING_ORIGIN, previewOrigin: PREVIEW_ORIGIN };
  // Declared OUTSIDE the try: the tsx transform loses try-block scope in the
  // matching finally (verified empirically — a const declared in the try is
  // "not defined" in the finally); an outer `let` keeps cleanup correct on
  // every path, including an exception before the interval is created.
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  const keepalive = { posts: 0, errors: 0 };
  if (browser === null) {
    rows['C02-browser'] = { status: 'UNVERIFIED', detail: 'no local browser available' };
    proc.kill('SIGTERM');
    return { ...result, skipped: 'browser' };
  }
  try {
    const page = await browser.newPage();
    await page.send('Network.enable');
    try {
      await page.goto(AUTHORING_ORIGIN + '/', { waitMs: 4000 });
      // The editor attaches its WS session; wait for the app shell + the
      // viewport canvas.
      const appReady = await page.waitFor(`document.querySelector('.tl-app__stage canvas') !== null`, { timeoutMs: 30_000 });
      rows['C02-editor-loaded'] = appReady ? { status: 'PASS', detail: 'real editor page loaded; WS session attached (status bar present)' } : { status: 'FAIL', detail: { body: (await page.evaluate(`document.body?.innerText?.slice(0, 400)`) as string) } };

      // The §11.5 silent-drop sweeper closes a WS idle > 60 s (close 1000
      // `heartbeat_timeout`), and the current editor client neither sends the
      // §5.2 heartbeat ping nor auto-reconnects a code-1000 close (verified
      // in source; recorded as ledger defect candidate D-63-3) — an idle
      // editor therefore loses its session, and an active play terminates
      // `session_lost`. A real operator keeps the session alive by working;
      // the harness plays that role with periodic real query commands over
      // the public HTTP route (each command touches the session's
      // lastActivityAt, sessions.ts `touch`). Diagnostic keepalive — it does
      // not change what is being measured.
      keepaliveTimer = setInterval(() => {
        void fetch(`${AUTHORING_ORIGIN}/api/v1/projects/${PROJECT_ID}/commands`, {
          method: 'POST',
          headers: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'queryEntities', projectId: PROJECT_ID, args: { limit: 1, offset: 0 } }),
        }).then((r) => { if (r.ok) keepalive.posts += 1; else keepalive.errors += 1; }).catch(() => { keepalive.errors += 1; });
      }, 15_000);
      await sleep(1500);

      // The authoring viewport renders the scene (non-blank canvas).
      const vpCanvas = await page.evaluate(`new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('.tl-app__stage canvas'); r(c ? c.toDataURL('image/png') : null); }))`);
      const vpBytes = (vpCanvas as string | null)?.length ?? 0;
      writeFileSync(join(evidence, 'c-01-authoring-viewport.png'), Buffer.from((vpCanvas as string).split(',')[1] ?? '', 'base64'));
      rows['C03-authoring-viewport-renders'] = vpBytes > 2000 ? { status: 'PASS', detail: { canvasBytes: vpBytes } } : { status: 'FAIL', detail: { canvasBytes: vpBytes } };

      // Editor-side bridge transcript (installed BEFORE Play, so it captures
      // the whole exchange: the editor's outbound `tl.handshake` is NOT seen
      // here (it posts to the iframe, not this window), but every
      // preview→editor message is: `tl.handshake.ack`, `tl.load.progress`,
      // `tl.ready`, `tl.error`, `tl.pong`, `tl.stopped`. This is the
      // authoritative record of what the PREVIEW sent back — e.g. a `tl.error`
      // (play_content_not_ready) proves `loadContent` ran (snapshot arrived);
      // a `tl.handshake.ack` proves the preview accepted the handshake; their
      // ABSENCE localizes the stall to the editor's ack→snapshot leg.
      await page.evaluate(`window.__tlBridgeTx = []; window.__tlBridgeTxOn = true; window.addEventListener('message', (e) => { const d = e.data; if (d && typeof d === 'object' && typeof d.type === 'string' && d.type.startsWith('tl.')) { (window.__tlBridgeTx ??= []).push({ type: d.type, from: e.origin, t: Math.round(performance.now()) }); } });`);

      // Install BEFORE the Play click (before the iframe exists): wrap the
      // `src` setter so the moment React sets the preview iframe's src, a
      // `load` listener is attached on the element (deterministic
      // load-event detection — a post-hoc attach would race the fast
      // headless load). Diagnostic only; the product code is untouched.
      const srcWrap = await page.evaluate(`(() => { if (window.__tlSrcWrapped) return 'already'; window.__tlSrcWrapped = true; const d = Element.prototype.setAttribute; Element.prototype.setAttribute = function (name, value) { try { if (name === 'src' && this instanceof HTMLIFrameElement && !this.__tlLoadHook) { this.__tlSrcSetAt = Math.round(performance.now()); this.__tlLoadHook = true; this.__tlLoadFired = []; this.addEventListener('load', () => this.__tlLoadFired.push(Math.round(performance.now()))); } } catch (e) {} return d.call(this, name, value); }; return 'wrapped'; })()`);

      // The editor's session must be STABLE before Play: the Play POST races
      // a mid-reconnect session (observed: 409 session_conflict when the
      // click lands before/while the WS re-establishes). Poll the real status
      // bar until it reads connected + a revision + no error (60 s window —
      // the first establish/resync/upgrade cycle can be slow; diagnostic,
      // non-blocking: the click below proceeds either way and C05 records
      // the real outcome).
      const stable = await page.waitFor(`(() => { const t = document.querySelector('.tl-statusbar')?.textContent ?? ''; return (t.includes('connected') && !t.includes('error') && /revision \d+/.test(t)) ? t : null; })()`, { timeoutMs: 60_000 });
      rows['C03b-session-stable'] = typeof stable === 'string' ? { status: 'INFO', detail: { statusBar: stable, note: 'connected before the Play click' } } : { status: 'INFO', detail: { stable: null, note: 'the status bar never read connected-without-error within 60 s of load (a re-establish cycle); the Play click proceeds and C05 records the real outcome' } };

      // Click the real Play button — a trusted CDP click at the button's
      // real rect (fallback: a real DOM .click() on the element).
      const playRect = await page.evaluate(`(() => { const b = document.querySelector('button.tl-btn--play'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled, visible: r.width > 0 && r.height > 0 }; })()`);
      writeFileSync(join(evidence, 'c-04-playrect.json'), JSON.stringify({ playRect }, null, 2));
      let clicked = false;
      let clickMethod: string = 'none';
      if (playRect !== null && (playRect as { disabled: boolean }).disabled === false && typeof (playRect as { x?: unknown }).x === 'number' && (playRect as { visible: boolean }).visible) {
        await page.click((playRect as { x: number; y: number }).x, (playRect as { x: number; y: number }).y);
        clicked = true;
        clickMethod = 'cdp-trusted';
      } else {
        clicked = (await page.evaluate(`(() => { const b = document.querySelector('button.tl-btn--play') as HTMLButtonElement | null; if (!b || b.disabled) return false; b.click(); return true; })()`)) === true;
        clickMethod = 'dom-click';
      }
      rows['C04-play-button'] = clicked ? { status: 'PASS', detail: { playRect, clickMethod } } : { status: 'FAIL', detail: { playRect, bodyTail: ((await page.evaluate(`document.body?.innerText?.slice(-400)`)) as string) } };
      if (!clicked) return;

      // Wait for the real preview iframe with its src. The /play POST builds
      // the play content in-process (content closure + manifest + artifacts)
      // before responding; the iframe appears only when BOTH the POST result
      // and the retained play.started WS event are in the editor — generous
      // budget for the first build. The keepalive above keeps the owner WS
      // past the §11.5 60 s silent drop while this (and C06–C10) runs.
      const clickAt = Date.now();
      const iframeSrc = await page.waitFor(`(() => { const s = document.querySelector('iframe.tl-app__preview-frame')?.src ?? ''; return s.includes('/play-content/') ? s : null; })()`, { timeoutMs: 90_000 });
      if (typeof iframeSrc !== 'string' || iframeSrc.length === 0) {
        const net = page.summary();
        const netResp: Array<{ url: string; status: number }> = (page.events ?? [])
          .filter((e) => e.method === 'Network.responseReceived')
          .map((e) => ({ url: e.params?.response?.url ?? '', status: e.params?.response?.status ?? 0 }))
          .filter((r) => r.url.includes('/api/v1/') || r.url.includes('/play'));
        // The establish attempts' own request bodies (sessionId per attempt)
        // + frame id + initiator: the decisive data for the 409 conflict
        // storm (one fixed client sessionId ⇒ re-attach; many ⇒ repeated
        // page loads / client recreation).
        const estReqs = (page.events ?? [])
          .filter((e) => e.method === 'Network.requestWillBeSent' && String(e.params?.request?.url ?? '').includes('/api/v1/sessions'))
          .map((e) => ({ frameId: e.params?.frameId, initiator: e.params?.initiator?.type ?? null, body: e.params?.request?.postData ?? null }));
        const sidCounts: Record<string, number> = {};
        for (const r of estReqs) {
          try {
            const sid = JSON.parse(r.body)?.sessionId;
            if (typeof sid === 'string') sidCounts[sid] = (sidCounts[sid] ?? 0) + 1;
          } catch { /* non-JSON body */ }
        }
        const statusBar = await page.evaluate(`document.querySelector('.tl-statusbar, .tl-app__status')?.textContent ?? ''`);
        const pageDiagnostics = await page.evaluate(`({ historyLength: history.length, navType: performance.getEntriesByType('navigation')[0]?.type ?? null, title: document.title, url: location.href })`);
        const previewDom = await page.evaluate(`(() => { const f = document.querySelector('iframe'); const l = document.querySelector('.tl-app__preview-label'); return { anyIframe: f !== null, iframeSrc: f?.src ?? null, label: l?.textContent ?? null }; })()`);
        writeFileSync(join(evidence, 'c-05-play-failure.json'), JSON.stringify({
          iframeSrc,
          statusBar,
          pageDiagnostics,
          establishAttempts: estReqs.length,
          sessionIdCounts: sidCounts,
          previewDom,
          playRequests: net.requests.filter((u) => u.includes('play') || u.includes('api')),
          apiResponses: netResp,
          consoleMessages: net.consoleMessages.slice(0, 30),
          errors: net.errors.slice(0, 20),
          sessionLog: await sessionLog(),
          backendStderrTail: stderr.slice(-1500),
        }, null, 2));
      }
      rows['C05-preview-iframe'] = typeof iframeSrc === 'string' && iframeSrc.length > 0 ? { status: 'PASS', detail: { src: iframeSrc, msAfterClick: Date.now() - clickAt } } : { status: 'FAIL', detail: { iframeSrc, note: 'see c-05-play-failure.json' } };
      const bridgeStart = Date.now();
      if (typeof iframeSrc !== 'string' || iframeSrc.length === 0) {
        rows['C06-preview-context'] = { status: 'UNVERIFIED', detail: 'no preview iframe — C06–C12 not reached' };
        return;
      }

      // Bridge traffic capture (diagnostic): the preview-side message log is
      // the complete record of editor→preview delivery (any delivered
      // postMessage reaches the preview window, whatever the bridge does with
      // it). The handshake fires at the iframe `load` (~150 ms here), so the
      // listener must be installed at CONTEXT CREATION, not on a slow poll:
      // watch `page.events` for the preview-origin `Runtime.executionContextCreated`
      // and install on first sight (15 ms poll). The expression is idempotent
      // (guarded by `__tlRecvOn`). Per-message source identity
      // (`e.source === window.parent`) is the exact §13.3 check the
      // preview-side `isTrustedSource` performs — a `false` proves the drop.
      const INSTALL_EXPR = `(() => { if (!window.__tlPostWrapped) { window.__tlPostWrapped = true; const orig = Window.prototype.postMessage; Window.prototype.postMessage = function (data, targetOrigin, transfer) { try { (window.__tlPostLog ??= []).push({ type: (data && typeof data === 'object' && data.type) || 'unknown', targetOrigin, keys: (data && typeof data === 'object') ? Object.keys(data).slice(0, 12) : null, t: Math.round(performance.now()) }); } catch (e) {} return orig.call(this, data, targetOrigin, transfer); }; } if (!window.__tlRecvOn) { window.__tlRecvOn = true; window.__tlRecvInstalledAt = Math.round(performance.now()); window.addEventListener('message', (e) => { (window.__tlRecvLog ??= []).push({ type: e.data?.type ?? 'unknown', origin: e.origin, sourceIsParent: e.source === window.parent, sourceIsOpener: e.source === window.opener, t: Math.round(performance.now()) }); }); } return { on: true, installedAt: window.__tlRecvInstalledAt ?? null, readyState: document.readyState, href: location.href, canvas: !!document.querySelector('canvas'), log: (window.__tlRecvLog ?? []).slice(-60), posts: (window.__tlPostLog ?? []).slice(-60) }; })()`;
      const bridgeLog = { installedAt: null, preview: null, received: [] as unknown[], posts: [] as unknown[], installs: 0, control: null as unknown };
      const bridgeWrapStop = ((): { stop(): void } => {
        let stopped = false;
        let confirmed = false;
        let lastRefresh = 0;
        const tryInstall = () => {
          void evalInFrame(page, PREVIEW_ORIGIN, INSTALL_EXPR, { timeoutMs: 2_000 }).then((v) => {
            if (v && typeof v === 'object' && 'on' in (v as Record<string, unknown>)) {
              const d = v as { installedAt: number | null; readyState: string; href: string; canvas: boolean; log: unknown[]; posts: unknown[] };
              bridgeLog.installedAt = d.installedAt;
              bridgeLog.preview = { readyState: d.readyState, href: d.href, canvas: d.canvas };
              bridgeLog.received = d.log;
              bridgeLog.posts = d.posts;
              confirmed = true;
              bridgeLog.installs += 1;
              lastRefresh = Date.now();
            }
          }).catch(() => {});
        };
        const t = setInterval(() => {
          if (stopped) return;
          const sawCtx = (page.events ?? []).some((e) => e.method === 'Runtime.executionContextCreated' && String(e.params?.context?.origin ?? '').includes('18502'));
          if (sawCtx && (!confirmed || Date.now() - lastRefresh > 400)) tryInstall();
          if (Date.now() - bridgeStart > 5_000) clearInterval(t);
        }, 15);
        t.unref?.();
        return { stop: () => { stopped = true; clearInterval(t); } };
      })();

      // Controlled bridge probe: prove the editor→preview postMessage
      // transport + the preview-side bridge accept the editor's origin/source
      // in THIS deployment. If the control `tl.ping` is received by the
      // preview (raw log) and answered with `tl.pong` (editor raw log), the
      // empty received-log is attributable to the editor side (the handshake
      // was never delivered), not to the environment. `tl.ping` is on the
      // §13.5 allowlist and the preview answers with `tl.pong` (no play state
      // is affected). ALSO: attach a `load` listener to the iframe element as
      // early as possible (right after C05, src is set but the doc is still
      // loading) to record whether the iframe `load` event fires at all — the
      // editor's `onLoad` (which runs `beginHandshake`) only fires on `load`,
      // so a `load` that fired yet no handshake arrived ⇒ the editor's
      // listener was not attached in time (React passive-effect vs load race)
      // or `beginHandshake` was dropped.
      const loadProbeAttach = await page.evaluate(`(() => { const f = document.querySelector('iframe.tl-app__preview-frame'); if (!f) return 'no-iframe'; if (!f.__tlLoadHook) { f.__tlLoadHook = true; f.__tlLoadFired = []; f.addEventListener('load', () => { f.__tlLoadFired.push(Math.round(performance.now())); }); } return { added: true, t: Math.round(performance.now()) }; })()`);
      const control = await (async () => {
        await sleep(1_500); // let the preview document finish loading (its `load` fired by now)
        await page.evaluate(`window.__tlEditorMsgLog = []; window.addEventListener('message', (e) => { if (e.origin === ${JSON.stringify(PREVIEW_ORIGIN)}) (window.__tlEditorMsgLog ??= []).push({ type: e.data?.type ?? 'unknown', t: Math.round(performance.now()) }); });`);
        const sent = await page.evaluate(`(() => { const f = document.querySelector('iframe.tl-app__preview-frame'); if (!f || !f.contentWindow) return 'no-contentWindow'; f.contentWindow.postMessage({ v: 2, type: 'tl.ping' }, ${JSON.stringify(PREVIEW_ORIGIN)}); return 'sent'; })()`);
        await sleep(1_000);
        const probe = await evalInFrame(page, PREVIEW_ORIGIN, `({ recvPing: (window.__tlRecvLog ?? []).filter((m) => m.type === 'tl.ping'), postPing: (window.__tlPostLog ?? []).filter((m) => m.type === 'tl.ping') })`, { timeoutMs: 2_000 });
        const editorMsgs = await page.evaluate(`(window.__tlEditorMsgLog ?? []).slice(-10)`);
        const loadFired = await page.evaluate(`(() => { const f = document.querySelector('iframe.tl-app__preview-frame'); return f ? { fired: (f.__tlLoadFired ?? []), srcSetAt: f.__tlSrcSetAt ?? null, now: Math.round(performance.now()) } : null; })()`);
        // The /play HTTP response body (CDP capture) — carries the real
        // `playContent.buildId` the editor puts in the handshake; validating
        // the reconstructed handshake body against the §13.5 validator
        // decides whether the preview-side drop is a buildId-format contract
        // breach (64 lowercase hex required).
        const playResp = await (async () => {
          const reqEvt = (page.events ?? []).find((e) => e.method === 'Network.requestWillBeSent' && e.params?.request?.method === 'POST' && String(e.params?.request?.url ?? '').includes('/api/v1/projects/' + PROJECT_ID + '/play'));
          if (!reqEvt) return { error: 'no /play request event' };
          try {
            const r = (await page.send('Network.getResponseBody', { requestId: reqEvt.params.requestId })) as { body?: string; base64Encoded?: boolean };
            const body = JSON.parse(r.body ?? '{}') as Record<string, unknown>;
            const playContent = (body['playContent'] ?? {}) as Record<string, unknown>;
            return { buildId: playContent['buildId'] ?? null, contentId: playContent['contentId'] ?? null, snapshotId: body['snapshotId'] ?? null, revision: body['revision'] ?? null, playBase: body['playBase'] ?? null };
          } catch (e) { return { error: String(e) }; }
        })();
        // Decisive probe 2: send a VALID reconstructed `tl.handshake` from
        // the editor (real playSessionId/contentId from the iframe src, real
        // buildId from the /play response, fresh 16-hex nonce) — if the
        // preview answers with `tl.handshake.ack` (captured by the editor
        // transcript), the preview's handshake→ack path is intact and the
        // stall is in the editor's own real handshake (body/timing); if it
        // stays silent, the preview's handler/ack path is broken. (The
        // editor's real Bridge drops my probe's ack on its own nonce check —
        // no real-state interference.)
        const hsProbe = await page.evaluate(`(() => { const f = document.querySelector('iframe.tl-app__preview-frame'); if (!f || !f.contentWindow || !f.src) return 'no-iframe'; const u = new URL(f.src); const playSessionId = u.searchParams.get('play') ?? ''; const contentId = u.searchParams.get('content') ?? ''; const buildId = ${JSON.stringify(String(playResp['buildId'] ?? ''))}; const nonce = 'ab'.repeat(8).split('').map(() => Math.floor(Math.random() * 16).toString(16)).join(''); f.contentWindow.postMessage({ v: 2, type: 'tl.handshake', bridgeVersion: 2, playSessionId, nonce, demo: false, contentId, buildId }, ${JSON.stringify(PREVIEW_ORIGIN)}); window.__tlProbeNonce = nonce; window.__tlProbePlayId = playSessionId; return { sent: true, playSessionId, contentIdLen: contentId.length, buildIdLen: buildId.length, nonce }; })()`);
        await sleep(500);
        // Decisive probe 4: send a `tl.snapshot` with the PROBE's nonce. If
        // the preview's `tl.handshake` handler ran (setting snapshotNonce),
        // this snapshot is accepted and `loadContent` runs — the preview then
        // posts `tl.load.progress` / `tl.ready` / `tl.error` (captured by the
        // editor transcript): proof the preview CAN load + compose when the
        // snapshot arrives, isolating the break to the missing handshake ack.
        // If the handshake was dropped before the nonce section, the snapshot
        // is dropped (`snapshot_nonce_mismatch`) and nothing follows.
        const snapProbe = await page.evaluate(`(() => { const f = document.querySelector('iframe.tl-app__preview-frame'); if (!f || !f.contentWindow) return 'no-iframe'; const playSessionId = window.__tlProbePlayId ?? ''; const nonce = window.__tlProbeNonce ?? ''; const snapshot = { snapshotId: 'beacon-reach@r26', projectId: 'beacon-reach', revision: 26, scene: { schemaVersion: 3, sceneId: 'scene-main', revision: 26, entities: [] } }; f.contentWindow.postMessage({ v: 2, type: 'tl.snapshot', playSessionId, nonce, snapshot }, ${JSON.stringify(PREVIEW_ORIGIN)}); return { sent: true, nonce }; })()`);
        await sleep(800);
        // Decisive probe 3: `tl.diagnostics.request` — the preview handler
        // returns `not_ready` when `runtime === null`, and (when ready)
        // `bridge.drops`. Either way a response proves the preview Bridge
        // dispatches editor→preview requests beyond `tl.ping`; a `not_ready`
        // confirms the runtime was never built (loadContent never ran ⇒ the
        // `tl.snapshot` never arrived).
        const diagProbe = await page.evaluate(`(() => { const f = document.querySelector('iframe.tl-app__preview-frame'); if (!f || !f.contentWindow || !f.src) return 'no-iframe'; const playSessionId = new URL(f.src).searchParams.get('play') ?? ''; const relayId = 'relay-' + 'cd'.repeat(16); f.contentWindow.postMessage({ v: 2, type: 'tl.diagnostics.request', playSessionId, relayId }, ${JSON.stringify(PREVIEW_ORIGIN)}); return { sent: true, relayId }; })()`);
        await sleep(800);
        return { sent, probe, editorMsgs, loadFired, loadProbeAttach, srcWrap, playResp, hsProbe, snapProbe, diagProbe };
      })();
      bridgeLog.control = control;

      // Inside the preview frame context: wait for the host to mount (title).
      // NOTE the 15 s §10.2 present timeout (sessions.md §10.2 / play.ts): the
      // backend stops a play that is not `presented` (editor `play.preview.
      // ready`) 15 s after creation — and the current editor client has no WS
      // send path at all (ledger D-63-4), so the frame dies ~15 s after the
      // click no matter what. This window is therefore bounded: capture what
      // the frame shows (mount success OR an early error message) fast.
      const ctxId = await waitForContext(page, PREVIEW_ORIGIN, { timeoutMs: 10_000 });
      if (ctxId === null) {
        rows['C06-preview-context'] = { status: 'FAIL', detail: 'no execution context for the preview origin' };
        return;
      }
      let firstBody = null;
      const title = await (async () => {
        const deadline = Date.now() + 12_000;
        for (;;) {
          const t = await evalInFrame(page, PREVIEW_ORIGIN, `document.querySelector('#tl-hud-root h1')?.textContent ?? ''`, { timeoutMs: 3_000 });
          if (typeof t === 'string' && t.length > 0) return t;
          const err = await evalInFrame(page, PREVIEW_ORIGIN, `document.body?.innerText?.slice(0, 300) ?? ''`, { timeoutMs: 3_000 });
          if (typeof err === 'string' && err.length > 0 && firstBody === null) firstBody = err;
          if (String(err).includes('export error') || String(err).includes('no M3 play session') || String(err).includes('play failed') || String(err).includes('preview failed')) return `ERR:${err}`;
          if (Date.now() > deadline) return null;
          await sleep(250);
        }
      })();
      if (typeof title !== 'string' || title.startsWith('ERR:') || title === null) {
        bridgeWrapStop.stop();
        const net = page.summary();
        writeFileSync(join(evidence, 'c-06-failure.json'), JSON.stringify({
          title,
          firstBody,
          bridgeLog,
          editorTx: (await page.evaluate(`(window.__tlBridgeTx ?? []).slice(-60)`)),
          iframeSrc: (await page.evaluate(`document.querySelector('iframe.tl-app__preview-frame')?.src ?? null`)),
          contextEvents: contextEvents(page, PREVIEW_ORIGIN),
          previewRequests: net.requests.filter((u) => u.includes('play-content') || u.includes('preview')),
          previewResponses: (page.events ?? [])
            .filter((e) => e.method === 'Network.responseReceived')
            .map((e) => ({ url: e.params?.response?.url ?? '', status: e.params?.response?.status ?? 0 }))
            .filter((r) => r.url.includes('play-content') || r.url.includes('18502')),
          statusBar: await page.evaluate(`document.querySelector('.tl-statusbar')?.textContent ?? ''`),
          sessionLog: await sessionLog(),
          backendStderrTail: stderr.slice(-1500),
        }, null, 2));
        writeFileSync(join(evidence, 'c-06-editor.png'), await page.screenshot());
      }
      rows['C06-preview-host-mounted'] = typeof title === 'string' && !title.startsWith('ERR:') ? { status: 'PASS', detail: { title, firstBody } } : { status: 'FAIL', detail: { title, firstBody, note: 'see c-06-failure.json (sessionLog carries the authoritative play lifecycle: the §10.2 15 s present timeout stops the play because the editor client never sends play.preview.ready — D-63-4)' } };

      // Canvas present + rendering in the preview frame (fast — the §10.2
      // 15 s present window is the real deadline). A flat bootstrap canvas
      // (solid background, ~2 KB dataURL) does NOT count — a rendered scene
      // (geometry + lighting + HUD) is ≥ ~10 KB in Phase A/B. This is the
      // true "the host composed and rendered" check.
      const pCanvas = await (async () => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const c = await evalInFrame(page, PREVIEW_ORIGIN, `new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('canvas'); r(c ? c.toDataURL('image/png') : null); }))`, { timeoutMs: 3_000 });
          if (typeof c === 'string' && c.length > 10_000) return c;
          if (Date.now() > deadline) return null;
          await sleep(250);
        }
      })();
      const pCanvasAny = await evalInFrame(page, PREVIEW_ORIGIN, `new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('canvas'); r(c ? c.toDataURL('image/png') : null); }))`, { timeoutMs: 2_000 });
      writeFileSync(join(evidence, 'c-02-preview-spawn.png'), Buffer.from((pCanvas ?? pCanvasAny as string | null)?.split(',')[1] ?? '', 'base64'));
      rows['C07-preview-canvas-renders'] = typeof pCanvas === 'string' ? { status: 'PASS', detail: { canvasBytes: pCanvas.length, note: 'scene rendered (host composed)' } } : { status: 'FAIL', detail: { sceneCanvasBytes: null, bootstrapCanvasBytes: typeof pCanvasAny === 'string' ? pCanvasAny.length : null, note: 'only the flat bootstrap canvas is present (no scene render — the host did not compose)' } };

      // Keyboard: the preview frame must still be alive (the §10.2 present
      // timeout tears it down ~15 s after the click — D-63-4). If it is gone,
      // the as-shipped keyboard facts are already covered by Phase B
      // (B02–B04 over the identical production composition); record
      // UNVERIFIED rather than a misleading FAIL.
      const frameAlive = (await evalInFrame(page, PREVIEW_ORIGIN, `document.querySelector('canvas') !== null`, { timeoutMs: 2_000 })) === true;
      if (!frameAlive) {
        for (const k of ['C08-keyboard-as-shipped', 'C09-enter-starts', 'C10-preview-motion']) {
          rows[k] = { status: 'UNVERIFIED', detail: { note: 'the preview frame was torn down before the keyboard window (the §10.2 15 s present timeout; the editor client never sends play.preview.ready — D-63-4). The as-shipped keyboard facts are recorded in Phase B (B02–B04) over the identical production composition.' } };
        }
      } else {
      // HUD prompt trace (host-owned, live) — pre-Start state.
      const promptPre = await evalInFrame(page, PREVIEW_ORIGIN, `[...document.querySelectorAll('#tl-hud-root p')].map((p) => p.textContent)`);

      // Keyboard as shipped (no tabindex on the wrapper-created canvas).
      await evalInFrame(page, PREVIEW_ORIGIN, `(() => { const c = document.querySelector('canvas'); c?.focus?.(); return document.activeElement === c ? 'focused' : 'not-focusable'; })()`);
      await page.dispatchKey('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(150);
      await page.dispatchKey('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(1200);
      const promptAfterNoTab = await evalInFrame(page, PREVIEW_ORIGIN, `[...document.querySelectorAll('#tl-hud-root p')].map((p) => p.textContent)`);
      rows['C08-keyboard-as-shipped'] = {
        status: 'INFO',
        detail: {
          promptPre,
          promptAfterNoTabindex: promptAfterNoTab,
          changed: JSON.stringify(promptPre) !== JSON.stringify(promptAfterNoTab),
          note: 'as-shipped the preview canvas is not focusable (no tabindex) — the canvas-scoped keydown owner cannot receive browser keyboard input. Recorded as delivery defect candidate D-63-2 (with B02/A02).',
        },
      };

      // Harness focus shim inside the frame, then a real CDP Enter + held D.
      await evalInFrame(page, PREVIEW_ORIGIN, `(() => { const c = document.querySelector('canvas'); c?.setAttribute('tabindex', '0'); c?.focus(); return document.activeElement === c ? 'focused' : 'not-focused'; })()`);
      await page.dispatchKey('keyDown', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(150);
      await page.dispatchKey('keyUp', { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(1000);
      const promptAfterEnter = await evalInFrame(page, PREVIEW_ORIGIN, `[...document.querySelectorAll('#tl-hud-root p')].map((p) => p.textContent)`);
      rows['C09-enter-starts'] = JSON.stringify(promptAfterEnter) !== JSON.stringify(promptPre) ? { status: 'PASS', detail: { promptAfterEnter } } : { status: 'FAIL', detail: { promptAfterEnter } };

      const before = pCanvas;
      await page.dispatchKey('rawKeyDown', { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
      const holdFrames: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        const c = await evalInFrame(page, PREVIEW_ORIGIN, `new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('canvas'); r(c ? c.toDataURL('image/png') : null); }))`);
        holdFrames.push(String(c?.length ?? 'none'));
        await sleep(300);
      }
      await page.dispatchKey('keyUp', { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68 });
      await sleep(400);
      const after = await evalInFrame(page, PREVIEW_ORIGIN, `new Promise((r) => requestAnimationFrame(() => { const c = document.querySelector('canvas'); r(c ? c.toDataURL('image/png') : null); }))`);
      writeFileSync(join(evidence, 'c-03-preview-moved.png'), Buffer.from((after as string | null)?.split(',')[1] ?? '', 'base64'));
      const distinct = new Set(holdFrames).size;
      rows['C10-preview-motion'] = after !== null && before !== null && after !== before ? { status: 'PASS', detail: { distinctHoldFrames: distinct } } : distinct > 1 ? { status: 'PASS', detail: { distinctHoldFrames: distinct } } : { status: 'UNVERIFIED', detail: { distinctHoldFrames: distinct, note: 'canvas identical across the held-D window (see B04/B04b for the simulation-state split)' } };
      } // frameAlive

      // Console/network of the editor origin (the preview frame's requests
      // are same-process too; the external-origin rule is the claim).
      const net = page.summary();
      const external = externalOrigins(net.requests, [AUTHORING_ORIGIN, PREVIEW_ORIGIN]);
      rows['C11-no-external-requests'] = { status: external.length === 0 ? 'PASS' : 'FAIL', detail: { requests: net.requests, externalOrigins: external } };
      const jsErrors = net.errors.filter((e) => e.startsWith('console.error'));
      rows['C12-console-clean'] = { status: jsErrors.length === 0 ? 'PASS' : 'FAIL', detail: { jsErrors, consoleMessages: net.consoleMessages.slice(0, 25) } };
      writeFileSync(join(evidence, 'c-console-network.json'), JSON.stringify({ requests: net.requests, consoleMessages: net.consoleMessages, errors: net.errors }, null, 2));
      bridgeWrapStop.stop();
      const editorTx = await page.evaluate(`(window.__tlBridgeTx ?? []).slice(-60)`);
      writeFileSync(join(evidence, 'c-bridge.json'), JSON.stringify({ ...bridgeLog, editorTx }, null, 2));
      writeFileSync(join(evidence, 'c-04-editor.png'), await page.screenshot());
      rows['C13-keepalive'] = { status: 'INFO', detail: { ...keepalive, note: 'harness session keepalive (real query commands over the public route) — compensates for the missing §5.2 client heartbeat (ledger D-63-3, merged into D-63-4: the editor WS client has no send path); a real operator\'s activity would serve the same role' } };
    } finally {
      if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
      await page.close();
    }
  } finally {
    // Guaranteed on every path (early `return`s jump over sequential code,
    // so the close lives in the finally — an orphaned Chrome would otherwise
    // keep its editor client auto-reconnecting to the next run's backend and
    // steal the session, producing a 409 `session_conflict` storm).
    await browser.close();
    proc.kill('SIGTERM');
    await sleep(500);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  writeFileSync(join(evidence, 'c-summary.json'), JSON.stringify({ ...result, rows }, null, 2));
  return result;
}