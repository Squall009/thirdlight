/**
 * Packet-26 tests: WebGL context-loss handling in the M1 scene adapter (the
 * adapter is where a renderer exists, so it is where loss is observed).
 *
 * Node-level with a stub canvas that only exposes the listener surface: this
 * proves the structured `render_context_lost` error, the restore path, and that
 * the adapter owns exactly two context listeners and releases them once.
 * A REAL `webglcontextlost`/`webglcontextrestored` round trip (and any rendered
 * output after restoration) is browser-only and remains UNVERIFIED — see
 * docs/acceptance/evidence-m2/26/manifest.md.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_MODULES,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type Runtime,
  type RuntimeSnapshot,
} from '@thirdlight/runtime';
import { createSceneAdapter } from './index';
import { baseScene, cloneJson, snapshotOf } from './test-scene';

interface StubCanvas {
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  getContext(type: string): null;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  /** Test-side event dispatch. */
  fire(type: string, event?: unknown): void;
  readonly listeners: Map<string, Set<(event: unknown) => void>>;
}

function stubCanvasWithEvents(): StubCanvas {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    listeners,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    getContext: () => null,
    width: 320,
    height: 240,
    clientWidth: 320,
    clientHeight: 240,
    fire(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

function makeRuntime(): { runtime: Runtime; snapshot: RuntimeSnapshot } {
  const registry = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
  const snapshot = snapshotOf(cloneJson(baseScene())) as RuntimeSnapshot;
  const res = instantiateRuntime({ snapshot, registry, driver: { kind: 'manual' }, clock: () => 0 });
  if (!res.ok) throw new Error('instantiate failed');
  res.runtime.start();
  res.runtime.tick(0);
  return { runtime: res.runtime, snapshot };
}

describe('packet 26 — lost WebGL context (adapter, Node-level)', () => {
  it('reports render_context_lost while lost, resumes normally after restore, and prevents the default', () => {
    const { runtime, snapshot } = makeRuntime();
    const canvas = stubCanvasWithEvents();
    const adapter = createSceneAdapter(canvas, { runtime, snapshot });
    // The adapter owns exactly two context listeners on the canvas.
    expect(canvas.listeners.get('webglcontextlost')?.size).toBe(1);
    expect(canvas.listeners.get('webglcontextrestored')?.size).toBe(1);

    const preventDefault = vi.fn();
    canvas.fire('webglcontextlost', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);

    const lost = adapter.renderFrame();
    expect(lost.ok).toBe(false);
    if (!lost.ok) {
      expect(lost.error.code).toBe('render_context_lost');
      expect(lost.error.message.length).toBeLessThanOrEqual(256);
    }
    const shotWhileLost = adapter.captureScreenshot(128);
    expect(shotWhileLost.ok).toBe(false);
    if (!shotWhileLost.ok) expect(shotWhileLost.error.code).toBe('render_context_lost');
    // Diagnostics keep their contract field set (no render backend yet in Node).
    const diagnostics = adapter.diagnostics();
    expect(diagnostics.ok).toBe(true);
    if (diagnostics.ok) expect(diagnostics.diagnostics.renderBackend).toBeNull();

    canvas.fire('webglcontextrestored');
    const after = adapter.renderFrame();
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('render_unsupported'); // Node: still no real WebGL

    expect(adapter.dispose()).toEqual({ ok: true });
    expect(canvas.listeners.get('webglcontextlost')?.size).toBe(0);
    expect(canvas.listeners.get('webglcontextrestored')?.size).toBe(0);
    expect(adapter.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    expect(canvas.listeners.get('webglcontextlost')?.size).toBe(0); // no double release
    runtime.dispose();
  });

  it('keeps the M1 canvas-without-listeners path unchanged (no context listener assumptions)', () => {
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter({ getContext: () => null, width: 10, height: 10 }, { runtime, snapshot });
    const res = adapter.renderFrame();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('render_unsupported');
    adapter.dispose();
    runtime.dispose();
  });

  it('captureScreenshot never requires a network fetch (fetch/XHR/WebSocket stubbed to throw)', () => {
    const throwing = (): never => {
      throw new Error('network access attempted by the adapter');
    };
    vi.stubGlobal('fetch', throwing);
    vi.stubGlobal('XMLHttpRequest', throwing);
    vi.stubGlobal('WebSocket', throwing);
    const { runtime, snapshot } = makeRuntime();
    const adapter = createSceneAdapter(stubCanvasWithEvents(), { runtime, snapshot });
    const shot = adapter.captureScreenshot(256);
    expect(shot.ok).toBe(false);
    if (!shot.ok) expect(shot.error.code).toBe('render_unsupported'); // Node: no WebGL, and no fabricated image
    expect(globalThis.fetch).toBe(throwing);
    adapter.dispose();
    runtime.dispose();
    vi.unstubAllGlobals();
  });
});
