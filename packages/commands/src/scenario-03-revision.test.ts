/**
 * Scenario 03 replay — `fixtures/commands/scenarios/03-stale-revision`
 * (storage v4: the pure layer runs on the scene file's scene and the
 * content catalog, as the workspace hands them over).
 *
 * A stale setTransform (expectedRevision 4 at current revision 5) is
 * reported as STALE, not validated (commands.md §6.1: revision checking
 * precedes argument validation) — the pinned `revision_conflict` payload
 * with `currentRevision`. The recovery re-issue (fresh requestId, current
 * revision) succeeds; the final scene must equal the disk-after scene.
 * The state at T5 has an EMPTY history (fresh process, §9.2 restart
 * boundary — the re-issue is the first recorded entry, undoDepth 1).
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical } from '@thirdlight/project-model';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { bytesEqual, fixtureProjectV4, fixtureText, withoutSceneId } from './test-fixtures';

const DIR = 'scenarios/03-stale-revision';

function stateAt(dir: string): CommandState<SceneV4> {
  const { scene, content } = fixtureProjectV4(dir);
  return createCommandState(scene, content);
}

function sceneBytes(scene: unknown): Uint8Array {
  const r = serializeCanonical(scene);
  if (!r.ok) throw new Error('canonical serialization failed');
  return r.bytes;
}

describe('scenario 03 — stale revision, then recovery re-issue', () => {
  const messages = JSON.parse(fixtureText(`${DIR}/messages.json`)) as {
    in: unknown;
    out: Record<string, unknown>;
  }[];

  it('step 1: stale request fails with the pinned revision_conflict payload; state unchanged', () => {
    const state = stateAt(`${DIR}/disk-before`);
    const before = sceneBytes(state.scene);
    const beforeHistory = JSON.stringify(state.history);

    const m0 = messages[0]!;
    const outcome = applyMutation(state, m0.in);
    if (outcome.ok) throw new Error('stale request should have failed');
    expect(outcome.result).toEqual(m0.out);
    expect(bytesEqual(sceneBytes(state.scene), before)).toBe(true);
    expect(JSON.stringify(state.history)).toBe(beforeHistory);
  });

  it('step 2: the re-issue (fresh requestId, current revision) succeeds verbatim; final scene matches disk-after', () => {
    const state = stateAt(`${DIR}/disk-before`);
    const m0 = messages[0]!;
    const m1 = messages[1]!;
    // The stale attempt first (as in the fixture timeline).
    const stale = applyMutation(state, m0.in);
    if (stale.ok) throw new Error('stale request should have failed');
    if (stale.result.ok === false) {
      expect(stale.result.error.code).toBe('revision_conflict');
      expect(stale.result.error.expectedRevision).toBe(4);
      expect(stale.result.error.currentRevision).toBe(5);
    }
    // Then the re-issue: the workspace's ack adds the edited scene's id.
    const outcome = applyMutation(state, m1.in);
    if (!outcome.ok) throw new Error('re-issue should have succeeded');
    expect(m1.out['sceneId']).toBe('scene-main');
    expect(outcome.result).toEqual(withoutSceneId(m1.out));

    // applyMutation is pure: the post-state comes from the outcome.
    const after = fixtureProjectV4(`${DIR}/disk-after`).scene;
    expect(bytesEqual(sceneBytes(outcome.state.scene), sceneBytes(after))).toBe(true);
    expect(outcome.state.scene.revision).toBe(6);
    // Fresh-process history: the re-issue is the first entry, depths (1, 0).
    expect(outcome.state.history.entries.length).toBe(1);
    expect(outcome.state.history.cursor).toBe(1);
  });

  it('a stale UNDO is rejected before the history check (revision check precedes op preconditions)', () => {
    const state = stateAt(`${DIR}/disk-before`);
    // Empty history AND stale revision: the pinned order is revision_conflict.
    const r = applyMutation(state, {
      op: 'undo',
      projectId: 'demo-0001',
      expectedRevision: 4,
      requestId: 'req-30000000000000000000000000000099',
      args: {},
    });
    if (r.ok) throw new Error('stale undo should have failed');
    if (r.result.ok === false) {
      expect(r.result.error.code).toBe('revision_conflict');
      expect(r.result.error.currentRevision).toBe(5);
    }
  });
});
