/**
 * The committed `m3` command contract fixtures
 * (`fixtures/m3/contracts/commands/**`) through the REAL engine.
 *
 * The scenario was recorded against a character controller layer the engine
 * does not have (its zones, the camera follow, `setGameConfig`), so its
 * message stream and after-envelope are not replayed. Only the recorded
 * cases whose subject is generic are run, against the recorded states with the
 * removed components stripped (`m3NeutralJson`): the surface-preset
 * no-change case and the component/field failure cases F6, F8 and F9. Every
 * recorded `code` and auxiliary field of those cases is asserted exactly.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandError, CommandState, ContentDocument } from './index';
import { m3ContractJson, m3NeutralJson } from './test-fixtures';

interface EnvelopeFixture {
  storageVersion: number;
  type: string;
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}

const AFTER = m3NeutralJson<EnvelopeFixture>('commands/scenario.after.json');

type State = CommandState<SceneV3>;

function stateOf(env: EnvelopeFixture): State {
  return createCommandState(
    structuredClone(env.scene),
    structuredClone(env.content) as unknown as ContentDocument,
  ) as unknown as State;
}

describe('no-change cases', () => {
  const NC = m3ContractJson<{
    state: string;
    messages: { requestId: string; op: string; expectedRevision: number; args: Record<string, unknown> }[];
  }>('commands/no-change.json');

  // Recorded cases 2 (`setGameConfig`) and 3 (a `gameZone` edit) edit the
  // removed game layer.
  const GENERIC = NC.messages.filter((m) => m.op === 'applySurfacePreset');

  it('reports no_change for the recorded surface-preset case and leaves the state untouched', () => {
    expect(NC.messages.length).toBe(3);
    expect(GENERIC.map((m) => m.requestId)).toEqual(['req-00000000000000000000000000000011']);
    for (const m of GENERIC) {
      const state: State = stateOf(AFTER);
      const beforeScene = structuredClone(state.scene);
      const beforeContent = structuredClone(state.content);
      const outcome = applyMutation(state, {
        op: m.op,
        projectId: AFTER.projectId,
        expectedRevision: m.expectedRevision,
        requestId: m.requestId,
        args: m.args,
      });
      expect(outcome.ok, m.requestId).toBe(false);
      if (!outcome.ok) expect(outcome.result.error.code, m.requestId).toBe('no_change');
      expect(state.scene).toEqual(beforeScene);
      expect(state.content).toEqual(beforeContent);
    }
  });
});

interface FailureCase {
  id: string;
  state: string;
  expectedRevision: number;
  op: string;
  args: Record<string, unknown>;
  expect: { code: string; path?: string; expected?: string } & Record<string, unknown>;
}

/**
 * The recorded failure cases whose subject is generic. F1–F5 and F10–F12
 * exercise the removed game block and zones (`game_reference_in_use`, a
 * zone/spawn conflict, `setGameConfig`, a zone edit); F7 names a removed
 * surface preset.
 */
const GENERIC_FAILURES = ['F6', 'F8', 'F9'];

describe('reachable failures', () => {
  const FAILURES = m3ContractJson<{ cases: FailureCase[] }>('commands/failures.json').cases;

  it('produces the recorded code and auxiliary fields for the generic cases', () => {
    expect(FAILURES.length).toBe(12);
    const cases = FAILURES.filter((c) => GENERIC_FAILURES.includes(c.id));
    expect(cases.map((c) => c.id)).toEqual(GENERIC_FAILURES);
    for (const c of cases) {
      const env = c.state === 'commands/scenario.after.json'
        ? AFTER
        : m3NeutralJson<EnvelopeFixture>(c.state);
      const state = stateOf(env);
      const beforeScene = structuredClone(state.scene);
      const outcome = applyMutation(state, {
        op: c.op,
        projectId: AFTER.projectId,
        expectedRevision: c.expectedRevision,
        requestId: `req-${c.id.toLowerCase().padEnd(32, '0')}`,
        args: c.args,
      });
      expect(outcome.ok, `${c.id} expected failure ${c.expect.code}`).toBe(false);
      if (outcome.ok) continue;
      const error = outcome.result.error as CommandError & Record<string, unknown>;
      expect(error.code, `${c.id} code`).toBe(c.expect.code);
      if (c.expect.path !== undefined) expect(error.path, c.id).toBe(c.expect.path);
      if (c.expect.expected !== undefined) {
        const first = (error.details as readonly { expected?: string }[] | undefined)?.[0];
        expect(String(error.expected ?? first?.expected), c.id).toContain(c.expect.expected);
      }
      // No partial write on any rejection.
      expect(state.scene, c.id).toEqual(beforeScene);
    }
  });
});
