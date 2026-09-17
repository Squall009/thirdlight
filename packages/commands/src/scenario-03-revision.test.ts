/**
 * Scenario 03 replay — `fixtures/commands/scenarios/03-stale-revision`.
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
import { serializeCanonical, validateScene } from '@thirdlight/project-model';
import type { Scene } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { bytesEqual, fixtureText } from './test-fixtures';

const DIR = 'scenarios/03-stale-revision';

interface Envelope {
  scene: Scene;
}

function loadEnvelopeScene(rel: string): Scene {
  const envelope = JSON.parse(fixtureText(rel)) as Envelope;
  const v = validateScene(envelope.scene);
  if (!v.ok) throw new Error(`fixture scene invalid: ${JSON.stringify(v.errors)}`);
  return v.normalized;
}

function sceneBytes(scene: Scene): Uint8Array {
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
    const state = createCommandState(loadEnvelopeScene(`${DIR}/disk-before/scenes/main.json`));
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
    let state: CommandState = createCommandState(loadEnvelopeScene(`${DIR}/disk-before/scenes/main.json`));
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
    // Then the re-issue.
    const outcome = applyMutation(state, m1.in);
    if (!outcome.ok) throw new Error('re-issue should have succeeded');
    expect(outcome.result).toEqual(m1.out);

    // applyMutation is pure: the post-state comes from the outcome.
    const after = loadEnvelopeScene(`${DIR}/disk-after/scenes/main.json`);
    expect(bytesEqual(sceneBytes(outcome.state.scene), sceneBytes(after))).toBe(true);
    expect(outcome.state.scene.revision).toBe(6);
    // Fresh-process history: the re-issue is the first entry, depths (1, 0).
    expect(outcome.state.history.entries.length).toBe(1);
    expect(outcome.state.history.cursor).toBe(1);
  });

  it('a stale UNDO is rejected before the history check (revision check precedes op preconditions)', () => {
    const state = createCommandState(loadEnvelopeScene(`${DIR}/disk-before/scenes/main.json`));
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