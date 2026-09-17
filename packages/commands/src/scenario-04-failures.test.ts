/**
 * Scenario 04 replay — `fixtures/commands/scenarios/04-invalid-no-partial`.
 *
 * Four REJECTED commands at the mainline T5 state (revision 5): a
 * result-scene quaternion failure, an `entity_not_found`, a
 * `reference_missing`, and a `no_change`. Each failure payload must match
 * the fixture `out` verbatim, and — the packet's "invalid edits leave
 * inputs unchanged" acceptance — the scene bytes AND the history state
 * must be bit-for-bit unchanged after every rejected command.
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical, validateScene } from '@thirdlight/project-model';
import type { Scene } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState } from './index';
import { bytesEqual, fixtureText } from './test-fixtures';

const DIR = 'scenarios/04-invalid-no-partial';

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

describe('scenario 04 — invalid commands leave the state byte-identical', () => {
  const messages = JSON.parse(fixtureText(`${DIR}/messages.json`)) as {
    in: unknown;
    out: Record<string, unknown>;
  }[];

  it('has the four pinned rejections', () => {
    expect(messages).toHaveLength(4);
  });

  it('replays all four rejections with verbatim failure payloads and unchanged state', () => {
    let state: CommandState = createCommandState(loadEnvelopeScene(`${DIR}/disk-before/scenes/main.json`));
    const beforeBytes = sceneBytes(state.scene);
    const beforeHistory = JSON.stringify(state.history);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const outcome = applyMutation(state, msg.in);
      if (outcome.ok) {
        throw new Error(`step ${i + 1} unexpectedly succeeded`);
      }
      if (i === 0) {
        // KNOWN CROSS-CONTRACT DRIFT (recorded in docs/handoffs/06.md):
        // the fixture's detail hint ("identity rotation is [0, 0, 0, 1]",
        // matching the commands.md §5.2 example) predates the project-model
        // §12.5 hint wording, which the approved project-model emits
        // verbatim: "normalize to unit length; e.g. 45-degree yaw about Y
        // is [0, 0.3826834323650898, 0, 0.9238795325112867]". commands.md
        // §5.2 mandates the details BE the project-model's error objects,
        // so pass-through is correct and only this one hint string differs.
        const expected = structuredClone(msg.out) as {
          error: { details: { hint: string }[] };
        };
        expect((outcome.result.ok === false ? outcome.result.error.details?.[0]?.hint : undefined)).toBe(
          'normalize to unit length; e.g. 45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]',
        );
        expected.error.details[0]!.hint =
          'normalize to unit length; e.g. 45-degree yaw about Y is [0, 0.3826834323650898, 0, 0.9238795325112867]';
        expect(outcome.result, 'step 1 failure payload mismatch (except the documented stale hint)').toEqual(expected);
      } else {
        expect(outcome.result, `step ${i + 1} failure payload mismatch`).toEqual(msg.out);
      }
      // No partial change: the scene is byte-identical...
      expect(bytesEqual(sceneBytes(state.scene), beforeBytes)).toBe(true);
      // ...and the history (stacks and depths) is unchanged.
      expect(JSON.stringify(state.history)).toBe(beforeHistory);
      // The pure layer must not have swapped the state object.
      // (Failure outcomes carry no new state; the caller keeps the same one.)
    }

    // The envelope's scene on disk is byte-identical by construction:
    // every failure path returned before any application.
    const diskAfter = JSON.parse(fixtureText(`${DIR}/disk-after/scenes/main.json`)) as Envelope;
    expect(bytesEqual(sceneBytes(state.scene), sceneBytes(diskAfter.scene))).toBe(true);
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