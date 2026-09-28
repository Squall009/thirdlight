/**
 * Packet 49 (phase 24.7: what stays generic of it) — a playable snapshot's
 * shape at instantiate and the run surface after dispose. The M3 session's
 * own cases (run states, the composition table, run commands, setViewport,
 * the effective-frame overrides, the gameplay port, the event ring) went
 * with the game session in phase 24.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, createSimulationRegistry, instantiateRuntime, registerSimulationModule, type RuntimeError } from './index';
import { baseScene, cloneJson, snapshotOf } from './test-helpers';

function registry() {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  return r;
}

function errorOf(snapshot: unknown): RuntimeError | null {
  const res = instantiateRuntime({ snapshot, registry: registry(), driver: { kind: 'manual' } });
  if (res.ok) {
    res.runtime.dispose();
    return null;
  }
  return res.error;
}

describe('a playable snapshot (phase 9.3 / 24)', () => {
  it('only a v3/v4 scene plays; a v1/v2 scene is refused before anything is created', () => {
    for (const schemaVersion of [1, 2]) {
      const scene = { ...cloneJson(baseScene()), schemaVersion } as unknown as { revision: number };
      expect(errorOf(snapshotOf(scene))).toMatchObject({ code: 'snapshot_invalid', reason: 'shape', path: '/scene/schemaVersion' });
    }
    expect(errorOf(snapshotOf(cloneJson(baseScene())))).toBeNull();
  });

  it('the game block is gone: absent or null plays, a block is refused', () => {
    const withGame = (game: unknown): unknown => {
      const s = snapshotOf(cloneJson(baseScene())) as Record<string, unknown>;
      if (game === undefined) delete s['game'];
      else s['game'] = game;
      return s;
    };
    expect(errorOf(withGame(null))).toBeNull();
    expect(errorOf(withGame(undefined))).toBeNull();
    const refused = errorOf(withGame({ configVersion: 2, title: 'Old', playerId: 'box-0001', cameraId: 'cam-main' }));
    expect(refused).toMatchObject({ code: 'snapshot_invalid', reason: 'shape', path: '/game' });
    expect(refused?.message).toContain('removed in phase 24');
  });

  it('dispose releases the run surface (runtime_disposed), and a second dispose says so', () => {
    const res = instantiateRuntime({ snapshot: snapshotOf(cloneJson(baseScene())), registry: registry(), driver: { kind: 'manual' }, clock: () => 0 });
    if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
    const rt = res.runtime;
    expect(rt.start().ok).toBe(true);
    expect(rt.dispose()).toEqual({ ok: true });
    const state = rt.getInterpolatedState();
    expect(!state.ok && state.error.code).toBe('runtime_disposed');
    const diag = rt.getDiagnostics(); // diagnostics work in every state (runtime.md §8)
    expect(diag.ok && diag.diagnostics.state).toBe('disposed');
    expect(rt.queueUiEvent!({ kind: 'restart', doc: '', widget: '', name: '' })).toMatchObject({ ok: false, error: { code: 'runtime_disposed' } });
    expect(rt.dispose()).toEqual({ ok: true, alreadyDisposed: true });
  });
});
