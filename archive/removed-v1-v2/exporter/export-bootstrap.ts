/**
 * Export bundle bootstrap (export.md §5.5 — normative steps 1–5).
 *
 * Runs in the exported static page (`<script type="module">`, IIFE bundle —
 * no top-level `await`: the contract §5.3 pins `format: "iife"` and esbuild
 * rejects top-level await in IIFE output, so step 1 is a `.then()` chain).
 *
 * It is the SAME runtime as play mode (export.md §5.1 / runtime.md §9): the
 * runtime + three-adapter from the same sources at the same pinned versions
 * — no separate gameplay implementation. The snapshot arrives from the
 * exported `./snapshot.json` (the ONE engine-initiated `fetch`, §5.3) —
 * there is no backend, no bridge, no credentials, no other network call.
 *
 * Behavior:
 *   1. `fetch("./snapshot.json")` (relative; a failure ⇒ a structured
 *      on-page message, no silent blank page).
 *   2. `instantiateRuntime` with the frozen snapshot, the built-in registry,
 *      `modules: ["thirdlight.demo:box-motion"]`, the default
 *      clock/driver (runtime.md §3.1).
 *   3. `createSceneAdapter` on the page canvas (WebGL 2 path; the selected
 *      backend is reported on the HUD line).
 *   4. `start()`. Runtime errors surface on-page with the runtime.md error
 *      code (structured, not a stack dump).
 *   5. No stop/dispose path (M1 export — the tab ends; the runtime's
 *      disposal rules still apply to teardown, runtime.md §3.4).
 *
 * Browser-only: DOM + WebGL via three-adapter.
 */

import {
  BUILTIN_MODULES,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type RuntimeSnapshot,
} from '@thirdlight/runtime';
import { createSceneAdapter, type SceneAdapter } from '@thirdlight/three-adapter';

/** The M1 export's fixed demonstration module (export.md §5.1 — demo-on only). */
const MODULES: readonly string[] = ['thirdlight.demo:box-motion'];

/** The HUD line: snapshotId + renderer backend (filled at runtime, §7). */
function hud(text: string, isError: boolean): void {
  const el = document.getElementById('hud');
  if (el !== null) {
    el.textContent = text;
    el.className = isError ? 'error' : '';
  }
}

function start(snapshot: unknown): void {
  const registry = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
  // The onFrame holder breaks the runtime↔adapter circular reference: the
  // runtime's onFrame calls the adapter's renderFrame (step → sync → render)
  // — the single frame-driver owner rule (runtime.md §6/§9).
  const adapterRef: { current: SceneAdapter | null } = { current: null };
  const rt = instantiateRuntime({
    snapshot,
    registry,
    modules: MODULES,
    driver: { kind: 'raf' },
    clock: () => performance.now() / 1000,
    onFrame: () => {
      const a = adapterRef.current;
      if (a !== null) a.renderFrame();
    },
  });
  if (rt.ok === false) {
    hud('runtime error: ' + rt.error.code + ' — ' + rt.error.message.slice(0, 120), true);
    return;
  }
  const canvas = document.getElementById('game');
  if (canvas === null || !(canvas instanceof HTMLCanvasElement)) {
    hud('runtime error: config_invalid — the page has no canvas#game', true);
    rt.runtime.dispose();
    return;
  }
  const adapter = createSceneAdapter(canvas, { runtime: rt.runtime, snapshot: snapshot as RuntimeSnapshot });
  adapterRef.current = adapter;
  const started = rt.runtime.start();
  if (started.ok === false) {
    hud('runtime error: ' + started.error.code + ' — ' + started.error.message.slice(0, 120), true);
    adapter.dispose();
    rt.runtime.dispose();
    return;
  }
  // The HUD line: the snapshotId and the SELECTED renderer backend (the
  // backend is chosen on the first renderFrame — refresh after the first
  // frames have run).
  const snap = snapshot as RuntimeSnapshot;
  const refresh = (): void => {
    const d = adapter.diagnostics();
    if (d.ok) {
      hud(snap.snapshotId + ' · ' + (d.diagnostics.renderBackend ?? 'no render backend yet'), false);
    }
  };
  refresh();
  setTimeout(refresh, 500);
  setTimeout(refresh, 2000);
}

// Step 1 — the single engine-initiated relative fetch (export.md §5.3/§5.5).
fetch('./snapshot.json')
  .then((r) => {
    if (!r.ok) throw new Error('snapshot fetch failed (HTTP ' + String(r.status) + ')');
    return r.text();
  })
  .then((text) => start(JSON.parse(text)))
  .catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    hud('export error: ' + msg.slice(0, 160), true);
  });