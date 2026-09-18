/**
 * Scene-adapter surface tests (packet 08; dependencies.md §3 row).
 *
 * UNIT/MOCK-LEVEL — labeled per AGENTS.md ("mocks alone do not establish
 * integration success"): these run in Node with a STUB canvas (no GPU,
 * no real HTMLCanvasElement). They prove the public surface shape, the
 * structured (never-throw) error paths, the diagnostics shape including
 * the non-browser ABSENT backend value (`renderBackend: null` — the
 * reporting PATH is proved, not the browser backend), and dispose
 * idempotency. Rendering, the actual WebGL backend, and visual
 * camera/axes/motion remain UNVERIFIED unless the packet 08 browser
 * step succeeds (see docs/handoffs/08.md).
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODULES,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
} from '@thirdlight/runtime';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import { baseScene, cloneJson, snapshotOf } from './test-scene';
import { createSceneAdapter, ERROR_CODES } from './index';

/** A stub canvas: exposes the structural surface, no real context. */
function stubCanvas(): Record<string, unknown> {
  return {
    getContext: () => null,
    width: 640,
    height: 480,
    clientWidth: 640,
    clientHeight: 480,
  };
}

function makeRuntime(): { runtime: Runtime; snapshot: RuntimeSnapshot } {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  const snapshot = snapshotOf(cloneJson(baseScene())) as RuntimeSnapshot;
  const res = instantiateRuntime({
    snapshot,
    registry: r,
    driver: { kind: 'manual' },
    clock: () => 0,
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  res.runtime.start();
  res.runtime.tick(0); // anchor frame
  return { runtime: res.runtime, snapshot };
}

describe('scene adapter surface (packet 08; Node unit/mock-level)', () => {
  it('exports the contract surface: createSceneAdapter, ERROR_CODES, and the four adapter members', () => {
    expect(typeof createSceneAdapter).toBe('function');
    expect(Array.isArray(ERROR_CODES)).toBe(true);
    expect(ERROR_CODES.length).toBeGreaterThan(0);
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter(stubCanvas(), { runtime, snapshot });
    expect(typeof adapter.renderFrame).toBe('function');
    expect(typeof adapter.captureScreenshot).toBe('function');
    expect(typeof adapter.diagnostics).toBe('function');
    expect(typeof adapter.dispose).toBe('function');
    // createSceneAdapter never throws (even with a null canvas).
    const weird = createSceneAdapter(null, { runtime, snapshot });
    expect(typeof weird.renderFrame).toBe('function');
    adapter.dispose();
    weird.dispose();
    runtime.dispose();
  });

  it('diagnostics in Node report the ABSENT backend (null) with the §8 field set', () => {
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter(stubCanvas(), { runtime, snapshot });
    const res = adapter.diagnostics();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = res.diagnostics;
    expect(Object.keys(d).sort()).toEqual(['canvasSize', 'pixelRatio', 'renderBackend', 'rendererInfo']);
    expect(d.renderBackend).toBeNull(); // no successful render yet (non-browser absent value)
    expect(d.rendererInfo).toBeNull();
    expect(d.canvasSize).toEqual([640, 480]);
    expect(typeof d.pixelRatio).toBe('number');
    expect(d.pixelRatio).toBe(1); // Node: no window.devicePixelRatio
    adapter.dispose();
    runtime.dispose();
  });

  it('renderFrame without a WebGL context ⇒ structured render_unsupported (never throws)', () => {
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter(stubCanvas(), { runtime, snapshot });
    const res = adapter.renderFrame();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('render_unsupported');
      expect(res.error.message.length).toBeLessThanOrEqual(256);
      expect(ERROR_CODES).toContain(res.error.code);
    }
    // The failure is sticky (no repeated context attempts), and the
    // backend in diagnostics stays the absent value.
    const again = adapter.renderFrame();
    expect(again.ok).toBe(false);
    const d = adapter.diagnostics();
    if (d.ok) expect(d.diagnostics.renderBackend).toBeNull();
    adapter.dispose();
    runtime.dispose();
  });

  it('captureScreenshot without a WebGL context ⇒ structured error (no fabricated image)', () => {
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter(stubCanvas(), { runtime, snapshot });
    const res = adapter.captureScreenshot(512);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('render_unsupported');
    }
    adapter.dispose();
    runtime.dispose();
  });

  it('captureScreenshot validates maxWidth BEFORE any render attempt (structured error, no side effects)', () => {
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter(stubCanvas(), { runtime, snapshot });
    for (const bad of [0, -5, NaN, 1.5, '1024' as unknown as number]) {
      const res = adapter.captureScreenshot(bad);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        // Observed in Node where the render itself would be
        // render_unsupported: the argument error must win (fail-fast,
        // no render side effects).
        expect(res.error.code).toBe('screenshot_failed');
        expect(res.error.message.length).toBeLessThanOrEqual(256);
      }
    }
    adapter.dispose();
    runtime.dispose();
  });

  it('a canvas without getContext ⇒ canvas_invalid', () => {
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter({ width: 10, height: 10 }, { runtime, snapshot });
    const res = adapter.renderFrame();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('canvas_invalid');
    }
    adapter.dispose();
    runtime.dispose();
  });

  it('dispose is idempotent and subsequent render/capture ⇒ adapter_disposed; diagnostics still works', () => {
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter(stubCanvas(), { runtime, snapshot });
    expect(adapter.dispose().ok).toBe(true);
    const again = adapter.dispose();
    expect(again).toEqual({ ok: true, alreadyDisposed: true });
    const render = adapter.renderFrame();
    expect(render.ok).toBe(false);
    if (!render.ok) expect(render.error.code).toBe('adapter_disposed');
    const shot = adapter.captureScreenshot();
    expect(shot.ok).toBe(false);
    if (!shot.ok) expect(shot.error.code).toBe('adapter_disposed');
    const d = adapter.diagnostics();
    expect(d.ok).toBe(true); // reports the last known (absent) state
    if (d.ok) expect(d.diagnostics.renderBackend).toBeNull();
    runtime.dispose();
  });

  it('renderFrame reports a structured error when the runtime is disposed (no throw, no render)', () => {
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter(stubCanvas(), { runtime, snapshot });
    runtime.dispose();
    // The context attempt happens first in Node (structured
    // render_unsupported) — the key property is: never throws, never
    // renders. In a browser (context available) the runtime-state
    // failure would surface as render_failed.
    const res = adapter.renderFrame();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(ERROR_CODES).toContain(res.error.code);
    }
    adapter.dispose();
  });
});