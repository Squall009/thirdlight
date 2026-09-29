/**
 * Tuning values as data in the project model — optional fields
 * appended last in the canonical forms (a document without them keeps its
 * exact bytes), their ranges, and the recorded model bounds travelling from
 * the asset metrics into the captured content view.
 */
import { describe, expect, it } from 'vitest';

import { canonicalController, controllerTuningOf, DEFAULT_CONTROLLER_TUNING } from './components';
import { ENGINE_TIMING_DEFAULTS, validateContentV4 } from './content';
import { captureContentViewV3 } from './manifest-v2';
import { validateSceneV4 } from './scene-v3';

type Obj = Record<string, unknown>;
const SAMPLE = JSON.parse(
  Object.values(import.meta.glob('../../../templates/starter/captured/project.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>)[0] as string,
) as { content: { assets: Obj[] } };
const MODEL = SAMPLE.content.assets.find((a) => a['kind'] === 'model')!;
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function scene(entities: Obj[]): Obj {
  return { schemaVersion: 4, sceneId: 'main', revision: 1, entities: [{ id: 'spawn-0001', components: { transform: T, playerSpawn: {} } }, ...entities] };
}
function content(extra: Obj = {}): Obj {
  return { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, scenes: [{ sceneId: 'main', name: 'Main' }], startScenes: ['main'], ...extra };
}
const withBounds = (bounds: unknown): Obj => {
  const m = JSON.parse(JSON.stringify(MODEL)) as Obj;
  ((m['versions'] as Obj[])[0]!['metrics'] as Obj)['bounds'] = bounds;
  return m;
};

describe('tuning values in the project model (phase 15.3)', () => {
  it('a controller without tuning keeps its canonical bytes; the tuning follows the capsule', () => {
    expect(canonicalController({})).toEqual({});
    expect(JSON.stringify(canonicalController({ capsule: { radius: 0.3, height: 1.8 } }))).toBe('{"capsule":{"radius":0.3,"height":1.8}}');
    expect(Object.keys(canonicalController({ skin: 0.02, capsule: { radius: 0.3, height: 1.8 }, acceleration: 30 }))).toEqual(['capsule', 'acceleration', 'skin']);
    expect(controllerTuningOf(undefined)).toEqual(DEFAULT_CONTROLLER_TUNING);
    expect(controllerTuningOf({ jumpRelease: 1, autostep: true })).toMatchObject({ jumpRelease: 1, autostep: true, acceleration: 40 });
  });

  it('the scene validator keeps the tuning through normalization and refuses out-of-range values', () => {
    const doc = scene([{ id: 'player-0001', components: { transform: T, controller: { coyoteTime: 0.1, autostep: true, autostepHeight: 0.3 } } }]);
    const r = validateSceneV4(doc);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.normalized.entities[1]!.components as Obj)['controller']).toEqual({ coyoteTime: 0.1, autostep: true, autostepHeight: 0.3 });
    for (const bad of [{ skin: 0 }, { acceleration: 0 }, { coyoteTime: 2 }, { autostep: 'yes' }, { jumpRelease: 1.5 }]) {
      expect(validateSceneV4(scene([{ id: 'player-0001', components: { transform: T, controller: bad } }])).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('phase 24.7: the engine timing is a fixed default (no game block carries it)', () => {
    expect(ENGINE_TIMING_DEFAULTS).toEqual({ dropThroughTime: 0.125, settleTime: 0.1 });
    expect(Object.isFrozen(ENGINE_TIMING_DEFAULTS)).toBe(true);
  });

  it('model metrics may record bounds (min <= max, finite); they reach the captured content view', () => {
    expect(validateContentV4(content({ assets: [withBounds({ min: [-1, 0, -1], max: [1, 2, 1] })] })).ok).toBe(true);
    expect(validateContentV4(content({ assets: [withBounds({ min: [1, 0, 0], max: [0, 1, 1] })] })).ok).toBe(false);
    expect(validateContentV4(content({ assets: [withBounds({ min: [0, 0], max: [1, 1, 1] })] })).ok).toBe(false);
    const placed = scene([{ id: 'thing-0001', components: { transform: T, model: { asset: { assetId: MODEL['assetId'] } } } }]);
    const view = captureContentViewV3(placed, content({ assets: [withBounds({ min: [-1, 0, -1], max: [1, 2, 1] })] }), { projectId: 'p', revision: 1 }, [placed]);
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.normalized.assets[0]!.bounds).toEqual({ min: [-1, 0, -1], max: [1, 2, 1] });
    const old = captureContentViewV3(placed, content({ assets: [MODEL] }), { projectId: 'p', revision: 1 }, [placed]);
    expect(old.ok && 'bounds' in old.normalized.assets[0]!).toBe(false);
  });
});
