import { describe, it, expect } from 'vitest';
import {
  makeRequestId,
  isValidRequestId,
  makeEnvelope,
  makeEstablishBody,
  adoptRevision,
  isDuplicateResponse,
  decideRetry,
  type CommandOutcome,
  type MutationResponse,
} from './envelope';

describe('envelope — requestId', () => {
  it('generates a valid req- + 32 lowercase hex id', () => {
    const id = makeRequestId();
    expect(isValidRequestId(id)).toBe(true);
    expect(id).toMatch(/^req-[0-9a-f]{32}$/);
  });

  it('is deterministic under an injected rng (testable)', () => {
    const id = makeRequestId(() => 0); // all zeros
    expect(id).toBe('req-' + '0'.repeat(32));
  });
});

describe('envelope — makeEnvelope / makeEstablishBody', () => {
  it('builds a commands.md §4 envelope', () => {
    const env = makeEnvelope('createEntity', 'proj-1', 'req-a', 3, { kind: 'box', parentId: null, name: 'x' }, { kind: 'browser', clientId: 'sess-1' });
    expect(env).toEqual({
      op: 'createEntity',
      projectId: 'proj-1',
      requestId: 'req-a',
      expectedRevision: 3,
      args: { kind: 'box', parentId: null, name: 'x' },
      origin: { kind: 'browser', clientId: 'sess-1' },
    });
  });

  it('builds the establish body (sessions.md §5.1)', () => {
    expect(makeEstablishBody('proj-1', 'sess-1')).toEqual({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      clientInfo: { kind: 'browser', label: 'editor' },
    });
  });
});

describe('envelope — revision adoption + duplicate detection', () => {
  it('adopts the authoritative backend revision (never self-advances)', () => {
    const ok: MutationResponse = { ok: true, revision: 7, duplicated: false, change: {} };
    expect(adoptRevision(5, ok)).toBe(7);
    expect(adoptRevision(9, ok)).toBe(9); // never decreases
    const conflict: MutationResponse = { ok: false, code: 'revision_conflict', currentRevision: 4 };
    expect(adoptRevision(5, conflict)).toBe(5); // a conflict does not advance
  });

  it('detects a duplicate replay', () => {
    expect(isDuplicateResponse({ ok: true, revision: 2, duplicated: true, change: {} })).toBe(true);
    expect(isDuplicateResponse({ ok: true, revision: 2, duplicated: false, change: {} })).toBe(false);
  });
});

describe('envelope — ack-loss retry discipline (sessions.md §8.4)', () => {
  const lost: CommandOutcome = { status: 'lost' };
  const applied: CommandOutcome = { status: 'response', response: { ok: true, revision: 6, duplicated: false, change: {} } };
  const replay: CommandOutcome = { status: 'response', response: { ok: true, revision: 6, duplicated: true, change: {} } };
  const conflict: CommandOutcome = { status: 'response', response: { ok: false, code: 'revision_conflict', currentRevision: 6 } };

  it('a lost ack retries with the SAME requestId (idempotent)', () => {
    const d = decideRetry('req-same', lost, false);
    expect(d.retry).toBe(true);
    expect(d.requestId).toBe('req-same');
  });

  it('a lost ack retries at most once', () => {
    expect(decideRetry('req-same', lost, true).retry).toBe(false);
  });

  it('a successful apply does not retry', () => {
    expect(decideRetry('req-same', applied, false).retry).toBe(false);
  });

  it('a duplicate replay is accepted (no retry)', () => {
    const d = decideRetry('req-same', replay, false);
    expect(d.retry).toBe(false);
    expect(d.reason).toContain('duplicate');
  });

  it('a revision_conflict is not a blind retry (the gesture handles it)', () => {
    const d = decideRetry('req-same', conflict, false);
    expect(d.retry).toBe(false);
    expect(d.reason).toContain('gesture');
  });
});