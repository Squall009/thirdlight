/**
 * Scenario 04 replay — `fixtures/commands/scenarios/04-invalid-no-partial`
 * (storage v4: the pure layer runs on the scene file's scene and the
 * content catalog, as the workspace hands them over).
 *
 * Four REJECTED commands at the mainline T5 state (revision 5): a
 * result-scene quaternion failure, an `entity_not_found`, a
 * `reference_missing`, and a `no_change`. Each failure payload must match
 * the fixture `out` verbatim (the quaternion detail is the project-model's
 * own error object, passed through), and — the "invalid edits leave inputs
 * unchanged" acceptance — the scene bytes AND the history state must be
 * bit-for-bit unchanged after every rejected command.
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical } from '@thirdlight/project-model';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { bytesEqual, fixtureProjectV4, fixtureText } from './test-fixtures';

const DIR = 'scenarios/04-invalid-no-partial';

function sceneBytes(scene: unknown): Uint8Array {
  const r = serializeCanonical(scene);
  if (!r.ok) throw new Error('canonical serialization failed');
  return r.bytes;
}

describe('scenario 04 — invalid commands leave the state byte-identical', () => {
  const messages = JSON.parse(fixtureText(`${DIR}/messages.json`)) as {
    in: unknown;
    out: Record<string, unknown>;
  }[];

  it('has the four pinned rejections', () => {
    expect(messages).toHaveLength(4);
  });

  it('replays all four rejections with verbatim failure payloads and unchanged state', () => {
    const { scene, content } = fixtureProjectV4(`${DIR}/disk-before`);
    const state: CommandState<SceneV4> = createCommandState(scene, content);
    const beforeBytes = sceneBytes(state.scene);
    const beforeHistory = JSON.stringify(state.history);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const outcome = applyMutation(state, msg.in);
      if (outcome.ok) {
        throw new Error(`step ${i + 1} unexpectedly succeeded`);
      }
      expect(outcome.result, `step ${i + 1} failure payload mismatch`).toEqual(msg.out);
      // No partial change: the scene is byte-identical...
      expect(bytesEqual(sceneBytes(state.scene), beforeBytes)).toBe(true);
      // ...and the history (stacks and depths) is unchanged.
      expect(JSON.stringify(state.history)).toBe(beforeHistory);
    }

    // The scene on disk is byte-identical by construction: every failure
    // path returned before any application.
    const diskAfter = fixtureProjectV4(`${DIR}/disk-after`).scene;
    expect(bytesEqual(sceneBytes(state.scene), sceneBytes(diskAfter))).toBe(true);
  });

  it('the four error codes, in order, are quaternion_invalid, entity_not_found, reference_missing, no_change', () => {
    const codes = messages.map((m) => (m!.out as { error: { code: string } }).error.code);
    expect(codes).toEqual([
      'quaternion_invalid',
      'entity_not_found',
      'reference_missing',
      'no_change',
    ]);
  });
});
