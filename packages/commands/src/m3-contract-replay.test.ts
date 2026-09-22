/**
 * Packet 45 — replay of the committed packet-39 command contract fixtures
 * through the REAL engine (`fixtures/m3/contracts/commands/**`).
 *
 * The committed packet-39 checker replays the scenario from recorded change
 * data (contract consistency); this test drives the same scenario through
 * `applyMutation` + the pure history engine and asserts the recorded
 * revision/createdId/change/inverse/history values, the recorded error codes,
 * and the byte-exact final envelope.
 *
 * Documented fixture/contract divergences (handoff 45 CC-45-1/2/3): the
 * committed failure fixtures' auxiliary `path`/`reason` fields predate the
 * promoted project-model §23.9 vocabularies and commands.md §3's request-path
 * rule. Every recorded `code` is asserted exactly; each divergent auxiliary
 * value is asserted against the contract-correct value in `AUXILIARY` below
 * (never silently ignored).
 */

import { describe, expect, it } from 'vitest';
import type { SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { ApplyOutcome, CommandError, CommandState, ContentDocument, MutationSuccess } from './index';
import { m3ContractJson } from './test-fixtures';

interface Message {
  seq: number;
  requestId: string;
  op: string;
  expectedRevision: number;
  args: Record<string, unknown>;
  result: {
    revision: number;
    createdId?: string;
    change: unknown;
    history: { undoDepth: number; redoDepth: number };
  };
  inverse?: unknown;
}

interface EnvelopeFixture {
  storageVersion: number;
  type: string;
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}

const BEFORE = m3ContractJson<EnvelopeFixture>('commands/scenario.before.json');
const AFTER = m3ContractJson<EnvelopeFixture>('commands/scenario.after.json');
const MESSAGES = m3ContractJson<{ messages: Message[] }>('commands/scenario.messages.json').messages;

type State = CommandState<SceneV3>;

function stateOf(env: EnvelopeFixture): State {
  return createCommandState(
    structuredClone(env.scene),
    structuredClone(env.content) as unknown as ContentDocument,
  ) as unknown as State;
}

function request(m: Message): unknown {
  return {
    op: m.op,
    projectId: BEFORE.projectId,
    expectedRevision: m.expectedRevision,
    requestId: m.requestId,
    args: m.args,
  };
}

function expectOk(outcome: ApplyOutcome<SceneV3>): MutationSuccess {
  if (!outcome.ok) throw new Error(`expected success, got ${JSON.stringify(outcome.result)}`);
  return outcome.result;
}

/** Apply a request that must succeed and return the new state. */
function nextState(state: State, request: unknown): State {
  const outcome = applyMutation(state, request);
  if (!outcome.ok) throw new Error(`expected success, got ${JSON.stringify(outcome.result)}`);
  return outcome.state as State;
}

/** The last recorded history entry of an applied state. */
function lastEntry(state: State): { inverse: unknown; change: unknown } | undefined {
  const { entries, cursor } = state.history;
  if (cursor === 0) return undefined;
  return entries[cursor - 1] as unknown as { inverse: unknown; change: unknown };
}

describe('packet-39 command scenario through the real engine', () => {
  it('replays every message byte-exactly (revision, createdId, change, inverse, history)', () => {
    let state = stateOf(BEFORE);
    expect(MESSAGES.length).toBe(7);
    for (const m of MESSAGES) {
      const outcome = applyMutation(state, {
        op: m.op,
        projectId: BEFORE.projectId,
        expectedRevision: m.expectedRevision,
        requestId: m.requestId,
        args: m.args,
      });
      const result = expectOk(outcome);
      expect(result.revision, `seq ${m.seq} revision`).toBe(m.result.revision);
      expect(result.change, `seq ${m.seq} change`).toEqual(m.result.change);
      expect(result.history, `seq ${m.seq} history`).toEqual(m.result.history);
      if (m.result.createdId !== undefined) {
        expect(result.createdId, `seq ${m.seq} createdId`).toBe(m.result.createdId);
      }
      if (!outcome.ok) throw new Error('unreachable');
      state = outcome.state as State;
      if (m.inverse !== undefined) {
        expect(lastEntry(state)?.inverse ?? null, `seq ${m.seq} recorded inverse`).toEqual(m.inverse);
      }
    }
    // The final durable state is byte-identical to the committed after-envelope.
    expect(state.scene).toEqual(AFTER.scene);
    expect(state.content).toEqual(AFTER.content);
  });

  it('an identical retry replays the recorded createdId (exact-ID retry)', () => {
    const created = MESSAGES[0] as Message;
    const first = applyMutation(stateOf(BEFORE), {
      op: created.op,
      projectId: BEFORE.projectId,
      expectedRevision: created.expectedRevision,
      requestId: created.requestId,
      args: created.args,
    });
    const again = applyMutation(stateOf(BEFORE), {
      op: created.op,
      projectId: BEFORE.projectId,
      expectedRevision: created.expectedRevision,
      requestId: 'req-' + 'f'.repeat(32),
      args: created.args,
    });
    expect(expectOk(first).createdId).toBe(created.result.createdId);
    expect(expectOk(again).createdId).toBe(created.result.createdId);
  });

  it('undo/redo move the recorded values with exact depths', () => {
    let state = stateOf(BEFORE);
    for (const m of MESSAGES) state = nextState(state, request(m));
    const undo = applyMutation(state, {
      op: 'undo',
      projectId: BEFORE.projectId,
      expectedRevision: 7,
      requestId: 'req-' + 'a'.repeat(32),
      args: {},
    });
    const undone = expectOk(undo);
    expect(undone.history).toEqual({ undoDepth: 4, redoDepth: 1 });
    expect(undone.change).toEqual(MESSAGES[5]!.result.change);
    if (!undo.ok) throw new Error('unreachable');
    const redo = applyMutation(undo.state as State, {
      op: 'redo',
      projectId: BEFORE.projectId,
      expectedRevision: 8,
      requestId: 'req-' + 'b'.repeat(32),
      args: {},
    });
    const redone = expectOk(redo);
    expect(redone.history).toEqual({ undoDepth: 5, redoDepth: 0 });
    expect(redone.change).toEqual(MESSAGES[6]!.result.change);
    if (!redo.ok) throw new Error('unreachable');
    expect((redo.state as State).content).toEqual(AFTER.content);
  });

  it('a fresh edit after an undo invalidates the redo tail', () => {
    let state = stateOf(BEFORE);
    for (const m of MESSAGES) state = nextState(state, request(m));
    const undo = applyMutation(state, {
      op: 'undo',
      projectId: BEFORE.projectId,
      expectedRevision: 7,
      requestId: 'req-' + 'c'.repeat(32),
      args: {},
    });
    if (!undo.ok) throw new Error('unreachable');
    const edit = applyMutation(undo.state as State, {
      op: 'applySurfacePreset',
      projectId: BEFORE.projectId,
      expectedRevision: 8,
      requestId: 'req-' + 'd'.repeat(32),
      args: { entityId: 'box-0001', preset: 'beacon' },
    });
    const applied = expectOk(edit);
    expect(applied.history).toEqual({ undoDepth: 5, redoDepth: 0 });
    if (!edit.ok) throw new Error('unreachable');
    const redone = applyMutation(edit.state as State, {
      op: 'redo',
      projectId: BEFORE.projectId,
      expectedRevision: 9,
      requestId: 'req-' + 'e'.repeat(32),
      args: {},
    });
    expect(redone.ok).toBe(false);
    if (!redone.ok) expect(redone.result.error.code).toBe('history_empty');
  });
});

describe('packet-39 no-change cases', () => {
  const NC = m3ContractJson<{
    state: string;
    messages: { requestId: string; op: string; expectedRevision: number; args: Record<string, unknown> }[];
  }>('commands/no-change.json');

  it('reports no_change for every recorded case and leaves the state untouched', () => {
    expect(NC.messages.length).toBe(3);
    for (const m of NC.messages) {
      const state: State = stateOf(AFTER);
      const beforeScene = structuredClone(state.scene);
      const beforeContent = structuredClone(state.content);
      const outcome = applyMutation(state, {
        op: m.op,
        projectId: BEFORE.projectId,
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
  expect: { code: string; path?: string; references?: string[]; reason?: string; expected?: string } & Record<string, unknown>;
}

/**
 * The one auxiliary fixture/contract divergence still asserted explicitly:
 * - F5 records `zone_and_spawn`, but the model's §23.3.1 conflict reason is
 *   `spawn_target` (the reason vocabulary is not in the promoted contract).
 *
 * CC-45-1/2/3 were promoted at Gate L: F1 now records the real `references`
 * array, F8/F9/F12 record the commands.md §3 request-pointer paths, and F10's
 * legal partial edit is recorded as `ok`. No auxiliary override remains for
 * them.
 */
const AUXILIARY: Record<string, { path?: string; reason?: string }> = {
  F5: { reason: 'spawn_target' },
};

describe('packet-39 reachable failures', () => {
  const FAILURES = m3ContractJson<{ cases: FailureCase[] }>('commands/failures.json').cases;

  it('produces the recorded code (and the contract-correct auxiliary fields) for all 12 cases', () => {
    expect(FAILURES.length).toBe(12);
    for (const c of FAILURES) {
      const env = c.state === 'commands/scenario.after.json'
        ? AFTER
        : m3ContractJson<EnvelopeFixture>(c.state);
      const state = stateOf(env);
      const beforeScene = structuredClone(state.scene);
      const outcome = applyMutation(state, {
        op: c.op,
        projectId: BEFORE.projectId,
        expectedRevision: c.expectedRevision,
        requestId: `req-${c.id.toLowerCase().padEnd(32, '0')}`,
        args: c.args,
      });
      if (c.expect.code === 'ok') {
        expect(outcome.ok, c.id).toBe(true);
        // F10 (commands.md §3.1.10/§8.14): a non-empty partial object is a
        // legal EDIT of a present block.
        if (c.id === 'F10' && outcome.ok) {
          expect(outcome.result.change).toMatchObject({
            type: 'setGameConfig',
            changedFields: ['title'],
          });
        }
        continue;
      }
      expect(outcome.ok, `${c.id} expected failure ${c.expect.code}`).toBe(false);
      if (outcome.ok) continue;
      const error = outcome.result.error as CommandError & Record<string, unknown>;
      expect(error.code, `${c.id} code`).toBe(c.expect.code);
      if (c.expect.code === 'revision_conflict') {
        expect(error.expectedRevision).toBe(c.expectedRevision);
        expect(error.currentRevision).toBe(7);
      }
      if (c.expect.references !== undefined) {
        // CC-45-1: `game_reference_in_use` carries `references` (the
        // document-relative pointers of the records that name the target).
        const references = error.references as readonly string[];
        for (const ref of c.expect.references) expect(references, c.id).toContain(ref);
      }
      if (c.expect.path !== undefined) {
        if (error.code === 'game_reference_in_use') {
          const references = error.references as readonly string[];
          expect(references, c.id).toContain(c.expect.path);
        } else {
          expect(error.path, c.id).toBe(AUXILIARY[c.id]?.path ?? c.expect.path);
        }
      }
      if (c.expect.reason !== undefined && AUXILIARY[c.id]?.reason !== undefined) {
        // A result-scene rejection carries its model errors in `details`
        // (commands.md §5.2); the fixture's top-level `reason` records the
        // first detail's reason.
        const first = (error.details as readonly { reason?: string }[] | undefined)?.[0];
        expect(error.reason ?? first?.reason, c.id).toBe(AUXILIARY[c.id]!.reason);
      }
      if (c.expect.expected !== undefined) {
        const first = (error.details as readonly { expected?: string }[] | undefined)?.[0];
        expect(String(error.expected ?? first?.expected), c.id).toContain(c.expect.expected);
      }
      // No partial write on any rejection.
      expect(state.scene, c.id).toEqual(beforeScene);
    }
  });
});
