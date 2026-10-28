/**
 * The Lighting window's level edit through the real command path: the editor
 * builds the project's levels, `setEnvironment` validates and stores them, and
 * the adapter's quality control draws from what was stored. Editing a lighting
 * field copies the engine's levels into the project; the copy must not turn
 * the engine's medium scale into an override of the project's own
 * render_scale and dynamic_resolution.
 */
import { describe, expect, it } from 'vitest';

import { applyMutation, createCommandState, type CommandState } from '../packages/commands/src/index';
import { m2EnvelopeV4 } from '../packages/commands/src/test-fixtures';
import type { EnvironmentConfig, SceneV4 } from '../packages/project-model/src/index';
import { levelsWithLighting } from '../packages/editor/src/ui/tools/SceneToolWindows';
import { createQualityControl } from '../packages/three-adapter/src/quality-control';
import { createRenderControl } from '../packages/three-adapter/src/render-control';
import { LodTuning } from '../packages/three-adapter/src/lod-switch';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');

function drawn(env: EnvironmentConfig | undefined, render: { renderScale: number; dynamicResolution: boolean }) {
  const renderControl = createRenderControl(render);
  const q = createQualityControl(
    { renderControl, lodTuning: new LodTuning(), setLightLimits: () => false, reselectLights: () => undefined, setPixelRatioCap: () => undefined, environment: () => null, changed: () => undefined },
    { project: env ?? null },
  );
  q.setDevice({ api: 'webgpu', vendor: 'intel', architecture: 'gen-12lp' });
  return { level: q.level().id, ...renderControl.diagnostics() };
}

describe('lighting levels edited in the Lighting window', () => {
  it('an edited lighting field keeps the project\'s own render scale and dynamic resolution at medium', () => {
    const own = { renderScale: 1, dynamicResolution: false };
    expect(drawn(undefined, own)).toMatchObject({ level: 'medium', renderScale: 1, dynamicResolution: false });
    const levels = levelsWithLighting(undefined, 'medium', { surfaceCacheMiB: 48 });
    expect(levels).toBeDefined();
    const state = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as CommandState<SceneV4>;
    const r = applyMutation(state, { op: 'setEnvironment', projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${'4216d'.padStart(32, '0')}`, args: { environment: { qualityLevels: levels } } });
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    if (!r.ok) return;
    const env = (r.state.content as { environment?: EnvironmentConfig }).environment;
    expect(env?.qualityLevels?.find((l) => l.id === 'medium')).toMatchObject({ surfaceCacheMiB: 48 });
    expect(drawn(env, own)).toMatchObject({ level: 'medium', renderScale: 1, dynamicResolution: false });
    // A project's own scale on a level still sets it over the project's.
    const scaled = env?.qualityLevels?.map((l) => (l.id === 'medium' ? { ...l, renderScale: 0.5 } : l));
    expect(drawn({ ...env, qualityLevels: scaled }, own)).toMatchObject({ renderScale: 0.5 });
  });
});
