/**
 * Packet 52 — the M3 light/shadow/surface realization in `createSceneAdapter`
 * (presentation.md §§41.1/41.2; Node unit/mock-level per the packet-08
 * pattern: a STUB canvas, no GPU. The realized THREE light nodes, the real
 * WebGL-2 gate and the first-render probe are exercised in the browser
 * (`tests/browser/m3-render/`) — UNVERIFIED in this container. What IS
 * proved here: the construction-time shadow decision and the diagnostics
 * fields (the §41.1.4 bounded record), the M1 path staying `off` /
 * `cast_shadow_false`, the structured (never-throw) render failures, the
 * `animation_role_unresolved` code-set registration, and repeated
 * create/dispose.
 */
import { describe, expect, it } from 'vitest';
import type { Runtime, RuntimeSnapshot } from '@thirdlight/runtime';
import { createSceneAdapter, ERROR_CODES, SHADOW_PROFILE, SURFACE_PRESETS } from './index';

/** A stub canvas: the structural surface, no real context. */
function stubCanvas(): Record<string, unknown> {
  return { getContext: () => null, width: 640, height: 480, clientWidth: 640, clientHeight: 480 };
}

/** The adapter only calls `getInterpolatedState` on a successful render —
 * unreachable with the stub canvas (the context attempt fails first) — so a
 * structural fake keeps these construction/decision tests focused. */
function fakeRuntime(): Runtime {
  return {
    getInterpolatedState: () => ({ ok: true, state: { transforms: [] } }),
    dispose: () => undefined,
  } as unknown as Runtime;
}

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const LEVEL = { minX: 0, maxX: 48, minY: -4, maxY: 8 };
const LEVEL_WIDE = { minX: 0, maxX: 200, minY: -4, maxY: 8 };

function v3Snapshot(opts: {
  key?: { castShadow: boolean };
  level?: { minX: number; maxX: number; minY: number; maxY: number };
  withLights?: boolean;
  withSurfaceBox?: boolean;
}): RuntimeSnapshot {
  // The structural v3 document (the runtime-validated shape) — built
  // untyped and cast once, so the structural components (`light`,
  // `surface`) are not excess-property-checked against the v1/v2 union
  // members. The adapter reads it structurally; it never re-validates.
  const entities: unknown[] = [
    {
      id: 'cam-main',
      name: 'Gameplay camera',
      components: { transform: { ...T }, camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 } },
    },
  ];
  if (opts.withLights !== false) {
    entities.push(
      {
        id: 'light-key',
        components: {
          transform: { ...T },
          light: {
            type: 'directional',
            color: '#fff4e0',
            intensity: 2.2,
            direction: [0.5, -1, -0.6],
            castShadow: opts.key?.castShadow ?? true,
          },
        },
      },
      {
        id: 'light-fill',
        components: { transform: { ...T }, light: { type: 'ambient', color: '#8899bb', intensity: 0.55 } },
      },
    );
  }
  if (opts.withSurfaceBox !== false) {
    entities.push(
      {
        id: 'box-hazard',
        components: {
          transform: { ...T },
          box: { size: [1, 1, 1], material: { color: '#6f6f6f' } },
          surface: { color: '#d42a1e', roughness: 0.55, metalness: 0, emissive: '#3a0703', emissiveIntensity: 0.35 },
        },
      },
      {
        id: 'box-plain',
        components: { transform: { ...T }, box: { size: [1, 1, 1], material: { color: '#6f6f6f' } } },
      },
    );
  }
  return {
    snapshotId: 'demo-52@r1',
    projectId: 'demo-52',
    revision: 1,
    scene: { schemaVersion: 3, sceneId: 'scene-main', revision: 1, entities },
    game: {
      configVersion: 1,
      title: 't',
      objective: 'o',
      instructions: 'i',
      playerId: 'box-plain',
      cameraId: 'cam-main',
      spawnId: 'cam-main',
      level: opts.level ?? LEVEL,
      killY: -4,
      cues: { start: null, jump: null, checkpoint: null, death: null, goal: null },
    },
  } as unknown as RuntimeSnapshot;
}

describe('packet 52 — the M3 shadow decision + diagnostics in createSceneAdapter', () => {
  it('v3 with a shadow-casting key light and in-bounds level ⇒ planned `on` (no reason field)', () => {
    const adapter = createSceneAdapter(stubCanvas(), { runtime: fakeRuntime(), snapshot: v3Snapshot({}) });
    const res = adapter.diagnostics();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = res.diagnostics;
    expect(d.shadows).toBe('on');
    expect('shadowReason' in d).toBe(false); // present iff off
    expect(d.renderBackend).toBeNull(); // no render yet (stub canvas)
    adapter.dispose();
  });

  it("v3 with the author's castShadow: false ⇒ off / cast_shadow_false (not an error)", () => {
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime(),
      snapshot: v3Snapshot({ key: { castShadow: false } }),
    });
    const res = adapter.diagnostics();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diagnostics.shadows).toBe('off');
    expect(res.diagnostics.shadowReason).toBe('cast_shadow_false');
    adapter.dispose();
  });

  it('v3 with the level too wide (halfExtent 102 > 64) ⇒ off / shadow_bounds_exceeded', () => {
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime(),
      snapshot: v3Snapshot({ level: LEVEL_WIDE }),
    });
    const res = adapter.diagnostics();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diagnostics.shadows).toBe('off');
    expect(res.diagnostics.shadowReason).toBe('shadow_bounds_exceeded');
    adapter.dispose();
  });

  it('v3 with no authored lights ⇒ off / cast_shadow_false (the M1 pair is v1/v2 only)', () => {
    const adapter = createSceneAdapter(stubCanvas(), {
      runtime: fakeRuntime(),
      snapshot: v3Snapshot({ withLights: false }),
    });
    const res = adapter.diagnostics();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diagnostics.shadows).toBe('off');
    expect(res.diagnostics.shadowReason).toBe('cast_shadow_false');
    adapter.dispose();
  });

  it('the planned state survives a failed render (the probe flips `on` ⇒ off only on a real renderer)', () => {
    const adapter = createSceneAdapter(stubCanvas(), { runtime: fakeRuntime(), snapshot: v3Snapshot({}) });
    const first = adapter.renderFrame();
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe('render_unsupported');
    const d = adapter.diagnostics();
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.diagnostics.shadows).toBe('on'); // no renderer ⇒ no probe ⇒ still planned
      expect(d.diagnostics.renderBackend).toBeNull();
    }
    adapter.dispose();
  });
});

describe('packet 52 — the §41.7.2 D code-set registration + the public surface', () => {
  it('ERROR_CODES carries animation_role_unresolved (registered in 52; raised by 53)', () => {
    expect(ERROR_CODES).toContain('animation_role_unresolved');
  });

  it('the lighting surface is exported from the root subpath (loader-free, unchanged graph)', () => {
    expect(SHADOW_PROFILE.mapSize).toBe(512);
    expect(SHADOW_PROFILE.type).toBe('PCFShadowMap');
    expect(SURFACE_PRESETS.hazard.color).toBe('#d42a1e');
    expect(SURFACE_PRESETS.beacon.emissiveIntensity).toBe(1.2);
  });
});

describe('packet 52 — repeated create/dispose (the B11 ownership checklist half)', () => {
  it('five create/dispose cycles over v3 scenes: idempotent, no throw, diagnostics stay coherent', () => {
    for (let i = 0; i < 5; i += 1) {
      const adapter = createSceneAdapter(stubCanvas(), { runtime: fakeRuntime(), snapshot: v3Snapshot({}) });
      expect(adapter.dispose().ok).toBe(true);
      expect(adapter.dispose()).toEqual({ ok: true, alreadyDisposed: true });
      const render = adapter.renderFrame();
      expect(render.ok).toBe(false);
      if (!render.ok) expect(render.error.code).toBe('adapter_disposed');
      const d = adapter.diagnostics();
      expect(d.ok).toBe(true); // reports the last known state after dispose
      if (d.ok) expect(d.diagnostics.shadows).toBe('on');
    }
  });
});