/**
 * Public surface and module-boundary behavior — dependencies.md §3
 * ("types (envelopes), the pure apply/inverse functions, the history
 * model, ERROR_CODES"), totality (never throws), purity (the input state
 * is never mutated), and determinism.
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical } from '@thirdlight/project-model';

import * as pkg from './index';
import { applyMutation, ERROR_CODES, MAX_REVISION } from './index';
import type {
  ApplyOutcome,
  CommandError,
  CommandState,
  CreateEntityArgs,
  DeleteEntityArgs,
  EmptyArgs,
  HistoryEntry,
  MutationOp,
  MutationRequest,
  MutationResult,
  SetTransformArgs,
} from './index';
import { at, boxEntity, cameraEntity, req, scene, v4State } from './test-scene';

const ST = () => v4State(scene(0, [cameraEntity(), boxEntity('box-0001')]));

describe('public surface (dependencies.md §3)', () => {
  it('exports the entry points and constants', () => {
    expect(typeof pkg.applyMutation).toBe('function');
    expect(typeof pkg.createCommandState).toBe('function');
    // Packet 21 extended ERROR_CODES with the commands.md §5.4 M2 rows
    // (prefab/behavior/property/settings/content codes). The M1 rows are
    // unchanged and in the same order; the assertion records the full set.
    expect(ERROR_CODES).toEqual([
      'invalid_request',
      'field_missing',
      'field_unexpected',
      'field_type',
      'field_value',
      'project_not_found',
      'project_unavailable',
      'workspace_closed',
      'revision_conflict',
      'request_id_reused',
      'revision_exhausted',
      'entity_not_found',
      'reference_missing',
      'camera_count_invalid',
      'limits_exceeded',
      'id_exhaustion',
      'no_change',
      'prefab_not_found',
      'prefab_id_duplicate',
      'prefab_camera_capture_forbidden',
      'prefab_nested_forbidden',
      'prefab_external_reference_forbidden',
      'prefab_local_unknown',
      'prefab_reference_missing',
      'prefab_component_forbidden',
      'behavior_not_found',
      'behavior_id_duplicate',
      'behavior_reference_missing',
      'behavior_publication_unavailable',
      'property_unknown',
      'property_type',
      'property_value',
      'property_declaration_incompatible',
      'setting_unknown',
      'reference_in_use',
      'asset_not_found',
      'asset_id_duplicate',
      'asset_reference_missing',
      'behavior_trust_unacknowledged',
      'behavior_declaration_mismatch',
      'digest_invalid',
      'component_missing',
      'id_invalid',
      'external_change_unresolved',
      'history_empty',
      'history_invalid',
      'write_failed',
      // Packet 45 appended the commands.md §5.4 v3 game/presentation rows
      // (and the §41.3.2 animation-role rows); no accepted row changed.
      'game_reference_missing',
      'game_reference_in_use',
      'zone_transform_unsupported',
      'spawn_transform_unsupported',
      'zone_checkpoint_count_invalid',
      'zone_goal_missing',
      'asset_kind_mismatch',
      'game_config_invalid',
      'animation_role_out_of_range',
      'animation_role_duplicate',
      'animation_role_mismatch',
      'animation_role_ambiguous',
      'animation_skin_unsupported',
      'animation_root_motion',
    ]);
    expect(MAX_REVISION).toBe(2 ** 53 - 1);
  });

  it('the types are structurally sound (compile-time check via casts)', () => {
    // Wire envelope (documented shape; runtime validation is the gate).
    const wire: MutationRequest = {
      op: 'createEntity',
      projectId: 'demo-0001',
      expectedRevision: 0,
      requestId: 'req-' + '0'.repeat(32),
      args: { kind: 'box' } as CreateEntityArgs,
    };
    const setArgs: SetTransformArgs = {
      entityId: 'box-0001',
      transform: { position: [1, 0, 0] },
    };
    const delArgs: DeleteEntityArgs = { entityId: 'box-0001' };
    const empty: EmptyArgs = {};
    const ops: MutationOp[] = [
      'createEntity',
      'setTransform',
      'deleteEntity',
      'undo',
      'redo',
    ];
    const entry: HistoryEntry = {
      seq: 1,
      requestId: wire.requestId,
      op: 'createEntity',
      origin: null,
      appliedRevision: 1,
      change: {
        type: 'createEntity',
        id: 'box-0001',
        entity: boxEntity('box-0001'),
      },
      inverse: { kind: 'delete', rootId: 'box-0001' },
    };
    const err: CommandError = {
      code: 'no_change',
      cls: 'validation',
      message: 'the resulting scene and content are byte-identical to the current state',
    };
    const res: MutationResult = { ok: false, error: err };
    const out: ApplyOutcome = { ok: false, result: res };
    expect([wire, setArgs, delArgs, empty, ops, entry, out]).toBeDefined();
  });
});

describe('totality — malformed inputs never throw', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['string', 'createEntity'],
    ['boolean', true],
    ['array', [1, 2, 3]],
    ['object without op', {}],
  ])('applyMutation(state, %s) yields a structured invalid_request', (_label, v) => {
    const st = ST();
    const r = applyMutation(st, v);
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.result.ok).toBe(false);
      expect(r.result.error.code).toBe('invalid_request');
      expect(r.result.error.cls).toBe('validation');
      expect(typeof r.result.error.message).toBe('string');
    }
  });
});

describe('purity — the input state is never mutated', () => {
  it('a SUCCESSFUL apply leaves the input state object untouched', () => {
    const st = ST();
    const snap = JSON.parse(JSON.stringify(st));
    const r = applyMutation(st, req('createEntity', { kind: 'box' }));
    expect(r.ok).toBe(true);
    // Old state intact...
    expect(JSON.parse(JSON.stringify(st))).toEqual(snap);
    // ...and the scene entity objects were not rewritten in place.
    expect(st.scene.entities.map((e) => e.id)).toEqual(['cam-main', 'box-0001']);
    if (r.ok) {
      // New state is a different graph with the new entity.
      expect(r.state.scene.entities.map((e) => e.id)).toEqual([
        'cam-main',
        'box-0001',
        'box-0002',
      ]);
      expect(r.state.scene.revision).toBe(1);
    }
  });

  it('re-applying the same request to the SAME old state gives identical results (determinism)', () => {
    const st = ST();
    const request = req('setTransform', {
      entityId: 'box-0001',
      transform: { position: [2.5, 0, 0] },
    });
    const r1 = applyMutation(st, request);
    const r2 = applyMutation(st, request);
    if (!r1.ok || !r2.ok) throw new Error('both should succeed');
    expect(JSON.stringify(r1.result)).toBe(JSON.stringify(r2.result));
    const a = serializeCanonical(r1.state.scene);
    const b = serializeCanonical(r2.state.scene);
    expect(a.ok && b.ok && a.bytes.length === b.bytes.length).toBe(true);
    if (a.ok && b.ok) {
      for (let i = 0; i < a.bytes.length; i++) {
        expect(a.bytes[i]).toBe(b.bytes[i]);
      }
    }
  });
});

describe('success payload invariants (§5.1)', () => {
  it('every successful mutation advances the revision by exactly 1 and echoes the request', () => {
    let st = ST();
    const request = req('setTransform', {
      entityId: 'box-0001',
      transform: { position: [0.1, 0.2, 0.3] },
    });
    const r = applyMutation(st, request);
    if (!r.ok) throw new Error('should succeed');
    expect(r.result.revision).toBe(st.scene.revision + 1);
    expect(r.result.revision).toBe((request.expectedRevision as number) + 1);
    expect(r.result.projectId).toBe('demo-0001');
    expect(r.result.requestId).toBe(request.requestId);
    expect(r.result.op).toBe('setTransform');
    expect(r.result.duplicated).toBe(false);
    // No createdId / appliedOf on a forward setTransform.
    expect('createdId' in r.result).toBe(false);
    expect('appliedOf' in r.result).toBe(false);
    expect('originOfApplied' in r.result).toBe(false);
  });

  it('canonical key order of the success payload (durable record, §5.1)', () => {
    const r = applyMutation(ST(), req('createEntity', { kind: 'box' }));
    if (!r.ok) throw new Error('should succeed');
    expect(Object.keys(r.result)).toEqual([
      'ok',
      'op',
      'projectId',
      'requestId',
      'revision',
      'duplicated',
      'createdId',
      'change',
      'history',
    ]);
    const u = applyMutation(r.ok ? r.state : (null as never), at(r.ok ? r.state : (null as never), 'undo', {}));
    if (!u.ok) throw new Error('undo should succeed');
    expect(Object.keys(u.result)).toEqual([
      'ok',
      'op',
      'projectId',
      'requestId',
      'revision',
      'duplicated',
      'change',
      'appliedOf',
      'originOfApplied',
      'history',
    ]);
  });

  it('canonical key order of failure payloads (fixture-pinned)', () => {
    const st = ST();
    const r = applyMutation(st, req('setTransform', {
      entityId: 'box-0001',
      transform: { position: [0.1, 0.2, 0.3] },
    }));
    if (!r.ok) throw new Error('should succeed');
    // Now force a no_change on the new state (same values again).
    const r2 = applyMutation(r.ok ? r.state : (null as never), at(r.ok ? r.state : (null as never), 'setTransform', {
      entityId: 'box-0001',
      transform: { position: [0.1, 0.2, 0.3] },
    }));
    if (r2.ok) throw new Error('second identical setTransform ⇒ no_change');
    expect(Object.keys(r2.result)).toEqual(['ok', 'op', 'projectId', 'requestId', 'error']);
    // v3/v4 states report the whole-state no_change (scene AND content
    // byte-identical): code, cls, message.
    expect(Object.keys(r2.result.error)).toEqual(['code', 'cls', 'message']);

    // result-scene failure key order (scenario 04 pin): code, cls,
    // detailDocument, details, detailCount, message, hint.
    const r3 = applyMutation(ST(), req('setTransform', {
      entityId: 'box-0001',
      transform: { rotation: [0, 0, 0, 0] },
    }));
    if (r3.ok) throw new Error('should fail (quaternion)');
    expect(Object.keys(r3.result.error)).toEqual([
      'code',
      'cls',
      'detailDocument',
      'details',
      'detailCount',
      'message',
      'hint',
    ]);
  });

  it('history entries carry the §9.1 shape with canonical key order', () => {
    const st = ST();
    const r = applyMutation(st, req('createEntity', {
      kind: 'box',
      name: 'X',
    }, { origin: { kind: 'mcp', clientId: 'harness' } }));
    if (!r.ok) throw new Error('should succeed');
    const entry = r.state.history.entries[0];
    expect(entry).toBeDefined();
    expect(Object.keys(entry!)).toEqual([
      'seq',
      'requestId',
      'op',
      'origin',
      'appliedRevision',
      'change',
      'inverse',
    ]);
    expect(entry?.seq).toBe(1);
    expect(entry?.appliedRevision).toBe(1);
    expect(entry?.origin).toEqual({ kind: 'mcp', clientId: 'harness' });
    expect(Object.keys(entry?.inverse ?? {})).toEqual(['kind', 'rootId']);
    expect(Object.keys(entry?.change ?? {})).toEqual(['type', 'id', 'entity']);
  });
});