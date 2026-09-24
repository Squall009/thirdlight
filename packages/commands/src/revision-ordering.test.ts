/**
 * Pipeline ordering regression (06-review F1, commands.md §6.1 step 4):
 * "Revision checking precedes argument validation: a stale request is
 * reported as stale, not validated."
 *
 * The F1 repair split request validation into the envelope pass
 * (`invalid_request`, runs BEFORE the revision check) and the per-op
 * args-schema pass (`field_*`, runs AFTER the revision check and the
 * `revision_exhausted` check). These tests pin the ordering:
 *
 * - stale request + schema-invalid args ⇒ `revision_conflict` carrying
 *   both `expectedRevision` and `currentRevision` (never `field_*`);
 * - `expectedRevision` = current = MAX_REVISION + schema-invalid args ⇒
 *   `revision_exhausted` (a state-level condition precedes validation);
 * - guards for the orderings the repair must NOT change: a malformed
 *   envelope is still `invalid_request` even when stale (reviewer probe
 *   A6), and per-op preconditions (e.g. `entity_not_found`) remain AFTER
 *   the revision check (reviewer probes A2/A4/L1).
 */

import { describe, expect, it } from 'vitest';

import { applyMutation, MAX_REVISION } from './index';
import type { CommandError, CommandState } from './index';
import { boxEntity, cameraEntity, req, scene, v4State } from './test-scene';

/** A valid scene at the given revision (one camera + one box). */
function stateAt(revision: number): CommandState {
  return v4State(scene(revision, [cameraEntity(), boxEntity('box-0001')]));
}

/** Apply and return the structured error (these requests must all fail). */
function fail(state: CommandState, request: unknown): CommandError {
  const r = applyMutation(state, request);
  if (r.ok) throw new Error('request should have failed');
  if (r.result.ok !== false) throw new Error('expected a failure payload');
  return r.result.error;
}

describe('revision check precedes args-schema validation (§6.1 step 4) — F1 regression', () => {
  it('stale + field_type args (entityId: 42) ⇒ revision_conflict carrying both revisions (probe A1)', () => {
    const e = fail(
      stateAt(5),
      req('setTransform', { entityId: 42, transform: { position: [1, 0, 0] } }, { expectedRevision: 6 }),
    );
    expect(e.code).toBe('revision_conflict');
    expect(e.cls).toBe('conflict');
    expect(e.expectedRevision).toBe(6);
    expect(e.currentRevision).toBe(5);
  });

  it('stale + transform: {} ⇒ revision_conflict, not field_value (probe A3)', () => {
    const e = fail(
      stateAt(5),
      req('setTransform', { entityId: 'box-0001', transform: {} }, { expectedRevision: 6 }),
    );
    expect(e.code).toBe('revision_conflict');
    expect(e.cls).toBe('conflict');
    expect(e.expectedRevision).toBe(6);
    expect(e.currentRevision).toBe(5);
  });

  it('stale + field_missing args ⇒ revision_conflict (all field_* codes lose to staleness)', () => {
    const e = fail(stateAt(5), req('createEntity', {}, { expectedRevision: 6 }));
    expect(e.code).toBe('revision_conflict');
    expect(e.expectedRevision).toBe(6);
    expect(e.currentRevision).toBe(5);
  });

  it('at MAX_REVISION (== current) + schema-invalid args ⇒ revision_exhausted (probe A5)', () => {
    const e = fail(
      stateAt(MAX_REVISION),
      req('setTransform', { entityId: 42, transform: { position: [1, 0, 0] } }, { expectedRevision: MAX_REVISION }),
    );
    expect(e.code).toBe('revision_exhausted');
    expect(e.cls).toBe('internal');
    expect(e.currentRevision).toBe(MAX_REVISION);
  });
});

describe('ordering guards — kept correct by the F1 repair', () => {
  it('malformed envelope + stale ⇒ invalid_request (the envelope pass precedes the revision check; probe A6)', () => {
    const e = fail(stateAt(5), {
      op: 'setTransform',
      projectId: 'demo-0001',
      expectedRevision: 6,
      requestId: 'not-a-request-id',
      args: { entityId: 'box-0001', transform: { position: [1, 0, 0] } },
    });
    expect(e.code).toBe('invalid_request');
    expect(e.cls).toBe('validation');
    expect(e.path).toBe('/requestId');
  });

  it('stale + valid args + missing entity ⇒ revision_conflict (preconditions stay after the revision check; probes A2/A4/L1)', () => {
    const e = fail(
      stateAt(5),
      req('setTransform', { entityId: 'no-such-entity', transform: { position: [1, 0, 0] } }, { expectedRevision: 6 }),
    );
    expect(e.code).toBe('revision_conflict');
    expect(e.currentRevision).toBe(5);
  });

  it('fresh + schema-invalid args ⇒ field_type (the args pass still runs when the revision matches)', () => {
    const e = fail(
      stateAt(5),
      req('setTransform', { entityId: 42, transform: { position: [1, 0, 0] } }, { expectedRevision: 5 }),
    );
    expect(e.code).toBe('field_type');
    expect(e.path).toBe('/args/entityId');
  });

  it('fresh + valid args ⇒ success (the happy path is untouched)', () => {
    const r = applyMutation(
      stateAt(5),
      req('setTransform', { entityId: 'box-0001', transform: { position: [1, 0, 0] } }, { expectedRevision: 5 }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.ok).toBe(true);
      if (r.result.ok) {
        expect(r.result.revision).toBe(6);
        expect(r.result.duplicated).toBe(false);
      }
    }
  });
});