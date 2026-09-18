/**
 * Play-preview bootstrap (sessions.md §13; runtime.md §9; packet 10).
 *
 * Runs in the SEPARATE-origin preview iframe. It is backend-free by design:
 * it receives NO credentials (the only page config is `{ v, authoringOrigin }`
 * — sessions.md §13.2) and NEVER talks to the backend. The snapshot arrives
 * only through the checked §13.5 bridge (the nonce-verified `tl.snapshot`);
 * without the verified authoring-origin bridge it has no snapshot and shows a
 * static "no active play" notice (useless standalone).
 *
 * It instantiates the runtime + three-adapter (the SAME runtime as play mode —
 * runtime.md §9) from the bridge-delivered snapshot, renders the play, and
 * services the screenshot/diagnostics/stop relays. Repeated play disposal
 * (start → stop → start → stop) disposes the runtime/adapter cleanly each cycle
 * (runtime.md §3.4) — no leaked loops or GPU resources.
 *
 * Browser-only: DOM + WebGL via three-adapter.
 */

import {
  BUILTIN_MODULES,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type Runtime,
  type RuntimeSnapshot,
} from '@thirdlight/runtime';
import { createSceneAdapter, type SceneAdapter } from '@thirdlight/three-adapter';
import { Bridge } from './bridge';

/** The injected preview page config (sessions.md §13.2 — config, not a secret). */
interface PreviewPageConfig {
  v: 1;
  authoringOrigin: string;
}

declare global {
  interface Window {
    __thirdlightPreview?: PreviewPageConfig;
  }
}

const NO_PLAY_HTML =
  '<div style="font:14px/1.5 system-ui,sans-serif;color:#9aa4b2;padding:24px;">' +
  'No active play. Open this preview from the editor&#39;s Play button.</div>';

function showNoPlay(): void {
  const el = document.createElement('div');
  el.className = 'tl-preview-no-play';
  el.innerHTML = NO_PLAY_HTML;
  document.body.appendChild(el);
}

export function bootstrapPreview(): void {
  const cfg = window.__thirdlightPreview;
  const playId = new URLSearchParams(window.location.search).get('play');
  if (!cfg || cfg.v !== 1 || !playId) {
    showNoPlay();
    return;
  }
  const authoringOrigin = cfg.authoringOrigin;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100vw;height:100vh;display:block;background:#0e1015;';
  document.body.style.margin = '0';
  document.body.appendChild(canvas);

  // The trusted source is the window that sent the accepted handshake. Before
  // a completed handshake only the embedding editor window (parent for the
  // iframe mechanism, opener for a new tab) may initiate (sessions.md §13.3).
  let trustedSource: unknown = null;
  const bridge = new Bridge({
    direction: 'preview',
    expectedOrigin: authoringOrigin,
    targetOrigin: authoringOrigin,
    post: (data, target) => window.parent.postMessage(data, target),
    isTrustedSource: (s) => s === trustedSource || s === window.parent || s === window.opener,
  });

  let runtime: Runtime | null = null;
  let adapter: SceneAdapter | null = null;
  let snapshotId = '';
  let snapshotRevision = 0;

  const disposePlay = (): void => {
    if (runtime) {
      runtime.stop();
      runtime.dispose();
      runtime = null;
    }
    if (adapter) {
      adapter.dispose();
      adapter = null;
    }
  };

  const startRuntime = (snapshot: unknown, demo: boolean): void => {
    disposePlay(); // a fresh play always starts from a clean state
    const registry = createSimulationRegistry();
    for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
    // The onFrame holder breaks the runtime↔adapter circular reference: the
    // runtime's onFrame calls the adapter's renderFrame (step → sync → render).
    const adapterRef: { current: SceneAdapter | null } = { current: null };
    const rt = instantiateRuntime({
      snapshot,
      registry,
      modules: demo ? [BUILTIN_MODULES[0]?.id ?? 'thirdlight.demo:box-motion'] : [],
      driver: { kind: 'raf' },
      clock: () => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000),
      onFrame: () => {
        const a = adapterRef.current;
        if (a) a.renderFrame();
      },
    });
    if (rt.ok === false) {
      bridge.sendError(playId, rt.error.code, rt.error.message);
      return;
    }
    const ad = createSceneAdapter(canvas, { runtime: rt.runtime, snapshot: snapshot as RuntimeSnapshot });
    adapterRef.current = ad;
    runtime = rt.runtime;
    adapter = ad;
    const started = rt.runtime.start();
    if (started.ok === false) {
      bridge.sendError(playId, started.error.code, started.error.message);
      disposePlay();
      return;
    }
    const snap = snapshot as { snapshotId: string; revision: number };
    snapshotId = snap.snapshotId;
    snapshotRevision = snap.revision;
  };

  bridge.on('tl.handshake', (m, event) => {
    const body = m as { playSessionId: string; nonce: string; demo: boolean };
    trustedSource = event.source; // store the handshake source (§13.3)
    bridge.ackHandshake(body.playSessionId, body.nonce);
    void body.demo;
  });

  bridge.on('tl.snapshot', (m) => {
    const body = m as { snapshot: unknown };
    startRuntime(body.snapshot, false);
    if (runtime && adapter) {
      // Report ready with the snapshot identity (the editor displays it).
      bridge.sendReady(playId, snapshotId, snapshotRevision);
    }
  });

  bridge.on('tl.screenshot.request', (m) => {
    const body = m as { relayId: string; maxWidth?: number };
    const a = adapter;
    if (!a) {
      bridge.sendScreenshotResult(playId, body.relayId, { ok: false, error: { code: 'not_ready' } });
      return;
    }
    const res = a.captureScreenshot(body.maxWidth ?? 1024);
    if (res.ok === false) {
      bridge.sendScreenshotResult(playId, body.relayId, { ok: false, error: { code: res.error.code, message: res.error.message?.slice(0, 256) } });
      return;
    }
    bridge.sendScreenshotResult(playId, body.relayId, { ok: true, dataUrl: res.result.dataUrl, width: res.result.width, height: res.result.height });
  });

  bridge.on('tl.diagnostics.request', (m) => {
    const body = m as { relayId: string };
    const rt = runtime;
    const a = adapter;
    if (!rt || !a) {
      bridge.sendDiagnosticsResult(playId, body.relayId, { ok: false, error: { code: 'not_ready' } });
      return;
    }
    const rd = rt.getDiagnostics();
    const ad = a.diagnostics();
    const diagnostics =
      rd.ok && ad.ok
        ? { runtime: rd.diagnostics, adapter: ad.diagnostics }
        : { runtime: rd.ok ? rd.diagnostics : { error: rd.error.code }, adapter: ad.ok ? ad.diagnostics : { error: ad.error.code } };
    bridge.sendDiagnosticsResult(playId, body.relayId, { ok: true, diagnostics });
  });

  bridge.on('tl.play.stop', () => {
    disposePlay();
    bridge.sendStopped(playId);
  });

  bridge.on('tl.ping', () => {
    bridge.sendPong();
  });

  const onMsg = (ev: MessageEvent): void => {
    bridge.handleMessage({ origin: ev.origin, source: ev.source, data: ev.data });
  };
  window.addEventListener('message', onMsg);
}

// The preview bundle entry: bootstrap immediately on load (the backend template
// loads this script; the `?play=` param + injected config are read here).
bootstrapPreview();