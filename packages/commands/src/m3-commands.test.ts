/**
 * Packet 45 — implementation-level tests for the pure v3 presentation
 * command surface (commands.md §§2/3.1/5.3/5.4/8.5.1/8.10/8.13–8.14).
 *
 * Covers: creation of the add-capable component kinds, component removal,
 * invalid reimport role/kind, no-change, exact inverse and redo IDs, stale
 * request ordering, failed-atomic-edit (no partial write), mixed UI/MCP
 * history, copied surface presets staying independent, the reusable
 * `queryEntities` component filter and the v3 content summary, and immutable
 * inputs.
 */

import { describe, expect, it } from 'vitest';
import { SURFACE_PRESETS, type SceneV3 } from '@thirdlight/project-model';

import {
  applyMutation,
  contentCounts,
  filterEntitiesByComponent,
  queryGameConfig,
  createCommandState,
  ERROR_CODES,
} from './index';
import type { CommandState, ContentDocument, MutationSuccess } from './index';
import { m3NeutralJson } from './test-fixtures';

interface EnvelopeFixture {
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}

const BEFORE = m3NeutralJson<EnvelopeFixture>('commands/scenario.before.json');
const AFTER = m3NeutralJson<EnvelopeFixture>('commands/scenario.after.json');
const MEDIA = m3NeutralJson<EnvelopeFixture>('envelope/valid/demo-0003-media-v3.json');

type State = CommandState<SceneV3>;

function stateOf(env: EnvelopeFixture): State {
  return createCommandState(
    structuredClone(env.scene),
    structuredClone(env.content) as unknown as ContentDocument,
  ) as unknown as State;
}

let counter = 0;
function req(
  op: string,
  args: Record<string, unknown>,
  expectedRevision: number,
  origin?: { kind: 'browser' | 'mcp'; clientId: string },
): unknown {
  counter += 1;
  return {
    op,
    projectId: BEFORE.projectId,
    expectedRevision,
    requestId: `req-${counter.toString(16).padStart(32, '0')}`,
    ...(origin === undefined ? {} : { origin }),
    args,
  };
}

function ok(outcome: ReturnType<typeof applyMutation>): MutationSuccess {
  if (!outcome.ok) throw new Error(`expected success, got ${JSON.stringify(outcome.result)}`);
  return outcome.result;
}

function fail(outcome: ReturnType<typeof applyMutation>): string {
  if (outcome.ok) throw new Error(`expected failure, got ${JSON.stringify(outcome.result)}`);
  return outcome.result.error.code;
}

/** Apply a request that must succeed and return the new state. */
function nextState(state: State, request: unknown): State {
  const outcome = applyMutation(state, request);
  if (!outcome.ok) throw new Error(`expected success, got ${JSON.stringify(outcome.result)}`);
  return outcome.state as State;
}

describe('createEntity with v3 components (authoring §A3.1/§A4.1)', () => {
  it('creates each add-capable component kind with the derived ID prefix', () => {
    const cases: Array<{ components: Record<string, unknown>; kind: string; id: string }> = [
      { kind: 'group', components: { playerSpawn: {} }, id: 'spawn-0002' },
      { kind: 'group', components: { light: { type: 'directional', color: '#ffffff', intensity: 1, direction: [0, -1, 0] } }, id: 'light-0001' },
      { kind: 'box', components: { collider: { shape: { type: 'box', hx: 1, hy: 1 } } }, id: 'box-0002' },
    ];
    for (const c of cases) {
      const state = stateOf(BEFORE);
      const result = ok(applyMutation(state, req('createEntity', { kind: c.kind, transform: { position: [1, 1, 0] }, components: c.components }, 0)));
      expect(result.createdId, JSON.stringify(c.components)).toBe(c.id);
      expect(result.change.type).toBe('createEntity');
      if (result.change.type === 'createEntity') {
        expect(Object.keys(result.change.entity.components)).toEqual(
          expect.arrayContaining(Object.keys(c.components)),
        );
      }
    }
  });

  it('copies a surface preset on create', () => {
    const preset = ok(
      applyMutation(stateOf(BEFORE), req('createEntity', { kind: 'box', surfacePreset: 'signal-red' }, 0)),
    );
    expect(preset.change.type).toBe('createEntity');
    if (preset.change.type === 'createEntity') {
      expect((preset.change.entity.components as unknown as Record<string, unknown>)['surface']).toEqual(SURFACE_PRESETS['signal-red']);
    }
  });

  it('phase 25.6: a component only setComponent adds is refused with how to add it, not as unknown', () => {
    const refusal = (components: Record<string, unknown>): { code: string; message: string } => {
      const r = applyMutation(stateOf(BEFORE), req('createEntity', { kind: 'group', components }, 0));
      expect(r.ok).toBe(false);
      return r.ok ? { code: '', message: '' } : { code: r.result.error.code, message: r.result.error.message };
    };
    expect(refusal({ nope: {} }).message).toBe('unknown component name (the registry is closed)');
    const path = refusal({ cameraPath: { points: [[0, 0, 0], [1, 0, 0]] } });
    expect(path.code).toBe('component_unknown');
    expect(path.message).toBe('"cameraPath" cannot be added by createEntity: create the entity, then add it with setComponent');
    expect(refusal({ materialParams: {} }).message).toContain('then add it with setComponent');
    expect(refusal({ box: {} }).message).toBe('"box" is not added through components: createEntity makes it from kind "box" and its box argument (or add it afterwards with setComponent)');
  });

  it('rejects unknown keys, nullable values, preset/surface coexistence and illegal targets', () => {
    expect(fail(applyMutation(stateOf(BEFORE), req('createEntity', { kind: 'group', components: { nope: {} } }, 0)))).toBe('component_unknown');
    expect(fail(applyMutation(stateOf(BEFORE), req('createEntity', { kind: 'group', components: { light: null } }, 0)))).toBe('field_value');
    expect(fail(applyMutation(stateOf(BEFORE), req('createEntity', { kind: 'box', surfacePreset: 'signal-red', components: { surface: { color: '#ffffff' } } }, 0)))).toBe('field_value');
    // A second controller is refused by the composition rule.
    const second = applyMutation(stateOf(BEFORE), req('createEntity', { kind: 'group', components: { controller: {} } }, 0));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.result.error.code).toBe('controller_count_invalid');
  });
});

describe('v3 setComponent add/edit/remove and reference safety', () => {
  it('adds and edits a directional light and a surface', () => {
    const added = ok(
      applyMutation(
        stateOf(BEFORE),
        req('setComponent', { entityId: 'group-0001', component: 'light', value: { type: 'ambient', color: '#404860', intensity: 0.6 } }, 0),
      ),
    );
    expect(added.change).toMatchObject({ type: 'setComponent', id: 'group-0001', component: 'light', previous: null });
    const surface = ok(
      applyMutation(stateOf(BEFORE), req('setComponent', { entityId: 'box-0001', component: 'surface', value: { color: '#112233' } }, 0)),
    );
    expect(surface.change).toMatchObject({ type: 'setComponent', component: 'surface', previous: null });
    if (surface.change.type === 'setComponent') {
      expect(surface.change.next).toMatchObject({ color: '#112233' });
      expect((surface.change.next as { roughness: number }).roughness).toBeTypeOf('number');
      expect(surface.change.changedFields).toEqual(['color']);
    }
  });

  it('removes add-capable components and audits conflicting fields', () => {
    // Removing a spawn nothing references is legal.
    const removed = ok(applyMutation(stateOf(AFTER), req('setComponent', { entityId: 'spawn-0002', component: 'playerSpawn', value: null }, 7)));
    expect(removed.change).toMatchObject({ type: 'setComponent', id: 'spawn-0002', component: 'playerSpawn', next: null });
    // An ambient light may not carry `direction` (model value rule): add one,
    // then try to add the forbidden field in a second edit.
    const ambientState = nextState(stateOf(BEFORE), req('setComponent', { entityId: 'group-0001', component: 'light', value: { type: 'ambient', color: '#404860', intensity: 0.6 } }, 0));
    const bad = applyMutation(ambientState, req('setComponent', { entityId: 'group-0001', component: 'light', value: { direction: [0, -1, 0] } }, 1));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.result.error.code).toBe('field_value');
  });

  it('validates the animation role stages against the named version', () => {
    const media: State = stateOf(MEDIA);
    const outOfRange = applyMutation(
      media,
      req('setComponent', { entityId: 'model-0001', component: 'modelAnimation', value: { roles: { idle: { clipIndex: 9, clipName: 'x' }, run: { clipIndex: 1, clipName: 'r' }, airborne: { clipIndex: 2, clipName: 'a' } } } }, 5),
    );
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.result.error.code).toBe('animation_role_out_of_range');
    const duplicate = applyMutation(
      stateOf(MEDIA),
      req('setComponent', { entityId: 'model-0001', component: 'modelAnimation', value: { roles: { idle: { clipIndex: 0, clipName: 'i' }, run: { clipIndex: 0, clipName: 'r' }, airborne: { clipIndex: 2, clipName: 'a' } } } }, 5),
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.result.error.code).toBe('animation_role_duplicate');
    const missing = applyMutation(
      stateOf(MEDIA),
      req('setComponent', { entityId: 'model-0001', component: 'modelAnimation', value: { roles: { idle: { clipIndex: 0, clipName: 'i' }, run: { clipIndex: 1, clipName: 'r' } } } }, 5),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.result.error.code).toBe('field_missing');
  });
});

describe('applySurfacePreset (commands.md §8.13)', () => {
  it('copies the frozen row, keeps copies independent and re-applies the recorded value on redo', () => {
    let state = stateOf(BEFORE);
    const applied = ok(applyMutation(state, req('applySurfacePreset', { entityId: 'box-0001', preset: 'signal-red' }, 0)));
    expect(applied.change).toEqual({
      type: 'applySurfacePreset',
      id: 'box-0001',
      preset: 'signal-red',
      previous: null,
      next: SURFACE_PRESETS['signal-red'],
      changedFields: ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'],
    });
    state = nextState(state, req('applySurfacePreset', { entityId: 'box-0001', preset: 'signal-red' }, 0));
    // A second entity's copy is independent.
    const second = ok(applyMutation(state, req('createEntity', { kind: 'box', surfacePreset: 'emissive-accent' }, 1)));
    if (second.change.type === 'createEntity') {
      expect((second.change.entity.components as unknown as Record<string, unknown>)['surface']).toEqual(SURFACE_PRESETS['emissive-accent']);
    }
    // Editing one entity's surface leaves the other and the constant untouched.
    const afterCreate = nextState(state, req('createEntity', { kind: 'box', surfacePreset: 'emissive-accent' }, 1));
    const edited = applyMutation(afterCreate, req('setComponent', { entityId: second.createdId as string, component: 'surface', value: { color: '#000001' } }, 2));
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error('unreachable');
    const entities = (edited.state as State).scene.entities as unknown as {
      id: string;
      components: Record<string, unknown>;
    }[];
    const first = entities.find((e) => e.id === 'box-0001')!.components['surface'];
    expect(first).toEqual(SURFACE_PRESETS['signal-red']);
    expect(SURFACE_PRESETS['signal-red'].color).toBe('#d42a1e');
    // Undo/redo round-trip with the exact inverse.
    const undo = ok(applyMutation(state, req('undo', {}, 1)));
    expect(undo.change).toMatchObject({ type: 'setComponent', component: 'surface', next: null });
    const redo = ok(applyMutation(nextState(state, req('undo', {}, 1)), req('redo', {}, 2)));
    expect(redo.change).toMatchObject({ type: 'applySurfacePreset', next: SURFACE_PRESETS['signal-red'] });
    expect(fail(applyMutation(stateOf(BEFORE), req('applySurfacePreset', { entityId: 'group-0001', preset: 'signal-red' }, 0)))).toBe('component_missing');
    expect(fail(applyMutation(stateOf(BEFORE), req('applySurfacePreset', { entityId: 'box-0001', preset: 'nope' }, 0)))).toBe('field_value');
  });
});

describe('queryGameConfig and the content counts (commands.md §A6)', () => {
  it('queryGameConfig reports the tags (no game block); the counts report spawns and audio assets', () => {
    const state = stateOf(AFTER);
    const q = queryGameConfig(state, { op: 'queryGameConfig', projectId: BEFORE.projectId, args: {} });
    expect(q.ok).toBe(true);
    if (q.ok) {
      expect(q.tags).toEqual([]);
      expect(q.revision).toBe(7);
      expect('game' in q).toBe(false);
    }
    expect(contentCounts(state)).toEqual({ assets: 0, prefabs: 0, behaviors: 0, settingsKeys: 0, audioAssets: 0, spawns: 2 });
  });
});

describe('publishAsset kind and reimport rules (commands.md §3.1.1/§8.5)', () => {
  // presentation.md §41.4.3 (packet 47, CC-44-2): the real `pcm-wav` recipe and
  // `PcmWavMetrics` member (96 frames of the committed cue-start preimage). The
  // packet-41 placeholder shape (`recipeVersion: 0`, empty toolchain, GLB
  // metrics) is refused by the promoted §18.5/§18.6 audio rules.
  const AUDIO_RECIPE = { profile: 'pcm-wav', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } };
  const MODEL_RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
  const AUDIO_METRICS = { container: 'riff-wave', encoding: 'pcm-s16le', channels: 1, sampleRate: 48000, bitsPerSample: 16, frames: 96, durationMs: 2, pcmBytes: 192, dataChunkBytes: 192, riffChunkBytes: 228 };
  const MODEL_METRICS = { nodes: 0, meshes: 0, primitives: 0, materials: 0, images: 0, textures: 0, vertices: 0, triangles: 0, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 0, decodedImageBytes: 0 };

  it('creates an audio record and rejects a kind change on reimport', () => {
    const base = stateOf(BEFORE);
    const created = ok(
      applyMutation(
        base,
        req('publishAsset', { mode: 'create', assetId: 'asset-audio-1', kind: 'audio', sourceDigest: 'a'.repeat(64), sourceByteLength: 236, importRecipe: AUDIO_RECIPE, metrics: AUDIO_METRICS, importedAt: '2026-09-19T00:00:00Z' }, 0),
      ),
    );
    const record = created.change.type === 'publishAsset' ? created.change.next : null;
    expect(record?.kind).toBe('audio');
    const withAudio = nextState(base, req('publishAsset', { mode: 'create', assetId: 'asset-audio-1', kind: 'audio', sourceDigest: 'a'.repeat(64), sourceByteLength: 236, importRecipe: AUDIO_RECIPE, metrics: AUDIO_METRICS, importedAt: '2026-09-19T00:00:00Z' }, 0));
    const mismatch = applyMutation(withAudio, req('publishAsset', { mode: 'reimport', assetId: 'asset-audio-1', kind: 'model', sourceDigest: 'b'.repeat(64), sourceByteLength: 236, importRecipe: AUDIO_RECIPE, metrics: AUDIO_METRICS, importedAt: '2026-09-19T00:00:00Z' }, 1));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.result.error.code).toBe('asset_kind_mismatch');
      expect(mismatch.result.error.assetId).toBe('asset-audio-1');
    }
    // A v3 create omitting the kind is refused.
    expect(fail(applyMutation(stateOf(BEFORE), req('publishAsset', { mode: 'create', assetId: 'asset-x', sourceDigest: 'a'.repeat(64), sourceByteLength: 1, importRecipe: AUDIO_RECIPE, metrics: AUDIO_METRICS, importedAt: '2026-09-19T00:00:00Z' }, 0)))).toBe('field_missing');
    expect(contentCounts(withAudio).audioAssets).toBe(1);
  });

  it('requires and atomically applies the version-local role mapping on reimport', () => {
    const roles = {
      idle: { clipIndex: 0, clipName: 'idle' },
      run: { clipIndex: 1, clipName: 'run' },
      airborne: { clipIndex: 2, clipName: 'jump' },
    };
    const REIMPORT: Record<string, unknown> = { mode: 'reimport', assetId: 'asset-model-courier', kind: 'model', sourceDigest: 'c'.repeat(64), sourceByteLength: 4096, importRecipe: MODEL_RECIPE, metrics: { ...MODEL_METRICS, animations: 3 }, importedAt: '2026-09-19T00:00:00Z' };
    const entityComponent = (state: State, id: string): { version?: number; roles?: unknown } =>
      (state.scene as unknown as { entities: Array<{ id: string; components: Record<string, unknown> }> }).entities
        .find((e) => e.id === id)!.components.modelAnimation as { version?: number; roles?: unknown };
    const absent = applyMutation(
      stateOf(MEDIA),
      req('publishAsset', REIMPORT, 5),
    );
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.result.error.code).toBe('field_missing');
    const applied = ok(
      applyMutation(
        stateOf(MEDIA),
        req('publishAsset', { ...REIMPORT, animation: { entityId: 'model-0001', roles } }, 5),
      ),
    );
    // CC-L-1 (Gate L): the change carries the FULL `modelAnimation` component
    // in both directions — `version` advances to the newly appended version
    // together with the new mapping (the binding is owned by that
    // (assetId, version); a roles-only change would leave the entity
    // recording the old version and capture would keep delivering the
    // previous bytes — a silent no-op success, project-model §19.2).
    expect(applied.change).toMatchObject({
      type: 'publishAsset',
      mode: 'reimport',
      animation: {
        entityId: 'model-0001',
        previous: { assetId: 'asset-model-courier', version: 1 },
        next: { assetId: 'asset-model-courier', version: 2, roles },
      },
    });
    // One revision, one history entry; undo restores BOTH the record and the
    // full component.
    expect(applied.history).toEqual({ undoDepth: 1, redoDepth: 0 });
    const appliedState = nextState(
      stateOf(MEDIA),
      req('publishAsset', { ...REIMPORT, animation: { entityId: 'model-0001', roles } }, 5),
    );
    // Regression (CC-L-1): the entity's recorded version advanced to the
    // asset's new currentVersion — the reimported bytes are now what capture
    // resolves the entity to.
    expect(entityComponent(appliedState, 'model-0001').version).toBe(2);
    expect(entityComponent(appliedState, 'model-0001').roles).toEqual(roles);
    expect(appliedState.content?.assets.find((a) => a.assetId === 'asset-model-courier')?.currentVersion).toBe(2);
    const undone = ok(applyMutation(appliedState, req('undo', {}, 6)));
    expect(undone.change.type).toBe('publishAsset');
    // Undo restores the previous record and the FULL previous component in
    // the same entry, and moves both or neither.
    if (undone.change.type === 'publishAsset') {
      expect(undone.change.next?.currentVersion).toBe(1);
      // The undo direction swaps the recorded full components: `next` is the
      // OLD component (version 1 + the placeholder roles).
      expect(undone.change.animation?.entityId).toBe('model-0001');
      expect(undone.change.animation?.next).toMatchObject({
        assetId: 'asset-model-courier',
        version: 1,
        roles: { idle: { binding: 'packet-41-placeholder' } },
      });
      expect(undone.change.animation?.previous).toEqual({ assetId: 'asset-model-courier', version: 2, roles });
    }
    const undoneState = nextState(appliedState, req('undo', {}, 6));
    expect(undoneState.content?.assets.some((a) => a.assetId === 'asset-model-courier' && a.currentVersion === 1)).toBe(true);
    // Regression (CC-L-1): the entity's component is the FULL previous
    // component — version 1 is a valid binding against the rolled-back
    // record (1 ≤ version ≤ currentVersion, project-model §23.3.6); a
    // roles-only restore would have left version 2 recorded above a
    // currentVersion 1 (an invalid binding).
    expect(entityComponent(undoneState, 'model-0001').version).toBe(1);
    expect(entityComponent(undoneState, 'model-0001').roles).toEqual({
      idle: { binding: 'packet-41-placeholder' },
      run: { binding: 'packet-41-placeholder' },
      airborne: { binding: 'packet-41-placeholder' },
    });
    // Redo re-applies the recorded FULL next component (recorded-value rule,
    // commands.md §9.1): version and roles together.
    const redoneState = nextState(undoneState, req('redo', {}, 7));
    expect(entityComponent(redoneState, 'model-0001').version).toBe(2);
    expect(entityComponent(redoneState, 'model-0001').roles).toEqual(roles);
    // An out-of-range role is refused before any write.
    const badRole = applyMutation(
      stateOf(MEDIA),
      req('publishAsset', { ...REIMPORT, animation: { entityId: 'model-0001', roles: { ...roles, idle: { clipIndex: 7, clipName: 'i' } } } }, 5),
    );
    expect(badRole.ok).toBe(false);
    if (!badRole.ok) expect(badRole.result.error.code).toBe('animation_role_out_of_range');
  });
});

describe('engine invariants (packet 45)', () => {
  it('orders the stale revision check before argument validation', () => {
    const state = stateOf(AFTER);
    const stale = applyMutation(state, req('setComponent', { entityId: 'nope', component: 'nope', value: 1 }, 3));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.result.error.code).toBe('revision_conflict');
    // With the matching revision the target's component rules are reported.
    expect(fail(applyMutation(state, req('setComponent', { entityId: 'nope', component: 'surface', value: { color: '#ffffff' } }, 7)))).toBe('entity_not_found');
    expect(fail(applyMutation(state, req('setComponent', { entityId: 'group-0001', component: 'surface', value: { color: '#ffffff' } }, 7)))).toBe('component_missing');
  });

  it('leaves the state untouched on a failed atomic edit', () => {
    const state = stateOf(AFTER);
    const sceneBefore = JSON.stringify(state.scene);
    const contentBefore = JSON.stringify(state.content);
    const depthsBefore = JSON.stringify(state.history);
    expect(fail(applyMutation(state, req('applySurfacePreset', { entityId: 'nope', preset: 'signal-red' }, 7)))).toBe('entity_not_found');
    expect(fail(applyMutation(state, req('setComponent', { entityId: 'box-0001', component: 'surface', value: { color: 'not-a-colour' } }, 7)))).toBe('field_value');
    expect(JSON.stringify(state.scene)).toBe(sceneBefore);
    expect(JSON.stringify(state.content)).toBe(contentBefore);
    expect(JSON.stringify(state.history)).toBe(depthsBefore);
  });

  it('records mixed browser/MCP origins and reports the applied origin', () => {
    let state = stateOf(BEFORE);
    state = nextState(state, req('applySurfacePreset', { entityId: 'box-0001', preset: 'signal-red' }, 0, { kind: 'browser', clientId: 'browser-1' }));
    const mcp = applyMutation(state, req('setComponent', { entityId: 'group-0001', component: 'light', value: { type: 'ambient', color: '#404860', intensity: 0.6 } }, 1, { kind: 'mcp', clientId: 'mcp-1' }));
    if (!mcp.ok) throw new Error(`expected success, got ${JSON.stringify(mcp.result)}`);
    state = mcp.state as State;
    const undo = ok(applyMutation(state, req('undo', {}, 2)));
    expect(undo.originOfApplied).toEqual({ kind: 'mcp', clientId: 'mcp-1' });
    const undo2 = ok(applyMutation(nextState(state, req('undo', {}, 2)), req('undo', {}, 3)));
    expect(undo2.originOfApplied).toEqual({ kind: 'browser', clientId: 'browser-1' });
  });

  it('never mutates the input state or request objects', () => {
    const state = stateOf(BEFORE);
    const sceneSnapshot = JSON.stringify(state.scene);
    const contentSnapshot = JSON.stringify(state.content);
    const request = req('createEntity', { kind: 'group', components: { light: { type: 'ambient', color: '#ffffff', intensity: 1 } } }, 0) as Record<string, unknown>;
    const requestSnapshot = JSON.stringify(request);
    const outcome = applyMutation(state, request);
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(state.scene)).toBe(sceneSnapshot);
    expect(JSON.stringify(state.content)).toBe(contentSnapshot);
    expect(JSON.stringify(request)).toBe(requestSnapshot);
    // A successful create does not alias the request's component values.
    if (outcome.ok && outcome.result.change.type === 'createEntity') {
      const components = (request['args'] as { components: Record<string, unknown> }).components;
      expect((outcome.result.change.entity.components as unknown as Record<string, unknown>)['light']).not.toBe(components['light']);
    }
  });

  it('filters queryEntities by component and rejects unknown names', () => {
    const entities = stateOf(BEFORE).scene.entities as unknown as { components: Record<string, unknown> }[];
    const bodies = filterEntitiesByComponent(entities, 'collider');
    expect(bodies.ok).toBe(true);
    if (bodies.ok) expect(bodies.entities.map((e) => (e as { id?: string }).id)).toEqual(['box-0001']);
    const spawns = filterEntitiesByComponent(entities, 'playerSpawn');
    if (spawns.ok) expect(spawns.entities.length).toBe(1);
    const bad = filterEntitiesByComponent(entities, 'nope');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('field_value');
    const all = filterEntitiesByComponent(entities, undefined);
    if (all.ok) expect(all.entities.length).toBe(entities.length);
  });

  it('exposes every contract failure code in ERROR_CODES (reachable set)', () => {
    const fixtureCodes = ['component_missing', 'field_value', 'field_unexpected', 'field_missing', 'revision_conflict', 'no_change'];
    for (const code of fixtureCodes) expect(ERROR_CODES as readonly string[]).toContain(code);
    const v3Codes = ['spawn_transform_unsupported', 'asset_kind_mismatch', 'animation_role_out_of_range', 'animation_role_duplicate'];
    for (const code of v3Codes) expect(ERROR_CODES as readonly string[]).toContain(code);
    // A spawn on a parented entity is `spawn_transform_unsupported`.
    expect(fail(applyMutation(stateOf(BEFORE), req('createEntity', { kind: 'group', parentId: 'group-0001', components: { playerSpawn: {} } }, 0)))).toBe('spawn_transform_unsupported');
  });
});
