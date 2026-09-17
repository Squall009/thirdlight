/**
 * Scenario 05 replay — `fixtures/commands/scenarios/05-undo-redo-mixed`.
 *
 * The self-contained 9-step human/agent history timeline (commands.md
 * §9/§9.3/§8.4/§5.1/§5.3). The pure layer replays every message from the
 * disk-before state and each result payload must match the fixture `out`
 * VERBATIM (deep equality over the exact objects): create, transform
 * edit, subtree delete, undo (restoreSubtree + deleteEntity inverses),
 * redo (recorded entity, original ID, end of array), redo invalidation
 * by a fresh edit, and undo with swapped previous/next + all-three
 * changedFields.
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical, validateScene } from '@thirdlight/project-model';
import type { Scene } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { bytesEqual, fixtureText } from './test-fixtures';

const DIR = 'scenarios/05-undo-redo-mixed';

interface Envelope {
  storageVersion: number;
  type: string;
  projectId: string;
  scene: Scene;
  retry: { retention: number; records: unknown[] };
}

function loadEnvelopeScene(rel: string): Scene {
  const envelope = JSON.parse(fixtureText(rel)) as Envelope;
  // Fixture sanity: the embedded scene is a valid canonical document.
  const v = validateScene(envelope.scene);
  if (!v.ok) throw new Error(`fixture scene invalid: ${JSON.stringify(v.errors)}`);
  return v.normalized;
}

function loadMessages(): { in: unknown; out: Record<string, unknown> }[] {
  const msgs = JSON.parse(fixtureText(`${DIR}/messages.json`));
  if (!Array.isArray(msgs)) throw new Error('messages.json is not an array');
  return msgs;
}

describe('scenario 05 — undo/redo with mixed human/agent edits (pure replay)', () => {
  const messages = loadMessages();

  it('has the 9 pinned steps', () => {
    expect(messages).toHaveLength(9);
  });

  it('replays all nine steps; every result payload matches the fixture verbatim', () => {
    const state0: CommandState = createCommandState(loadEnvelopeScene(`${DIR}/disk-before/scenes/main.json`));
    let state: CommandState = state0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const outcome = applyMutation(state, msg.in);
      // Every step succeeds in this scenario.
      if (!outcome.ok) {
        throw new Error(`step ${i + 1} unexpectedly failed: ${JSON.stringify(outcome.result)}`);
      }
      expect(
        outcome.result,
        `step ${i + 1} (${JSON.stringify(msg.in).slice(0, 120)}…) result mismatch`,
      ).toEqual(msg.out);
      // The state carried into the next step is the new state.
      state = outcome.state;
    }

    // Final scene must equal the disk-after envelope's scene (canonical
    // bytes, revision 9, entities [cam-main, box-0001, box-0002]).
    const after = loadEnvelopeScene(`${DIR}/disk-after/scenes/main.json`);
    const got = serializeCanonical(state.scene);
    const want = serializeCanonical(after);
    if (!got.ok || !want.ok) throw new Error('canonical serialization failed');
    expect(bytesEqual(got.bytes, want.bytes)).toBe(true);

    // Final depths per scenario.md: (undoDepth, redoDepth) = (3, 1).
    expect(state.history.cursor).toBe(3);
    expect(state.history.entries.length).toBe(4);
  });

  it('fresh edits invalidate redo (step 8 truncates the redo tail; step 9 leaves redoDepth 1)', () => {
    // Re-run to step 8 (fresh edit) and verify the redo tail is gone.
    let state: CommandState = createCommandState(loadEnvelopeScene(`${DIR}/disk-before/scenes/main.json`));
    for (let i = 0; i < 8; i++) {
      const outcome = applyMutation(state, messages[i]!.in);
      if (!outcome.ok) throw new Error(`step ${i + 1} failed: ${JSON.stringify(outcome.result)}`);
      state = outcome.state;
    }
    expect(state.history.cursor).toBe(state.history.entries.length); // redoDepth 0

    // A redo now fails with history_empty (which: redo).
    const redoReq = {
      op: 'redo',
      projectId: 'demo-0001',
      expectedRevision: 8,
      requestId: 'req-200000000000000000000000000000ff',
      args: {},
    };
    const r = applyMutation(state, redoReq);
    if (r.ok) throw new Error('redo should have failed (empty redo stack)');
    expect(r.result.ok).toBe(false);
    if (r.result.ok === false) {
      expect(r.result.error.code).toBe('history_empty');
      expect(r.result.error.which).toBe('redo');
    }
    // State untouched.
    expect(state.history.cursor).toBe(state.history.entries.length);
  });

  it('undo with an empty undo stack fails with history_empty (which: undo)', () => {
    const state = createCommandState(loadEnvelopeScene(`${DIR}/disk-before/scenes/main.json`));
    const r = applyMutation(state, {
      op: 'undo',
      projectId: 'demo-0001',
      expectedRevision: 0,
      requestId: 'req-200000000000000000000000000000ee',
      args: {},
    });
    if (r.ok) throw new Error('undo should have failed (empty history)');
    if (r.result.ok === false) {
      expect(r.result.error.code).toBe('history_empty');
      expect(r.result.error.which).toBe('undo');
    }
  });
});